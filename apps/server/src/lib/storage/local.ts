/**
 * Local disk storage driver.
 *
 * Every path is resolved and then checked to be inside the upload root before any I/O
 * happens. Keys are generated server-side so traversal should be impossible by
 * construction, but a containment check is cheap and this is exactly the code path where
 * a future bug would turn into arbitrary file write.
 */

import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { env } from '../../env.js';
import type { StorageDriver } from './index.js';

function resolveWithinRoot(root: string, key: string): string {
  const target = path.resolve(root, key);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access a path outside the upload root: ${key}`);
  }
  return target;
}

export async function createLocalStorage(): Promise<StorageDriver> {
  const root = path.resolve(env.UPLOAD_DIR);
  await mkdir(root, { recursive: true });

  return {
    name: 'local',

    async put(key, data) {
      const target = resolveWithinRoot(root, key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    },

    async remove(key) {
      const target = resolveWithinRoot(root, key);
      await rm(target, { force: true });
    },

    async check() {
      try {
        await access(root, fsConstants.W_OK);
        return { ok: true, detail: root };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    urlFor(key) {
      // Keys always use forward slashes; normalise in case a caller passed a Windows path.
      return `${env.PUBLIC_URL}/uploads/${key.split(path.sep).join('/')}`;
    },
  };
}

/** Absolute path of the upload root, needed to mount the static file route. */
export function localUploadRoot(): string {
  return path.resolve(env.UPLOAD_DIR);
}
