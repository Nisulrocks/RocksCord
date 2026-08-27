/**
 * A live input meter, with optional monitoring.
 *
 * This answers the question a device dropdown cannot: *is this the microphone that can
 * actually hear me?* Names like "Microphone Array (Realtek(R) Audio)" do not identify a
 * physical object, so choosing one is guesswork until something moves when you speak — and
 * hearing yourself back removes the last of the doubt.
 *
 * The capture is opened here rather than borrowed from the call, so this works when you
 * are not in a voice channel, which is when people configure it.
 *
 * Two constraints differ deliberately from the ones the call uses:
 *
 *   - `deviceId` is `exact`, not `ideal`. In a call, `ideal` is right: an unplugged
 *     headset should fall back to the default rather than fail the join. Here the entire
 *     question is "does *this* device work", so silently testing a different one would
 *     make the feature actively misleading.
 *   - Monitoring plays through an `<audio>` element rather than the AudioContext, so it
 *     honours the chosen output device and volume like every other voice sound.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, Mic, Square } from 'lucide-react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Button } from '../ui/primitives';

/** Bars in the meter. Enough to read as a level, few enough to stay legible. */
const SEGMENTS = 14;

export function MicTest() {
  const inputDeviceId = useSettingsStore((s) => s.inputDeviceId);
  const outputDeviceId = useSettingsStore((s) => s.outputDeviceId);
  const outputVolume = useSettingsStore((s) => s.outputVolume);
  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);

  const [testing, setTesting] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The label the browser reports for the device actually opened. */
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  const monitorRef = useRef<HTMLAudioElement | null>(null);

  /*
   * One effect owns the whole capture lifecycle.
   *
   * Changing device or processing while the test is running has to reopen it, and doing
   * that as a separate "restart" effect meant two code paths racing over the same
   * MediaStream. Listing the settings as dependencies makes React do the teardown, so a
   * change is expressed as "close the old one, open a new one" with no third state.
   */
  useEffect(() => {
    if (!testing) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame: number | null = null;

    const close = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => {});
      if (monitorRef.current) {
        monitorRef.current.srcObject = null;
        monitorRef.current = null;
      }
      setLevel(0);
    };

    (async () => {
      setError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
            echoCancellation,
            noiseSuppression,
            autoGainControl,
          },
          video: false,
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        // Report what was actually opened, so a mismatch is visible rather than assumed.
        setActiveLabel(stream.getAudioTracks()[0]?.label || null);

        context = new AudioContext();
        const analyser = context.createAnalyser();
        // Small window, heavy smoothing: this is a level meter, not a spectrogram, and a
        // twitchy bar is harder to read than a slightly laggy one.
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        context.createMediaStreamSource(stream).connect(analyser);

        const samples = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(samples);

          // RMS around the 128 midpoint tracks perceived loudness far better than peak
          // amplitude does.
          let sum = 0;
          for (const sample of samples) {
            const centred = (sample - 128) / 128;
            sum += centred * centred;
          }
          const rms = Math.sqrt(sum / samples.length);

          // Speech sits low in a linear 0–1 range, so the meter would barely move. The
          // cube root spreads normal speaking level across most of the bar.
          setLevel(Math.min(1, Math.cbrt(rms) * 1.35));
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (caught) {
        if (cancelled) return;
        const name = (caught as DOMException)?.name;
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Microphone access was blocked. Allow it, then try again.'
            : name === 'OverconstrainedError' || name === 'NotFoundError'
              ? 'That microphone is no longer available. Pick another one.'
              : 'Could not open that microphone.',
        );
        setTesting(false);
      }
    })();

    return () => {
      cancelled = true;
      close();
    };
  }, [testing, inputDeviceId, echoCancellation, noiseSuppression, autoGainControl]);

  /*
   * Monitoring is a separate effect so toggling it does not reopen the microphone.
   * It attaches to the live track rather than to a second capture, which is what makes
   * what you hear the same audio the meter is measuring.
   */
  useEffect(() => {
    if (!testing || !monitor) {
      if (monitorRef.current) {
        monitorRef.current.pause();
        monitorRef.current.srcObject = null;
        monitorRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let element: HTMLAudioElement | null = null;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
            echoCancellation,
            noiseSuppression,
            autoGainControl,
          },
          video: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        element = new Audio();
        element.srcObject = stream;
        element.volume = outputVolume;

        const withSink = element as HTMLAudioElement & {
          setSinkId?: (id: string) => Promise<void>;
        };
        if (outputDeviceId && typeof withSink.setSinkId === 'function') {
          await withSink.setSinkId(outputDeviceId).catch(() => {});
        }

        await element.play().catch(() => {});
        monitorRef.current = element;
      } catch {
        if (!cancelled) setMonitor(false);
      }
    })();

    return () => {
      cancelled = true;
      for (const track of (element?.srcObject as MediaStream | null)?.getTracks() ?? []) {
        track.stop();
      }
      element?.pause();
      if (element) element.srcObject = null;
      monitorRef.current = null;
    };
  }, [
    testing,
    monitor,
    inputDeviceId,
    outputDeviceId,
    outputVolume,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
  ]);

  // Stop the test when the panel closes: an open capture keeps the recording indicator
  // lit, which is alarming and looks like a bug.
  useEffect(
    () => () => {
      setTesting(false);
      setMonitor(false);
    },
    [],
  );

  const toggle = useCallback(() => setTesting((value) => !value), []);
  const lit = Math.round(level * SEGMENTS);

  return (
    <div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={toggle}>
          {testing ? <Square size={14} aria-hidden /> : <Mic size={14} aria-hidden />}
          {testing ? 'Stop test' : 'Test microphone'}
        </Button>

        <div
          className="flex h-2.5 flex-1 gap-[3px]"
          role="meter"
          aria-label="Microphone input level"
          aria-valuenow={Math.round(level * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {Array.from({ length: SEGMENTS }, (_, index) => (
            <span
              key={index}
              className={`flex-1 rounded-[2px] transition-colors duration-75 ${
                index < lit
                  ? // The last two turn amber: that is where a browser starts clipping,
                    // and seeing it is the cue to move the microphone back.
                    index >= SEGMENTS - 2
                    ? 'bg-warning'
                    : 'bg-online'
                  : 'bg-surface-4'
              }`}
            />
          ))}
        </div>
      </div>

      {testing && (
        <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[13px] text-ink-dim">
          <input
            type="checkbox"
            checked={monitor}
            onChange={(event) => setMonitor(event.target.checked)}
            className="accent-accent"
          />
          <Headphones size={14} aria-hidden />
          Hear myself
          <span className="text-ink-faint">— use headphones, or this will echo</span>
        </label>
      )}

      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : testing ? (
          <>
            Say something — the bar should move. Nothing is sent anywhere.
            {activeLabel && (
              <>
                {' '}
                Listening to <span className="text-ink-dim">{activeLabel}</span>.
              </>
            )}
          </>
        ) : (
          'Check that the microphone you picked is the one that can hear you.'
        )}
      </p>
    </div>
  );
}
