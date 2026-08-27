/**
 * Input normalisation.
 *
 * Note what this file deliberately does *not* do: it does not escape HTML. Message
 * content is stored exactly as the user typed it and rendered by walking a token array
 * into React elements, never through `innerHTML`. Escaping on the way in would corrupt
 * legitimate text (`a < b`) while providing no protection that the renderer does not
 * already provide structurally.
 *
 * What it does do is remove things that are invisible, unbounded, or dangerous *outside*
 * of HTML: control characters, zero-width spoofing characters, directional overrides, and
 * path traversal in filenames.
 */

import { LIMITS } from '@rockscord/shared';

/**
 * Characters stripped from all user text:
 *  - C0/C1 control characters, except tab and newline
 *  - Zero-width space/joiner family, used to fake duplicate usernames and evade filters
 *  - Bidirectional overrides (the "Trojan Source" trick), which can visually reorder text
 */
const INVISIBLE_CHARS = new RegExp(
  [
    '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', // C0 controls (tab and newline kept)
    '[\u0080-\u009F]', // C1 controls
    '[\u200B-\u200F]', // zero-width space/joiner, LTR/RTL marks
    '[\u202A-\u202E]', // bidi embedding/override ("Trojan Source")
    '[\u2060-\u2064]', // word joiner, invisible operators
    '[\u2066-\u2069]', // bidi isolates
    '\uFEFF', // BOM / zero-width no-break space
  ].join('|'),
  'g',
);

/** Strip invisible characters and normalise Unicode to a canonical form. */
export function cleanText(input: string): string {
  return input.normalize('NFC').replace(INVISIBLE_CHARS, '');
}

/**
 * Normalise message content.
 *
 * Trailing whitespace is trimmed and runs of more than two blank lines are collapsed, so
 * one person cannot push everyone else's messages off screen with a wall of newlines.
 */
export function sanitizeMessageContent(input: string): string {
  const cleaned = cleanText(input)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned.slice(0, LIMITS.MESSAGE_MAX);
}

/** Normalise a display name / nickname: single line, collapsed whitespace. */
export function sanitizeDisplayName(
  input: string,
  max: number = LIMITS.DISPLAY_NAME_MAX,
): string {
  return cleanText(input).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Normalise a channel name into the lowercase-hyphenated form users expect from a text
 * channel. Voice channels keep their spacing and capitalisation, so callers pass
 * `slug: false` for those.
 */
export function sanitizeChannelName(input: string, slug = true): string {
  const cleaned = cleanText(input).replace(/\s+/g, ' ').trim();
  if (!slug) return cleaned.slice(0, LIMITS.CHANNEL_NAME_MAX);
  return (
    cleaned
      .toLowerCase()
      .replace(/[^a-z0-9\-_]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, LIMITS.CHANNEL_NAME_MAX) || 'channel'
  );
}

/**
 * Make an uploaded filename safe to store and to send in a Content-Disposition header.
 *
 * Everything about the client-supplied name is treated as hostile: directory separators,
 * `..`, leading dots, Windows reserved device names, and characters that would let the
 * name break out of a quoted header value.
 */
export function sanitizeFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? 'file';

  let safe = cleanText(base)
    .replace(/[^\w\s.\-()[\]]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();

  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 are unusable as filenames on Windows.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) {
    safe = `file_${safe}`;
  }

  if (!safe) safe = 'file';

  // Leave room for the extension when truncating a very long name.
  if (safe.length > 120) {
    const dot = safe.lastIndexOf('.');
    const ext = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : '';
    safe = safe.slice(0, 120 - ext.length) + ext;
  }

  return safe;
}

/** Extract a lowercase extension including the dot, or '' when there isn't one. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || fileName.length - dot > 12) return '';
  return fileName.slice(dot).toLowerCase();
}

/**
 * Escape a string for use inside an FTS5 MATCH expression.
 *
 * FTS5 has its own query syntax where characters like `"`, `*`, `:`, `-`, `(`, `)`, and
 * `NEAR` are operators. Wrapping each token in double quotes (with internal quotes
 * doubled) turns the whole thing into a literal phrase search, so a user typing
 * `a" OR b` gets no results instead of a syntax error or an unintended query.
 */
export function escapeFtsQuery(input: string): string {
  const tokens = cleanText(input)
    .replace(/["^*():\-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 12);

  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/** Escape a string used inside a SQL LIKE pattern (the fallback search path). */
export function escapeLike(input: string): string {
  return cleanText(input).replace(/[\\%_]/g, (m) => `\\${m}`);
}
