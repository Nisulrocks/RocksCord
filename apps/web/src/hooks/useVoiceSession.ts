/**
 * Voice session controls.
 *
 * Bridges three things that all have to agree: the local WebRTC mesh (`lib/voice`), the
 * server's view of who is in the channel (socket events), and the UI's own state
 * (`useVoiceStore`). Components call these functions and never touch the mesh directly.
 *
 * Ordering matters when joining. The microphone is acquired *before* announcing the join,
 * so that peers who immediately start negotiating are offered a connection that already
 * has a track attached -- otherwise the first few seconds are silent while a
 * renegotiation round-trips.
 */

import { useCallback, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useUiStore } from '../store/useUiStore';
import { useVoiceStore } from '../store/useVoiceStore';
import {
  connectToPeer,
  setMicrophoneEnabled,
  setOutputMuted,
  startCamera,
  startScreenShare,
  startVoice,
  stopCamera,
  stopScreenShare,
  stopVoice,
} from '../lib/voice';
import { emitVoiceJoin, emitVoiceLeave, emitVoiceState } from '../lib/socket';

export function useVoiceSession() {
  const user = useAppStore((s) => s.user);
  const voiceParticipants = useAppStore((s) => s.voiceParticipants);
  const toast = useUiStore((s) => s.toast);

  const channelId = useVoiceStore((s) => s.channelId);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const streaming = useVoiceStore((s) => s.streaming);
  const camera = useVoiceStore((s) => s.camera);
  const connecting = useVoiceStore((s) => s.connecting);

  const store = useVoiceStore;

  const leave = useCallback(() => {
    if (!useVoiceStore.getState().channelId) return;
    emitVoiceLeave();
    stopVoice();
  }, []);

  const join = useCallback(
    async (targetChannelId: string) => {
      const state = useVoiceStore.getState();

      // Clicking the channel you are already in disconnects, which is what people expect.
      if (state.channelId === targetChannelId) {
        leave();
        return;
      }
      if (state.connecting) return;
      if (!user) return;

      if (state.channelId) leave();

      store.getState().setConnecting(true);
      store.getState().setError(null);

      try {
        const existing = (useAppStore.getState().voiceParticipants[targetChannelId] ?? [])
          .map((p) => p.userId)
          .filter((id) => id !== user.id);

        await startVoice({
          channelId: targetChannelId,
          userId: user.id,
          existingPeerIds: existing,
        });

        store.getState().setChannel(targetChannelId);
        emitVoiceJoin(targetChannelId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Could not connect to voice.';
        store.getState().setError(message);
        toast(message, 'error');
        stopVoice();
      } finally {
        store.getState().setConnecting(false);
      }
    },
    [user, leave, toast, store],
  );

  /**
   * Dial anyone who joins after us.
   *
   * Both sides run this, and both would try to offer -- which is exactly the glare case.
   * `connectToPeer` resolves it deterministically by user id, so only one side actually
   * sends an offer.
   */
  useEffect(() => {
    if (!channelId || !user) return;
    const participants = voiceParticipants[channelId] ?? [];
    for (const participant of participants) {
      if (participant.userId === user.id) continue;
      void connectToPeer(participant.userId, channelId);
    }
  }, [channelId, voiceParticipants, user]);

  /** Leave the call if the tab is closed, so we do not linger in the channel. */
  useEffect(() => {
    const onUnload = () => {
      if (useVoiceStore.getState().channelId) {
        emitVoiceLeave();
        stopVoice();
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const toggleMute = useCallback(() => {
    const state = useVoiceStore.getState();
    const next = !state.selfMute;

    // Un-muting while deafened has to also un-deafen, or the button appears to do nothing.
    const nextDeaf = next ? state.selfDeaf : false;

    state.setSelfMute(next);
    if (nextDeaf !== state.selfDeaf) state.setSelfDeaf(nextDeaf);

    setMicrophoneEnabled(!next);
    setOutputMuted(nextDeaf);
    emitVoiceState({ selfMute: next, selfDeaf: nextDeaf });
  }, []);

  const toggleDeafen = useCallback(() => {
    const state = useVoiceStore.getState();
    const next = !state.selfDeaf;

    state.setSelfDeaf(next);
    // Deafening implies muting; undeafening restores the mic unless explicitly muted.
    const nextMute = next ? true : false;
    state.setSelfMute(nextMute);

    setOutputMuted(next);
    setMicrophoneEnabled(!nextMute);
    emitVoiceState({ selfDeaf: next, selfMute: nextMute });
  }, []);

  const toggleScreenShare = useCallback(async () => {
    const state = useVoiceStore.getState();
    if (!state.channelId) return;

    if (state.streaming) {
      stopScreenShare();
      state.setStreaming(false);
      emitVoiceState({ streaming: false });
      return;
    }

    const started = await startScreenShare();
    if (started) {
      state.setStreaming(true);
      emitVoiceState({ streaming: true });
    }
  }, []);

  const toggleCamera = useCallback(async () => {
    const state = useVoiceStore.getState();
    if (!state.channelId) return;

    if (state.camera) {
      stopCamera();
      state.setCamera(false);
      emitVoiceState({ camera: false });
      return;
    }

    const started = await startCamera();
    if (started) {
      state.setCamera(true);
      emitVoiceState({ camera: true });
    } else {
      // Denied, or no camera. Leaving the flag false keeps the button honest rather than
      // showing an "on" state that is sending nothing.
      useUiStore.getState().toast('Could not start your camera', 'error');
    }
  }, []);

  return {
    channelId,
    connecting,
    selfMute,
    selfDeaf,
    streaming,
    camera,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleScreenShare,
    toggleCamera,
  };
}
