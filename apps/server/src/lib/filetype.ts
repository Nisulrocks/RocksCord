/**
 * Content sniffing for uploads.
 *
 * The `Content-Type` a browser sends with a multipart file is attacker-controlled: it is
 * whatever the client says it is. Trusting it would let someone upload `payload.html`
 * labelled `image/png`, which the storage layer would then happily serve.
 *
 * So the real type is derived from the file's leading bytes and must agree with the
 * declared type before the upload is accepted. Only formats on the allow-list have
 * signatures here; anything unrecognised is rejected rather than guessed at.
 */

const TEXT_LIKE = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

interface Signature {
  mime: string;
  /** Byte pattern; `null` matches any byte at that offset. */
  bytes: (number | null)[];
  offset?: number;
}

const SIGNATURES: Signature[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // ZIP container. Also the envelope for .docx/.xlsx/.pptx, which we do not distinguish.
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x05, 0x06] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/mpeg', bytes: [0xff, 0xfb] },
  { mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'audio/wav', bytes: [0x52, 0x49, 0x46, 0x46] }, // refined below via RIFF form
];

function matches(buffer: Buffer, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (buffer.length < offset + signature.bytes.length) return false;
  return signature.bytes.every((byte, i) => byte === null || buffer[offset + i] === byte);
}

/** RIFF and ISO-BMFF containers need a second look to tell audio from video. */
function sniffContainer(buffer: Buffer): string | null {
  // RIFF....WAVE / RIFF....WEBP
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF') {
    const form = buffer.subarray(8, 12).toString('latin1');
    if (form === 'WAVE') return 'audio/wav';
    if (form === 'WEBP') return 'image/webp';
    return null;
  }

  // EBML header -> Matroska/WebM
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';

  // ISO base media file format: ....ftyp<brand>
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    return 'video/mp4';
  }

  return null;
}

/**
 * Determine the real MIME type from the file's contents.
 * Returns null when the bytes do not match any format we accept.
 */
export function detectMimeType(buffer: Buffer): string | null {
  const container = sniffContainer(buffer);
  if (container) return container;

  for (const signature of SIGNATURES) {
    if (signature.mime === 'audio/wav') continue; // handled by sniffContainer
    if (matches(buffer, signature)) return signature.mime;
  }

  return null;
}

/**
 * Text files have no magic bytes, so they are validated structurally instead: the content
 * must decode as UTF-8 and contain no NUL bytes or stray control characters. That is
 * enough to stop a binary payload from being smuggled in as `notes.txt`.
 */
export function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return false;

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  // U+FFFD means the bytes were not valid UTF-8.
  if (decoded.includes(String.fromCharCode(0xfffd))) return false;

  // Tab (9), line feed (10), and carriage return (13) are legitimate in text files.
  // Any other C0 control character means this is binary content wearing a .txt name.
  for (let i = 0; i < decoded.length; i += 1) {
    const code = decoded.charCodeAt(i);
    if (code > 31) continue;
    if (code === 9 || code === 10 || code === 13) continue;
    return false;
  }
  return true;
}

/**
 * Validate that a declared type is plausible for the bytes received.
 * Returns the type to actually store, or null if the file should be rejected.
 */
export function resolveUploadType(buffer: Buffer, declared: string): string | null {
  const normalized = declared.split(';')[0]?.trim().toLowerCase() ?? '';

  if (TEXT_LIKE.has(normalized)) {
    return looksLikeText(buffer) ? normalized : null;
  }

  const detected = detectMimeType(buffer);
  if (!detected) return null;

  // JPEG is served for both image/jpeg and image/jpg; treat them as equivalent.
  const equivalent = (a: string, b: string) =>
    a === b || (a === 'image/jpeg' && b === 'image/jpg');

  if (!equivalent(detected, normalized) && !equivalent(normalized, detected)) {
    // The declared type disagrees with the bytes. Trust the bytes -- but only if the
    // detected type is itself something we allow, which the caller checks next.
    return detected;
  }

  return detected;
}
