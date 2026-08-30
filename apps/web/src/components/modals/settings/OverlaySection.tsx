/**
 * The in-game voice overlay, in settings.
 *
 * Desktop only, and it says so rather than showing controls that quietly do nothing: the
 * whole feature is an always-on-top native window, which a browser tab has no way to
 * produce. In a browser this renders one explanatory line and stops.
 */

import clsx from 'clsx';
import { Monitor } from 'lucide-react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { isDesktop, type OverlaySettings } from '../../../lib/desktop';
import { Toggle } from '../../ui/primitives';

const POSITIONS: { value: OverlaySettings['position']; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

/** A labelled range that shows its current value, since a bare slider says nothing. */
function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className={clsx('block', disabled && 'opacity-50')}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        <span className="text-[12px] tabular-nums text-ink-dim">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent"
      />
    </label>
  );
}

export function OverlaySection() {
  const overlay = useSettingsStore((s) => s.overlay);
  const setOverlay = useSettingsStore((s) => s.setOverlay);

  if (!isDesktop()) {
    return (
      <section className="rounded-lg border border-line bg-surface-3 p-4">
        <h4 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <Monitor size={16} aria-hidden />
          Voice overlay
        </h4>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">
          A small panel showing who is in your call and who is talking, floating over
          whatever else is on screen. It needs a window of its own that sits above other
          applications, which only the desktop app can create &mdash; so it is not available
          in a browser tab.
        </p>
      </section>
    );
  }

  const off = !overlay.enabled;

  return (
    <section className="space-y-3">
      <h4 className="text-[14px] font-semibold text-ink">Voice overlay</h4>

      <Toggle
        checked={overlay.enabled}
        onChange={(enabled) => setOverlay({ enabled })}
        label="Show the overlay during calls"
        description="A small panel over your other windows showing who is in the call and who is speaking."
      />

      <div className={clsx('space-y-4 rounded-lg border border-line bg-surface-3 p-4')}>
        <div className={clsx(off && 'opacity-50')}>
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">
            Corner
          </span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {POSITIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={off}
                onClick={() => setOverlay({ position: option.value })}
                aria-pressed={overlay.position === option.value}
                className={clsx(
                  'rounded-md border px-3 py-2 text-[13px] transition-colors',
                  overlay.position === option.value
                    ? 'border-accent bg-accent-wash text-ink'
                    : 'border-line bg-surface-2 text-ink-dim hover:border-line-strong hover:text-ink',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <Range
          label="Size"
          value={overlay.scale}
          min={0.8}
          max={1.4}
          step={0.05}
          disabled={off}
          format={(value) => `${Math.round(value * 100)}%`}
          onChange={(scale) => setOverlay({ scale })}
        />

        <Range
          label="Opacity"
          value={overlay.opacity}
          min={0.3}
          max={1}
          step={0.05}
          disabled={off}
          format={(value) => `${Math.round(value * 100)}%`}
          onChange={(opacity) => setOverlay({ opacity })}
        />

        <div className={clsx(off && 'opacity-50')}>
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">
            Show it
          </span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(
              [
                { value: 'always', label: 'Whole call', hint: 'Visible while connected' },
                { value: 'speaking', label: 'Only when talking', hint: 'Appears as people speak' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={off}
                onClick={() => setOverlay({ showWhen: option.value })}
                aria-pressed={overlay.showWhen === option.value}
                className={clsx(
                  'rounded-md border px-3 py-2 text-left transition-colors',
                  overlay.showWhen === option.value
                    ? 'border-accent bg-accent-wash text-ink'
                    : 'border-line bg-surface-2 text-ink-dim hover:border-line-strong hover:text-ink',
                )}
              >
                <span className="block text-[13px] font-medium">{option.label}</span>
                <span className="block text-[11.5px] leading-tight text-ink-faint">
                  {option.hint}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[12.5px] leading-relaxed text-ink-faint">
        The overlay floats above your other windows and ignores clicks entirely, so it can
        never swallow one mid-game. It cannot draw over a game running in exclusive
        fullscreen &mdash; that needs hooking the game&rsquo;s own renderer, which this does
        not do. Borderless or windowed mode works, and is what most games default to.
      </p>
    </section>
  );
}
