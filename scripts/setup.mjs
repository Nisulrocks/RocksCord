/**
 * One-command setup: `npm run setup`.
 *
 * Goal: from a fresh clone to a running, seeded application with a single command and no
 * decisions. Every step is idempotent, so running it again is safe and is also the right
 * way to recover if something is half-configured.
 *
 * What it does:
 *   1. checks the Node version
 *   2. installs dependencies (skipped if already present)
 *   3. builds the shared package (server and client both import it)
 *   4. creates .env with a generated JWT secret, if one does not exist
 *   5. applies database migrations
 *   6. seeds demo accounts and a demo server
 *
 * It deliberately does NOT build the web client -- `npm run dev` serves it from Vite with
 * hot reload, which is what you want while developing.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * ANSI styling. ESC is built from its character code rather than embedded as a literal
 * control byte, so this file stays reviewable in a diff.
 *
 * Colour is suppressed when output is redirected or NO_COLOR is set, so piping the setup
 * output to a file produces clean text.
 */
const ESC = String.fromCharCode(27);
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (useColour ? ESC + '[' + code + 'm' : '');

const colour = {
  reset: sgr(0),
  bold: sgr(1),
  dim: sgr(2),
  green: sgr(32),
  yellow: sgr(33),
  cyan: sgr(36),
  red: sgr(31),
};

let stepNumber = 0;
const TOTAL_STEPS = 6;

function step(message) {
  stepNumber += 1;
  console.log(
    `\n${colour.cyan}${colour.bold}[${stepNumber}/${TOTAL_STEPS}]${colour.reset} ${colour.bold}${message}${colour.reset}`,
  );
}

function info(message) {
  console.log(`      ${colour.dim}${message}${colour.reset}`);
}

function done(message) {
  console.log(`      ${colour.green}✓${colour.reset} ${message}`);
}

function warn(message) {
  console.log(`      ${colour.yellow}!${colour.reset} ${message}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: options.quiet ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
  });
}

/* -------------------------------------------------------------------------- */

console.log(`
${colour.bold}RocksCord — setup${colour.reset}
${colour.dim}Real-time chat, voice, and communities.${colour.reset}`);

/* 1 --------------------------------------------------------------------- */

step('Checking your Node.js version');

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(
    `\n${colour.red}Node ${process.versions.node} is too old.${colour.reset}\n` +
      'RocksCord needs Node 20 or newer. Download it from https://nodejs.org\n',
  );
  process.exit(1);
}
done(`Node ${process.versions.node}`);

/* 2 --------------------------------------------------------------------- */

step('Installing dependencies');

if (existsSync(path.join(root, 'node_modules', 'fastify'))) {
  done('Already installed — skipping. Delete node_modules to force a reinstall.');
} else {
  info('This takes a couple of minutes the first time.');
  run('npm', ['install']);
  done('Dependencies installed');
}

/* 3 --------------------------------------------------------------------- */

step('Building the shared package');

info('Types, permission logic, and validation shared by the server and the client.');
run('npm', ['run', 'build', '-w', '@rockscord/shared']);
done('Shared package built');

/* 4 --------------------------------------------------------------------- */

step('Creating your .env file');

const envPath = path.join(root, '.env');

if (existsSync(envPath)) {
  const contents = readFileSync(envPath, 'utf8');
  const hasSecret = /^JWT_SECRET=.+$/m.test(contents);
  done('.env already exists — leaving it alone.');
  if (!hasSecret) {
    warn('JWT_SECRET is empty. That is fine for development (a new one is');
    warn('generated per run), but set it before deploying.');
  }
} else {
  const examplePath = path.join(root, '.env.example');
  const template = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';

  // A stable secret means restarting the dev server does not sign you out.
  const secret = randomBytes(48).toString('base64url');
  const contents = template.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);

  writeFileSync(envPath, contents, 'utf8');
  done('.env created with a freshly generated JWT_SECRET');
  info('Every other setting has a working default. Nothing else to fill in.');
}

/* 5 --------------------------------------------------------------------- */

step('Setting up the database');

info('SQLite file at ./data/rockscord.db — no database server to install.');
run('npm', ['run', 'db:migrate', '-w', '@rockscord/server']);
done('Schema applied');

/* 6 --------------------------------------------------------------------- */

step('Adding demo accounts and a demo server');

run('npm', ['run', 'db:seed', '-w', '@rockscord/server']);

/* -------------------------------------------------------------------------- */

console.log(`
${colour.green}${colour.bold}Setup complete.${colour.reset}

${colour.bold}Start the app${colour.reset}
  ${colour.cyan}npm run dev${colour.reset}          then open ${colour.cyan}http://localhost:5173${colour.reset}

${colour.bold}Sign in with a demo account${colour.reset}
  alex@rockscord.test   ${colour.dim}/${colour.reset}  password123
  nova@rockscord.test   ${colour.dim}/${colour.reset}  password123
  kit@rockscord.test    ${colour.dim}/${colour.reset}  password123

${colour.bold}Test two users at once${colour.reset}
  Open a second ${colour.bold}private/incognito${colour.reset} window and sign in as a different account.
  A normal second tab shares the session cookie, so both tabs become the same user.

${colour.bold}Other commands${colour.reset}
  ${colour.cyan}npm test${colour.reset}             run the test suite (130 tests)
  ${colour.cyan}npm run smoke${colour.reset}        end-to-end check against a running server
  ${colour.cyan}npm run build:exe${colour.reset}    build the Windows executable
  ${colour.cyan}npm run db:reset${colour.reset}     wipe and re-seed the database
`);
