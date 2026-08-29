/**
 * A camera preview, for checking yourself before anyone else sees you.
 *
 * The same argument as the microphone meter: a dropdown full of names like "HD Webcam
 * (04f2:b6d9)" tells you nothing about which physical camera that is, or whether it is
 * pointing at the ceiling.
 *
 * It is off until asked. A settings panel that silently lights the webcam indicator the
 * moment it opens is alarming, and rightly so.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, VideoOff } from 'lucide-react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Button } from '../ui/primitives';

export function CameraPreview() {
  const cameraDeviceId = useSettingsStore((s) => s.cameraDeviceId);

  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  /*
   * One effect owns the capture, keyed on the chosen device. Changing camera while the
   * preview is open therefore closes the old one and opens the new one through React's
   * own teardown, rather than two code paths racing over the same MediaStream.
   */
  useEffect(() => {
    if (!previewing) return;

    let cancelled = false;
    let stream: MediaStream | null = null;

    (async () => {
      setError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            // `exact` here, unlike in a call: the entire question is whether *this*
            // camera works, so silently previewing a different one would mislead.
            ...(cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : {}),
            width: { ideal: 640 },
            height: { ideal: 360 },
          },
          audio: false,
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        setLabel(stream.getVideoTracks()[0]?.label || null);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (caught) {
        if (cancelled) return;
        const name = (caught as DOMException)?.name;
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Camera access was blocked. Allow it, then try again.'
            : name === 'OverconstrainedError' || name === 'NotFoundError'
              ? 'That camera is no longer available. Pick another one.'
              : 'Could not open that camera.',
        );
        setPreviewing(false);
      }
    })();

    return () => {
      cancelled = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [previewing, cameraDeviceId]);

  // Releasing the camera when the panel closes matters: a live capture keeps the hardware
  // indicator lit, which looks like the app is recording you.
  useEffect(() => () => setPreviewing(false), []);

  const toggle = useCallback(() => setPreviewing((value) => !value), []);

  return (
    <div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={toggle}>
          {previewing ? <VideoOff size={14} aria-hidden /> : <Video size={14} aria-hidden />}
          {previewing ? 'Stop preview' : 'Preview camera'}
        </Button>
      </div>

      {previewing && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          // Mirrored, because an unmirrored view of yourself reads as wrong -- it is not
          // what a mirror shows, and every video app does the same.
          className="mt-2 h-[168px] w-full scale-x-[-1] rounded-lg bg-black object-cover"
        />
      )}

      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : previewing ? (
          <>
            Only you can see this. Nothing is sent anywhere.
            {label && (
              <>
                {' '}
                Showing <span className="text-ink-dim">{label}</span>.
              </>
            )}
          </>
        ) : (
          'Check your camera and framing before joining a call.'
        )}
      </p>
    </div>
  );
}
