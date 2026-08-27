/**
 * Supabase Storage driver.
 *
 * Used when the app is deployed to a host without a persistent disk (Render's free tier).
 * The bucket must be created as **public** for `urlFor` to resolve; the capability-URL
 * model described in `index.ts` is what protects the objects.
 *
 * The service-role key is used because uploads happen server-side after the request has
 * already been authenticated and permission-checked. It must never reach a client.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../env.js';
import type { StorageDriver } from './index.js';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export function createSupabaseStorage(): StorageDriver {
  const bucket = env.SUPABASE_BUCKET;

  return {
    name: 'supabase',

    async put(key, data, contentType) {
      const { error } = await getClient()
        .storage.from(bucket)
        .upload(key, data, { contentType, upsert: true, cacheControl: '31536000' });

      if (error) {
        throw new Error(`Supabase upload failed for ${key}: ${error.message}`);
      }
    },

    async remove(key) {
      // A missing object is not an error condition for us -- the caller's intent is
      // "ensure this is gone", which is already satisfied.
      const { error } = await getClient().storage.from(bucket).remove([key]);
      if (error && !/not found/i.test(error.message)) {
        throw new Error(`Supabase delete failed for ${key}: ${error.message}`);
      }
    },

    urlFor(key) {
      const { data } = getClient().storage.from(bucket).getPublicUrl(key);
      return data.publicUrl;
    },
  };
}
