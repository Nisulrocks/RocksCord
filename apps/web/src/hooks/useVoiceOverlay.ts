/**
 * Feed the desktop voice overlay.
 *
 * The overlay is a separate, chrome-less window with no session and no socket. It is fed
 * from here because *speaking* only exists in this renderer: it is derived from analysing
 * the WebRTC audio, so a window with its own connection could learn who is in a call but
 * never who is talking, which is the whole point of an overlay.
 *
 * A no-op in a browser. The bridge functions swallow that themselves, so this runs
 * unconditionally rather than branching on the platform.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { resolveAssetUrl } from '../lib/api';
import { pushOverlaySettings, pushOverlayState, type OverlayParticipant } from '../lib/desktop';

export function useVoiceOverlay(): void {
  const overlay = useSettingsStore((s) => s.overlay);
  const channelId = useVoiceStore((s) => s.channelId);
  const speaking = useVoiceStore((s) => s.speaking);
  const voiceParticipants = useAppStore((s) => s.voiceParticipants);

  // Settings are small and change rarely, so they go across whenever they change.
  useEffect(() => {
    pushOverlaySettings(overlay);
  }, [overlay]);

  const participants = useMemo<OverlayParticipant[]>(() => {
    // Not in a call: an empty list is what tells the overlay to take itself off screen.
    if (!overlay.enabled || !channelId) return [];

    return (voiceParticipants[channelId] ?? []).map((person) => ({
      userId: person.userId,
      name: person.user.displayName,
      /*
       * Absolute, because the overlay is a `file://` page. A relative `/uploads/...` would
       * resolve against the filesystem there and silently render nothing.
       */
      avatarUrl: resolveAssetUrl(person.user.avatarUrl),
      speaking: Boolean(speaking[person.userId]) && !person.selfMute && !person.serverMute,
      muted: person.selfMute || person.serverMute,
      deafened: person.selfDeaf || person.serverDeaf,
    }));
  }, [overlay.enabled, channelId, voiceParticipants, speaking]);

  /*
   * Only send when something actually differs.
   *
   * `speaking` updates many times a second while anyone is talking, and each send is an
   * IPC round trip that ends in a DOM update in another window. Comparing the serialised
   * payload keeps that to the transitions that are visible -- someone starting or stopping
   * -- rather than every animation frame of the audio meter.
   */
  const lastSent = useRef<string>('');

  useEffect(() => {
    const encoded = JSON.stringify(participants);
    if (encoded === lastSent.current) return;
    lastSent.current = encoded;
    pushOverlayState(participants);
  }, [participants]);
}
