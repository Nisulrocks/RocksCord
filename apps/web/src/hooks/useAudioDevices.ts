/**
 * The list of microphones and speakers the browser will admit to.
 *
 * Two quirks shape this hook, and both are privacy features rather than bugs:
 *
 *  1. **Labels are hidden until permission is granted.** Before that, `enumerateDevices`
 *     returns the right *number* of entries with empty `label` strings, so a picker built
 *     naively shows a list of blanks. The fix is to ask for the microphone once; the
 *     labels appear for the rest of the session.
 *  2. **Output devices are not listed at all in some browsers.** Firefox does not expose
 *     `audiooutput`, and `setSinkId` does not exist there either, so the speaker picker
 *     has to degrade rather than appear broken.
 *
 * Devices are re-read on `devicechange`, so plugging in a headset updates the list without
 * reopening settings.
 */

import { useCallback, useEffect, useState } from 'react';

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export interface AudioDevices {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** False while labels are still hidden, i.e. microphone permission has never been given. */
  labelled: boolean;
  /** False where the browser does not expose output devices at all (Firefox). */
  outputSelectable: boolean;
  loading: boolean;
  error: string | null;
  /** Prompt for the microphone once, purely to reveal device labels. */
  requestPermission: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** `setSinkId` is the capability that makes an output picker meaningful. */
const CAN_CHOOSE_OUTPUT =
  typeof window !== 'undefined' && typeof HTMLMediaElement !== 'undefined'
    ? 'setSinkId' in HTMLMediaElement.prototype
    : false;

export function useAudioDevices(enabled = true): AudioDevices {
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [labelled, setLabelled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError('This browser cannot list audio devices.');
      return;
    }

    setLoading(true);
    try {
      const all = await navigator.mediaDevices.enumerateDevices();

      const microphones = all.filter((d) => d.kind === 'audioinput');
      const speakers = all.filter((d) => d.kind === 'audiooutput');

      /*
       * A non-empty label on any device means permission has been granted. Checking the
       * Permissions API instead would be cleaner but is not implemented consistently for
       * microphones, and this is the fact actually being asked about.
       */
      setLabelled(microphones.some((d) => d.label !== ''));

      const named = (device: MediaDeviceInfo, index: number, kind: string) => ({
        deviceId: device.deviceId,
        label: device.label || `${kind} ${index + 1}`,
      });

      setInputs(microphones.map((d, i) => named(d, i, 'Microphone')));
      setOutputs(speakers.map((d, i) => named(d, i, 'Speaker')));
      setError(null);
    } catch {
      setError('Could not read the list of audio devices.');
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Released immediately: this was only ever about unlocking the labels.
      for (const track of stream.getTracks()) track.stop();
      await refresh();
    } catch (caught) {
      const name = (caught as DOMException)?.name;
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was blocked, so device names stay hidden.'
          : 'No microphone was found.',
      );
    }
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();

    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;

    const onChange = () => void refresh();
    media.addEventListener('devicechange', onChange);
    return () => media.removeEventListener('devicechange', onChange);
  }, [enabled, refresh]);

  return {
    inputs,
    outputs,
    labelled,
    outputSelectable: CAN_CHOOSE_OUTPUT,
    loading,
    error,
    requestPermission,
    refresh,
  };
}
