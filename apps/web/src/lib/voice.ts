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
import { emitVoiceSignal } from './socket';
import { useVoiceStore } from '../store/useVoiceStore';

interface PeerEntry {
  connection: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  /** Cleanup for the speaking-detection loop. */
  stopAnalyser?: () => void;
}

interface SignalMessage {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

const peers = new Map<string, PeerEntry>();

let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
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

  try {
    const context = getAudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.fftSize);
    let quietFrames = 0;

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
        quietFrames = 0;
        onChange(true);
      } else if (speaking && rms < 0.025) {
        quietFrames += 1;
        // ~250 ms of quiet before we call it silence.
        if (quietFrames > 15) {
          speaking = false;
          onChange(false);
        }
      } else if (speaking) {
        quietFrames = 0;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  } catch {
    return () => {};
  }

  return () => {
    stopped = true;
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

  const entry: PeerEntry = { connection, stream, audio };

  for (const track of localStream?.getTracks() ?? []) {
    connection.addTrack(track, localStream!);
  }
  // Captured locally so TypeScript keeps the non-null narrowing inside the loop.
  const activeScreenStream = screenStream;
  if (activeScreenStream) {
    for (const track of activeScreenStream.getTracks()) {
      connection.addTrack(track, activeScreenStream);
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
    for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
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
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
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

  currentChannelId = null;
  useVoiceStore.getState().reset();
}

/** Enable or disable the outgoing microphone track. */
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
  if (!currentChannelId) return;
  for (const peerId of peers.keys()) {
    await renegotiate(peerId, currentChannelId);
  }
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
