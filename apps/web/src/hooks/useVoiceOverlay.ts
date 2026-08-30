/**
 * Feed the desktop voice overlay.
 *
 * The overlay is a separate, chrome-less window with no session and no socket. It is fed
 * from here because *speaking* only exists in this renderer: it is derived from analysing
 * the WebRTC audio, so a window with its own connection could learn who is in a call but
 * never who is talking, which is the whole point of an overlay.
 *
 * **Deliberately not driven by rendering.** The overlay's entire job is to work while this
 * window is buried behind a game, and a buried window is one Chromium is free to stop
 * drawing. Anything that waits on a render -- a reactive selector, an effect -- can be
 * deferred exactly when the overlay is needed, so this subscribes to the stores directly
 * and pushes from the subscription callback. React is not in the loop at all.
 *
 * A no-op in a browser. The bridge functions swallow that themselves.
 */

import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { resolveAssetUrl } from '../lib/api';
import { pushOverlaySettings, pushOverlayState, type OverlayParticipant } from '../lib/desktop';

/** Build the overlay's view of the call from current store state. */
function currentParticipants(): OverlayParticipant[] {
  const { overlay } = useSettingsStore.getState();
  const { channelId, speaking } = useVoiceStore.getState();

  // Not in a call: an empty list is what tells the overlay to take itself off screen.
  if (!overlay.enabled || !channelId) return [];

  const participants = useAppStore.getState().voiceParticipants[channelId] ?? [];

  return participants.map((person) => ({
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
}

export function useVoiceOverlay(): void {
  useEffect(() => {
    let lastState = '';
    let lastSettings = '';

    const sync = () => {
      const settings = useSettingsStore.getState().overlay;
      const encodedSettings = JSON.stringify(settings);
      if (encodedSettings !== lastSettings) {
        lastSettings = encodedSettings;
        pushOverlaySettings(settings);
      }

      /*
       * Only send when something differs. Speaking changes many times while anyone is
       * talking, and each send is an IPC hop ending in a DOM update in another window --
       * so this is kept to the transitions that are actually visible.
       */
      const participants = currentParticipants();
      const encoded = JSON.stringify(participants);
      if (encoded !== lastState) {
        lastState = encoded;
        pushOverlayState(participants);
      }
    };

    sync();

    // Three stores, because a change in any of them can alter what the overlay shows:
    // who is in the call, who is talking, and how it is configured.
    const unsubscribers = [
      useVoiceStore.subscribe(sync),
      useAppStore.subscribe(sync),
      useSettingsStore.subscribe(sync),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, []);
}
