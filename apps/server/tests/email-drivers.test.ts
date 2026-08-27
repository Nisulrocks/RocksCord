/**
 * Transport selection, and the switch that decides whether verification is enforced.
 *
 * The two are deliberately independent, and that separation is the whole point of these
 * tests. Enforcement used to be inferred from whether a provider looked configured, which
 * conflated "a key was accepted" with "a message was delivered" -- and every free provider
 * has some gate between the two: an account awaiting manual approval, a domain
 * requirement, a host blocking the port. Inferring from the first locked people out of
 * their own accounts whenever the second turned out false.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import {
  emailVerificationRequired,
  getEmailDriver,
  setEmailDriver,
} from '../src/lib/email/index.js';

const KEYS = [
  'EMAIL_DRIVER',
  'EMAIL_API_KEY',
  'EMAIL_FROM',
  'REQUIRE_EMAIL_VERIFICATION',
] as const;

const original = Object.fromEntries(KEYS.map((key) => [key, env[key]])) as Record<string, unknown>;

function configure(values: Partial<Record<(typeof KEYS)[number], unknown>>) {
  const target = env as Record<string, unknown>;
  target.EMAIL_DRIVER = values.EMAIL_DRIVER ?? 'auto';
  target.EMAIL_API_KEY = values.EMAIL_API_KEY ?? '';
  target.EMAIL_FROM = values.EMAIL_FROM ?? '';
  target.REQUIRE_EMAIL_VERIFICATION = values.REQUIRE_EMAIL_VERIFICATION ?? false;
  // Clear the memoised driver so the next lookup re-runs the inference.
  setEmailDriver(null);
}

afterEach(() => {
  for (const key of KEYS) (env as Record<string, unknown>)[key] = original[key];
  setEmailDriver(null);
});

describe('choosing a transport', () => {
  it('falls back to the console when no key is configured', () => {
    configure({});
    expect(getEmailDriver().name).toBe('console');
  });

  it('uses Brevo once a key is present', () => {
    configure({ EMAIL_API_KEY: 'xkeysib-abc123', EMAIL_FROM: 'me@example.com' });
    expect(getEmailDriver().name).toBe('brevo');
  });

  it('obeys an explicit driver over the inference', () => {
    configure({ EMAIL_DRIVER: 'console', EMAIL_API_KEY: 'xkeysib-abc123' });
    expect(getEmailDriver().name).toBe('console');
  });

  it('reports whether the chosen transport can actually deliver', () => {
    configure({});
    expect(getEmailDriver().canDeliver).toBe(false);

    configure({ EMAIL_API_KEY: 'xkeysib-abc123', EMAIL_FROM: 'me@example.com' });
    expect(getEmailDriver().canDeliver).toBe(true);
  });
});

describe('whether verification is enforced', () => {
  it('is off by default', () => {
    configure({});
    expect(emailVerificationRequired()).toBe(false);
  });

  it('stays off merely because a provider is configured', () => {
    /*
     * The regression this guards against. A key proves only that a key was pasted in --
     * Brevo, for one, accepts a key perfectly and then refuses every send until it has
     * approved the account by hand. Enforcing on that basis produced accounts that could
     * never sign in and never receive the link that would fix it.
     */
    configure({ EMAIL_API_KEY: 'xkeysib-abc123', EMAIL_FROM: 'me@example.com' });
    expect(getEmailDriver().canDeliver).toBe(true);
    expect(emailVerificationRequired()).toBe(false);
  });

  it('turns on when asked', () => {
    configure({
      EMAIL_API_KEY: 'xkeysib-abc123',
      EMAIL_FROM: 'me@example.com',
      REQUIRE_EMAIL_VERIFICATION: true,
    });
    expect(emailVerificationRequired()).toBe(true);
  });

  it('can be turned on with no provider, so the flow can be exercised locally', () => {
    // Links go to the server log; you copy one out of the terminal.
    configure({ REQUIRE_EMAIL_VERIFICATION: true });
    expect(getEmailDriver().name).toBe('console');
    expect(emailVerificationRequired()).toBe(true);
  });
});
