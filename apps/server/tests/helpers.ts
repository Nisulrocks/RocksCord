/**
 * Test harness.
 *
 * Every test file gets its own private database file under the OS temp directory, so
 * tests never share state and can run in parallel. `buildApp` takes the database as a
 * parameter precisely to make this possible -- there is no global to reset between files.
 *
 * **Why a temp file and not `:memory:`.** `@libsql/client` gives every *connection* its
 * own private in-memory database. Drizzle's `db.transaction()` opens a second connection,
 * so under `:memory:` a transaction runs against an empty schema and fails with
 * "no such table". A throwaway file behaves exactly like production and costs
 * milliseconds.
 *
 * Two flavours of harness:
 *   `createTestApp()`     -- no network. Uses `app.inject()`, which is faster and does not
 *                            consume ports. Right for HTTP-level tests.
 *   `createLiveTestApp()` -- binds a real ephemeral port. Needed for Socket.IO tests,
 *                            which require an actual TCP listener.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createDb, type Database, type DbHandle } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';
import { resetPresence } from '../src/realtime/presence.js';
import { resetVoice } from '../src/realtime/voice.js';
import { setStorageDriver, type StorageDriver } from '../src/lib/storage/index.js';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Database;
  /** Base URL when the app is listening on a real port; empty otherwise. */
  url: string;
  close: () => Promise<void>;
}

/**
 * An in-memory storage driver so upload tests never touch the disk.
 * Exposed so tests can assert on what was written.
 */
export function createMemoryStorage(): StorageDriver & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    name: 'local',
    files,
    async put(key, data) {
      files.set(key, data);
    },
    async remove(key) {
      files.delete(key);
    },
    urlFor(key) {
      return `http://test.local/uploads/${key}`;
    },
  };
}

async function build(listen: boolean): Promise<TestApp> {
  // A private database file per harness, in its own temp directory so the WAL and shm
  // sidecars are cleaned up with it.
  const directory = mkdtempSync(path.join(tmpdir(), 'rockscord-test-'));
  const databaseUrl = `file:${path.join(directory, 'test.db').replace(/\\/g, '/')}`;

  const handle: DbHandle = await createDb(databaseUrl, undefined);

  setStorageDriver(createMemoryStorage());

  const built = await buildApp({
    db: handle.db,
    migrate: true,
    realtime: true,
    logLevel: 'silent',
  });

  let url = '';
  if (listen) {
    // Port 0 lets the OS pick a free port, so parallel test files cannot collide.
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const address = built.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    url = `http://127.0.0.1:${port}`;
  }

  return {
    app: built.app,
    ctx: built.ctx,
    db: handle.db,
    url,
    close: async () => {
      await built.close();
      await handle.close();
      // Presence and voice are module-level singletons; clear them so the next file
      // does not inherit "online" users from this one.
      resetPresence();
      resetVoice();
      setStorageDriver(null);
      // Best-effort: on Windows the file can still be briefly locked after close.
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A leftover file in the OS temp directory is harmless.
      }
    },
  };
}

export const createTestApp = () => build(false);
export const createLiveTestApp = () => build(true);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export interface TestUser {
  id: string;
  username: string;
  discriminator: string;
  email: string;
  password: string;
  accessToken: string;
  /** Raw Set-Cookie value, for tests that exercise refresh. */
  refreshCookie: string;
  auth: { authorization: string };
}

let userCounter = 0;

/** Register a user through the real HTTP route, so the full pipeline is exercised. */
export async function registerUser(
  test: TestApp,
  overrides: Partial<{ username: string; email: string; password: string }> = {},
): Promise<TestUser> {
  userCounter += 1;
  const username = overrides.username ?? `user${userCounter}${Math.random().toString(36).slice(2, 6)}`;
  const email = overrides.email ?? `${username}@test.local`;
  const password = overrides.password ?? 'correct horse battery';

  const response = await test.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, username, password },
  });

  if (response.statusCode !== 201) {
    throw new Error(`registerUser failed: ${response.statusCode} ${response.body}`);
  }

  const body = response.json();
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : (setCookie ?? '');

  return {
    id: body.user.id,
    username: body.user.username,
    discriminator: body.user.discriminator,
    email,
    password,
    accessToken: body.accessToken,
    refreshCookie: cookieHeader.split(';')[0] ?? '',
    auth: { authorization: `Bearer ${body.accessToken}` },
  };
}

/** Create a server and return its id plus the ids of its default channels and roles. */
export async function createServer(
  test: TestApp,
  user: TestUser,
  name = 'Test Server',
): Promise<{
  serverId: string;
  generalChannelId: string;
  voiceChannelId: string;
  everyoneRoleId: string;
  moderatorRoleId: string;
  adminRoleId: string;
}> {
  const created = await test.app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: user.auth,
    payload: { name },
  });

  if (created.statusCode !== 201) {
    throw new Error(`createServer failed: ${created.statusCode} ${created.body}`);
  }
  const serverId = created.json().server.id as string;

  const channels = await test.app.inject({
    method: 'GET',
    url: `/api/channels/server/${serverId}`,
    headers: user.auth,
  });
  const channelList = channels.json().channels as { id: string; type: string; name: string }[];

  const roles = await test.app.inject({
    method: 'GET',
    url: `/api/servers/${serverId}/roles`,
    headers: user.auth,
  });
  const roleList = roles.json().roles as { id: string; name: string; isDefault: boolean }[];

  return {
    serverId,
    generalChannelId: channelList.find((c) => c.type === 'text')!.id,
    voiceChannelId: channelList.find((c) => c.type === 'voice')!.id,
    everyoneRoleId: roleList.find((r) => r.isDefault)!.id,
    moderatorRoleId: roleList.find((r) => r.name === 'Moderator')!.id,
    adminRoleId: roleList.find((r) => r.name === 'Admin')!.id,
  };
}

/** Have `joiner` accept an invite to `serverId`. */
export async function joinServer(
  test: TestApp,
  owner: TestUser,
  serverId: string,
  joiner: TestUser,
): Promise<void> {
  const invite = await test.app.inject({
    method: 'POST',
    url: `/api/invites/server/${serverId}`,
    headers: owner.auth,
    payload: {},
  });
  const code = invite.json().invite.code as string;

  const accepted = await test.app.inject({
    method: 'POST',
    url: `/api/invites/${code}`,
    headers: joiner.auth,
  });

  if (accepted.statusCode !== 200) {
    throw new Error(`joinServer failed: ${accepted.statusCode} ${accepted.body}`);
  }
}

/** Send a message and return the created message body. */
export async function sendMessage(
  test: TestApp,
  user: TestUser,
  channelId: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const response = await test.app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/messages`,
    headers: user.auth,
    payload: { content, ...extra },
  });
  return { status: response.statusCode, body: response.json() };
}

/** Give a member a role, as the server owner. */
export async function assignRole(
  test: TestApp,
  owner: TestUser,
  serverId: string,
  member: TestUser,
  roleIds: string[],
): Promise<void> {
  const response = await test.app.inject({
    method: 'PATCH',
    url: `/api/servers/${serverId}/members/${member.id}`,
    headers: owner.auth,
    payload: { roleIds },
  });
  if (response.statusCode !== 200) {
    throw new Error(`assignRole failed: ${response.statusCode} ${response.body}`);
  }
}

/** A minimal valid PNG (1x1, transparent) for upload tests. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Build a multipart body by hand, so upload tests do not need a form-data dependency. */
export function multipart(
  fileName: string,
  contentType: string,
  data: Buffer,
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----rockscordtest${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    body: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
