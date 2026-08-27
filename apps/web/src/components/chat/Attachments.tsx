/**
 * Attachment rendering.
 *
 * Images render inline with their intrinsic aspect ratio reserved *before* the file
 * loads. The server records width and height at upload time precisely so the client can
 * do this — without it, every image that loads pushes the message list around and yanks
 * the reader's scroll position.
 *
 * Everything else renders as a download card. Nothing non-image is ever embedded, which
 * is the other half of the upload-security story (see `lib/filetype.ts` on the server).
 */

import { FileText, Download, FileArchive, FileAudio, FileVideo, File } from 'lucide-react';
import type { Attachment } from '@rockscord/shared';
import { IMAGE_MIME_TYPES } from '@rockscord/shared';
import { resolveAssetUrl } from '../../lib/api';
import { useUiStore } from '../../store/useUiStore';

/** Largest inline image box; bigger images are scaled down but keep their ratio. */
const MAX_WIDTH = 420;
const MAX_HEIGHT = 340;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(contentType: string) {
  if (contentType.startsWith('audio/')) return FileAudio;
  if (contentType.startsWith('video/')) return FileVideo;
  if (contentType === 'application/zip') return FileArchive;
  if (contentType.startsWith('text/') || contentType === 'application/json') return FileText;
  if (contentType === 'application/pdf') return FileText;
  return File;
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {attachments.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const openModal = useUiStore((s) => s.openModal);
  const url = resolveAssetUrl(attachment.url) ?? attachment.url;

  if (IMAGE_MIME_TYPES.has(attachment.contentType)) {
    // Scale to fit the box while preserving the aspect ratio, so the reserved space
    // matches the rendered size exactly.
    const ratio =
      attachment.width && attachment.height ? attachment.width / attachment.height : 16 / 9;

    let width = Math.min(attachment.width ?? MAX_WIDTH, MAX_WIDTH);
    let height = width / ratio;
    if (height > MAX_HEIGHT) {
      height = MAX_HEIGHT;
      width = height * ratio;
    }

    return (
      <button
        onClick={() => openModal({ kind: 'image', url, fileName: attachment.fileName })}
        className="group/img block w-fit overflow-hidden rounded-lg border border-line bg-surface-0 transition-colors hover:border-line-strong"
        title={`${attachment.fileName} — ${formatBytes(attachment.size)}`}
      >
        <img
          src={url}
          alt={attachment.fileName}
          width={Math.round(width)}
          height={Math.round(height)}
          loading="lazy"
          decoding="async"
          className="block h-auto max-w-full object-contain"
          style={{ width: Math.round(width), aspectRatio: `${ratio}` }}
        />
      </button>
    );
  }

  if (attachment.contentType.startsWith('video/')) {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-w-[420px] rounded-lg border border-line bg-black"
      />
    );
  }

  if (attachment.contentType.startsWith('audio/')) {
    return (
      <div className="w-fit max-w-full rounded-lg border border-line bg-surface-3 p-2">
        <div className="mb-1.5 truncate px-1 text-[13px] text-ink-dim">
          {attachment.fileName}
        </div>
        <audio src={url} controls preload="metadata" className="h-9" />
      </div>
    );
  }

  const Icon = iconFor(attachment.contentType);

  return (
    <a
      href={url}
      download={attachment.fileName}
      target="_blank"
      rel="noreferrer noopener"
      className="flex w-fit max-w-full items-center gap-3 rounded-lg border border-line bg-surface-3 px-3 py-2.5 transition-colors hover:border-line-strong"
    >
      <Icon size={26} className="shrink-0 text-accent-soft" />
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-medium text-accent-soft">
          {attachment.fileName}
        </span>
        <span className="block text-[12px] text-ink-faint">
          {formatBytes(attachment.size)}
        </span>
      </span>
      <Download size={16} className="ml-2 shrink-0 text-ink-faint" />
    </a>
  );
}
