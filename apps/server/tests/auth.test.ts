/**
 * Authentication tests.
 *
 * These cover the security-relevant behaviour, not just the happy path: password hashing,
 * account enumeration resistance, refresh-token rotation, and stolen-token detection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';
import { createTestApp, registerUser, type TestApp } from './helpers.js';

let test: TestApp;

beforeAll(async () => {
  test = await createTestApp();
});

afterAll(async () => {
  await test.close();
});

describe('registration', () => {
  it('creates an account and returns an access token', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'newbie@test.local', username: 'newbie', password: 'a-good-password' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.username).toBe('newbie');
    expect(body.accessToken).toBeTypeOf('string');
    // A 4-digit tag is allocated automatically so usernames need not be globally unique.
    expect(body.user.discriminator).toMatch(/^\d{4}$/);
  });

  it('never returns the password hash or another user email', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'secret@test.local', username: 'secretive', password: 'a-good-password' },
    });

    const raw = response.body;
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('$argon2');
  });

  it('stores an argon2id hash, never the plaintext', async () => {
    const user = await registerUser(test, { password: 'plaintext-should-not-persist' });

    const [row] = await test.db.select().from(users).where(eq(users.id, user.id));

    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.passwordHash).not.toContain('plaintext-should-not-persist');
  });

  it('allows two people to share a username with different tags', async () => {
    const first = await registerUser(test, { username: 'twins', email: 'twin1@test.local' });
    const second = await registerUser(test, { username: 'twins', email: 'twin2@test.local' });

    expect(first.username).toBe(second.username);
    expect(first.discriminator).not.toBe(second.discriminator);
  });

  it('rejects a duplicate email', async () => {
    await registerUser(test, { email: 'taken@test.local' });

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'taken@test.local', username: 'other', password: 'a-good-password' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ALREADY_EXISTS');
  });

  it('rejects a weak password with a field-level error', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'weak@test.local', username: 'weakling', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.password).toBeDefined();
  });

  it('rejects reserved usernames', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'admin@test.local', username: 'admin', password: 'a-good-password' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('login', () => {
  it('accepts an email, a username, or a full handle', async () => {
    const user = await registerUser(test, { username: 'multi', email: 'multi@test.local' });

    for (const identifier of [
      user.email,
      user.username,
      `${user.username}#${user.discriminator}`,
    ]) {
      const response = await test.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier, password: user.password },
      });
      expect(response.statusCode, `identifier: ${identifier}`).toBe(200);
    }
  });

  it('rejects a wrong password', async () => {
    const user = await registerUser(test);

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: user.email, password: 'not-the-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('gives the same error for an unknown account as for a wrong password', async () => {
    const user = await registerUser(test);

    const unknown = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'nobody@test.local', password: 'whatever' },
    });
    const wrongPassword = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: user.email, password: 'whatever' },
    });

    // Identical status *and* message: the response must not reveal which accounts exist.
    expect(unknown.statusCode).toBe(wrongPassword.statusCode);
    expect(unknown.json().error.message).toBe(wrongPassword.json().error.message);
  });

  it('sets an httpOnly refresh cookie', async () => {
    const user = await registerUser(test);

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: user.email, password: user.password },
    });

    const setCookie = response.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);

    expect(cookie).toContain('rockscord_refresh=');
    // httpOnly is what stops an XSS from stealing the long-lived credential.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/SameSite=(Lax|None)/i);
  });
});

describe('authorisation', () => {
  it('rejects a request with no token', async () => {
    const response = await test.app.inject({ method: 'GET', url: '/api/servers' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a forged token', async () => {
    const response = await test.app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.notreal' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a valid token', async () => {
    const user = await registerUser(test);
    const response = await test.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: user.auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(user.id);
  });
});

describe('refresh token rotation', () => {
  it('exchanges a refresh cookie for a new access token', async () => {
    const user = await registerUser(test);

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: user.refreshCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeTypeOf('string');
  });

  it('issues a different refresh token on every use', async () => {
    const user = await registerUser(test);

    const first = await test.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: user.refreshCookie },
    });

    const firstCookie = String(first.headers['set-cookie']).split(';')[0];
    expect(firstCookie).not.toBe(user.refreshCookie);
  });

  it('revokes every session when a used refresh token is replayed', async () => {
    const user = await registerUser(test);

    // Legitimate rotation.
    const rotated = await test.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: user.refreshCookie },
    });
    expect(rotated.statusCode).toBe(200);
    const newCookie = String(rotated.headers['set-cookie']).split(';')[0]!;

    // An attacker replays the *old* token. This is the theft signal.
    const replay = await test.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: user.refreshCookie },
    });
    expect(replay.statusCode).toBe(401);

    // The legitimate token is now dead too -- the whole family was revoked.
    const afterBreach = await test.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: newCookie },
    });
    expect(afterBreach.statusCode).toBe(401);
  });

  it('rejects refresh with no cookie', async () => {
    const response = await test.app.inject({ method: 'POST', url: '/api/auth/refresh' });
    expect(response.statusCode).toBe(401);
  });
});

describe('password change', () => {
  it('requires the current password', async () => {
    const user = await registerUser(test);

    const response = await test.app.inject({
      method: 'PATCH',
      url: '/api/auth/password',
      headers: user.auth,
      payload: { currentPassword: 'wrong-one', newPassword: 'a-brand-new-password' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('changes the password and invalidates old refresh tokens', async () => {
    const user = await registerUser(test);

    const changed = await test.app.inject({
      method: 'PATCH',
      url: '/api/auth/password',
      headers: { ...user.auth, cookie: user.refreshCookie },
      payload: { currentPassword: user.password, newPassword: 'a-brand-new-password' },
    });
    expect(changed.statusCode).toBe(200);

    // Old password no longer works.
    const oldLogin = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: user.email, password: user.password },
    });
    expect(oldLogin.statusCode).toBe(401);

    // New one does.
    const newLogin = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: user.email, password: 'a-brand-new-password' },
    });
    expect(newLogin.statusCode).toBe(200);

    // Sessions elsewhere were terminated.
    const staleRefresh = await test.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: user.refreshCookie },
    });
    expect(staleRefresh.statusCode).toBe(401);
  });
});

describe('request parsing', () => {
  it('accepts a bodyless POST that still declares a JSON content type', async () => {
    // Clients commonly set Content-Type unconditionally. Fastify's default parser
    // rejects that with an empty body, which produced a confusing 400 on routes that
    // legitimately take no body (accept invite, logout, refresh).
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
  });

  it('still rejects genuinely malformed JSON', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{ not valid json',
    });

    expect(response.statusCode).toBe(400);
  });
});
