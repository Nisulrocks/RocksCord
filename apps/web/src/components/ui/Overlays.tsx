/**
 * Global overlays: the right-click context menu and the toast stack.
 *
 * Both are rendered once at the root and driven from `useUiStore`, so any component can
 * raise one by calling a store action rather than owning portal state of its own.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useUiStore } from '../../store/useUiStore';

/* -------------------------------------------------------------------------- */
/* Context menu                                                                */
/* -------------------------------------------------------------------------- */

export function ContextMenu() {
  const menu = useUiStore((s) => s.contextMenu);
  const close = useUiStore((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Measure after paint and nudge the menu back on-screen if it would overflow. Doing
  // this in useLayoutEffect avoids a visible one-frame jump.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.min(menu.x, window.innerWidth - rect.width - margin),
      y: Math.min(menu.y, window.innerHeight - rect.height - margin),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    // `true` so a scroll inside any container also dismisses, matching OS behaviour.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu, close]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={clsx(
        'animate-pop-in fixed z-[60] min-w-[190px] overflow-hidden rounded-lg',
        'border border-line-strong bg-surface-4 p-1 shadow-pop',
      )}
      style={{ left: position.x, top: position.y }}
    >
      {menu.items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          {item.separated && index > 0 && <div className="my-1 h-px bg-line" />}
          <button
            role="menuitem"
            onClick={() => {
              close();
              item.onSelect();
            }}
            className={clsx(
              'flex w-full items-center rounded px-2.5 py-1.5 text-left text-[13px] transition-colors',
              item.danger
                ? 'text-danger hover:bg-danger hover:text-white'
                : 'text-ink-dim hover:bg-accent hover:text-white',
            )}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

const TOAST_ICON = {
  info: Info,
  success: CheckCircle2,
  error: XCircle,
} as const;

const TOAST_TONE = {
  info: 'border-line-strong text-ink',
  success: 'border-online/40 text-ink',
  error: 'border-danger/50 text-ink',
} as const;

const TOAST_ICON_TONE = {
  info: 'text-accent-soft',
  success: 'text-online',
  error: 'text-danger',
} as const;

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const Icon = TOAST_ICON[toast.tone];
        return (
          <button
            key={toast.id}
            onClick={() => dismiss(toast.id)}
            className={clsx(
              'animate-pop-in pointer-events-auto flex max-w-md items-center gap-2.5',
              'rounded-lg border bg-surface-4 px-3.5 py-2.5 text-left text-sm shadow-pop',
              TOAST_TONE[toast.tone],
            )}
          >
            <Icon size={16} className={clsx('shrink-0', TOAST_ICON_TONE[toast.tone])} />
            <span className="min-w-0">{toast.message}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
