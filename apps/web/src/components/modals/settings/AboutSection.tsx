/**
 * Versions, shown at the foot of settings.
 *
 * Two numbers, because there are genuinely two things: the Electron shell compiled into
 * the installed exe, and the server the window is talking to. They move independently —
 * `git push` advances the server while every installed copy stays put — so reporting one
 * number would be wrong half the time, and "which version am I on" is usually asked when
 * something is behaving unexpectedly and the difference is the answer.
 *
 * In a browser there is no shell, so only the server line appears.
 */

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { desktopInfo, type DesktopInfo } from '../../../lib/desktop';

interface Health {
  version: string;
  database: string;
  uptimeSeconds: number;
}

/** Turn an uptime in seconds into something a person reads at a glance. */
function describeUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function AboutSection() {
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;

    void desktopInfo().then((info) => {
      if (!cancelled) setDesktop(info);
    });

    // Unauthenticated and cheap; it is the same endpoint the desktop app polls on launch.
    void api
      .get<Health>('/health')
      .then((result) => {
        if (!cancelled) setHealth(result);
      })
      .catch(() => {
        // Offline, or the server restarted mid-request. The line is simply omitted.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="border-t border-line px-5 py-3 text-[11.5px] leading-relaxed text-ink-faint">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-ink-dim">RocksCord</span>

        {desktop && (
          <span>
            App <span className="tabular-nums text-ink-dim">{desktop.version}</span>
          </span>
        )}

        {health && (
          <span>
            Server <span className="tabular-nums text-ink-dim">{health.version}</span>
            {health.uptimeSeconds > 0 && ` · up ${describeUptime(health.uptimeSeconds)}`}
          </span>
        )}

        {desktop && (
          <span className="truncate">
            {desktop.mode === 'remote' ? desktop.remoteUrl : 'Built-in server'}
          </span>
        )}
      </div>

      {desktop && (
        <p className="mt-1">
          Updates install themselves on launch. Check manually from{' '}
          <span className="text-ink-dim">Help → Check for updates</span>.
        </p>
      )}
    </div>
  );
}
