/**
 * "Alex is typing…" strip above the composer.
 *
 * Occupies a fixed-height row whether or not anyone is typing, so the composer never
 * shifts up and down while people type — a jumping input is far more distracting than a
 * few pixels of empty space.
 */

import { EMPTY_ARRAY, useAppStore } from '../../store/useAppStore';

export function TypingRow({ channelId }: { channelId: string }) {
  const entries = useAppStore((s) => s.typing[channelId] ?? EMPTY_ARRAY);
  const myId = useAppStore((s) => s.user?.id);

  const others = entries.filter((entry) => entry.userId !== myId);

  const label = (() => {
    if (others.length === 0) return null;
    if (others.length === 1) return `${others[0]!.username} is typing…`;
    if (others.length === 2) {
      return `${others[0]!.username} and ${others[1]!.username} are typing…`;
    }
    if (others.length === 3) {
      return `${others[0]!.username}, ${others[1]!.username}, and ${others[2]!.username} are typing…`;
    }
    return 'Several people are typing…';
  })();

  return (
    <div className="h-6 shrink-0 px-5" aria-live="polite">
      {label && (
        <div className="animate-fade-in flex items-center gap-1.5 text-[13px] text-ink-dim">
          <span className="flex items-end gap-[3px] pb-[3px]" aria-hidden>
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="block h-[5px] w-[5px] rounded-full bg-ink-dim"
                style={{
                  animation: 'rockscord-typing-dot 1.15s ease-in-out infinite',
                  animationDelay: `${index * 0.16}s`,
                }}
              />
            ))}
          </span>
          <span className="truncate">{label}</span>
        </div>
      )}
    </div>
  );
}
