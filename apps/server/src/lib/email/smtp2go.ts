/**
 * SMTP2GO transactional email driver.
 *
 * The combination that makes this the one to reach for on a free host:
 *
 *   - an HTTPS API, so it survives hosts that block outbound SMTP ports (Render's free
 *     tier blocks 25, 465 and 587 outright, which rules out every SMTP relay including
 *     Gmail's)
 *   - **single sender** verification, so one confirmed address is enough and no domain is
 *     required, unlike Resend
 *   - no manual account review before the first send, unlike Brevo
 *
 * Free allowance is 1,000 messages a month, 200 a day, and 25 an hour until a domain is
 * verified. For an app whose users sign up once, the hourly cap is the only one worth
 * knowing about.
 *
 * One API quirk drives the shape of `send` below: a rejected message still comes back as
 * HTTP 200. The outcome is inside the body.
 */

import type { EmailDriver, EmailMessage } from './types.js';

const ENDPOINT = 'https://api.smtp2go.com/v3/email/send';
const TIMEOUT_MS = 10_000;

export interface Smtp2goOptions {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

interface Smtp2goResponse {
  data?: {
    succeeded?: number;
    failed?: number;
    failures?: string[];
    error?: string;
    error_code?: string;
    field_validation_errors?: { field?: string; message?: string };
  };
}

export function createSmtp2goDriver({ apiKey, fromEmail, fromName }: Smtp2goOptions): EmailDriver {
  return {
    name: 'smtp2go',
    canDeliver: true,

    async send(message: EmailMessage): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'X-Smtp2go-Api-Key': apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            sender: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
            to: [message.to],
            subject: message.subject,
            html_body: message.html,
            text_body: message.text,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`SMTP2GO did not respond within ${TIMEOUT_MS / 1000}s`);
        }
        throw new Error(
          `Could not reach SMTP2GO: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      const raw = await response.text().catch(() => '');

      if (!response.ok) {
        throw new Error(
          `SMTP2GO rejected the message (HTTP ${response.status}): ${raw.slice(0, 500) || 'no body'}`,
        );
      }

      /*
       * A refused message is still HTTP 200 here, with the reason in the body. Trusting
       * the status code alone would report every rejection as a successful send, which is
       * the single worst failure mode for this feature: the screen tells someone to check
       * an inbox that will never receive anything.
       */
      let parsed: Smtp2goResponse;
      try {
        parsed = JSON.parse(raw) as Smtp2goResponse;
      } catch {
        throw new Error(`SMTP2GO returned a reply that could not be read: ${raw.slice(0, 300)}`);
      }

      const data = parsed.data ?? {};
      if ((data.succeeded ?? 0) > 0) return;

      const reason =
        data.error ??
        data.field_validation_errors?.message ??
        data.failures?.join(', ') ??
        raw.slice(0, 300);

      // The sender not being a confirmed one is by far the most common cause, and the
      // API's own wording for it does not say what to do about it.
      if (/sender|from address|not verified|unverified/i.test(String(reason))) {
        throw new Error(
          `SMTP2GO refused the sender ${fromEmail}: it must be added and confirmed under ` +
            'Sending > Verified Senders (a single email address is enough; no domain is ' +
            `needed). Original response: ${reason}`,
        );
      }

      throw new Error(`SMTP2GO did not send the message: ${reason}`);
    },
  };
}
