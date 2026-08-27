/**
 * Email verification.
 *
 * Two harnesses run side by side here, and the split is the point:
 *
 *   `{ email: true }`  installs a driver that reports it can deliver, so the server
 *                      enforces verification — the deployed configuration.
 *   plain harness      falls through to the console transport, which cannot deliver, so
 *                      verification is off — the offline desktop configuration.
 *
 * Both are shipped, so both are tested. The second suite exists to prove that adding this
 * feature did not quietly break the install that has no email provider at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, registerPending, type TestApp } from './helpers.js';
import { emailVerifications, users } from '../src/db/schema.js';

describe('with an email provider configured', () => {
  let test: TestApp;

  beforeEach(async () => {
    test = await createTestApp({ email: true });
  });

  afterEach(async () => {
    await test.close();
  });

  const register = (payload: Record<string, unknown>) =>
    test.app.inject({ method: 'POST', url: '/api/auth/register', payload });

  const login = (identifier: string, password: string) =>
    test.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password } });

  const visitLink = (token: string) =>
    test.app.inject({
      method: 'GET',
      url: `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    });

  /* ---------------------------------------------------------------------- */

  it('creates the account but withholds a session until the address is confirmed', async () => {
    const response = await register({
      email: 'newcomer@test.local',
      username: 'newcomer',
      password: 'correct horse battery',
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.verificationRequired).toBe(true);
    expect(body.email).toBe('newcomer@test.local');

    // The significant assertion: no credentials of any kind came back.
    expect(body.accessToken).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();

    const [row] = await test.db
      .select()
      .from(users)
      .where(eq(users.email, 'newcomer@test.local'));
    expect(row).toBeDefined();
    expect(row!.emailVerifiedAt).toBeNull();
  });

  it('sends exactly one email, addressed to the registrant, containing a usable link', async () => {
    await register({
      email: 'mailcheck@test.local',
      username: 'mailcheck',
      password: 'correct horse battery',
    });

    expect(test.mail!.sent).toHaveLength(1);
    const message = test.mail!.sent[0]!;
    expect(message.to).toBe('mailcheck@test.local');
    expect(message.subject).toMatch(/confirm/i);
    // Both parts are always sent: HTML-only mail scores badly with spam filters.
    expect(message.html).toContain('<html');
    expect(message.text.length).toBeGreaterThan(0);

    expect(test.mail!.lastLink()).toContain('/api/auth/verify-email?token=');
  });

  it('refuses to sign in an unverified account and names the address to confirm', async () => {
    await register({
      email: 'unconfirmed@test.local',
      username: 'unconfirmed',
      password: 'correct horse battery',
    });

    const response = await login('unconfirmed@test.local', 'correct horse battery');

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(response.json().error.email).toBe('unconfirmed@test.local');
  });

  it('still rejects a wrong password on an unverified account as bad credentials', async () => {
    await register({
      email: 'wrongpass@test.local',
      username: 'wrongpass',
      password: 'correct horse battery',
    });

    const response = await login('wrongpass@test.local', 'not the password');

    /*
     * The password is checked before the verification state, so this endpoint cannot be
     * used to discover which addresses are registered — an unverified account with a bad
     * password must look identical to no account at all.
     */
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('confirms the address from the link and then allows sign-in', async () => {
    const account = await registerPending(test);

    const visited = await visitLink(account.token);
    expect(visited.statusCode).toBe(200);
    expect(visited.headers['content-type']).toMatch(/text\/html/);
    expect(visited.body).toMatch(/confirmed/i);

    const [row] = await test.db.select().from(users).where(eq(users.email, account.email));
    expect(row!.emailVerifiedAt).not.toBeNull();

    const signedIn = await login(account.email, account.password);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().accessToken).toBeTruthy();
    expect(signedIn.json().user.emailVerified).toBe(true);
  });

  it('reports success, not an error, when a link is opened twice', async () => {
    const account = await registerPending(test);

    await visitLink(account.token);
    const second = await visitLink(account.token);

    // Mail scanners pre-fetch links. Telling the human who follows behind them that
    // something went wrong would be both alarming and false.
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatch(/already confirmed/i);
  });

  it('rejects a token that was never issued', async () => {
    const response = await visitLink('a'.repeat(43));
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/not valid/i);
  });

  it('rejects a token that has expired', async () => {
    const account = await registerPending(test);

    await test.db
      .update(emailVerifications)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(emailVerifications.email, account.email));

    const response = await visitLink(account.token);
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/expired/i);

    const [row] = await test.db.select().from(users).where(eq(users.email, account.email));
    expect(row!.emailVerifiedAt).toBeNull();
  });

  it('rejects a token whose address no longer matches the account', async () => {
    const account = await registerPending(test);

    // Simulate the address being changed after the link went out.
    await test.db
      .update(users)
      .set({ email: 'moved@test.local' })
      .where(eq(users.email, account.email));

    const response = await visitLink(account.token);
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/out of date/i);
  });

  it('escapes hostile input rather than reflecting it into the page', async () => {
    const response = await visitLink('"><script>alert(1)</script>aaaaaaaaaaaaaaaaaaaa');
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('<script>alert(1)</script>');
  });

  describe('resending', () => {
    /** Age the outstanding token so the cooldown check passes without a real wait. */
    const stepPastCooldown = (email: string) =>
      test.db
        .update(emailVerifications)
        .set({ createdAt: Date.now() - 120_000 })
        .where(eq(emailVerifications.email, email));

    const resend = (email: string) =>
      test.app.inject({
        method: 'POST',
        url: '/api/auth/resend-verification',
        payload: { email },
      });

    it('issues a fresh link and retires the previous one', async () => {
      const account = await registerPending(test);
      const firstToken = account.token;

      await stepPastCooldown(account.email);

      const resent = await resend(account.email);
      expect(resent.statusCode).toBe(200);
      expect(test.mail!.sent).toHaveLength(2);

      const secondToken = test.mail!.lastToken();
      expect(secondToken).not.toBe(firstToken);

      // The superseded link must be dead, or every resend would leave another working
      // credential sitting in the mailbox.
      expect((await visitLink(firstToken)).statusCode).toBe(400);
      expect((await visitLink(secondToken)).statusCode).toBe(200);
    });

    it('stays silent about whether the address exists', async () => {
      const account = await registerPending(test);
      const sentSoFar = test.mail!.sent.length;

      const unknown = await resend('nobody-at-all@test.local');

      await stepPastCooldown(account.email);
      const known = await resend(account.email);

      expect(unknown.statusCode).toBe(known.statusCode);
      expect(unknown.json()).toEqual(known.json());
      // Identical answers, but only the real account actually generated a message.
      expect(test.mail!.sent.length).toBe(sentSoFar + 1);
    });

    it('does not send again inside the cooldown window', async () => {
      const account = await registerPending(test);
      const sentSoFar = test.mail!.sent.length;

      const response = await resend(account.email);

      expect(response.statusCode).toBe(200);
      expect(test.mail!.sent.length).toBe(sentSoFar);
    });

    it('does not send to an address that is already confirmed', async () => {
      const account = await registerPending(test);
      await visitLink(account.token);
      const sentSoFar = test.mail!.sent.length;

      await stepPastCooldown(account.email);
      const response = await resend(account.email);

      expect(response.statusCode).toBe(200);
      expect(test.mail!.sent.length).toBe(sentSoFar);
    });
  });

  it('advertises the requirement so the client can word its screens correctly', async () => {
    const response = await test.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(response.json().requireEmailVerification).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('with no email provider configured', () => {
  let test: TestApp;

  beforeEach(async () => {
    test = await createTestApp();
  });

  afterEach(async () => {
    await test.close();
  });

  const register = (email: string, username: string) =>
    test.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, username, password: 'correct horse battery' },
    });

  it('signs the user in immediately, because no link could ever arrive', async () => {
    const response = await register('offline@test.local', 'offline');

    expect(response.statusCode).toBe(201);
    expect(response.json().accessToken).toBeTruthy();
    expect(response.json().user.emailVerified).toBe(true);
  });

  it('marks the account verified in the database rather than leaving it in limbo', async () => {
    await register('limbo@test.local', 'limbo');

    const [row] = await test.db.select().from(users).where(eq(users.email, 'limbo@test.local'));
    /*
     * Otherwise switching a provider on later would strand every account created before
     * it, since no verification row exists for them to confirm against.
     */
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it('reports the requirement as off', async () => {
    const response = await test.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(response.json().requireEmailVerification).toBe(false);
  });
});
