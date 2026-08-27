/**
 * Upload tests.
 *
 * The interesting cases are all adversarial: a client can claim any Content-Type it
 * likes, so these check that the *bytes* decide what is accepted, that filenames cannot
 * escape the storage root, and that one user cannot attach another user's upload.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@rockscord/shared';
import {
  TINY_PNG,
  createServer,
  createTestApp,
  multipart,
  registerUser,
  sendMessage,
  type TestApp,
  type TestUser,
} from './helpers.js';

let test: TestApp;
let user: TestUser;
let other: TestUser;
let ids: Awaited<ReturnType<typeof createServer>>;

beforeAll(async () => {
  test = await createTestApp();
  user = await registerUser(test, { username: 'uploader' });
  other = await registerUser(test, { username: 'bystander' });
  ids = await createServer(test, user, 'Upload Lab');
});

afterAll(async () => {
  await test.close();
});

async function upload(
  as: TestUser,
  fileName: string,
  contentType: string,
  data: Buffer,
  url = '/api/files/upload',
) {
  const { body, headers } = multipart(fileName, contentType, data);
  return test.app.inject({
    method: 'POST',
    url,
    headers: { ...as.auth, ...headers },
    payload: body,
  });
}

describe('accepting valid files', () => {
  it('accepts a real PNG and records its dimensions', async () => {
    const response = await upload(user, 'pixel.png', 'image/png', TINY_PNG);

    expect(response.statusCode).toBe(201);
    const attachment = response.json().attachment;
    expect(attachment.contentType).toBe('image/png');
    // Dimensions are recorded at upload time so the client can reserve layout space
    // before the image loads.
    expect(attachment.width).toBe(1);
    expect(attachment.height).toBe(1);
  });

  it('accepts a plain text file', async () => {
    const response = await upload(
      user,
      'notes.txt',
      'text/plain',
      Buffer.from('just some notes\nwith a second line\n'),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().attachment.contentType).toBe('text/plain');
  });
});

describe('rejecting hostile files', () => {
  it('rejects an HTML payload disguised as a PNG', async () => {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');

    // The client claims image/png; the bytes say otherwise.
    const response = await upload(user, 'innocent.png', 'image/png', html);

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a binary payload disguised as text', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03]);

    const response = await upload(user, 'notes.txt', 'text/plain', binary);

    expect(response.statusCode).toBe(415);
  });

  it('rejects an executable', async () => {
    // MZ header -- a Windows PE binary.
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]);

    const response = await upload(user, 'setup.exe', 'application/octet-stream', exe);

    expect(response.statusCode).toBe(415);
  });

  it('rejects an empty file', async () => {
    const response = await upload(user, 'empty.png', 'image/png', Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
  });

  it('rejects a file over the size limit', async () => {
    // A valid PNG header followed by padding past the limit.
    const oversized = Buffer.concat([TINY_PNG, Buffer.alloc(LIMITS.MAX_UPLOAD_BYTES + 1024, 0x41)]);

    const response = await upload(user, 'huge.png', 'image/png', oversized);

    expect([413, 415]).toContain(response.statusCode);
  });

  it('strips directory traversal from the stored filename', async () => {
    const response = await upload(user, '../../../../etc/passwd.png', 'image/png', TINY_PNG);

    expect(response.statusCode).toBe(201);
    const fileName = response.json().attachment.fileName as string;

    expect(fileName).not.toContain('..');
    expect(fileName).not.toContain('/');
    expect(fileName).not.toContain('\\');
    expect(fileName).toBe('passwd.png');
  });

  it('renames Windows reserved device names', async () => {
    const response = await upload(user, 'CON.png', 'image/png', TINY_PNG);

    expect(response.statusCode).toBe(201);
    // "CON" is unusable as a filename on Windows, so it gets a prefix.
    expect(response.json().attachment.fileName).toBe('file_CON.png');
  });
});

describe('attaching uploads to messages', () => {
  it('attaches an upload the sender owns', async () => {
    const uploaded = await upload(user, 'pixel.png', 'image/png', TINY_PNG);
    const attachmentId = uploaded.json().attachment.id as string;

    const sent = await sendMessage(test, user, ids.generalChannelId, 'here is a picture', {
      attachmentIds: [attachmentId],
    });

    expect(sent.status).toBe(201);
    expect(sent.body.message.attachments).toHaveLength(1);
    expect(sent.body.message.attachments[0].fileName).toBe('pixel.png');
  });

  it("refuses to attach someone else's upload", async () => {
    const uploaded = await upload(other, 'theirs.png', 'image/png', TINY_PNG);
    const attachmentId = uploaded.json().attachment.id as string;

    const sent = await sendMessage(test, user, ids.generalChannelId, 'stealing this', {
      attachmentIds: [attachmentId],
    });

    expect(sent.status).toBe(400);
  });

  it('refuses to reuse an attachment that is already on a message', async () => {
    const uploaded = await upload(user, 'once.png', 'image/png', TINY_PNG);
    const attachmentId = uploaded.json().attachment.id as string;

    const first = await sendMessage(test, user, ids.generalChannelId, 'first use', {
      attachmentIds: [attachmentId],
    });
    expect(first.status).toBe(201);

    const second = await sendMessage(test, user, ids.generalChannelId, 'second use', {
      attachmentIds: [attachmentId],
    });
    expect(second.status).toBe(400);
  });

  it('allows a message with only an attachment and no text', async () => {
    const uploaded = await upload(user, 'silent.png', 'image/png', TINY_PNG);

    const sent = await sendMessage(test, user, ids.generalChannelId, '', {
      attachmentIds: [uploaded.json().attachment.id],
    });

    expect(sent.status).toBe(201);
  });
});

describe('avatars', () => {
  it('accepts an image and updates the profile', async () => {
    const response = await upload(user, 'me.png', 'image/png', TINY_PNG, '/api/files/avatar');

    expect(response.statusCode).toBe(200);
    expect(response.json().avatarUrl).toContain('http');

    const me = await test.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: user.auth,
    });
    expect(me.json().user.avatarUrl).toBeTruthy();
  });

  it('rejects a non-image avatar', async () => {
    const response = await upload(
      user,
      'notes.txt',
      'text/plain',
      Buffer.from('not an image'),
      '/api/files/avatar',
    );

    expect(response.statusCode).toBe(415);
  });
});

describe('server icons', () => {
  it('requires MANAGE_SERVER', async () => {
    const response = await upload(
      other,
      'icon.png',
      'image/png',
      TINY_PNG,
      `/api/files/icon/${ids.serverId}`,
    );

    // `other` is not even a member, so the server should not be discoverable.
    expect([403, 404]).toContain(response.statusCode);
  });

  it('lets the owner set it', async () => {
    const response = await upload(
      user,
      'icon.png',
      'image/png',
      TINY_PNG,
      `/api/files/icon/${ids.serverId}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().iconUrl).toContain('http');
  });
});

/**
 * Serving uploaded files over HTTP.
 *
 * These use the *real* on-disk storage driver rather than the in-memory fake, because the
 * fake never touches the `/uploads` static route — and that gap once hid a bug where
 * serving an existing file threw inside the send pipeline. It did not surface as a 500:
 * the response simply never completed, so the request hung until the client gave up.
 */
describe('serving uploaded files', () => {
  let disk: TestApp;
  let owner: TestUser;

  beforeAll(async () => {
    disk = await createTestApp({ realStorage: true });
    owner = await registerUser(disk, { username: 'diskuser' });
  });

  afterAll(async () => {
    await disk.close();
  });

  /** Upload through the real pipeline and return the path under /uploads. */
  async function uploadAndGetPath(fileName: string, contentType: string, data: Buffer) {
    const { body, headers } = multipart(fileName, contentType, data);
    const response = await disk.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { ...owner.auth, ...headers },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    const url = response.json().attachment.url as string;
    return url.slice(url.indexOf('/uploads/'));
  }

  it('serves the bytes back, byte for byte', async () => {
    const path = await uploadAndGetPath('pixel.png', 'image/png', TINY_PNG);

    const served = await disk.app.inject({ method: 'GET', url: path });

    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(TINY_PNG)).toBe(true);
  });

  it('sets the hardening headers on the response', async () => {
    const path = await uploadAndGetPath('pixel.png', 'image/png', TINY_PNG);
    const served = await disk.app.inject({ method: 'GET', url: path });

    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(String(served.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(served.headers['cache-control'])).toContain('immutable');
  });

  it('renders images inline but forces everything else to download', async () => {
    const image = await uploadAndGetPath('inline.png', 'image/png', TINY_PNG);
    const text = await uploadAndGetPath('notes.txt', 'text/plain', Buffer.from('plain text\n'));

    const servedImage = await disk.app.inject({ method: 'GET', url: image });
    const servedText = await disk.app.inject({ method: 'GET', url: text });

    // An image is safe to show in place.
    expect(servedImage.headers['content-disposition']).toBeUndefined();
    // Anything else downloads, so a crafted file cannot be navigated to and executed
    // as a document in the app's own origin.
    expect(servedText.headers['content-disposition']).toBe('attachment');
  });

  it('404s for a file that does not exist', async () => {
    const served = await disk.app.inject({
      method: 'GET',
      url: '/uploads/attachments/2026-01/nothing-here.png',
    });

    expect(served.statusCode).toBe(404);
  });
});
