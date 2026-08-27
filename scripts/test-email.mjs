/**
 * Email delivery diagnostic: `npm run test:email -- you@example.com`
 *
 * Talks to the provider directly, with the same payload the server sends, and prints
 * whatever comes back verbatim. The point is to separate two questions that look
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

/**
 * Explain a rejection.
 *
 * The provider's error codes are stable and each has exactly one fix, so naming that fix
 * here saves a documentation search at the moment someone is already stuck.
 */
function explain(status, body, fromEmail) {
  const code = typeof body === 'object' && body ? String(body.code ?? '') : '';
  const message = typeof body === 'object' && body ? String(body.message ?? '') : String(body);

  if (status === 401 || code === 'unauthorized') {
    return [
      yellow('The key was refused.'),
      '  - Regenerate it: Brevo -> SMTP & API -> API Keys',
      '  - Check for a trailing space or a truncated paste in your host dashboard',
      '  - A brand-new Brevo account can be held for review before it may send at all;',
      '    the Transactional page in the dashboard says so when that is the case',
    ];
  }
  if (/sender/i.test(message) || code === 'invalid_parameter') {
    return [
      yellow('The sender address was refused.'),
      `  EMAIL_FROM is currently ${bold(fromEmail)}.`,
      '  It has to be an address listed AND confirmed under',
      '  Brevo -> Senders, Domains & Dedicated IPs -> Senders.',
      '  Adding it there is not enough on its own: Brevo emails that address a',
      '  confirmation link, and the sender stays unusable until someone clicks it.',
    ];
  }
  if (status === 402 || /credit|quota|limit/i.test(message)) {
    return [
      yellow('Out of sending allowance.'),
      '  The free plan is 300 messages a day, shared with campaigns.',
    ];
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

  let apiKey = setting('EMAIL_API_KEY');
  let fromEmail = setting('EMAIL_FROM');

  if (apiKey) console.log(`${green('OK')} EMAIL_API_KEY found locally ${dim(`(${apiKey.slice(0, 12)}...)`)}`);
  if (fromEmail) console.log(`${green('OK')} EMAIL_FROM found locally ${dim(`(${fromEmail})`)}`);

  /*
   * The key normally lives on the host rather than this machine, so prompting is the
   * common path. The readline interface is opened only when something actually has to be
   * asked: opening stdin and then exiting while the handle is still closing trips a libuv
   * assertion on Windows, turning a clean diagnostic into a crash report.
   */
  if (!apiKey || !fromEmail) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!apiKey) {
        console.log(dim('\nEMAIL_API_KEY is not set locally. Paste it from your host dashboard.'));
        console.log(dim('It is used for this one request and never stored.\n'));
        apiKey = (await rl.question('Brevo API key: ')).trim();
      }
      if (!fromEmail) {
        fromEmail = (await rl.question('Verified sender address: ')).trim();
      }
    } finally {
      rl.close();
    }
  }

  if (!apiKey || !fromEmail) {
    console.error(`\n${red('Both a key and a sender address are required.')}\n`);
    return 1;
  }

  console.log(`\n${dim('POST https://api.brevo.com/v3/smtp/email')}`);
  console.log(dim(`  from: ${fromEmail}`));
  console.log(dim(`  to:   ${recipient}\n`));

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
          '<p>If you are reading this, the provider is configured correctly and RocksCord can send verification links.</p>',
        textContent: 'If you are reading this, the provider is configured correctly.',
      }),
    });
  } catch (error) {
    console.error(red('Could not reach the provider at all.'));
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\nThat is a network problem on this machine, not a configuration one.\n');
    return 1;
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (response.ok) {
    console.log(green(`Accepted (HTTP ${response.status})`));
    console.log(dim(typeof body === 'string' ? body : JSON.stringify(body)));
    console.log(`\n${bold('The provider took the message.')}`);
    console.log(`Now check ${bold(recipient)}, including spam.\n`);
    console.log('If it never arrives, the problem is delivery rather than configuration:');
    console.log('  - Brevo -> Transactional -> Logs will show a bounce or a block');
    console.log('  - a new sender with no domain is often filtered on its first message\n');
    return 0;
  }

  console.log(red(`Rejected (HTTP ${response.status})`));
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  console.log('');
  for (const line of explain(response.status, body, fromEmail)) console.log(line);
  console.log('');
  return 1;
}

process.exitCode = await main();
