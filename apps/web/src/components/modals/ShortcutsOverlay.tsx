/**
 * The keyboard shortcuts sheet, opened with Ctrl/Cmd + /.
 *
 * Shortcuts that nobody can discover are shortcuts nobody uses. This is the one place
 * they are listed, and it is itself reachable by a shortcut that is the near-universal
 * convention for exactly this.
 *
 * The list is written by hand rather than derived from the handlers. A generated list
 * would drift towards completeness — every keydown in the app — where what someone wants
 * is the handful worth memorising.
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';

/** True on macOS, where the modifier is ⌘ rather than Ctrl. */
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

const MOD = isMac ? '⌘' : 'Ctrl';

const GROUPS: { title: string; shortcuts: { keys: string[]; description: string }[] }[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: [MOD, 'K'], description: 'Jump to a channel, conversation, or server' },
      { keys: [MOD, '/'], description: 'Show this list' },
      { keys: ['Esc'], description: 'Close whatever is open' },
    ],
  },
  {
    title: 'Messages',
    shortcuts: [
      { keys: ['Enter'], description: 'Send' },
      { keys: ['Shift', 'Enter'], description: 'New line without sending' },
      { keys: ['↑'], description: 'Edit your last message' },
      { keys: ['Esc'], description: 'Cancel editing or replying' },
    ],
  },
  {
    title: 'Formatting',
    shortcuts: [
      { keys: ['**bold**'], description: 'Bold' },
      { keys: ['*italic*'], description: 'Italic' },
      { keys: ['~~strike~~'], description: 'Strikethrough' },
      { keys: ['`code`'], description: 'Inline code' },
      { keys: ['||spoiler||'], description: 'Hidden until clicked' },
    ],
  },
];

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface-4 px-1.5 py-0.5 font-mono text-[11.5px] text-ink-dim shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="max-h-[80vh] w-full max-w-[560px] overflow-y-auto rounded-panel border border-line bg-surface-2 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[16px] font-semibold text-ink">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X size={17} aria-hidden />
          </button>
        </header>

        <div className="space-y-5 px-5 py-4">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                {group.title}
              </h3>
              <ul className="space-y-1.5">
                {group.shortcuts.map((shortcut) => (
                  <li
                    key={shortcut.description}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-[13.5px] text-ink-dim">{shortcut.description}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <Key key={key}>{key}</Key>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
