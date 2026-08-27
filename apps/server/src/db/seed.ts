/**
 * Development seed data.
 *
 * Creates three accounts, a shared server with channels, a conversation with history, a
 * friendship, and a DM -- so that the moment you run the app there is something to look
 * at and multi-user testing needs no setup.
 *
 * Idempotent: running it twice will not duplicate anything. Safe to run against an
 * existing database.
 *
 *   Accounts:  alex@rockscord.test / nova@rockscord.test / kit@rockscord.test
 *   Password:  password123   (for all three)
 */

import { eq, sql } from 'drizzle-orm';
import {
  ADMIN_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  MODERATOR_PERMISSIONS,
} from '@rockscord/shared';
import type { Database } from './index.js';
import {
  channels,
  dmParticipants,
  friendships,
  memberRoles,
  members,
  messages,
  roles,
  servers,
  users,
} from './schema.js';
import { hashPassword } from '../lib/auth.js';
import { newId } from '../lib/ids.js';

const SEED_PASSWORD = 'password123';

interface SeedUser {
  email: string;
  username: string;
  displayName: string;
  discriminator: string;
  bio: string;
}

const SEED_USERS: SeedUser[] = [
  {
    email: 'alex@rockscord.test',
    username: 'alex',
    displayName: 'Alex Rivera',
    discriminator: '0001',
    bio: 'Building things that talk to each other.',
  },
  {
    email: 'nova@rockscord.test',
    username: 'nova',
    displayName: 'Nova Chen',
    discriminator: '0002',
    bio: 'Designer. Dark mode enthusiast.',
  },
  {
    email: 'kit@rockscord.test',
    username: 'kit',
    displayName: 'Kit Alvarez',
    discriminator: '0003',
    bio: 'Mostly here for the voice channels.',
  },
];

async function upsertUser(db: Database, seed: SeedUser, passwordHash: string): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, seed.email))
    .limit(1);

  if (existing) return existing.id;

  const id = newId();
  await db.insert(users).values({
    id,
    email: seed.email,
    username: seed.username,
    usernameLower: seed.username.toLowerCase(),
    discriminator: seed.discriminator,
    displayName: seed.displayName,
    passwordHash,
    bio: seed.bio,
    status: 'online',
  });
  return id;
}

export async function seed(db: Database): Promise<void> {
  // One hash for all seed accounts: Argon2 is deliberately slow, and hashing the same
  // password three times would triple the seed time for no benefit.
  const passwordHash = await hashPassword(SEED_PASSWORD);

  const userIds: string[] = [];
  for (const seedUser of SEED_USERS) {
    userIds.push(await upsertUser(db, seedUser, passwordHash));
  }
  const [alexId, novaId, kitId] = userIds as [string, string, string];

  const [existingServer] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.name, 'RocksCord HQ'))
    .limit(1);

  if (existingServer) {
    console.log('[seed] "RocksCord HQ" already exists -- nothing to do.');
    printSummary();
    return;
  }

  const serverId = newId();
  const everyoneRoleId = newId();
  const moderatorRoleId = newId();
  const adminRoleId = newId();

  const generalId = newId();
  const randomId = newId();
  const devId = newId();
  const voiceId = newId();

  await db.transaction(async (tx) => {
    await tx.insert(servers).values({
      id: serverId,
      name: 'RocksCord HQ',
      description: 'The demo server. Everything you need to poke at.',
      ownerId: alexId,
    });

    await tx.insert(roles).values([
      {
        id: everyoneRoleId,
        serverId,
        name: '@everyone',
        permissions: DEFAULT_EVERYONE_PERMISSIONS,
        position: 0,
        isDefault: true,
      },
      {
        id: moderatorRoleId,
        serverId,
        name: 'Moderator',
        color: '#3ba55d',
        permissions: MODERATOR_PERMISSIONS,
        position: 1,
        hoist: true,
      },
      {
        id: adminRoleId,
        serverId,
        name: 'Admin',
        color: '#f0b232',
        permissions: ADMIN_PERMISSIONS,
        position: 2,
        hoist: true,
      },
    ]);

    await tx.insert(channels).values([
      { id: generalId, serverId, name: 'general', type: 'text', position: 0, topic: 'Say hello.' },
      { id: randomId, serverId, name: 'random', type: 'text', position: 1 },
      {
        id: devId,
        serverId,
        name: 'dev-log',
        type: 'text',
        position: 2,
        topic: 'What changed today.',
      },
      { id: voiceId, serverId, name: 'General Voice', type: 'voice', position: 3 },
    ]);

    await tx.insert(members).values([
      { serverId, userId: alexId },
      { serverId, userId: novaId },
      { serverId, userId: kitId },
    ]);

    // Nova moderates; Kit is a plain member so permission differences are visible.
    await tx.insert(memberRoles).values([
      { serverId, userId: novaId, roleId: moderatorRoleId },
    ]);
  });

  // Backdated conversation so the channel does not open empty, and so "load older
  // messages" has something to load.
  const base = Date.now() - 1000 * 60 * 60 * 6;
  const script: Array<[string, string, number]> = [
    [alexId, 'Welcome to RocksCord HQ. This whole thing runs on free infrastructure.', 0],
    [novaId, 'The dark theme is doing a lot of heavy lifting here.', 90],
    [kitId, 'Voice actually works? No relay server?', 220],
    [alexId, 'Peer-to-peer WebRTC. The server only passes the handshake along.', 260],
    [novaId, 'Try replying to this message to see the reply preview.', 400],
    [kitId, 'Also try uploading an image, it renders inline.', 520],
    [alexId, 'Everything you see is in the repo. Nothing is a mock.', 640],
  ];

  const messageRows = script.map(([authorId, content, offsetSeconds], index) => ({
    id: newId(base + offsetSeconds * 1000 + index),
    channelId: generalId,
    authorId,
    content,
    createdAt: base + offsetSeconds * 1000,
  }));

  await db.insert(messages).values(messageRows);
  await db
    .update(channels)
    .set({ lastMessageAt: messageRows[messageRows.length - 1]!.createdAt })
    .where(eq(channels.id, generalId));

  await db.insert(messages).values([
    {
      id: newId(),
      channelId: devId,
      authorId: alexId,
      content: 'Added full-text search over messages today. FTS5, external content table.',
      createdAt: Date.now() - 1000 * 60 * 30,
    },
  ]);

  // Alex and Nova are friends; Kit has a pending request out to Alex.
  const pair = (a: string, b: string) => (a < b ? { low: a, high: b } : { low: b, high: a });

  const alexNova = pair(alexId, novaId);
  await db.insert(friendships).values({
    id: newId(),
    requesterId: alexId,
    addresseeId: novaId,
    userLowId: alexNova.low,
    userHighId: alexNova.high,
    status: 'accepted',
  });

  const kitAlex = pair(kitId, alexId);
  await db.insert(friendships).values({
    id: newId(),
    requesterId: kitId,
    addresseeId: alexId,
    userLowId: kitAlex.low,
    userHighId: kitAlex.high,
    status: 'pending',
  });

  // A DM with history between Alex and Nova.
  const dmId = newId();
  await db.insert(channels).values({
    id: dmId,
    serverId: null,
    name: 'Direct Message',
    type: 'dm',
    lastMessageAt: Date.now() - 1000 * 60 * 12,
  });
  await db.insert(dmParticipants).values([
    { channelId: dmId, userId: alexId },
    { channelId: dmId, userId: novaId },
  ]);
  await db.insert(messages).values([
    {
      id: newId(Date.now() - 1000 * 60 * 15),
      channelId: dmId,
      authorId: novaId,
      content: 'Did the presence indicator end up working across tabs?',
      createdAt: Date.now() - 1000 * 60 * 15,
    },
    {
      id: newId(Date.now() - 1000 * 60 * 12),
      channelId: dmId,
      authorId: alexId,
      content: 'Yep -- it reference-counts sockets, so closing one tab keeps you online.',
      createdAt: Date.now() - 1000 * 60 * 12,
    },
  ]);

  const [aggRow_total] = await db.select({ total: sql<number>`count(*)` }).from(messages);
const total = Number(aggRow_total?.total ?? 0);
  console.log(`[seed] created 1 server, 5 channels, ${total} messages, 3 users`);
  printSummary();
}

function printSummary(): void {
  console.log('\n  Seed accounts (password for all: password123)');
  for (const user of SEED_USERS) {
    console.log(`    ${user.email.padEnd(20)} ${user.username}#${user.discriminator}`);
  }
  console.log('');
}
