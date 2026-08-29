/**
 * Email bodies.
 *
 * Two rules shape everything here.
 *
 * **Every interpolated value is escaped.** A username is attacker-chosen text being
 * pasted into an HTML document that renders in someone else's mail client, which is the
 * same threat model as rendering it in the app -- and mail clients are worse at
 * containing it. `escapeHtml` is applied at every boundary without exception.
 *
 * **Layout is 2003-era on purpose.** Mail clients are not browsers: Gmail strips `<style>`
 * blocks, Outlook renders through Word. Inline styles on nested tables is the only thing
 * that survives all of them, so the markup looks nothing like the app's own CSS.
 */

/** Escape the five characters that can break out of HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND = '#6c5cff';
const INK = '#1c1c28';
const DIM = '#5c5c70';

export interface VerificationTemplateInput {
  /** Display name or username, shown in the greeting. */
  name: string;
  /** Absolute URL that confirms the address. */
  link: string;
  /** Human-readable validity window, e.g. "24 hours". */
  expiresIn: string;
  /** Product name, so a fork does not have to edit the markup. */
  appName: string;
}

export function verificationSubject(appName: string): string {
  return `Confirm your ${appName} email address`;
}

/**
 * The plain-text alternative is not a formality -- spam filters score messages that ship
 * HTML only, and some clients show nothing else. It carries the same information.
 */
export function verificationText({ name, link, expiresIn, appName }: VerificationTemplateInput): string {
  return [
    `Hi ${name},`,
    '',
    `Confirm this email address to finish setting up your ${appName} account:`,
    '',
    link,
    '',
    `The link expires in ${expiresIn}.`,
    '',
    `If you did not create a ${appName} account, you can ignore this message -- `,
    'nothing was set up and no further email will be sent.',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Shared layout                                                               */
/* -------------------------------------------------------------------------- */

interface ActionEmailInput {
  appName: string;
  /** Greeting name. */
  name: string;
  /** The grey line clients show beside the subject in the inbox list. */
  preheader: string;
  /** One sentence under the greeting, saying what the button will do. */
  intro: string;
  buttonLabel: string;
  link: string;
  /** The small print under the rule: the expiry, and a "not you?" note. */
  footer: string;
}

/**
 * The one message shell, shared by every transactional email.
 *
 * Both messages are the same object -- a greeting, a sentence, one button, the raw URL,
 * and small print -- and the fifty lines of nested tables that make that survive Outlook
 * are exactly the part nobody wants to maintain twice. Only the words differ, so only
 * the words are arguments.
 *
 * Escaping happens here rather than at the call sites, so a message added later cannot
 * forget to do it.
 */
function actionEmailHtml(input: ActionEmailInput): string {
  const appName = escapeHtml(input.appName);
  const name = escapeHtml(input.name);
  const preheader = escapeHtml(input.preheader);
  const intro = escapeHtml(input.intro);
  const buttonLabel = escapeHtml(input.buttonLabel);
  const link = escapeHtml(input.link);
  const footer = escapeHtml(input.footer);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${appName}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f7;">
    <!-- Preheader: the grey line clients show next to the subject in the inbox list. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="max-width:520px;background:#ffffff;border-radius:14px;border:1px solid #e4e4ec;">
            <tr>
              <td style="padding:32px 32px 8px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <div style="font-size:20px;font-weight:600;color:${INK};letter-spacing:-0.2px;">${appName}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:22px;color:${INK};">Hi ${name},</p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${DIM};">${intro}</p>
              </td>
            </tr>
            <tr>
              <td align="left" style="padding:0 32px;">
                <a href="${link}"
                   style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;
                          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                          font-size:15px;font-weight:600;padding:12px 26px;border-radius:9px;">
                  ${buttonLabel}
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0 0 6px 0;font-size:13px;line-height:20px;color:${DIM};">
                  Or paste this into your browser:
                </p>
                <!-- word-break matters: a 43-character token otherwise forces a horizontal scrollbar. -->
                <p style="margin:0;font-size:12px;line-height:18px;color:${BRAND};word-break:break-all;">${link}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <hr style="border:none;border-top:1px solid #e9e9f0;margin:0 0 16px 0;">
                <p style="margin:0;font-size:12px;line-height:19px;color:#8a8a9c;">${footer}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function verificationHtml(input: VerificationTemplateInput): string {
  return actionEmailHtml({
    appName: input.appName,
    name: input.name,
    preheader: `Confirm your email address to finish setting up your ${input.appName} account.`,
    intro: 'Confirm this email address to finish setting up your account.',
    buttonLabel: 'Confirm email address',
    link: input.link,
    footer:
      `The link expires in ${input.expiresIn}. If you did not create a ${input.appName} ` +
      'account, ignore this message — nothing was set up, and you will not hear from us ' +
      'again.',
  });
}

/* -------------------------------------------------------------------------- */
/* Password reset                                                              */
/* -------------------------------------------------------------------------- */

export interface PasswordResetTemplateInput {
  name: string;
  /** Absolute URL of the reset form, carrying the token. */
  link: string;
  expiresIn: string;
  appName: string;
}

export function passwordResetSubject(appName: string): string {
  return `Reset your ${appName} password`;
}

/**
 * The "if this was not you" line is load-bearing rather than boilerplate.
 *
 * Anyone can type someone else's address into the form, so a share of these messages
 * arrive with people who did not ask for one. Saying plainly that ignoring it leaves the
 * password unchanged is what keeps that from being alarming, and stops the recipient
 * clicking the link to find out what it does — which is the one thing they should not do.
 */
export function passwordResetText({
  name,
  link,
  expiresIn,
  appName,
}: PasswordResetTemplateInput): string {
  return [
    `Hi ${name},`,
    '',
    `Someone asked to reset the password on your ${appName} account. Choose a new one here:`,
    '',
    link,
    '',
    `The link expires in ${expiresIn} and can only be used once.`,
    '',
    'If this was not you, ignore this message -- your password has not changed, and',
    'nobody can sign in without it.',
  ].join('\n');
}

export function passwordResetHtml(input: PasswordResetTemplateInput): string {
  return actionEmailHtml({
    appName: input.appName,
    name: input.name,
    preheader: `Choose a new ${input.appName} password.`,
    intro: `Someone asked to reset the password on your ${input.appName} account. Choose a new one below.`,
    buttonLabel: 'Choose a new password',
    link: input.link,
    footer:
      `The link expires in ${input.expiresIn} and can only be used once. If this was not ` +
      'you, ignore this message — your password has not changed.',
  });
}

/* -------------------------------------------------------------------------- */
/* The page the confirmation link lands on                                     */
/* -------------------------------------------------------------------------- */

export interface ResultPageInput {
  ok: boolean;
  heading: string;
  detail: string;
  /** Where "Continue" goes. Already absolute. */
  appUrl: string;
  appName: string;
}

/**
 * Rendered directly by the API rather than redirecting into the single-page app.
 *
 * The link is opened by whatever browser the mail client hands it to -- often not the one
 * running RocksCord, sometimes a stripped-down in-app webview. A self-contained page with
 * no scripts and no external requests renders identically in all of them, and it still
 * works in development, where the SPA is served by Vite on a different port and a redirect
 * to an API-relative path would land on a 404.
 */
export function verificationResultPage(input: ResultPageInput): string {
  const heading = escapeHtml(input.heading);
  const detail = escapeHtml(input.detail);
  const appUrl = escapeHtml(input.appUrl);
  const appName = escapeHtml(input.appName);
  const accent = input.ok ? BRAND : '#d0455d';
  const glyph = input.ok ? '&#10003;' : '!';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>${heading} &middot; ${appName}</title>
  </head>
  <body style="margin:0;background:#111118;color:#e7e7ef;
               font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;">
      <div style="max-width:420px;width:100%;background:#1a1a24;border:1px solid #2a2a38;
                  border-radius:16px;padding:36px 32px;text-align:center;">
        <div style="width:52px;height:52px;line-height:52px;margin:0 auto 20px auto;border-radius:50%;
                    background:${accent};color:#fff;font-size:26px;font-weight:700;">${glyph}</div>
        <h1 style="margin:0 0 10px 0;font-size:21px;font-weight:600;letter-spacing:-0.2px;">${heading}</h1>
        <p style="margin:0 0 26px 0;font-size:14px;line-height:21px;color:#9a9aae;">${detail}</p>
        <a href="${appUrl}"
           style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;
                  font-size:14px;font-weight:600;padding:11px 26px;border-radius:9px;">
          Continue to ${appName}
        </a>
      </div>
    </div>
  </body>
</html>`;
}
