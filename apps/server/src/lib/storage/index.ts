/**
 * File storage abstraction.
 *
 * Two drivers behind one interface, because the free hosting tier forces the split:
 *
 *   local     Writes under `data/uploads`. Used for development and for the packaged
 *             desktop app, where files should stay on the user's own machine.
 *   supabase  Pushes to a Supabase Storage bucket (1 GB free). Required in production on
 *             Render, whose free instances have no persistent disk -- anything written to
 *             local disk there is lost on every restart and every deploy.
 *
 * Access-control model: object keys embed 96 bits of randomness, making a URL an
 * unguessable capability. This is the same model image CDNs use. The trade-off is
 * explicit: someone who is *given* the URL can open the file without being a member of
 * the channel. Anything stronger would require signing every image URL and would break
 * plain `<img src>` rendering, which is not a worthwhile trade for this application.
 */

import { randomBytes } from 'node:crypto';
import { env } from '../../env.js';
import { newId } from '../ids.js';
import { fileExtension } from '../sanitize.js';

export interface StorageDriver {
  readonly name: 'local' | 'supabase';
  /** Persist bytes under `key`. Must overwrite silently if the key already exists. */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Remove an object. Must not throw when the object is already gone. */
  remove(key: string): Promise<void>;
  /** Absolute, publicly reachable URL for an object. */
  urlFor(key: string): string;
  /**
   * Confirm the destination is actually usable.
   *
   * Configuring storage has two halves that fail in different places: bad credentials stop
   * the process from starting, but a bucket that is missing, misnamed, or private starts
   * perfectly and then rejects the first upload -- which someone discovers as a generic
   * "something went wrong" while changing their avatar, with the real reason only in a log
   * they may not be able to read.
   *
   * This makes that answerable without an upload and without log access.
   */
  check(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Build an object key.
 *
 * Shape: `attachments/<yyyy-mm>/<ulid>-<96 random bits><ext>`
 *  - the month prefix keeps directory listings manageable on the local driver
 *  - the ULID makes keys naturally time-ordered
 *  - the random suffix is what makes the URL unguessable
 *  - the original extension is preserved so browsers pick sensible default filenames
 */
export function buildStorageKey(fileName: string): string {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const random = randomBytes(12).toString('base64url');
  return `attachments/${month}/${newId()}-${random}${fileExtension(fileName)}`;
}

let driver: StorageDriver | null = null;

/** Resolve (and memoise) the configured storage driver. */
export async function getStorage(): Promise<StorageDriver> {
  if (driver) return driver;

  if (env.STORAGE_DRIVER === 'supabase') {
    const { createSupabaseStorage } = await import('./supabase.js');
    driver = createSupabaseStorage();
  } else {
    const { createLocalStorage } = await import('./local.js');
    driver = await createLocalStorage();
  }

  return driver;
}

/** Test hook: swap in a fake driver. */
export function setStorageDriver(next: StorageDriver | null): void {
  driver = next;
}
