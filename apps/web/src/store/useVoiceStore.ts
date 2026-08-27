/**
 * Local voice session state.
 *
 * Kept separate from the main app store because it updates at a very different rate: the
 * speaking indicator changes many times per second, and every one of those writes would
 * otherwise re-render components subscribed to unrelated slices of the app store.
 *
 * This is *my* view of the call. Who else is in the channel comes from the server and
 * lives in `useAppStore.voiceParticipants`.
 */

import { create } from 'zustand';

export type PeerConnectionState = RTCPeerConnectionState;

interface VoiceState {
  /** The voice channel I am in, or null. */
  channelId: string | null;
  /** True between clicking join and the microphone actually being live. */
  connecting: boolean;
  /** Human-readable failure, shown in the voice panel. */
  error: string | null;

  selfMute: boolean;
  selfDeaf: boolean;
  streaming: boolean;
  /** True while sending camera video. Independent of `streaming`. */
  camera: boolean;

  /**
   * Bumped whenever an inbound video track appears or ends.
   *
   * The streams themselves live in a module-level map in `lib/voice`, because a
   * MediaStream is a mutable handle rather than a value and putting it in the store would
   * mean components re-rendering on identity changes that mean nothing. This counter is
   * the one bit React actually needs: "something about video changed, read it again."
   */
  videoEpoch: number;

  /** userId -> currently talking. Includes me. */
  speaking: Record<string, boolean>;
  /** userId -> ICE connection state, used to show "connecting"/"failed" per peer. */
  peerStates: Record<string, PeerConnectionState>;
  /** userId -> playback volume 0..1. */
  volumes: Record<string, number>;

  /** The peer whose screen share is being watched full-size, if any. */
  watching: string | null;

  setChannel: (channelId: string | null) => void;
  setConnecting: (connecting: boolean) => void;
  setError: (error: string | null) => void;
  setSelfMute: (muted: boolean) => void;
  setSelfDeaf: (deafened: boolean) => void;
  setStreaming: (streaming: boolean) => void;
  setCamera: (camera: boolean) => void;
  bumpVideo: () => void;
  setSpeaking: (userId: string, speaking: boolean) => void;
  setPeerState: (userId: string, state: PeerConnectionState) => void;
  setVolume: (userId: string, volume: number) => void;
  setWatching: (userId: string | null) => void;
  clearPeer: (userId: string) => void;
  reset: () => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  channelId: null,
  connecting: false,
  error: null,
  selfMute: false,
  selfDeaf: false,
  streaming: false,
  camera: false,
  videoEpoch: 0,
  speaking: {},
  peerStates: {},
  volumes: {},
  watching: null,

  setChannel: (channelId) => set({ channelId }),
  setConnecting: (connecting) => set({ connecting }),
  setError: (error) => set({ error }),
  setSelfMute: (selfMute) => set({ selfMute }),

  setSelfDeaf: (selfDeaf) =>
    // Deafening implies muting, matching the server-side rule so the two cannot disagree.
    set((state) => ({ selfDeaf, selfMute: selfDeaf ? true : state.selfMute })),

  setStreaming: (streaming) => set({ streaming }),
  setCamera: (camera) => set({ camera }),
  bumpVideo: () => set((state) => ({ videoEpoch: state.videoEpoch + 1 })),

  setSpeaking: (userId, speaking) =>
    set((state) => {
      if (!userId) return {};
      // Guard against redundant writes: this is called from an animation frame loop.
      if (Boolean(state.speaking[userId]) === speaking) return {};
      return { speaking: { ...state.speaking, [userId]: speaking } };
    }),

  setPeerState: (userId, peerState) =>
    set((state) => {
      if (state.peerStates[userId] === peerState) return {};
      return { peerStates: { ...state.peerStates, [userId]: peerState } };
    }),

  setVolume: (userId, volume) =>
    set((state) => ({ volumes: { ...state.volumes, [userId]: volume } })),

  setWatching: (watching) => set({ watching }),

  clearPeer: (userId) =>
    set((state) => {
      const speaking = { ...state.speaking };
      const peerStates = { ...state.peerStates };
      delete speaking[userId];
      delete peerStates[userId];
      return {
        speaking,
        peerStates,
        watching: state.watching === userId ? null : state.watching,
      };
    }),

  reset: () =>
    set({
      channelId: null,
      connecting: false,
      error: null,
      selfMute: false,
      selfDeaf: false,
      streaming: false,
  camera: false,
  videoEpoch: 0,
      speaking: {},
      peerStates: {},
      watching: null,
    }),
}));
