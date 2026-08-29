/**
 * `npm run build:exe`
 *
 * Stages the desktop app and packages it with electron-builder, then prints exactly
 * where the artifacts are.
 *
 * Bake a server address into the executable so it needs no configuration:
 *
 *   npm run build:exe -- --server=https://your-app.onrender.com
 *
 * Everyone you give that exe to connects to that server on first launch. Without it, the
 * app asks once which server to use.
 *
 * Pass electron-builder targets through too:
 *   npm run build:exe -- --win portable      only the portable exe (fastest)
 *   npm run build:exe -- --win nsis          only the installer
 *   npm run build:exe -- --dir               unpacked folder, no installer (quickest)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const desktopDir = path.join(root, 'apps', 'desktop');
const releaseDir = path.join(desktopDir, 'release');

const argv = process.argv.slice(2);

/*
 * `--server=URL` is ours, not electron-builder's, so pull it out before passing the rest
 * along. Setting it as an environment variable is how the staging build picks it up --
 * this flag exists because `VAR=value command` is not valid syntax in Windows cmd, which
 * is exactly where this gets run.
 */
const serverFlag = argv.find((arg) => arg.startsWith('--server='));
const passthrough = argv.filter((arg) => arg !== serverFlag);

if (serverFlag) {
  const url = serverFlag.slice('--server='.length).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    console.error(`
The --server value must start with http:// or https:// — got "${url}"
`);
    process.exit(1);
  }
  process.env.ROCKSCORD_SERVER_URL = url;
}

/*
 * `--release` publishes to the update feed instead of only building locally.
 *
 * Guarded rather than passed through blindly, because publishing has two preconditions
 * that fail unhelpfully: without GH_TOKEN electron-builder reports a generic 401, and
 * without a version bump it uploads over an existing release that no installed copy will
 * ever see -- the updater compares versions, so a re-published 1.0.0 is invisible.
 */
const releasing = argv.includes('--release');
const publishArgs = releasing ? ['--publish', 'always'] : [];
const buildArgs = passthrough.filter((arg) => arg !== '--release');

if (releasing) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.error(`
--release needs a GitHub token with 'repo' scope, so electron-builder can upload
the installer to the releases repository.

  PowerShell:  $env:GH_TOKEN = "ghp_..."
  bash:        export GH_TOKEN=ghp_...

Create one at https://github.com/settings/tokens
`);
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  console.log(`\n=== Releasing version ${version} ===`);
  console.log('Installed copies only see this if the version is higher than theirs.\n');
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function megabytes(filePath) {
  return `${(statSync(filePath).size / (1024 * 1024)).toFixed(0)} MB`;
}

console.log('\n=== Staging the desktop app ===\n');
run('node', [path.join(root, 'scripts', 'build-desktop.mjs')], root);

console.log('\n=== Packaging with electron-builder ===');
console.log('(the Electron runtime is downloaded and cached on the first run)\n');

run(
  'npx',
  ['electron-builder', '--config', 'electron-builder.yml', ...buildArgs, ...publishArgs],
  desktopDir,
);

/* -------------------------------------------------------------------------- */

const artifacts = [
  {
    file: path.join(releaseDir, 'RocksCord.exe'),
    label: 'Portable — double-click to run, no installation',
  },
  {
    file: path.join(releaseDir, 'RocksCord-Setup-1.0.0.exe'),
    label: 'Installer — adds Start menu and desktop shortcuts',
  },
  {
    file: path.join(releaseDir, 'win-unpacked', 'RocksCord.exe'),
    label: 'Unpacked folder — copy the whole win-unpacked folder anywhere',
  },
];

console.log('\n=== Build complete ===\n');

let found = 0;
for (const artifact of artifacts) {
  if (!existsSync(artifact.file)) continue;
  found += 1;
  console.log(`  ${artifact.file}`);
  console.log(`    ${megabytes(artifact.file)} — ${artifact.label}\n`);
}

if (found === 0) {
  console.log(`  No artifacts found in ${releaseDir}. Check the output above.`);
  process.exit(1);
}

console.log('To run it:  double-click RocksCord.exe');
console.log('First launch takes ~10 seconds while it unpacks.\n');
