/**
 * Appearance settings.
 *
 * The theme is stored on the device rather than the account, deliberately: people choose
 * light on a bright screen and dark on a dim one, often on the same account, so syncing it
 * would fight the user rather than help them.
 */

import { Check, Monitor, Moon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { useUiStore } from '../../../store/useUiStore';
import { useSettingsStore, type ThemePreference } from '../../../store/useSettingsStore';
import { Toggle } from '../../ui/primitives';

const THEMES: {
  value: ThemePreference;
  label: string;
  hint: string;
  Icon: typeof Sun;
}[] = [
  { value: 'dark', label: 'Dark', hint: 'The default', Icon: Moon },
  { value: 'light', label: 'Light', hint: 'Same palette, inverted', Icon: Sun },
  { value: 'system', label: 'System', hint: 'Follow your OS', Icon: Monitor },
];

export function AppearanceTab() {
  const memberListOpen = useUiStore((s) => s.memberListOpen);
  const toggleMemberList = useUiStore((s) => s.toggleMemberList);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="space-y-5">
      <section>
        <h4 className="text-[14px] font-semibold text-ink">Theme</h4>
        <p className="mt-1 text-[13px] text-ink-dim">
          Applies immediately, and only on this device.
        </p>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {THEMES.map(({ value, label, hint, Icon }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                aria-pressed={active}
                className={clsx(
                  'relative flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors',
                  active
                    ? 'border-accent bg-accent-wash text-ink'
                    : 'border-line bg-surface-3 text-ink-dim hover:border-line-strong hover:text-ink',
                )}
              >
                {active && (
                  <Check size={13} aria-hidden className="absolute right-2 top-2 text-accent-soft" />
                )}
                <Icon size={19} aria-hidden />
                <span className="text-[13px] font-medium">{label}</span>
                <span className="text-[11.5px] leading-tight text-ink-faint">{hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <Toggle
        checked={memberListOpen}
        onChange={toggleMemberList}
        label="Show the member list"
        description="Hide it to give the conversation more room."
      />
    </div>
  );
}
