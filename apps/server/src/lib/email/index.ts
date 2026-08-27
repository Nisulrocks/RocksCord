/**
 * Email delivery.
 *
 * Mirrors `lib/storage`: a driver is resolved lazily from configuration, and tests swap in
 * a fake through `setEmailDriver`. Nothing above this module knows which transport is in
 * use, so adding a provider means adding one file, not editing the auth routes.
 *
 * The default transport prints to the log rather than failing. That is deliberate -- the
 * app's whole premise is that it boots with an empty environment, so "no email account
 * configured" has to be a working state, not an error.
 */

import { env } from '../../env.js';
import { createBrevoDriver } from './brevo.js';
import {
  verificationHtml,
  verificationSubject,
  verificationText,
} from './templates.js';
import type { EmailDriver, EmailMessage } from './types.js';

export type { EmailDriver, EmailMessage } from './types.js';

const APP_NAME = 'RocksCord';

/**
 * The fallback transport: renders the message to the server log and delivers nothing.
 *
 * Printing the link in full is intentional. On a local or desktop install this *is* the
 * delivery mechanism -- you copy it out of the terminal. It is not a leak, because
 * anybody who can read the server's log already has far more than one account's worth of
 * access.
 */
function createConsoleDriver(log: (line: string) => void): EmailDriver {
  return {
    name: 'console',
    canDeliver: false,
    async send(message: EmailMessage): Promise<void> {
      const link = message.text.match(/https?:\/\/\S+/)?.[0] ?? '(no link in body)';
      log(
        `\n${'-'.repeat(72)}\n` +
          `  EMAIL (not sent -- no provider configured)\n` +
          `  To:      ${message.to}\n` +
          `  Subject: ${message.subject}\n` +
          `  Link:    ${link}\n` +
          `${'-'.repeat(72)}\n`,
      );
    },
  };
}

let override: EmailDriver | null = null;
let resolved: EmailDriver | null = null;

/** Replace the driver (tests) or clear the override by passing null. */
export function setEmailDriver(driver: EmailDriver | null): void {
  override = driver;
  resolved = null;
}

export function getEmailDriver(): EmailDriver {
  if (override) return override;
  if (resolved) return resolved;

  resolved = createDriver(resolveDriverName());
  return resolved;
}

type DriverName = 'brevo' | 'console';

/**
 * Work out which transport to use.
 *
 * `auto` reads the credentials rather than asking for the provider's name twice: a key
 * means Brevo, no key means the log.
 */
function resolveDriverName(): DriverName {
  if (env.EMAIL_DRIVER !== 'auto') return env.EMAIL_DRIVER;
  return env.EMAIL_API_KEY ? 'brevo' : 'console';
}

function createDriver(name: DriverName): EmailDriver {
  if (name === 'brevo') {
    return createBrevoDriver({
      apiKey: env.EMAIL_API_KEY,
      fromEmail: env.EMAIL_FROM,
      fromName: env.EMAIL_FROM_NAME,
    });
  }
  return createConsoleDriver((line) => console.log(line));
}

/**
 * Whether an account must confirm its address before it can sign in.
 *
 * Off unless `REQUIRE_EMAIL_VERIFICATION` explicitly turns it on -- deliberately a single
 * switch rather than something inferred from the configuration.
 *
 * It used to follow whether a provider looked usable, which was wrong in the way that
 * matters: "a key is present" and "this provider will actually deliver" are different
 * claims, and every free provider has some gate between them -- an account awaiting
 * manual approval, a domain requirement, a host blocking the port. Inferring from the
 * former locked people out of their own accounts whenever the latter turned out false.
 *
 * Turning it on is therefore a decision made after mail has been seen to arrive, not a
 * side effect of pasting a key. `npm run test:email` is how you check.
 */
export function emailVerificationRequired(): boolean {
  return env.REQUIRE_EMAIL_VERIFICATION === true;
}

/** Human-readable form of the link lifetime, for the email body. */
function describeTtl(seconds: number): string {
  const hours = Math.round(seconds / 3600);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 2) return `${hours} hours`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minutes`;
}

export interface VerificationEmail {
  to: string;
  /** Shown in the greeting. */
  name: string;
  /** The absolute confirmation URL. */
  link: string;
}

export async function sendVerificationEmail(input: VerificationEmail): Promise<void> {
  const templateInput = {
    name: input.name,
    link: input.link,
    expiresIn: describeTtl(env.EMAIL_VERIFICATION_TTL_SECONDS),
    appName: APP_NAME,
  };

  await getEmailDriver().send({
    to: input.to,
    subject: verificationSubject(APP_NAME),
    html: verificationHtml(templateInput),
    text: verificationText(templateInput),
  });
}
