/**
 * Generic SMTP driver.
 *
 * This is the escape hatch from every hosted provider's onboarding problem. The HTTP APIs
 * are pleasant right up until the provider decides your account needs approving (Brevo)
 * or that you cannot email anyone but yourself without a domain (Resend). SMTP has neither
 * gate: an ordinary mailbox will relay for you today.
 *
 * Gmail is the common case -- 500 recipients a day, no domain, no review queue. It needs
 * an *app password*, not the account password, which in turn needs 2-Step Verification
 * switched on. Any other SMTP service works the same way.
 *
 * Deliverability is generally better than a cold provider account, because the mail
 * leaves an established, reputable relay.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailDriver, EmailMessage } from './types.js';

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
}

export function createSmtpDriver(options: SmtpOptions): EmailDriver {
  /*
   * Built once and reused. Nodemailer pools connections behind this object, so creating
   * one per message would open a fresh TLS handshake every time -- and some relays treat
   * a burst of new connections as abuse.
   */
  let transport: Transporter | null = null;

  function getTransport(): Transporter {
    if (transport) return transport;
    transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      // 465 is implicit TLS; 587 and 25 start in the clear and upgrade via STARTTLS.
      secure: options.port === 465,
      auth: { user: options.user, pass: options.password },
      pool: true,
      maxConnections: 2,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return transport;
  }

  return {
    name: 'smtp',
    canDeliver: true,

    async send(message: EmailMessage): Promise<void> {
      try {
        await getTransport().sendMail({
          from: options.fromName
            ? `"${options.fromName.replace(/"/g, '')}" <${options.fromEmail}>`
            : options.fromEmail,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        /*
         * Two failures account for nearly every SMTP setup problem, and the raw messages
         * name neither cause nor cure. Translating them here is the difference between a
         * five-minute fix and an evening.
         */
        if (/invalid login|authentication failed|535|badcredentials/i.test(detail)) {
          throw new Error(
            `SMTP rejected the credentials for ${options.user}. With Gmail this means an ` +
              'ordinary account password was used: generate an app password instead ' +
              '(Google Account -> Security -> App passwords), which first requires ' +
              `2-Step Verification. Original error: ${detail}`,
          );
        }
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(detail)) {
          throw new Error(
            `Could not reach ${options.host}:${options.port}. Some hosts block outbound ` +
              `SMTP on port 25 -- use 587 or 465. Original error: ${detail}`,
          );
        }

        throw new Error(`SMTP send failed: ${detail}`);
      }
    },
  };
}
