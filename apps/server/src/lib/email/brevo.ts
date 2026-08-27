/**
 * Brevo transactional email driver.
 *
 * Brevo was chosen over the alternatives for one specific reason: its free tier
 * (300 messages/day, no card, no expiry) lets you send to *arbitrary* recipients after
 * verifying a single sender address. Resend and Mailgun's free tiers only reach addresses
 * you control unless you own a domain, which makes them useless for inviting friends.
 *
 * It speaks plain HTTPS+JSON, so this needs no SDK -- one `fetch` against the global
 * agent, which keeps the dependency list and the packaged desktop build smaller.
 */

import type { EmailDriver, EmailMessage } from './types.js';

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/** Give up rather than hold a request open indefinitely if the API stalls. */
const TIMEOUT_MS = 10_000;

export interface BrevoOptions {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

export function createBrevoDriver({ apiKey, fromEmail, fromName }: BrevoOptions): EmailDriver {
  return {
    name: 'brevo',
    canDeliver: true,

    async send(message: EmailMessage): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'api-key': apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            sender: { email: fromEmail, name: fromName },
            to: [{ email: message.to }],
            subject: message.subject,
            htmlContent: message.html,
            textContent: message.text,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Brevo did not respond within ${TIMEOUT_MS / 1000}s`);
        }
        throw new Error(
          `Could not reach Brevo: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return;

      /*
       * Brevo's error bodies are genuinely useful ("sender not valid", "IP not allowed"),
       * and these are configuration mistakes an operator has to see to fix. The body is
       * capped because it reaches the server log, and a caller never sees it: the routes
       * translate every send failure into a generic message.
       */
      const body = await response.text().catch(() => '');
      throw new Error(
        `Brevo rejected the message (HTTP ${response.status}): ${body.slice(0, 500) || 'no body'}`,
      );
    },
  };
}
