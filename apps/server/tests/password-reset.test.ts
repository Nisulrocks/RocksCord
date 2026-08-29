/**
 * Password reset.
 *
 * Two things are being held in place here, and they pull in opposite directions.
 *
 * The token is a *credential* -- anyone holding it can take the account without knowing
 * the password -- so most of these tests are about the ways one must stop working: used
 * once, expired, superseded, or pointing at an address the account no longer has.
 *
 * The endpoint is also *unauthenticated and takes an email address*, so it must not
 * become a way to ask "does this person have an account here". That is why several tests
 * assert on a reply being boringly identical rather than on anything happening.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, registerUser, type TestApp, type TestUser } from './helpers.js';
import { passwordResets, sessions, users } from '../src/db/schema.js';

describe('password reset', () => {
  let test: TestApp;
  let user: TestUser;

  beforeEach(async () => {
    // A transport, but verification off: reset has to work in that combination too.
    test = await createTestApp({ mail: true });
    user = await registerUser(test, { email: 'forgetful@test.local' });
  });

  afterEach(async () => {
    await test.close();
  });

  const forgot = (email: string) =>
    test.app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email } });

  const reset = (token: string, newPassword: string) =>
    test.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword },
    });

  const login = (identifier: string, password: string) =>
    test.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password } });

  /** Ask for a link and lift the token back out of the captured email. */
  const requestToken = async (email = user.email) => {
    await forgot(email);
    return test.mail!.lastToken();
  };

  /* ---------------------------------------------------------------------- */
  /* The happy path                                                          */
  /* ---------------------------------------------------------------------- */

  it('emails a link that changes the password', async () => {
    const token = await requestToken();

    const response = await reset(token, 'a whole new password');
    expect(response.statusCode).toBe(200);

    expect((await login(user.email, 'a whole new password')).statusCode).toBe(200);
    expect((await login(user.email, user.password)).statusCode).toBe(401);
  });

  it('sends exactly one email, to the address that asked', async () => {
    await forgot(user.email);

    expect(test.mail!.sent).toHaveLength(1);
    expect(test.mail!.sent[0]!.to).toBe('forgetful@test.local');
    expect(test.mail!.sent[0]!.subject).toMatch(/reset/i);
  });

  it('points the link at the web form rather than the API', async () => {
    await forgot(user.email);

    /*
     * Unlike a verification link, this one cannot be a GET that does the work: it has to
     * collect a new password first. Landing on the API would show raw JSON.
     */
    expect(new URL(test.mail!.lastLink()).pathname).toBe('/reset-password');
  });

  /* ---------------------------------------------------------------------- */
  /* Not an account oracle                                                   */
  /* ---------------------------------------------------------------------- */

  it('answers an unknown address exactly as it answers a real one', async () => {
    const known = await forgot(user.email);
    const unknown = await forgot('nobody@test.local');

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
  });

  it('sends nothing for an address with no account', async () => {
    await forgot('nobody@test.local');
    expect(test.mail!.sent).toHaveLength(0);
  });

  it('does not send to a deleted account, but still says the same thing', async () => {
    await test.db
      .update(users)
      .set({ deletedAt: Date.now() })
      .where(eq(users.id, user.id));

    const response = await forgot(user.email);

    expect(response.statusCode).toBe(200);
    expect(test.mail!.sent).toHaveLength(0);
  });

  /* ---------------------------------------------------------------------- */
  /* Token lifetime                                                          */
  /* ---------------------------------------------------------------------- */

  it('refuses a token that has already been used', async () => {
    const token = await requestToken();
    await reset(token, 'first new password');

    const replay = await reset(token, 'second new password');
    expect(replay.statusCode).toBe(400);

    // And the replay changed nothing: the first password still works.
    expect((await login(user.email, 'first new password')).statusCode).toBe(200);
  });

  it('refuses an expired token', async () => {
    const token = await requestToken();

    await test.db
      .update(passwordResets)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(passwordResets.userId, user.id));

    expect((await reset(token, 'too late for this')).statusCode).toBe(400);
    expect((await login(user.email, user.password)).statusCode).toBe(200);
  });

  it('refuses a token that was never issued', async () => {
    const response = await reset('not-a-real-token', 'hopeful new password');
    expect(response.statusCode).toBe(400);
  });

  it('retires the earlier link when a second is requested', async () => {
    const first = await requestToken();

    /*
     * The cooldown is what normally stops a second send, so it is moved out of the way
     * here -- this test is about the token, not the throttle.
     */
    await test.db
      .update(passwordResets)
      .set({ createdAt: Date.now() - 120_000 })
      .where(eq(passwordResets.userId, user.id));

    const second = await requestToken();
    expect(second).not.toBe(first);

    // Two live links would mean an old email could undo a reset done with the new one.
    expect((await reset(first, 'from the stale link')).statusCode).toBe(400);
    expect((await reset(second, 'from the fresh link')).statusCode).toBe(200);
  });

  it('stops working once the account uses a different address', async () => {
    const token = await requestToken();

    await test.db
      .update(users)
      .set({ email: 'moved@test.local' })
      .where(eq(users.id, user.id));

    /*
     * The token is still unexpired and unused, but it is sitting in an inbox the account
     * has walked away from -- which is the whole reason the address is recorded on the row.
     */
    expect((await reset(token, 'from the old inbox')).statusCode).toBe(400);
  });

  /* ---------------------------------------------------------------------- */
  /* Side effects of a successful reset                                      */
  /* ---------------------------------------------------------------------- */

  it('signs out every existing session, including the one that is signed in', async () => {
    const before = await test.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: user.auth,
    });
    expect(before.statusCode).toBe(200);

    const token = await requestToken();
    await reset(token, 'locking everyone out');

    const live = await test.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(live.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('kills the access token already in flight, not just the ability to refresh', async () => {
    /*
     * The sharp end of the previous test. Revoking session rows stops *refresh*, but an
     * access token is a signed JWT that nothing consults the database about -- so on its
     * own that leaves whoever holds one with a working account for the remainder of its
     * fifteen minutes. Which is precisely the window a reset exists to close, and what
     * the reset screen tells the user has happened.
     *
     * `passwordChangedAt` is the cut-off that makes the promise true.
     */
    const token = await requestToken();
    await reset(token, 'you are out of my account');

    /*
     * The cut-off is compared at second granularity, because `iat` is whole seconds --
     * a token minted in the same second as the change is kept, which is what lets the
     * in-app "change password" hand back a working token instead of signing the caller
     * out of the tab they are looking at.
     *
     * This test registers and resets within the same millisecond, so without nudging the
     * clock it would be asserting on that grace rather than on the cut-off. A real reset
     * cannot land in the same second as the sign-in it invalidates: an email has to
     * arrive and a link has to be clicked in between.
     */
    await test.db
      .update(users)
      .set({ passwordChangedAt: Date.now() + 1000 })
      .where(eq(users.id, user.id));

    const after = await test.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: user.auth,
    });
    expect(after.statusCode).toBe(401);
  });

  it('leaves an unrelated account signed in', async () => {
    // The cut-off is per user, so one person resetting must not sign anyone else out.
    const bystander = await registerUser(test);

    const token = await requestToken();
    await reset(token, 'only my account changes');

    const response = await test.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: bystander.auth,
    });
    expect(response.statusCode).toBe(200);
  });

  it('confirms the address, since reaching the link proves the mailbox works', async () => {
    await test.db
      .update(users)
      .set({ emailVerifiedAt: null })
      .where(eq(users.id, user.id));

    const token = await requestToken();
    await reset(token, 'confirmed by arriving here');

    const [row] = await test.db.select().from(users).where(eq(users.id, user.id));
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  /* ---------------------------------------------------------------------- */
  /* Input                                                                   */
  /* ---------------------------------------------------------------------- */

  it('holds the new password to the same rules as registration', async () => {
    const token = await requestToken();

    const response = await reset(token, 'short');
    expect(response.statusCode).toBe(400);

    // Rejected before the token was spent, so the link is still usable.
    expect((await reset(token, 'a long enough password')).statusCode).toBe(200);
  });

  it('throttles repeat requests rather than sending on every press', async () => {
    await forgot(user.email);
    const second = await forgot(user.email);

    // Still the same uniform reply -- the cooldown must not be observable either.
    expect(second.statusCode).toBe(200);
    expect(test.mail!.sent).toHaveLength(1);
  });
});
