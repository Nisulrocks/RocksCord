/**
 * Email delivery diagnostic: `npm run test:email -- you@example.com`
 *
 * Sends through whichever provider is configured, with the same payload the server uses,
 * and prints the reply verbatim. The point is to separate two questions that look
 * identical from the outside:
 *
 *   "is RocksCord failing to send?"   and   "is the provider refusing to accept?"
 *
 * Registration deliberately does not fail when a send fails -- losing an account because
 * a mail provider hiccupped would be worse -- so that error only reaches the server log.
 * This surfaces the same error without needing access to that log.
 *
 * Credentials are read from the environment or .env, and prompted for otherwise. Nothing
 * is written anywhere.
 */

import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColour ? `[${code}m${text}[0m` : text);
const bold = (t) => paint('1', t);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('90', t);

/** Minimal .env reader -- this has to work before anything is installed. */
function readEnvFile() {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return {};

  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

const fileEnv = readEnvFile();
const setting = (name) => process.env[name] || fileEnv[name] || '';

/** Mirrors the server's own inference, so the diagnostic tests what production would use. */
function resolveDriver() {
  const explicit = setting('EMAIL_DRIVER');
  if (explicit && explicit !== 'auto') return explicit;
  // Same precedence as the server: an API key wins over SMTP when both are present.
  if (setting('EMAIL_API_KEY').startsWith('api-')) return 'smtp2go';
  if (setting('EMAIL_API_KEY').startsWith('re_')) return 'resend';
  if (setting('EMAIL_API_KEY')) return 'brevo';
  if (setting('SMTP_HOST') && setting('SMTP_USER') && setting('SMTP_PASSWORD')) return 'smtp';
  return '';
}

const SUBJECT = 'RocksCord delivery test';
const HTML =
  '<p>If you are reading this, the provider is configured correctly and RocksCord can send verification links.</p>';
const TEXT = 'If you are reading this, the provider is configured correctly.';

async function sendViaBrevo({ apiKey, fromEmail, fromName, to }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: fromEmail, name: fromName },
      to: [{ email: to }],
      subject: SUBJECT,
      htmlContent: HTML,
      textContent: TEXT,
    }),
  });
  return { status: response.status, ok: response.ok, body: await response.text() };
}

async function sendViaResend({ apiKey, fromEmail, fromName, to }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: [to],
      subject: SUBJECT,
      html: HTML,
      text: TEXT,
    }),
  });
  return { status: response.status, ok: response.ok, body: await response.text() };
}

async function sendViaSmtp2go({ apiKey, fromEmail, fromName, to }) {
  const response = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: {
      'X-Smtp2go-Api-Key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: [to],
      subject: SUBJECT,
      html_body: HTML,
      text_body: TEXT,
    }),
  });

  const body = await response.text();

  /*
   * SMTP2GO answers 200 even when it refuses the message, with the outcome in the body.
   * Judging by the status code alone would call every rejection a success -- the exact
   * failure this script exists to catch.
   */
  let succeeded = 0;
  try {
    succeeded = JSON.parse(body)?.data?.succeeded ?? 0;
  } catch {
    /* treated as a failure below */
  }

  return { status: response.status, ok: response.ok && succeeded > 0, body };
}

async function sendViaSmtp({ fromEmail, fromName, to }) {
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(setting('SMTP_PORT') || 587);

  const transport = nodemailer.createTransport({
    host: setting('SMTP_HOST'),
    port,
    secure: port === 465,
    auth: { user: setting('SMTP_USER'), pass: setting('SMTP_PASSWORD') },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });

  try {
    const info = await transport.sendMail({
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to,
      subject: SUBJECT,
      text: TEXT,
      html: HTML,
    });
    return { status: 200, ok: true, body: JSON.stringify({ accepted: info.accepted, id: info.messageId }) };
  } catch (error) {
    return { status: 0, ok: false, body: error instanceof Error ? error.message : String(error) };
  } finally {
    transport.close();
  }
}

/**
 * Explain a rejection.
 *
 * Each provider has two or three failures that account for nearly everything, and none of
 * their raw messages name the cure. Mapping them here saves a documentation search at the
 * moment someone is already stuck.
 */
function explain(driver, status, raw, fromEmail) {
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* leave as text */
  }
  const code = typeof parsed === 'object' && parsed ? String(parsed.code ?? '') : '';
  const message = typeof parsed === 'object' && parsed ? String(parsed.message ?? '') : String(raw);

  if (driver === 'smtp') {
    if (/invalid login|authentication failed|535|badcredentials/i.test(message)) {
      return [
        yellow('The mailbox rejected those credentials.'),
        '  With Gmail this nearly always means an ordinary account password was used.',
        '  You need an app password: Google Account -> Security -> App passwords,',
        '  which requires 2-Step Verification to be on first.',
      ];
    }
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Connection timeout/i.test(message)) {
      return [
        yellow('Could not open an SMTP connection at all.'),
        '  If this works here but times out once deployed, your host is blocking it:',
        "  Render's free instances block outbound SMTP on 25, 465 and 587, so no relay",
        '  can work there regardless of credentials.',
        '',
        '  Use a provider with an HTTPS API instead. SMTP2GO needs only a verified',
        '  sender address, with no domain, and so is unaffected.',
      ];
    }
    return [yellow('SMTP refused the message.') + ' The error above is the server’s own wording.'];
  }

  if (driver === 'smtp2go') {
    if (/sender|from address|not verified|unverified/i.test(String(raw))) {
      return [
        yellow('SMTP2GO refused the sender address.'),
        `  ${bold(fromEmail)} has to be added and confirmed under`,
        '  Sending -> Verified Senders. A single email address is enough; no domain is',
        '  required. SMTP2GO emails that address a link you have to click.',
      ];
    }
    if (/limit|quota|exceeded/i.test(String(raw))) {
      return [
        yellow('Over an SMTP2GO sending limit.'),
        '  The free plan allows 1,000 a month, 200 a day, and 25 an hour until a domain',
        '  is verified. The hourly cap is usually the one being hit.',
      ];
    }
    return [yellow('SMTP2GO did not send it.') + ' The response above is its own wording.'];
  }

  if (driver === 'resend' && (status === 403 || /testing emails|own email address/i.test(message))) {
    return [
      yellow('Resend will only deliver to your own address.'),
      '  Without a verified domain, a Resend account can send only to the address it was',
      '  registered with. This is a sandbox, not a starter tier, so signup emails to your',
      '  users will never arrive.',
      '',
      `  ${bold('Either')} verify a domain you own (Resend -> Domains),`,
      `  ${bold('or')} use SMTP instead, which has no such restriction.`,
    ];
  }

  if (status === 403 || code === 'permission_denied') {
    return [
      yellow('The provider has not activated this account for sending.'),
      '  Nothing is wrong with your key, your sender, or RocksCord -- new accounts are',
      '  held until the provider approves them, and every send is refused until then.',
      '  Brevo: open the Transactional page for an activation prompt, or email',
      '  contact@brevo.com. Approval can take a day, and is sometimes refused outright.',
      '',
      '  SMTP through an ordinary mailbox has no such queue and works immediately.',
    ];
  }

  if (status === 401 || code === 'unauthorized') {
    return [
      yellow('The key was refused.'),
      '  Regenerate it in the provider dashboard, and check for a trailing space or a',
      '  truncated paste in your host configuration.',
    ];
  }

  if (/sender|from/i.test(message) || code === 'invalid_parameter') {
    return [
      yellow('The sender address was refused.'),
      `  EMAIL_FROM is currently ${bold(fromEmail)}.`,
      '  It has to be an address the provider will send as: a confirmed sender for Brevo,',
      '  an address at a verified domain for Resend, or the mailbox itself for SMTP.',
    ];
  }

  if (status === 402 || /credit|quota|limit/i.test(message)) {
    return [yellow('Out of sending allowance for now.')];
  }

  return [yellow('Unrecognised error.') + " The response above is the provider's own wording."];
}

async function main() {
  const recipient = process.argv[2];

  console.log(`\n${bold('RocksCord email diagnostic')}\n`);

  if (!recipient || !recipient.includes('@')) {
    console.error(`${red('Usage:')} npm run test:email -- you@example.com\n`);
    console.error('Send it to an address you can actually open.\n');
    return 1;
  }

  let driver = resolveDriver();
  let fromEmail = setting('EMAIL_FROM') || setting('SMTP_USER');
  const fromName = setting('EMAIL_FROM_NAME') || 'RocksCord';
  let apiKey = setting('EMAIL_API_KEY');

  /*
   * Credentials normally live on the host rather than this machine, so prompting is the
   * common path. The readline interface is opened only when something must be asked:
   * opening stdin and then exiting while the handle is still closing trips a libuv
   * assertion on Windows, turning a clean diagnostic into a crash report.
   */
  if (!driver) {
    console.log(dim('No provider is configured locally.\n'));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('Which provider? [smtp2go / smtp / brevo / resend]: ')).trim();
      driver = answer.toLowerCase();
      if (driver === 'smtp') {
        console.log(dim('\nFor Gmail: host smtp.gmail.com, port 587, and an app password.\n'));
        process.env.SMTP_HOST = (await rl.question('SMTP host: ')).trim();
        process.env.SMTP_PORT = (await rl.question('SMTP port [587]: ')).trim() || '587';
        process.env.SMTP_USER = (await rl.question('SMTP username (your address): ')).trim();
        process.env.SMTP_PASSWORD = (await rl.question('SMTP password / app password: ')).trim();
        fromEmail = fromEmail || process.env.SMTP_USER;
      } else {
        apiKey = (await rl.question('API key: ')).trim();
        if (!fromEmail) fromEmail = (await rl.question('Sender address: ')).trim();
      }
    } finally {
      rl.close();
    }
  }

  if (!['smtp2go', 'smtp', 'brevo', 'resend'].includes(driver)) {
    console.error(`\n${red(`Unknown provider "${driver}".`)} Expected smtp2go, smtp, brevo, or resend.\n`);
    return 1;
  }
  if (!fromEmail) {
    console.error(`\n${red('A sender address is required (EMAIL_FROM).')}\n`);
    return 1;
  }

  console.log(`${green('provider')}  ${driver}`);
  console.log(`${green('from')}      ${fromEmail}`);
  console.log(`${green('to')}        ${recipient}\n`);

  let result;
  try {
    const args = { apiKey, fromEmail, fromName, to: recipient };
    if (driver === 'smtp') result = await sendViaSmtp(args);
    else if (driver === 'smtp2go') result = await sendViaSmtp2go(args);
    else if (driver === 'resend') result = await sendViaResend(args);
    else result = await sendViaBrevo(args);
  } catch (error) {
    console.error(red('The attempt failed before a reply came back.'));
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    return 1;
  }

  if (result.ok) {
    console.log(green(`Accepted${result.status ? ` (HTTP ${result.status})` : ''}`));
    console.log(dim(result.body.slice(0, 300)));
    console.log(`\n${bold('The provider took the message.')}`);
    console.log(`Now check ${bold(recipient)}, including spam.\n`);
    console.log('If it never arrives, the problem is delivery rather than configuration:');
    console.log("  - the provider's own sending log will show a bounce or a block");
    console.log('  - a new sender with no domain is often filtered on its first message\n');
    return 0;
  }

  console.log(red(`Rejected${result.status ? ` (HTTP ${result.status})` : ''}`));
  console.log(result.body.slice(0, 800));
  console.log('');
  for (const line of explain(driver, result.status, result.body, fromEmail)) console.log(line);
  console.log('');
  return 1;
}

process.exitCode = await main();
