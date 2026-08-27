/**
 * A live input meter.
 *
 * The point of this is to answer the one question a device dropdown cannot: *is this the
 * microphone that can actually hear me?* Names like "Microphone Array (Realtek(R) Audio)"
 * do not tell anyone which physical device that is, so picking one is guesswork until
 * something moves when you speak.
 *
 * It opens its own capture rather than borrowing the call's, so it works when you are not
 * in a voice channel — which is when people configure this.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Button } from '../ui/primitives';

/** Bars in the meter. Enough to read as a level, few enough to stay legible. */
const SEGMENTS = 14;

export function MicTest() {
  const inputDeviceId = useSettingsStore((s) => s.inputDeviceId);
  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);

  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Held in refs, not state: these are teardown handles, and re-rendering on every
  // animation frame because a MediaStream changed identity would be pointless work.
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;

    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;

    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;

    setTesting(false);
    setLevel(0);
  }, []);

  // Releasing the microphone when the panel closes matters: an open capture keeps the
  // recording indicator lit, which is alarming and looks like a bug.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(inputDeviceId ? { deviceId: { ideal: inputDeviceId } } : {}),
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        },
        video: false,
      });

      streamRef.current = stream;
      const context = new AudioContext();
      contextRef.current = context;

      const analyser = context.createAnalyser();
      // Small window, heavy smoothing: this is a level meter, not a spectrogram, and a
      // twitchy bar is harder to read than a slightly laggy one.
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      context.createMediaStreamSource(stream).connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      setTesting(true);

      const tick = () => {
        analyser.getByteTimeDomainData(samples);

        // RMS of the waveform around its 128 midpoint, which tracks perceived loudness
        // far better than peak amplitude does.
        let sum = 0;
        for (const sample of samples) {
          const centred = (sample - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / samples.length);

        // Speech sits low in a linear 0–1 range, so the meter would barely move. The
        // cube root spreads normal speaking level across most of the bar.
        setLevel(Math.min(1, Math.cbrt(rms) * 1.35));

        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (caught) {
      const name = (caught as DOMException)?.name;
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was blocked. Allow it, then try again.'
          : 'Could not open that microphone.',
      );
      stop();
    }
  }, [inputDeviceId, echoCancellation, noiseSuppression, autoGainControl, stop]);

  // Restart on a device change so the meter always reflects the current selection.
  useEffect(() => {
    if (!testing) return;
    stop();
    void start();
    // Restarting when `start` or `stop` change identity would loop forever; the device
    // and processing options are the only inputs that should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputDeviceId, echoCancellation, noiseSuppression, autoGainControl]);

  const lit = Math.round(level * SEGMENTS);

  return (
    <div>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={testing ? stop : () => void start()}
        >
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
                  ? // The last two segments turn amber: that is the range where a browser
                    // will start clipping, and seeing it is the cue to move the mic back.
                    index >= SEGMENTS - 2
                    ? 'bg-warning'
                    : 'bg-online'
                  : 'bg-surface-4'
              }`}
            />
          ))}
        </div>
      </div>

      <p className="mt-2 text-[12.5px] text-ink-faint">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : testing ? (
          'Say something — the bar should move. Nothing is sent anywhere.'
        ) : (
          'Check that the microphone you picked is the one that can hear you.'
        )}
      </p>
    </div>
  );
}
