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
import { createResendDriver } from './resend.js';
import { createSmtpDriver } from './smtp.js';
import { createSmtp2goDriver } from './smtp2go.js';
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

/**
 * Work out which transport to use.
 *
 * `auto` reads the credentials rather than asking for the provider's name twice. SMTP
 * wins when configured because it is the only option with no approval queue and no domain
 * requirement, so an operator who has bothered to set it up wants it used. Between the two
 * HTTP providers the key itself is unambiguous: Resend issues `re_...`, Brevo `xkeysib-...`.
 */
type DriverName = 'smtp2go' | 'smtp' | 'brevo' | 'resend' | 'console';

function resolveDriverName(): DriverName {
  if (env.EMAIL_DRIVER !== 'auto') return env.EMAIL_DRIVER;
  /*
   * An API key wins over SMTP when both are present. SMTP is the more fragile of the two
   * in practice -- several free hosts block outbound SMTP ports entirely -- so an
   * operator who has configured both almost certainly added the key second, to fix that.
   */
  if (env.EMAIL_API_KEY.startsWith('api-')) return 'smtp2go';
  if (env.EMAIL_API_KEY.startsWith('re_')) return 'resend';
  if (env.EMAIL_API_KEY) return 'brevo';
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD) return 'smtp';
  return 'console';
}

function createDriver(name: DriverName): EmailDriver {
  const from = { fromEmail: env.EMAIL_FROM, fromName: env.EMAIL_FROM_NAME };

  switch (name) {
    case 'smtp2go':
      return createSmtp2goDriver({ apiKey: env.EMAIL_API_KEY, ...from });
    case 'smtp':
      return createSmtpDriver({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        ...from,
      });
    case 'brevo':
      return createBrevoDriver({ apiKey: env.EMAIL_API_KEY, ...from });
    case 'resend':
      return createResendDriver({ apiKey: env.EMAIL_API_KEY, ...from });
    default:
      return createConsoleDriver((line) => console.log(line));
  }
}

/**
 * Whether an account must confirm its address before it can sign in.
 *
 * An explicit `REQUIRE_EMAIL_VERIFICATION` always wins. Otherwise it tracks whether mail
 * can be delivered at all, so a deployment with a provider enforces it and an offline
 * install does not.
 */
export function emailVerificationRequired(): boolean {
  if (env.REQUIRE_EMAIL_VERIFICATION !== undefined) return env.REQUIRE_EMAIL_VERIFICATION;
  return getEmailDriver().canDeliver;
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
