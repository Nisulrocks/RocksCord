/**
 * Connection status strip.
 *
 * Only appears when the socket is down. It waits a moment before showing, because a
 * momentary blip during a normal reconnect is not worth alarming anyone about — a banner
 * that flashes on every brief hiccup trains people to ignore it.
 */

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

/** Grace period before a disconnect is worth mentioning. */
const GRACE_MS = 2500;

export function ConnectionBanner() {
  const connected = useAppStore((s) => s.connected);
  const hydrated = useAppStore((s) => s.hydrated);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (connected || !hydrated) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [connected, hydrated]);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 bg-idle px-4 py-1.5 text-[13px] font-medium text-surface-0"
    >
      <WifiOff size={14} />
      Reconnecting… messages you send will be queued until the connection is back.
    </div>
  );
}
