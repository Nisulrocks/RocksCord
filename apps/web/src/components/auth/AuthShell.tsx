/**
 * The frame every signed-out screen sits in.
 *
 * Sign in, create account, and the two password-reset steps are the same page with
 * different contents, and they are seen back to back -- a reset ends by returning to the
 * login form. Any drift between them (a different gradient, a mark two pixels higher)
 * reads as having been thrown somewhere else, so the frame is defined once.
 */

import type { ReactNode } from 'react';

/** The RocksCord wordmark: the app icon beside the product name. */
export function RocksCordMark() {
  return (
    <div className="flex items-center gap-3">
      <img
        src="/icon-192.png"
        alt=""
        width={48}
        height={48}
        // Explicit dimensions stop the heading shifting once the image decodes.
        className="h-12 w-12 shrink-0"
      />
      <span className="text-2xl font-semibold tracking-tight text-ink">RocksCord</span>
    </div>
  );
}

interface AuthShellProps {
  /** Omitted when the panel below brings its own heading, to avoid two in a row. */
  title?: string;
  subtitle?: string;
  children: ReactNode;
}

export function AuthShell({ title, subtitle, children }: AuthShellProps) {
  return (
    <div className="relative flex h-full items-center justify-center overflow-auto bg-surface-1 px-4 py-10">
      {/* Ambient gradient wash -- purely decorative, and cheap (no blur filters). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(60rem 40rem at 15% -10%, #7c6cff22, transparent 60%),' +
            'radial-gradient(50rem 36rem at 105% 110%, #3fb6c922, transparent 60%)',
        }}
      />

      <div className="relative w-full max-w-[420px]">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <RocksCordMark />
          {title && (
            <div>
              <h1 className="text-[26px] font-semibold tracking-tight text-ink">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-ink-dim">{subtitle}</p>}
            </div>
          )}
        </div>

        {children}
      </div>
    </div>
  );
}
