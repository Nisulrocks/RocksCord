/**
 * Resend transactional email driver.
 *
 * **Read this before choosing Resend.** Its free tier cannot email your users unless you
 * own a domain. Until a domain is verified, an account may only send from
 * `onboarding@resend.dev`, and messages from that address are delivered *only* to the
 * address the Resend account itself was registered with. It is a sandbox, not a starter
 * tier -- a signup confirmation sent to a new user simply never arrives, with a `200` on
 * the API call and nothing in the logs to explain it.
 *
 * With a verified domain it is excellent, and the free allowance (3,000/month, 100/day)
 * is generous. `EMAIL_FROM` then has to be an address at that domain.
 *
 * Like the Brevo driver this is one `fetch` against a JSON API, so it needs no SDK.
 */

import type { EmailDriver, EmailMessage } from './types.js';

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export interface ResendOptions {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

export function createResendDriver({ apiKey, fromEmail, fromName }: ResendOptions): EmailDriver {
  return {
    name: 'resend',
    canDeliver: true,

    async send(message: EmailMessage): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            // Resend takes RFC 5322 form rather than a structured sender object.
            from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Resend did not respond within ${TIMEOUT_MS / 1000}s`);
        }
        throw new Error(
          `Could not reach Resend: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return;

      const body = await response.text().catch(() => '');

      /*
       * The sandbox restriction surfaces as a 403 naming the recipient. Left as-is it
       * reads like a bug in this app, so it is translated into the thing that has to
       * change.
       */
      if (response.status === 403 && /testing emails|own email address|verify a domain/i.test(body)) {
        throw new Error(
          'Resend refused the recipient: without a verified domain it only delivers to ' +
            'the address your Resend account was registered with. Verify a domain, or use ' +
            'a provider that does not require one. Original response: ' +
            body.slice(0, 300),
        );
      }

      throw new Error(
        `Resend rejected the message (HTTP ${response.status}): ${body.slice(0, 500) || 'no body'}`,
      );
    },
  };
}
