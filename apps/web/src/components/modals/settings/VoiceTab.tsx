/**
 * Voice and audio settings.
 *
 * Everything here saves whether or not a call is running, and applies to a call already in
 * progress. Making someone leave and rejoin to change microphone is the sort of thing that
 * gets noticed precisely when it is most annoying — mid-conversation, because nobody can
 * hear them.
 *
 * Devices are stored as ids on this device only. They are never sent to the server: which
 * headset you own is a fact about the machine you are sitting at, not about your account.
 */

import { useEffect, useState } from 'react';
import { Headphones } from 'lucide-react';
import clsx from 'clsx';
import { LIMITS } from '@rockscord/shared';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useMediaDevices } from '../../../hooks/useMediaDevices';
import {
  isInVoice,
  reapplyAudioProcessing,
  setCameraDevice,
  setInputDevice,
  setOutputDevice,
  setOutputVolume,
} from '../../../lib/voice';
import { MicTest } from '../../voice/MicTest';
import { CameraPreview } from '../../voice/CameraPreview';
import { Button, Toggle } from '../../ui/primitives';

/** A labelled `<select>`, styled to match the app's inputs. */
function DeviceSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { deviceId: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink-dim">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(
          'w-full rounded-lg border border-line bg-surface-4 px-3 py-2 text-[14px] text-ink',
          'focus:border-accent focus:outline-none disabled:opacity-50',
        )}
      >
        {/* "" is a real choice, not a placeholder: it means "follow the system", which
            survives unplugging a headset in a way a pinned device id does not. */}
        <option value="">System default</option>
        {options.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function VoiceTab() {
  const devices = useMediaDevices();

  const inputDeviceId = useSettingsStore((s) => s.inputDeviceId);
  const cameraDeviceId = useSettingsStore((s) => s.cameraDeviceId);
  const outputDeviceId = useSettingsStore((s) => s.outputDeviceId);
  const outputVolume = useSettingsStore((s) => s.outputVolume);
  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);

  const setInputDeviceId = useSettingsStore((s) => s.setInputDeviceId);
  const setOutputDeviceId = useSettingsStore((s) => s.setOutputDeviceId);
  const setCameraDeviceId = useSettingsStore((s) => s.setCameraDeviceId);
  const setStoredVolume = useSettingsStore((s) => s.setOutputVolume);
  const setAudioProcessing = useSettingsStore((s) => s.setAudioProcessing);

  const [busy, setBusy] = useState(false);

  const chooseInput = async (id: string) => {
    setInputDeviceId(id);
    // Reopening the microphone only makes sense during a call; otherwise the saved id is
    // simply read on the next join.
    if (!isInVoice()) return;
    setBusy(true);
    try {
      await setInputDevice(id);
    } finally {
      setBusy(false);
    }
  };

  const chooseCamera = async (id: string) => {
    setCameraDeviceId(id);
    // Swapping the outgoing track only matters during a call; otherwise the saved id is
    // simply read the next time the camera is switched on.
    if (!isInVoice()) return;
    setBusy(true);
    try {
      await setCameraDevice(id);
    } finally {
      setBusy(false);
    }
  };

  const chooseOutput = async (id: string) => {
    setOutputDeviceId(id);
    await setOutputDevice(id);
  };

  const changeProcessing = async (
    key: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl',
    value: boolean,
  ) => {
    setAudioProcessing(key, value);
    if (!isInVoice()) return;
    setBusy(true);
    try {
      // Fixed by the browser at capture time, so honouring a live change means a fresh
      // capture and a track swap.
      await reapplyAudioProcessing();
    } finally {
      setBusy(false);
    }
  };

  // Keep playback level in step with the slider while a call is running.
  useEffect(() => {
    setOutputVolume(outputVolume);
  }, [outputVolume]);

  return (
    <div className="space-y-5">
      {!devices.labelled && (
        <div className="rounded-lg border border-line bg-surface-3 p-3">
          <p className="text-[13px] text-ink-dim">
            Your browser hides device names until microphone access has been granted once.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void devices.requestPermission()}
          >
            <Headphones size={14} aria-hidden />
            Show device names
          </Button>
        </div>
      )}

      {devices.error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {devices.error}
        </p>
      )}

      <section className="space-y-3">
        <DeviceSelect
          label="Microphone"
          value={inputDeviceId}
          onChange={(id) => void chooseInput(id)}
          options={devices.inputs}
          disabled={busy}
        />
        <MicTest />
      </section>

      <section className="space-y-3">
        <DeviceSelect
          label="Output device"
          value={outputDeviceId}
          onChange={(id) => void chooseOutput(id)}
          options={devices.outputs}
          disabled={!devices.outputSelectable}
        />

        {!devices.outputSelectable && (
          <p className="text-[12.5px] text-ink-faint">
            This browser will not let a page choose its output device. Change it in your
            operating system&rsquo;s sound settings instead.
          </p>
        )}

        <label className="block">
          <span className="mb-1.5 flex items-center justify-between text-[13px] font-medium text-ink-dim">
            Output volume
            <span className="tabular-nums text-ink-faint">{Math.round(outputVolume * 100)}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(outputVolume * 100)}
            onChange={(event) => setStoredVolume(Number(event.target.value) / 100)}
            className="w-full accent-accent"
            aria-label="Output volume"
          />
        </label>
      </section>

      <section className="space-y-2">
        <h4 className="text-[14px] font-semibold text-ink">Processing</h4>
        <Toggle
          checked={echoCancellation}
          onChange={(value) => void changeProcessing('echoCancellation', value)}
          label="Echo cancellation"
          description="Stops others hearing themselves back through your speakers."
        />
        <Toggle
          checked={noiseSuppression}
          onChange={(value) => void changeProcessing('noiseSuppression', value)}
          label="Noise suppression"
          description="Filters steady background sound like fans and keyboards."
        />
        <Toggle
          checked={autoGainControl}
          onChange={(value) => void changeProcessing('autoGainControl', value)}
          label="Automatic gain"
          description="Evens out your level so you stay audible without leaning in."
        />
        <p className="pt-1 text-[12.5px] leading-relaxed text-ink-faint">
          The browser applies these as it captures, so changing one during a call briefly
          reopens your microphone.
        </p>
      </section>

      <section className="space-y-3">
        <h4 className="text-[14px] font-semibold text-ink">Video</h4>

        <DeviceSelect
          label="Camera"
          value={cameraDeviceId}
          onChange={(id) => void chooseCamera(id)}
          options={devices.cameras}
          disabled={devices.cameras.length === 0}
        />

        {devices.cameras.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">
            No camera was found. Screen sharing still works without one.
          </p>
        ) : (
          <CameraPreview />
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface-3 p-4">
        <h4 className="text-[14px] font-semibold text-ink">How voice works here</h4>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">
          Voice is peer-to-peer over WebRTC. Your audio goes straight to the other people in
          the channel and never passes through the server &mdash; only the connection
          handshake does. That is what makes voice free to run, and it means nobody
          (including whoever runs the server) is in a position to record the call.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
          Because every participant sends audio to every other participant, quality is best
          up to about {LIMITS.VOICE_CHANNEL_SOFT_CAP} people in one channel.
        </p>
      </section>
    </div>
  );
}
