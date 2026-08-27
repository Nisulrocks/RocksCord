/**
 * Transport selection.
 *
 * `EMAIL_DRIVER=auto` infers the provider from whichever credentials happen to be set,
 * which spares operators from naming the provider twice but makes the choice implicit --
 * and an implicit choice that picks wrong fails in the worst possible way, by accepting a
 * message that never arrives. Each rule is pinned here.
 *
 * The prefixes are the providers' own: SMTP2GO issues `api-…`, Resend `re_…`, Brevo
 * `xkeysib-…`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { getEmailDriver, emailVerificationRequired, setEmailDriver } from '../src/lib/email/index.js';

/** Snapshot of every field the resolver reads, so each case starts from a clean slate. */
const KEYS = [
  'EMAIL_DRIVER',
  'EMAIL_API_KEY',
  'EMAIL_FROM',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'REQUIRE_EMAIL_VERIFICATION',
] as const;

const original = Object.fromEntries(KEYS.map((key) => [key, env[key]])) as Record<string, unknown>;

function configure(values: Partial<Record<(typeof KEYS)[number], unknown>>) {
  for (const key of KEYS) {
    (env as Record<string, unknown>)[key] = key in values ? values[key] : '';
  }
  (env as Record<string, unknown>).EMAIL_DRIVER = values.EMAIL_DRIVER ?? 'auto';
  (env as Record<string, unknown>).REQUIRE_EMAIL_VERIFICATION = values.REQUIRE_EMAIL_VERIFICATION;
  // Clear the memoised driver so the next lookup re-runs the inference.
  setEmailDriver(null);
}

afterEach(() => {
  for (const key of KEYS) (env as Record<string, unknown>)[key] = original[key];
  setEmailDriver(null);
});

describe('choosing a transport from configuration', () => {
  it('falls back to the console when nothing is configured', () => {
    configure({});
    expect(getEmailDriver().name).toBe('console');
  });

  it('recognises an SMTP2GO key by its prefix', () => {
    configure({ EMAIL_API_KEY: 'api-abc123', EMAIL_FROM: 'me@example.com' });
    expect(getEmailDriver().name).toBe('smtp2go');
  });

  it('recognises a Resend key by its prefix', () => {
    configure({ EMAIL_API_KEY: 're_abc123', EMAIL_FROM: 'me@example.com' });
    expect(getEmailDriver().name).toBe('resend');
  });

  it('treats any other key as Brevo', () => {
    configure({ EMAIL_API_KEY: 'xkeysib-abc123', EMAIL_FROM: 'me@example.com' });
    expect(getEmailDriver().name).toBe('brevo');
  });

  it('uses SMTP when a host, user and password are given', () => {
    configure({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASSWORD: 'pw' });
    expect(getEmailDriver().name).toBe('smtp');
  });

  it('ignores half-configured SMTP rather than failing at send time', () => {
    // A host with no credentials cannot authenticate anywhere; selecting it would turn a
    // configuration mistake into a runtime error on somebody's registration.
    configure({ SMTP_HOST: 'smtp.gmail.com' });
    expect(getEmailDriver().name).toBe('console');
  });

  it('prefers an API key over SMTP when both are present', () => {
    /*
     * SMTP is the more fragile of the two -- several free hosts block outbound SMTP ports
     * entirely -- so an operator holding both almost certainly added the key second, to
     * work around exactly that.
     */
    configure({
      EMAIL_API_KEY: 'api-abc123',
      EMAIL_FROM: 'me@example.com',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'me@gmail.com',
      SMTP_PASSWORD: 'pw',
    });
    expect(getEmailDriver().name).toBe('smtp2go');
  });

  it('obeys an explicit driver over any inference', () => {
    configure({ EMAIL_DRIVER: 'console', EMAIL_API_KEY: 'api-abc123' });
    expect(getEmailDriver().name).toBe('console');
  });
});

describe('whether verification is enforced', () => {
  it('is off when mail cannot be delivered', () => {
    configure({});
    expect(emailVerificationRequired()).toBe(false);
  });

  it('turns on by itself once a provider is configured', () => {
    configure({ EMAIL_API_KEY: 'api-abc123', EMAIL_FROM: 'me@example.com' });
    expect(emailVerificationRequired()).toBe(true);
  });

  it('can be forced on with no provider, so the flow can be exercised locally', () => {
    configure({ REQUIRE_EMAIL_VERIFICATION: true });
    expect(getEmailDriver().name).toBe('console');
    expect(emailVerificationRequired()).toBe(true);
  });

  it('can be forced off while a provider is still configured', () => {
    configure({
      EMAIL_API_KEY: 'api-abc123',
      EMAIL_FROM: 'me@example.com',
      REQUIRE_EMAIL_VERIFICATION: false,
    });
    expect(emailVerificationRequired()).toBe(false);
  });
});
