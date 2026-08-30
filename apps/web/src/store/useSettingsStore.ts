/**
 * Preferences that belong to this device rather than to the account.
 *
 * Theme and audio hardware are deliberately *not* stored on the server. Which microphone
 * you use is a fact about the machine you are sitting at, not about who you are — syncing
 * it would mean signing in on a laptop and having it try to use a desktop's headset. The
 * same argument applies to the theme: people pick light on a bright screen and dark on a
 * dim one, on the same account.
 *
 * Persistence is `localStorage` via zustand's own middleware. Values are validated on the
 * way back in, because this is the one input the app cannot control: a user can edit it,
 * and an older build may have written a shape that no longer exists.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { OverlaySettings } from '../lib/desktop';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export interface SettingsState {
  theme: ThemePreference;

  /**
   * Device ids from `enumerateDevices`. An empty string means "whatever the system
   * chooses", which is different from a real id and is the right default: an explicit id
   * goes stale the moment a headset is unplugged.
   */
  inputDeviceId: string;
  outputDeviceId: string;
  /** Which camera to send. Empty means whatever the system picks. */
  cameraDeviceId: string;

  /** Playback level for everyone else, 0–1. */
  outputVolume: number;

  /** Whether notifications make a sound. */
  notificationSounds: boolean;

  /**
   * The in-game voice overlay. Desktop only; the browser ignores it entirely.
   *
   * Device-local for the same reason the microphone is: an overlay position is a fact
   * about the screen you are sitting at, not about who you are.
   */
  overlay: OverlaySettings;

  /* Browser-side audio processing, applied when the microphone is opened. */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;

  setTheme: (theme: ThemePreference) => void;
  setInputDeviceId: (id: string) => void;
  setOutputDeviceId: (id: string) => void;
  setCameraDeviceId: (id: string) => void;
  setOutputVolume: (volume: number) => void;
  setNotificationSounds: (enabled: boolean) => void;
  setOverlay: (patch: Partial<OverlaySettings>) => void;
  setAudioProcessing: (
    key: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl',
    value: boolean,
  ) => void;
}

const DEFAULTS = {
  theme: 'dark' as ThemePreference,
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  outputVolume: 1,
  notificationSounds: true,
  overlay: {
    enabled: false,
    position: 'top-left',
    scale: 1,
    opacity: 0.95,
    showWhen: 'always',
  } as OverlaySettings,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const clampRange = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,

      setTheme: (theme) => set({ theme }),
      setInputDeviceId: (inputDeviceId) => set({ inputDeviceId }),
      setOutputDeviceId: (outputDeviceId) => set({ outputDeviceId }),
      setCameraDeviceId: (cameraDeviceId) => set({ cameraDeviceId }),
      setOutputVolume: (outputVolume) => set({ outputVolume: clamp01(outputVolume) }),
      setNotificationSounds: (notificationSounds) => set({ notificationSounds }),
      setOverlay: (patch) => set((state) => ({ overlay: { ...state.overlay, ...patch } })),
      setAudioProcessing: (key, value) => set({ [key]: value } as Partial<SettingsState>),
    }),
    {
      name: 'rockscord.settings',
      version: 1,
      /**
       * Re-validate everything that comes back off disk.
       *
       * A missing key means an older build; a wrong type means someone edited it by hand.
       * Either way the fix is the same, and falling back per-field keeps the rest of the
       * preferences rather than resetting all of them over one bad value.
       */
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>;

        const theme: ThemePreference =
          saved.theme === 'light' || saved.theme === 'dark' || saved.theme === 'system'
            ? saved.theme
            : DEFAULTS.theme;

        const text = (value: unknown, fallback: string) =>
          typeof value === 'string' ? value : fallback;
        const flag = (value: unknown, fallback: boolean) =>
          typeof value === 'boolean' ? value : fallback;

        return {
          ...current,
          theme,
          inputDeviceId: text(saved.inputDeviceId, DEFAULTS.inputDeviceId),
          outputDeviceId: text(saved.outputDeviceId, DEFAULTS.outputDeviceId),
          cameraDeviceId: text(saved.cameraDeviceId, DEFAULTS.cameraDeviceId),
          outputVolume:
            typeof saved.outputVolume === 'number' && Number.isFinite(saved.outputVolume)
              ? clamp01(saved.outputVolume)
              : DEFAULTS.outputVolume,
          notificationSounds: flag(saved.notificationSounds, DEFAULTS.notificationSounds),
          /*
           * Field by field, because this shape grew after people already had settings
           * stored: a saved object from an older build is missing keys the app now reads,
           * and spreading it wholesale would leave those undefined rather than defaulted.
           */
          overlay: {
            enabled: flag(saved.overlay?.enabled, DEFAULTS.overlay.enabled),
            position:
              saved.overlay?.position === 'top-right' ||
              saved.overlay?.position === 'bottom-left' ||
              saved.overlay?.position === 'bottom-right' ||
              saved.overlay?.position === 'top-left'
                ? saved.overlay.position
                : DEFAULTS.overlay.position,
            scale: clampRange(saved.overlay?.scale, 0.8, 1.4, DEFAULTS.overlay.scale),
            opacity: clampRange(saved.overlay?.opacity, 0.3, 1, DEFAULTS.overlay.opacity),
            showWhen: saved.overlay?.showWhen === 'speaking' ? 'speaking' : 'always',
          },
          echoCancellation: flag(saved.echoCancellation, DEFAULTS.echoCancellation),
          noiseSuppression: flag(saved.noiseSuppression, DEFAULTS.noiseSuppression),
          autoGainControl: flag(saved.autoGainControl, DEFAULTS.autoGainControl),
        };
      },
    },
  ),
);

/* -------------------------------------------------------------------------- */
/* Theme                                                                       */
/* -------------------------------------------------------------------------- */

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

export function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia(SYSTEM_DARK).matches
    ? 'dark'
    : 'light';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

/**
 * Write the resolved theme onto the document.
 *
 * Only `light` sets the attribute. Dark is the bare `:root`, so the default costs no
 * override and a failure to run this at all leaves the app in its intended palette rather
 * than an unstyled one.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  if (resolved === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

/**
 * Keep the document in sync with the preference, following the OS while set to `system`.
 * Returns an unsubscribe function.
 */
export function watchTheme(): () => void {
  const media = window.matchMedia(SYSTEM_DARK);

  const sync = () => applyTheme(resolveTheme(useSettingsStore.getState().theme));

  sync();
  const unsubscribe = useSettingsStore.subscribe(sync);
  media.addEventListener('change', sync);

  return () => {
    unsubscribe();
    media.removeEventListener('change', sync);
  };
}
