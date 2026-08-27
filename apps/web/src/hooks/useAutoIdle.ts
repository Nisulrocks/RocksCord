/**
 * Go idle at the keyboard, come back on activity.
 *
 * The status picker describes Idle as "around, but not at the keyboard" — a claim only
 * this makes true. Without it the label is aspirational, and everyone who walks away for
 * lunch stays green.
 *
 * Two rules keep it from being annoying, and both matter more than the feature itself:
 *
 *  1. **It only ever acts on "online".** Someone on Do Not Disturb is making a request of
 *     everyone else, and quietly demoting that to Idle would undermine it. Invisible is
 *     likewise a decision, not a default.
 *  2. **It only reverses its own change.** If you deliberately set yourself to Idle, a
 *     mouse movement must not shove you back to Online. That is why the socket layer
 *     tracks *chosen* status separately from an applied one.
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { getChosenStatus, setAutoPresenceStatus } from '../lib/socket';

/** How long without input counts as away. Discord uses roughly this. */
const IDLE_AFTER_MS = 5 * 60 * 1000;

/**
 * Activity signals. `visibilitychange` is included because switching to another
 * application is the most honest "not at the keyboard" signal a browser gets, and
 * `pointermove` covers mouse, pen, and touch in one listener.
 */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function useAutoIdle(): void {
  const userId = useAppStore((s) => s.user?.id);
  const presence = useAppStore((s) => (s.user ? s.presence[s.user.id] : undefined));

  /** True while the idle state on the server was put there by this hook. */
  const selfApplied = useRef(false);
  /** Read inside listeners without making them a dependency. */
  const statusRef = useRef(presence?.status);
  statusRef.current = presence?.status;

  useEffect(() => {
    if (!userId) return;

    let timer: number | null = null;

    const goIdle = () => {
      /*
       * Re-checked at the moment of firing rather than when the timer was set: five
       * minutes is long enough for the user to have chosen Do Not Disturb in between.
       */
      const chosen = getChosenStatus() ?? statusRef.current ?? 'online';
      if (chosen !== 'online' || statusRef.current !== 'online') return;

      selfApplied.current = true;
      setAutoPresenceStatus('idle');
    };

    const onActivity = () => {
      if (selfApplied.current) {
        selfApplied.current = false;
        // Only undo what this hook did. A status chosen while idle wins and is left alone.
        if (statusRef.current === 'idle') setAutoPresenceStatus('online');
      }

      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(goIdle, IDLE_AFTER_MS);
    };

    const onVisibility = () => {
      // Returning to the tab is activity; leaving it is not immediately idleness, since
      // people glance at other windows constantly. The timer decides.
      if (document.visibilityState === 'visible') onActivity();
    };

    for (const event of ACTIVITY_EVENTS) {
      // Passive: none of these are cancelled, and saying so keeps scrolling smooth.
      window.addEventListener(event, onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);

    // Start the clock, so an app left open untouched still goes idle.
    timer = window.setTimeout(goIdle, IDLE_AFTER_MS);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [userId]);
}
