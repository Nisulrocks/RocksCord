/**
 * Unit tests for the pure logic that the rest of the system depends on:
 * id generation, permission arithmetic, mention parsing, and input normalisation.
 *
 * These have no database and no HTTP, so they run in milliseconds and pin down the
 * behaviour that integration tests would only exercise indirectly.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  MODERATOR_PERMISSIONS,
  Permission,
  hasPermission,
  listPermissions,
  packPermissions,
  parseMentions,
  resolveBasePermissions,
  resolveChannelPermissions,
  tokenizeMentions,
  userMention,
} from '@rockscord/shared';
import { idToTimestamp, isValidId, newDiscriminator, newId, newInviteCode } from '../src/lib/ids.js';
import {
  escapeFtsQuery,
  sanitizeChannelName,
  sanitizeFileName,
  sanitizeMessageContent,
} from '../src/lib/sanitize.js';
import { detectMimeType, looksLikeText, resolveUploadType } from '../src/lib/filetype.js';
import { TINY_PNG } from './helpers.js';

describe('identifiers', () => {
  it('generates 26-character ULIDs', () => {
    const id = newId();
    expect(id).toHaveLength(26);
    expect(isValidId(id)).toBe(true);
  });

  it('sorts lexicographically in creation order', () => {
    const ids = Array.from({ length: 500 }, () => newId());
    const sorted = [...ids].sort();

    // This property is what makes keyset pagination and unread comparison work.
    expect(sorted).toEqual(ids);
  });

  it('stays monotonic within a single millisecond', () => {
    const now = Date.now();
    const ids = Array.from({ length: 200 }, () => newId(now));

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes a recoverable timestamp', () => {
    const when = Date.now();
    const id = newId(when);
    expect(idToTimestamp(id)).toBe(when);
  });

  it('rejects malformed ids', () => {
    expect(isValidId('too-short')).toBe(false);
    expect(isValidId('')).toBe(false);
    // I, L, O, and U are excluded from Crockford base32 to avoid visual ambiguity.
    expect(isValidId('IIIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false);
  });

  it('generates usable invite codes and discriminators', () => {
    const codes = Array.from({ length: 200 }, () => newInviteCode());
    expect(codes.every((c) => c.length === 8)).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);

    const tags = Array.from({ length: 200 }, () => newDiscriminator());
    expect(tags.every((t) => /^\d{4}$/.test(t))).toBe(true);
    // 0000 is reserved so a tag is never rendered as "missing".
    expect(tags.every((t) => t !== '0000')).toBe(true);
  });
});

describe('permission arithmetic', () => {
  it('checks every required bit, not just one', () => {
    const bits = Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL;

    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(bits, Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(bits, Permission.BAN_MEMBERS)).toBe(false);
    expect(hasPermission(bits, Permission.SEND_MESSAGES | Permission.BAN_MEMBERS)).toBe(false);
  });

  it('treats ADMINISTRATOR as a wildcard', () => {
    expect(hasPermission(Permission.ADMINISTRATOR, Permission.BAN_MEMBERS)).toBe(true);
    expect(hasPermission(Permission.ADMINISTRATOR, ALL_PERMISSIONS)).toBe(true);
  });

  it('round-trips through names', () => {
    const names = listPermissions(MODERATOR_PERMISSIONS);
    expect(packPermissions(names)).toBe(MODERATOR_PERMISSIONS);
  });

  it('keeps every permission inside 32 bits', () => {
    // The whole bitfield relies on JavaScript's 32-bit bitwise operators.
    for (const bit of Object.values(Permission)) {
      expect(bit).toBeLessThanOrEqual(2 ** 30);
      expect(bit | 0).toBe(bit);
    }
  });

  it('gives owners everything regardless of roles', () => {
    const bits = resolveBasePermissions({
      isOwner: true,
      everyoneRolePermissions: 0,
      rolePermissions: [],
    });
    expect(bits).toBe(ALL_PERMISSIONS);
  });

  it('unions the permissions of every role held', () => {
    const bits = resolveBasePermissions({
      isOwner: false,
      everyoneRolePermissions: Permission.VIEW_CHANNEL,
      rolePermissions: [Permission.SEND_MESSAGES, Permission.KICK_MEMBERS],
    });

    expect(hasPermission(bits, Permission.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(bits, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(bits, Permission.KICK_MEMBERS)).toBe(true);
    expect(hasPermission(bits, Permission.BAN_MEMBERS)).toBe(false);
  });
});

describe('channel overwrite resolution', () => {
  const everyoneRoleId = 'role-everyone';
  const staffRoleId = 'role-staff';
  const memberId = 'user-1';

  it('applies an @everyone denial', () => {
    const resolved = resolveChannelPermissions(
      DEFAULT_EVERYONE_PERMISSIONS,
      [
        {
          targetType: 'role',
          targetId: everyoneRoleId,
          allow: 0,
          deny: Permission.SEND_MESSAGES,
        },
      ],
      { isOwner: false, everyoneRoleId, memberRoleIds: [], memberId },
    );

    expect(hasPermission(resolved, Permission.SEND_MESSAGES)).toBe(false);
    expect(hasPermission(resolved, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it('lets a role allow beat an @everyone deny', () => {
    const resolved = resolveChannelPermissions(
      DEFAULT_EVERYONE_PERMISSIONS,
      [
        { targetType: 'role', targetId: everyoneRoleId, allow: 0, deny: Permission.SEND_MESSAGES },
        { targetType: 'role', targetId: staffRoleId, allow: Permission.SEND_MESSAGES, deny: 0 },
      ],
      { isOwner: false, everyoneRoleId, memberRoleIds: [staffRoleId], memberId },
    );

    expect(hasPermission(resolved, Permission.SEND_MESSAGES)).toBe(true);
  });

  it('ignores overwrites for roles the member does not hold', () => {
    const resolved = resolveChannelPermissions(
      DEFAULT_EVERYONE_PERMISSIONS,
      [
        { targetType: 'role', targetId: everyoneRoleId, allow: 0, deny: Permission.SEND_MESSAGES },
        { targetType: 'role', targetId: staffRoleId, allow: Permission.SEND_MESSAGES, deny: 0 },
      ],
      { isOwner: false, everyoneRoleId, memberRoleIds: [], memberId },
    );

    expect(hasPermission(resolved, Permission.SEND_MESSAGES)).toBe(false);
  });

  it('lets a member-specific overwrite beat every role rule', () => {
    const resolved = resolveChannelPermissions(
      DEFAULT_EVERYONE_PERMISSIONS,
      [
        { targetType: 'role', targetId: staffRoleId, allow: Permission.SEND_MESSAGES, deny: 0 },
        { targetType: 'member', targetId: memberId, allow: 0, deny: Permission.SEND_MESSAGES },
      ],
      { isOwner: false, everyoneRoleId, memberRoleIds: [staffRoleId], memberId },
    );

    // The most specific rule wins: this one person is muted despite their role.
    expect(hasPermission(resolved, Permission.SEND_MESSAGES)).toBe(false);
  });

  it('never lets an overwrite restrict the owner', () => {
    const resolved = resolveChannelPermissions(
      ALL_PERMISSIONS,
      [{ targetType: 'role', targetId: everyoneRoleId, allow: 0, deny: ALL_PERMISSIONS }],
      { isOwner: true, everyoneRoleId, memberRoleIds: [], memberId },
    );

    expect(resolved).toBe(ALL_PERMISSIONS);
  });
});

describe('mentions', () => {
  it('extracts user, role, and channel mentions', () => {
    const parsed = parseMentions('hi <@user1> and <@&role1> see <#chan1>');

    expect(parsed.userIds).toEqual(['user1']);
    expect(parsed.roleIds).toEqual(['role1']);
    expect(parsed.channelIds).toEqual(['chan1']);
  });

  it('detects @everyone only on a word boundary', () => {
    expect(parseMentions('hey @everyone').everyone).toBe(true);
    expect(parseMentions('@here now').everyone).toBe(true);
    // An email address must not ping the whole server.
    expect(parseMentions('mail me at bob@everyone.com').everyone).toBe(false);
  });

  it('deduplicates repeated mentions of the same person', () => {
    const parsed = parseMentions(`${userMention('u1')} ${userMention('u1')}`);
    expect(parsed.userIds).toEqual(['u1']);
  });

  it('tokenises content losslessly', () => {
    const content = 'hello <@u1>, welcome to <#c1>!';
    const tokens = tokenizeMentions(content);

    // Reassembling the tokens must reproduce the original exactly, or rendering would
    // silently drop characters.
    const reassembled = tokens
      .map((t) =>
        t.type === 'text'
          ? t.value
          : t.type === 'user'
            ? `<@${t.id}>`
            : t.type === 'role'
              ? `<@&${t.id}>`
              : t.type === 'channel'
                ? `<#${t.id}>`
                : t.value,
      )
      .join('');

    expect(reassembled).toBe(content);
  });
});

describe('input normalisation', () => {
  it('collapses runs of blank lines', () => {
    expect(sanitizeMessageContent('a\n\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('strips zero-width and bidi characters', () => {
    // Zero-width space and a right-to-left override, both used for spoofing.
    const nasty = 'he\u200Bllo\u202E';
    expect(sanitizeMessageContent(nasty)).toBe('hello');
  });

  it('preserves ordinary punctuation and angle brackets', () => {
    expect(sanitizeMessageContent('5 < 6 && 7 > 3')).toBe('5 < 6 && 7 > 3');
  });

  it('slugifies text channel names but leaves voice names alone', () => {
    expect(sanitizeChannelName('My Cool Channel')).toBe('my-cool-channel');
    expect(sanitizeChannelName('  spaced   out  ')).toBe('spaced-out');
    expect(sanitizeChannelName('!!!')).toBe('channel');
    expect(sanitizeChannelName('General Voice', false)).toBe('General Voice');
  });

  it('makes filenames safe', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFileName('....hidden.txt')).toBe('hidden.txt');
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('NUL')).toBe('file_NUL');
  });

  it('neutralises FTS5 operators in a search query', () => {
    // Left raw, these are MATCH syntax and would error or change the query's meaning.
    expect(escapeFtsQuery('hello" OR 1=1 --')).not.toContain('OR 1=1 --"');
    expect(escapeFtsQuery('normal words')).toBe('"normal" "words"');
    expect(escapeFtsQuery('   ')).toBe('');
  });
});

describe('file type sniffing', () => {
  it('identifies formats from their magic bytes', () => {
    expect(detectMimeType(TINY_PNG)).toBe('image/png');
    expect(detectMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectMimeType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(detectMimeType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
  });

  it('returns null for content it does not recognise', () => {
    expect(detectMimeType(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
    expect(detectMimeType(Buffer.from([0x00, 0x00, 0x00]))).toBeNull();
  });

  it('distinguishes RIFF containers', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);

    expect(detectMimeType(wav)).toBe('audio/wav');
    expect(detectMimeType(webp)).toBe('image/webp');
  });

  it('validates text structurally', () => {
    expect(looksLikeText(Buffer.from('plain text\nwith lines\tand tabs'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x41]))).toBe(false);
    expect(looksLikeText(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(false);
  });

  it('trusts the bytes over the declared type', () => {
    // Claimed as PNG, actually HTML -> not accepted as PNG.
    expect(resolveUploadType(Buffer.from('<html></html>'), 'image/png')).toBeNull();
    // Claimed as PNG, actually PNG -> fine.
    expect(resolveUploadType(TINY_PNG, 'image/png')).toBe('image/png');
    // Claimed as JPEG, actually PNG -> reported as what it really is.
    expect(resolveUploadType(TINY_PNG, 'image/jpeg')).toBe('image/png');
  });
});
