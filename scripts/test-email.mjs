/**
 * Email delivery diagnostic: `npm run test:email -- you@example.com`
 *
 * Sends through Brevo with the same payload the server uses, and prints the reply
 * verbatim. It separates two questions that look identical from the outside:
 *
 *   "is RocksCord failing to send?"   and   "is Brevo refusing to accept?"
 *
 * Run this before turning `REQUIRE_EMAIL_VERIFICATION` on. Enforcing sign-in against a
 * provider that has not actually delivered anything produces accounts that can never sign
 * in, and never receive the link that would fix them.
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

/**
 * Explain a rejection.
 *
 * Brevo's error codes are stable and each has exactly one fix, so naming that fix here
 * saves a documentation search at the moment someone is already stuck.
 */
function explain(status, raw, fromEmail) {
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* leave as text */
  }
  const code = typeof parsed === 'object' && parsed ? String(parsed.code ?? '') : '';
  const message = typeof parsed === 'object' && parsed ? String(parsed.message ?? '') : String(raw);

  if (status === 403 || code === 'permission_denied') {
    return [
      yellow('Brevo has not activated this account for sending.'),
      '  Nothing is wrong with your key, your sender, or RocksCord. New accounts are held',
      '  until Brevo approves them by hand, and every send is refused until then.',
      '',
      '  Open the Transactional page in the Brevo dashboard and look for an activation',
      '  prompt, or email contact@brevo.com describing what you send: transactional',
      '  account-verification email for a small chat app, low volume.',
      '',
      '  Leave REQUIRE_EMAIL_VERIFICATION off until this command succeeds.',
    ];
  }

  if (status === 401 || code === 'unauthorized') {
    return [
      yellow('The key was refused.'),
      '  Regenerate it under SMTP & API -> API Keys, and check for a trailing space or a',
      '  truncated paste in your host configuration.',
    ];
  }

  if (/sender/i.test(message) || code === 'invalid_parameter') {
    return [
      yellow('The sender address was refused.'),
      `  EMAIL_FROM is currently ${bold(fromEmail)}.`,
      '  It has to be listed AND confirmed under Senders, Domains & Dedicated IPs ->',
      '  Senders. Adding it is not enough on its own: Brevo emails that address a link,',
      '  and the sender stays unusable until someone clicks it.',
    ];
  }

  if (status === 402 || /credit|quota|limit/i.test(message)) {
    return [yellow('Out of sending allowance.'), '  The free plan is 300 messages a day.'];
  }

  return [yellow('Unrecognised error.') + " The response above is Brevo's own wording."];
}

async function main() {
  const recipient = process.argv[2];

  console.log(`\n${bold('RocksCord email diagnostic')}\n`);

  if (!recipient || !recipient.includes('@')) {
    console.error(`${red('Usage:')} npm run test:email -- you@example.com\n`);
    console.error('Send it to an address you can actually open.\n');
    return 1;
  }

  let apiKey = setting('EMAIL_API_KEY');
  let fromEmail = setting('EMAIL_FROM');

  /*
   * Credentials normally live on the host rather than this machine, so prompting is the
   * common path. The readline interface is opened only when something must be asked:
   * opening stdin and then exiting while the handle is still closing trips a libuv
   * assertion on Windows, turning a clean diagnostic into a crash report.
   */
  if (!apiKey || !fromEmail) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!apiKey) {
        console.log(dim('EMAIL_API_KEY is not set locally. Paste it from your host dashboard.'));
        console.log(dim('It is used for this one request and never stored.\n'));
        apiKey = (await rl.question('Brevo API key: ')).trim();
      }
      if (!fromEmail) {
        fromEmail = (await rl.question('Confirmed sender address: ')).trim();
      }
    } finally {
      rl.close();
    }
  }

  if (!apiKey || !fromEmail) {
    console.error(`\n${red('Both a key and a sender address are required.')}\n`);
    return 1;
  }

  console.log(`${green('from')}  ${fromEmail}`);
  console.log(`${green('to')}    ${recipient}\n`);

  let response;
  try {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: setting('EMAIL_FROM_NAME') || 'RocksCord' },
        to: [{ email: recipient }],
        subject: 'RocksCord delivery test',
        htmlContent:
          '<p>If you are reading this, Brevo is configured correctly and RocksCord can send verification links.</p>',
        textContent: 'If you are reading this, Brevo is configured correctly.',
      }),
    });
  } catch (error) {
    console.error(red('Could not reach Brevo at all.'));
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\nThat is a network problem on this machine, not a configuration one.\n');
    return 1;
  }

  const raw = await response.text();

  if (response.ok) {
    console.log(green(`Accepted (HTTP ${response.status})`));
    console.log(dim(raw.slice(0, 300)));
    console.log(`\n${bold('Brevo took the message.')}`);
    console.log(`Now check ${bold(recipient)}, including spam.\n`);
    console.log('If it arrives, you can safely set REQUIRE_EMAIL_VERIFICATION=true.');
    console.log('If it never arrives, the problem is delivery rather than configuration:');
    console.log('  - Brevo -> Transactional -> Logs will show a bounce or a block');
    console.log('  - a new sender with no domain is often filtered on its first message\n');
    return 0;
  }

  console.log(red(`Rejected (HTTP ${response.status})`));
  console.log(raw.slice(0, 800));
  console.log('');
  for (const line of explain(response.status, raw, fromEmail)) console.log(line);
  console.log('');
  return 1;
}

process.exitCode = await main();
