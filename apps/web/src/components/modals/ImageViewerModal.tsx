/**
 * Full-size image viewer.
 *
 * Deliberately not built on `Modal`: this needs an edge-to-edge presentation with no
 * chrome, and clicking anywhere outside the image closes it.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';

export function ImageViewerModal({
  url,
  fileName,
  onClose,
}: {
  url: string;
  fileName: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={fileName}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
        <span className="truncate text-[14px] text-white/80">{fileName}</span>
        <div className="flex shrink-0 items-center gap-1">
          <a
            href={url}
            download={fileName}
            // The click must not bubble to the backdrop and close the viewer.
            onClick={(event) => event.stopPropagation()}
            className="flex h-9 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Download"
            aria-label="Download"
          >
            <Download size={18} />
          </a>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Close"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img
          src={url}
          alt={fileName}
          onClick={(event) => event.stopPropagation()}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    </div>,
    document.body,
  );
}
