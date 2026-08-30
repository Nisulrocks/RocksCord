/**
 * Modal dialog.
 *
 * Behaviour that a `<div>` with `position: fixed` would not give you, and that people
 * notice immediately when it is missing:
 *  - Escape closes it
 *  - clicking the backdrop closes it, but a drag that *ends* on the backdrop does not
 *    (otherwise selecting text and releasing outside dismisses your work)
 *  - focus moves into the dialog on open and returns to the trigger on close
 *  - Tab is trapped inside while it is open
 *  - the page behind cannot scroll
 */

import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { IconButton } from './primitives';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  /** Hide the close button, e.g. while an operation is mid-flight. */
  hideClose?: boolean;
}

const WIDTHS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
  xl: 'max-w-3xl',
} as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
  hideClose,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** Where the mouse went *down*; a drag out of the panel must not close the modal. */
  const pressStartedOnBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first meaningful control, not the close button, so typing starts where
    // the user expects.
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const candidates = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const target =
        candidates.find((el) => !el.hasAttribute('data-modal-close')) ?? candidates[0];
      /*
       * `preventScroll` so focusing does not also scroll.
       *
       * A modal taller than the window opens scrolled to wherever its first control
       * happens to be, which for anything with the button at the end means opening part
       * way down and skipping the beginning of whatever it was there to say. Focus still
       * lands correctly for the keyboard and for screen readers; only the scrolling is
       * suppressed.
       */
      target?.focus({ preventScroll: true });
    }, 10);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!open) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      // Wrap focus so Tab never escapes into the page behind the dialog.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [open, onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, handleKeyDown]);

  if (!open) return null;

  const onBackdropMouseDown = (event: ReactMouseEvent) => {
    pressStartedOnBackdrop.current = event.target === event.currentTarget;
  };

  const onBackdropMouseUp = (event: ReactMouseEvent) => {
    if (pressStartedOnBackdrop.current && event.target === event.currentTarget) {
      onClose();
    }
    pressStartedOnBackdrop.current = false;
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
      onMouseDown={onBackdropMouseDown}
      onMouseUp={onBackdropMouseUp}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'animate-pop-in flex max-h-[85vh] w-full flex-col overflow-hidden',
          'rounded-panel border border-line bg-surface-2 shadow-pop',
          WIDTHS[width],
        )}
      >
        {(title || !hideClose) && (
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              {title && <h2 className="truncate text-lg font-semibold text-ink">{title}</h2>}
              {subtitle && (
                <p className="mt-0.5 text-[13px] leading-snug text-ink-dim">{subtitle}</p>
              )}
            </div>
            {!hideClose && (
              <IconButton
                label="Close"
                onClick={onClose}
                data-modal-close
                className="-mr-1 -mt-1 shrink-0"
              >
                <X size={18} />
              </IconButton>
            )}
          </header>
        )}

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-1 px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
