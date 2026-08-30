/**
 * WebRTC voice, as a full mesh.
 *
 * Every participant holds one RTCPeerConnection to every other participant and sends
 * their microphone track directly to each. The server only relays the SDP offer/answer
 * and ICE candidates -- audio never touches it. That is precisely why voice here costs
 * nothing to run, and it is the single biggest reason this project can be free.
 *
 * The trade-off is bandwidth: with N people, each client uploads N-1 copies of its own
 * audio. Opus at ~32 kbit/s makes that fine up to roughly 6-8 people
 * (`LIMITS.VOICE_CHANNEL_SOFT_CAP`) on a normal connection. Beyond that you need an SFU,
 * which needs a paid always-on server.
 *
 * **Glare avoidance:** if both peers sent an offer simultaneously the negotiation would
 * deadlock. The rule here is deterministic and needs no extra signalling -- the peer with
 * the lexicographically smaller user id is the *impolite* peer and always makes the
 * offer; the other waits. Since ids are unique, exactly one side offers.
 */

import { DEFAULT_ICE_SERVERS } from '@rockscord/shared';
import type { SignalPayload } from '@rockscord/shared';
import { api } from './api';
import { emitVoiceSignal, emitVoiceState } from './socket';
import { useVoiceStore } from '../store/useVoiceStore';
import { useSettingsStore } from '../store/useSettingsStore';

interface PeerEntry {
  connection: RTCPeerConnection;
  /** Audio only. Video is kept apart so the two sources stay distinguishable. */
  stream: MediaStream;
  audio: HTMLAudioElement;
  /**
   * Inbound video, one MediaStream per source, keyed by the sender's stream id.
   *
   * WebRTC delivers tracks, not intentions: a peer sending both a camera and a screen
   * arrives as two anonymous video tracks in the same connection. Grouping by the stream
   * they were published with keeps them separable, and `media-map` below says which is
   * which.
   */
  video: Map<string, MediaStream>;
  cameraStreamId?: string | null;
  screenStreamId?: string | null;
  /** Cleanup for the speaking-detection loop. */
  stopAnalyser?: () => void;
}

interface SignalMessage {
  type: 'offer' | 'answer' | 'candidate' | 'media-map';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /**
   * For 'media-map': which of the sender's stream ids is the camera and which is the
   * screen. Sent over the existing peer relay rather than added to voice state, because
   * it is transport detail that only the two endpoints need, and the relay already
   * carries opaque data between exactly the right pair.
   */
  cameraStreamId?: string | null;
  screenStreamId?: string | null;
}

const peers = new Map<string, PeerEntry>();

let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let currentChannelId: string | null = null;
let selfUserId: string | null = null;
let iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS.map((s) => ({ urls: s.urls }));
let stopLocalAnalyser: (() => void) | null = null;

/** Fetch ICE configuration once per session; STUN-only unless a TURN relay is configured. */
async function loadIceServers(): Promise<void> {
  try {
    const response = await api.get<{ iceServers: RTCIceServer[] }>('/api/voice/ice-servers');
    if (response.iceServers?.length) iceServers = response.iceServers;
  } catch {
    // Fall back to the compiled-in public STUN servers.
  }
}

/* -------------------------------------------------------------------------- */
/* Speaking detection                                                          */
/* -------------------------------------------------------------------------- */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  audioContext ??= new AudioContext();
  return audioContext;
}

/**
 * Drive a "who is talking" indicator from the audio itself.
 *
 * Root-mean-square of the time-domain samples, with hysteresis: it takes a louder signal
 * to start speaking than to keep speaking. Without that, the ring around an avatar
 * flickers on every pause between words.
 */
function watchSpeaking(
  stream: MediaStream,
  onChange: (speaking: boolean) => void,
): () => void {
  let stopped = false;
  let speaking = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  try {
    const context = getAudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.fftSize);
    /** When the level first dropped below the release threshold, or 0 while loud. */
    let quietSince = 0;

    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(buffer);

      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const centred = (buffer[i]! - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / buffer.length);

      if (!speaking && rms > 0.045) {
        speaking = true;
        quietSince = 0;
        onChange(true);
      } else if (speaking && rms < 0.025) {
        /*
         * Measured in milliseconds, not ticks.
         *
         * Counting ticks assumes a fixed rate, and this loop no longer has one: a browser
         * clamps background timers to a second, which would have turned "250 ms of quiet"
         * into fifteen seconds of a stuck speaking indicator.
         */
        if (quietSince === 0) quietSince = Date.now();
        else if (Date.now() - quietSince > 250) {
          speaking = false;
          quietSince = 0;
          onChange(false);
        }
      } else if (speaking) {
        quietSince = 0;
      }
    };

    /*
     * A timer, not `requestAnimationFrame`.
     *
     * rAF is driven by frame production, so a window that is not being drawn produces no
     * frames and the callback simply stops -- which is every window while you are playing
     * a game, and exactly when the overlay needs this most. `backgroundThrottling: false`
     * does not help, because it governs timer clamping and renderer priority rather than
     * whether frames are produced at all.
     *
     * 20 Hz is far more than speech detection needs and costs a fraction of 60 Hz.
     */
    interval = setInterval(tick, 50);
  } catch {
    return () => {};
  }

  return () => {
    stopped = true;
    if (interval !== null) clearInterval(interval);
    if (speaking) onChange(false);
  };
}

/* -------------------------------------------------------------------------- */
/* Peer connections                                                            */
/* -------------------------------------------------------------------------- */

function createPeer(peerId: string, channelId: string): PeerEntry {
  const connection = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
  const stream = new MediaStream();

  // A hidden <audio> element per peer. Attaching to one shared element would mean only
  // the most recent peer is audible.
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = stream;
  applyOutputSettings(audio);

  const entry: PeerEntry = { connection, stream, audio, video: new Map() };

  for (const track of localStream?.getTracks() ?? []) {
    connection.addTrack(track, localStream!);
  }
  // Captured locally so TypeScript keeps the non-null narrowing inside the loops.
  const activeScreenStream = screenStream;
  if (activeScreenStream) {
    for (const track of activeScreenStream.getTracks()) {
      connection.addTrack(track, activeScreenStream);
    }
  }
  const activeCameraStream = cameraStream;
  if (activeCameraStream) {
    for (const track of activeCameraStream.getTracks()) {
      connection.addTrack(track, activeCameraStream);
    }
  }

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      emitVoiceSignal(peerId, channelId, {
        type: 'candidate',
        candidate: event.candidate.toJSON(),
      } satisfies SignalMessage);
    }
  };

  connection.ontrack = (event) => {
    const sourceId = event.streams[0]?.id;

    if (event.track.kind === 'video') {
      /*
       * Video is grouped by the stream it was published with, not merged into one. A peer
       * sharing their screen *and* their camera sends two video tracks down the same
       * connection, and pooling them would make it impossible to say which belongs where.
       */
      if (sourceId) {
        const existing = entry.video.get(sourceId) ?? new MediaStream();
        if (!existing.getTracks().includes(event.track)) existing.addTrack(event.track);
        entry.video.set(sourceId, existing);

        // A track ending (camera switched off) should take its tile with it.
        event.track.addEventListener('ended', () => {
          entry.video.delete(sourceId);
          useVoiceStore.getState().bumpVideo();
        });
      }
      useVoiceStore.getState().bumpVideo();
      return;
    }

    for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
      if (track.kind === 'audio' && !stream.getTracks().includes(track)) stream.addTrack(track);
    }

    if (event.track.kind === 'audio') {
      void audio.play().catch(() => {
        // Autoplay can be blocked until the user interacts with the page. Joining voice
        // is itself a click, so this is rare, but failing silently is correct.
      });

      entry.stopAnalyser?.();
      entry.stopAnalyser = watchSpeaking(stream, (speaking) =>
        useVoiceStore.getState().setSpeaking(peerId, speaking),
      );
    }
  };

  connection.onconnectionstatechange = () => {
    const state = connection.connectionState;
    useVoiceStore.getState().setPeerState(peerId, state);
    if (state === 'failed') {
      // An ICE restart recovers from a network change (wifi -> cellular) without
      // tearing down and rebuilding the whole call.
      void renegotiate(peerId, channelId, true);
    }
  };

  peers.set(peerId, entry);
  return entry;
}

/** The peer with the smaller id offers. See the glare note at the top of the file. */
function shouldInitiate(peerId: string): boolean {
  return (selfUserId ?? '') < peerId;
}

async function renegotiate(peerId: string, channelId: string, iceRestart = false): Promise<void> {
  const entry = peers.get(peerId);
  if (!entry) return;

  try {
    const offer = await entry.connection.createOffer({ iceRestart });
    await entry.connection.setLocalDescription(offer);
    emitVoiceSignal(peerId, channelId, { type: 'offer', sdp: offer } satisfies SignalMessage);
  } catch (error) {
    console.warn('[voice] renegotiation failed', error);
  }
}

/** Open a connection to a peer that just joined (or that we just joined alongside). */
export async function connectToPeer(peerId: string, channelId: string): Promise<void> {
  if (peerId === selfUserId) return;
  if (peers.has(peerId)) return;

  createPeer(peerId, channelId);
  if (shouldInitiate(peerId)) await renegotiate(peerId, channelId);

  /*
   * Tell the new peer what our video streams are, if any. Without this a latecomer
   * receives our tracks with no way to classify them, and would render a screen share in
   * a camera tile.
   */
  if (cameraStream || screenStream) {
    emitVoiceSignal(peerId, channelId, {
      type: 'media-map',
      cameraStreamId: cameraStream?.id ?? null,
      screenStreamId: screenStream?.id ?? null,
    } satisfies SignalMessage);
  }
}

/** Handle an inbound offer/answer/candidate relayed by the server. */
export async function handleVoiceSignal(payload: SignalPayload): Promise<void> {
  const { peerId, channelId } = payload;
  const message = payload.data as SignalMessage;
  if (!message?.type) return;
  if (channelId !== currentChannelId) return;

  let entry = peers.get(peerId);
  if (!entry) {
    entry = createPeer(peerId, channelId);
  }

  if (message.type === 'media-map') {
    // Which of the sender's video streams is which. Arrives independently of the tracks,
    // so it is recorded whenever it turns up and the UI re-reads on the next epoch bump.
    entry.cameraStreamId = message.cameraStreamId ?? null;
    entry.screenStreamId = message.screenStreamId ?? null;
    useVoiceStore.getState().bumpVideo();
    return;
  }

  try {
    if (message.type === 'offer' && message.sdp) {
      await entry.connection.setRemoteDescription(new RTCSessionDescription(message.sdp));
      const answer = await entry.connection.createAnswer();
      await entry.connection.setLocalDescription(answer);
      emitVoiceSignal(peerId, channelId, { type: 'answer', sdp: answer } satisfies SignalMessage);
    } else if (message.type === 'answer' && message.sdp) {
      // Ignore a stray answer when we are not expecting one; applying it would throw.
      if (entry.connection.signalingState === 'have-local-offer') {
        await entry.connection.setRemoteDescription(new RTCSessionDescription(message.sdp));
      }
    } else if (message.type === 'candidate' && message.candidate) {
      await entry.connection.addIceCandidate(new RTCIceCandidate(message.candidate));
    }
  } catch (error) {
    console.warn('[voice] failed to apply signal', message.type, error);
  }
}

export function handleVoicePeerLeft(peerId: string): void {
  const entry = peers.get(peerId);
  if (!entry) return;

  entry.stopAnalyser?.();
  entry.connection.onicecandidate = null;
  entry.connection.ontrack = null;
  entry.connection.onconnectionstatechange = null;
  entry.connection.close();

  entry.audio.pause();
  entry.audio.srcObject = null;

  peers.delete(peerId);
  useVoiceStore.getState().clearPeer(peerId);
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                           */
/* -------------------------------------------------------------------------- */

export interface JoinVoiceOptions {
  channelId: string;
  userId: string;
  /** User ids already in the channel, so we can dial them immediately. */
  existingPeerIds: string[];
}

/**
 * Acquire the microphone and open connections to everyone already present.
 * Throws a human-readable error if permission is denied or no device exists -- the UI
 * shows this text directly.
 */
export async function startVoice(options: JoinVoiceOptions): Promise<void> {
  selfUserId = options.userId;
  currentChannelId = options.channelId;

  await loadIceServers();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(),
      video: false,
    });
  } catch (error) {
    currentChannelId = null;
    const name = (error as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('Microphone access was blocked. Allow it in your browser settings.');
    }
    if (name === 'NotFoundError') {
      throw new Error('No microphone was found.');
    }
    throw new Error('Could not start your microphone.');
  }

  // Browsers suspend AudioContext until a user gesture; joining voice is one.
  void getAudioContext().resume().catch(() => {});

  stopLocalAnalyser = watchSpeaking(localStream, (speaking) =>
    useVoiceStore.getState().setSpeaking(options.userId, speaking),
  );

  for (const peerId of options.existingPeerIds) {
    await connectToPeer(peerId, options.channelId);
  }
}

export function stopVoice(): void {
  for (const peerId of [...peers.keys()]) handleVoicePeerLeft(peerId);

  stopLocalAnalyser?.();
  stopLocalAnalyser = null;

  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;

  stopScreenShare();
  stopCamera();

  currentChannelId = null;
  useVoiceStore.getState().reset();
}

/** Enable or disable the outgoing microphone track. */
/**
 * Build the `getUserMedia` audio constraints from the saved preferences.
 *
 * `deviceId` is an `ideal` rather than an `exact` constraint on purpose. A saved id goes
 * stale the moment a headset is unplugged, and `exact` turns that into an
 * `OverconstrainedError` -- failing to join voice at all because of a device that is no
 * longer there. `ideal` falls back to the system default and lets the call connect.
 */
function microphoneConstraints(): MediaTrackConstraints {
  const { inputDeviceId, echoCancellation, noiseSuppression, autoGainControl } =
    useSettingsStore.getState();

  return {
    ...(inputDeviceId ? { deviceId: { ideal: inputDeviceId } } : {}),
    echoCancellation,
    noiseSuppression,
    autoGainControl,
  };
}

/**
 * Route playback to a chosen output device.
 *
 * `setSinkId` is not in every browser's type definitions and is absent in Firefox, so it
 * is feature-detected rather than assumed. An empty id means the system default.
 */
async function routeToOutput(audio: HTMLAudioElement, deviceId: string): Promise<void> {
  const element = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof element.setSinkId !== 'function') return;
  try {
    await element.setSinkId(deviceId);
  } catch {
    // The device may have been unplugged since it was chosen. Staying on the default is
    // the right outcome, and is what the browser does anyway.
  }
}

/** Apply the saved output device and volume to one freshly created element. */
function applyOutputSettings(audio: HTMLAudioElement): void {
  const { outputDeviceId, outputVolume } = useSettingsStore.getState();
  audio.volume = outputVolume;
  if (outputDeviceId) void routeToOutput(audio, outputDeviceId);
}

/**
 * Switch microphone without dropping the call.
 *
 * `replaceTrack` swaps the outgoing track on each sender in place, so no renegotiation is
 * needed and nobody hears a gap. Reconnecting instead would be far more disruptive than
 * the change deserves.
 */
export async function setInputDevice(deviceId: string): Promise<void> {
  if (!localStream) return;

  const replacement = await navigator.mediaDevices.getUserMedia({
    audio: { ...microphoneConstraints(), ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) },
    video: false,
  });

  const [track] = replacement.getAudioTracks();
  if (!track) return;

  // Carry over the mute state, or switching devices would silently unmute you.
  const wasEnabled = localStream.getAudioTracks()[0]?.enabled ?? true;
  track.enabled = wasEnabled;

  for (const entry of peers.values()) {
    const sender = entry.connection.getSenders().find((s) => s.track?.kind === 'audio');
    if (sender) await sender.replaceTrack(track);
  }

  for (const old of localStream.getAudioTracks()) {
    localStream.removeTrack(old);
    old.stop();
  }
  localStream.addTrack(track);

  stopLocalAnalyser?.();
  stopLocalAnalyser = watchSpeaking(localStream, (speaking) =>
    useVoiceStore.getState().setSpeaking(selfUserId ?? '', speaking),
  );
}

/** Re-route every peer's audio to a different output device. */
export async function setOutputDevice(deviceId: string): Promise<void> {
  await Promise.all([...peers.values()].map((entry) => routeToOutput(entry.audio, deviceId)));
}

/** Master playback level for everyone else, 0..1. */
export function setOutputVolume(volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume));
  for (const entry of peers.values()) {
    entry.audio.volume = clamped;
  }
}

/**
 * Re-open the microphone so changed processing options take effect.
 *
 * Echo cancellation and the rest are applied by the browser at capture time and cannot be
 * toggled on a live track, so the only way to honour a change mid-call is a fresh capture
 * and a `replaceTrack`.
 */
export async function reapplyAudioProcessing(): Promise<void> {
  if (!localStream) return;
  await setInputDevice(useSettingsStore.getState().inputDeviceId);
}

export function setMicrophoneEnabled(enabled: boolean): void {
  for (const track of localStream?.getAudioTracks() ?? []) {
    track.enabled = enabled;
  }
  if (!enabled) {
    // Stop the local speaking ring immediately rather than waiting for it to decay.
    useVoiceStore.getState().setSpeaking(selfUserId ?? '', false);
  }
}

/** Deafening mutes every inbound peer, independently of their own mute state. */
export function setOutputMuted(muted: boolean): void {
  for (const entry of peers.values()) {
    entry.audio.muted = muted;
  }
}

/** Per-peer volume, 0..1. Used by the right-click volume slider on a participant. */
export function setPeerVolume(peerId: string, volume: number): void {
  const entry = peers.get(peerId);
  if (entry) entry.audio.volume = Math.max(0, Math.min(1, volume));
}

/* -------------------------------------------------------------------------- */
/* Screen sharing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Add a screen capture track to every existing peer connection and renegotiate.
 * Returns false if the user cancelled the picker.
 */
export async function startScreenShare(): Promise<boolean> {
  if (!currentChannelId) return false;

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch {
    return false; // user cancelled the picker
  }

  // Clicking the browser's own "Stop sharing" bar must update our state too.
  screenStream.getVideoTracks()[0]?.addEventListener('ended', () => {
    void stopScreenShareAndNotify();
  });

  for (const [peerId, entry] of peers) {
    for (const track of screenStream.getTracks()) {
      entry.connection.addTrack(track, screenStream);
    }
    await renegotiate(peerId, currentChannelId);
  }

  broadcastMediaMap();
  return true;
}

export function stopScreenShare(): void {
  if (!screenStream) return;

  for (const track of screenStream.getTracks()) {
    track.stop();
    for (const entry of peers.values()) {
      const sender = entry.connection.getSenders().find((s) => s.track === track);
      if (sender) entry.connection.removeTrack(sender);
    }
  }
  screenStream = null;
}

async function stopScreenShareAndNotify(): Promise<void> {
  stopScreenShare();
  useVoiceStore.getState().setStreaming(false);
  emitVoiceState({ streaming: false });
  if (!currentChannelId) return;
  for (const peerId of peers.keys()) {
    await renegotiate(peerId, currentChannelId);
  }
  broadcastMediaMap();
}

/** The remote video track of a peer who is sharing their screen, if any. */
export function getPeerVideoStream(peerId: string): MediaStream | null {
  const entry = peers.get(peerId);
  if (!entry) return null;
  return entry.stream.getVideoTracks().length > 0 ? entry.stream : null;
}

export function getLocalScreenStream(): MediaStream | null {
  return screenStream;
}

export function isInVoice(): boolean {
  return currentChannelId !== null;
}

export function currentVoiceChannelId(): string | null {
  return currentChannelId;
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Tell every peer which of our stream ids is the camera and which is the screen.
 *
 * WebRTC carries no notion of "this is a webcam". Both arrive as anonymous video tracks,
 * and with two of them the receiver has no way to lay them out correctly. The mapping
 * goes over the existing peer relay rather than through voice state: it is transport
 * detail that concerns only the two endpoints, and it must arrive alongside the tracks
 * rather than fanned out to the whole channel.
 */
function broadcastMediaMap(): void {
  if (!currentChannelId) return;
  for (const peerId of peers.keys()) {
    emitVoiceSignal(peerId, currentChannelId, {
      type: 'media-map',
      cameraStreamId: cameraStream?.id ?? null,
      screenStreamId: screenStream?.id ?? null,
    } satisfies SignalMessage);
  }
}

/**
 * Start sending camera video.
 *
 * Returns false if the user denied access or has no camera, so the caller can leave the
 * button un-toggled rather than showing an "on" state that is not.
 */
/**
 * Camera constraints, from the saved preference.
 *
 * Modest by design: this is a mesh, so each participant uploads one copy of their video
 * per other participant. 720p between four people is a lot of upstream on home wifi.
 *
 * `deviceId` is `ideal` rather than `exact`, for the same reason the microphone is: a
 * saved id goes stale when a webcam is unplugged, and `exact` would turn that into a
 * failure to start the camera at all rather than a fallback to the built-in one.
 */
function cameraConstraints(): MediaTrackConstraints {
  const { cameraDeviceId } = useSettingsStore.getState();
  return {
    ...(cameraDeviceId ? { deviceId: { ideal: cameraDeviceId } } : {}),
    width: { ideal: 640 },
    height: { ideal: 360 },
    frameRate: { ideal: 24, max: 30 },
  };
}

/**
 * Switch camera without dropping the call.
 *
 * `replaceTrack` swaps the outgoing track on each sender in place, so no renegotiation is
 * needed and nobody sees a gap -- the same approach the microphone switch uses.
 */
export async function setCameraDevice(deviceId: string): Promise<void> {
  if (!cameraStream) return;

  const replacement = await navigator.mediaDevices.getUserMedia({
    video: { ...cameraConstraints(), ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) },
    audio: false,
  });

  const [track] = replacement.getVideoTracks();
  if (!track) return;

  track.addEventListener('ended', () => {
    void stopCameraAndNotify();
  });

  for (const entry of peers.values()) {
    const sender = entry.connection.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }

  for (const old of cameraStream.getVideoTracks()) {
    cameraStream.removeTrack(old);
    old.stop();
  }
  cameraStream.addTrack(track);
  useVoiceStore.getState().bumpVideo();
}

export async function startCamera(): Promise<boolean> {
  if (!currentChannelId || cameraStream) return false;

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(),
      audio: false,
    });
  } catch {
    cameraStream = null;
    return false;
  }

  // Unplugging a webcam ends the track; treat that exactly like switching it off.
  cameraStream.getVideoTracks()[0]?.addEventListener('ended', () => {
    void stopCameraAndNotify();
  });

  for (const [peerId, entry] of peers) {
    for (const track of cameraStream.getTracks()) {
      entry.connection.addTrack(track, cameraStream);
    }
    await renegotiate(peerId, currentChannelId);
  }

  broadcastMediaMap();
  return true;
}

export function stopCamera(): void {
  if (!cameraStream) return;

  for (const track of cameraStream.getTracks()) {
    track.stop();
    for (const entry of peers.values()) {
      const sender = entry.connection.getSenders().find((s) => s.track === track);
      if (sender) entry.connection.removeTrack(sender);
    }
  }
  cameraStream = null;
}

async function stopCameraAndNotify(): Promise<void> {
  stopCamera();
  useVoiceStore.getState().setCamera(false);
  emitVoiceState({ camera: false });
  if (!currentChannelId) return;
  for (const peerId of peers.keys()) {
    await renegotiate(peerId, currentChannelId);
  }
  broadcastMediaMap();
}

/** Our own camera feed, for the self-view tile. */
export function getLocalCameraStream(): MediaStream | null {
  return cameraStream;
}

/**
 * A peer's camera feed, if they are sending one.
 *
 * Resolved through the media map rather than by guessing at track order. Before the map
 * arrives — a window of one relay hop — a peer with exactly one video stream is assumed
 * to be a camera only if they are not also screen sharing, so the common case renders
 * immediately instead of waiting.
 */
export function getPeerCameraStream(peerId: string): MediaStream | null {
  const entry = peers.get(peerId);
  if (!entry) return null;

  if (entry.cameraStreamId) return entry.video.get(entry.cameraStreamId) ?? null;
  if (entry.cameraStreamId === null) return null; // mapped, and explicitly not sending
  return null;
}

/** A peer's screen share, if they are sending one. */
export function getPeerScreenStream(peerId: string): MediaStream | null {
  const entry = peers.get(peerId);
  if (!entry) return null;

  if (entry.screenStreamId) return entry.video.get(entry.screenStreamId) ?? null;
  if (entry.screenStreamId === null) return null;

  /*
   * No map yet. Screen sharing predates cameras here and is announced through voice
   * state, so a lone video stream from a peer is overwhelmingly their screen — falling
   * back to it keeps existing behaviour intact for anyone running an older client.
   */
  const [only] = [...entry.video.values()];
  return only ?? null;
}
