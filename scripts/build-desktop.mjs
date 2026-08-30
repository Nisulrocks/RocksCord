/**
 * Desktop staging build.
 *
 * Produces a self-contained "app root" that electron-builder can package, without
 * dragging the whole monorepo (and its workspace symlinks) into the installer.
 *
 *   apps/desktop/build/          the app root electron-builder packages
 *     package.json               only the native runtime dependencies
 *     main.cjs                   Electron main + the entire server, bundled
 *     preload.cjs
 *     node_modules/              installed natives (libsql, argon2)
 *   apps/desktop/resources/      copied verbatim next to the packaged app
 *     web/                       the built client
 *     drizzle/                   SQL migrations
 *
 * Everything except the native `.node` addons is bundled into `main.cjs` by esbuild, so
 * there is no workspace resolution to go wrong at runtime.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const desktopDir = path.join(root, 'apps', 'desktop');
const buildDir = path.join(desktopDir, 'build');
const resourcesDir = path.join(desktopDir, 'resources');

/**
 * Modules that must stay outside the bundle.
 *
 * Native `.node` addons cannot be inlined into JavaScript, and Electron itself is
 * provided by the runtime. `@supabase/supabase-js` is only reached when
 * STORAGE_DRIVER=supabase, which the desktop build never sets, so keeping it external
 * avoids shipping a cloud SDK nobody will call.
 */
const EXTERNALS = [
  'electron',
  'libsql',
  '@libsql/client',
  '@libsql/win32-x64-msvc',
  '@libsql/darwin-x64',
  '@libsql/darwin-arm64',
  '@libsql/linux-x64-gnu',
  '@node-rs/argon2',
  '@node-rs/argon2-win32-x64-msvc',
  '@supabase/supabase-js',
  // Dev-only pretty logger; production logs straight to stdout.
  'pino-pretty',
  // Installed as a real module instead; see RUNTIME_DEPENDENCIES.
  'electron-updater',
];

/**
 * Dependencies installed into the staged app root rather than bundled.
 *
 * The two native ones cannot be bundled at all. `electron-updater` is here for a
 * different reason: it resolves `app-update.yml` relative to its own location inside the
 * asar, and inlining it into main.cjs breaks that lookup -- the updater then reports no
 * configuration and silently never checks.
 */
const RUNTIME_DEPENDENCIES = {
  '@libsql/client': '^0.17.4',
  '@node-rs/argon2': '^2.1.0',
  'electron-updater': '^6.8.9',
};

function run(command, args, cwd) {
  console.log(`  $ ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

/* -------------------------------------------------------------------------- */

step('Cleaning previous staging output');
rmSync(buildDir, { recursive: true, force: true });
rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });

/* -------------------------------------------------------------------------- */

step('Building workspace packages (shared, server, web)');
run('npm', ['run', 'build', '-w', '@rockscord/shared'], root);
run('npm', ['run', 'build', '-w', '@rockscord/server'], root);
run('npm', ['run', 'build', '-w', '@rockscord/web'], root);

/* -------------------------------------------------------------------------- */

step('Bundling the Electron main process (with the server inside it)');

await esbuild.build({
  entryPoints: [path.join(desktopDir, 'src', 'main.ts')],
  outfile: path.join(buildDir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  /*
   * CommonJS, not ESM.
   *
   * Electron 44 can load an ESM main process, but electron-builder's `portable` target
   * launches the app in a way that does not reach an ESM entry point at all -- the
   * process starts and then silently does nothing. CJS works identically in every target,
   * and since the whole server is bundled into this one file the module format is an
   * implementation detail.
   */
  format: 'cjs',
  target: 'node20',
  // Electron 44 ships a modern Node; no need to down-level.
  external: EXTERNALS,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  /*
   * The server locates itself with `import.meta.url`, which has no meaning in a CommonJS
   * bundle. Rewrite it to the equivalent file URL derived from `__filename`, which CJS
   * does provide.
   */
  define: {
    'import.meta.url': '__rockscordModuleUrl',
    /*
     * Bake a server address into the executable.
     *
     *   ROCKSCORD_SERVER_URL=https://your-server.onrender.com npm run build:exe
     *
     * The resulting exe connects there on first launch with nothing to configure, which
     * is what makes it shareable with people who should not have to read instructions.
     */
    __ROCKSCORD_BAKED_SERVER_URL__: JSON.stringify(
      (process.env.ROCKSCORD_SERVER_URL ?? '').trim().replace(/\/+$/, ''),
    ),
  },
  banner: {
    js: "const __rockscordModuleUrl = require('node:url').pathToFileURL(__filename).href;",
  },
});

step('Bundling the preload script');

await esbuild.build({
  entryPoints: [path.join(desktopDir, 'src', 'preload.cts')],
  outfile: path.join(buildDir, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  // Preload scripts are loaded as CommonJS regardless of the app's module type.
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info',
});

/* -------------------------------------------------------------------------- */

step('Staging the app package manifest');

const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

writeFileSync(
  path.join(buildDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'rockscord-desktop',
      productName: 'RocksCord',
      version: rootManifest.version ?? '1.0.0',
      description: 'RocksCord — real-time chat, voice, and communities.',
      main: 'main.cjs',
      author: 'RocksCord',
      license: 'MIT',
      // Only the natives. Everything else is already inside main.cjs.
      dependencies: RUNTIME_DEPENDENCIES,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

step('Installing native dependencies into the staged app');
// `--omit=dev --no-audit --no-fund` keeps this to just the two native packages.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], buildDir);

/* -------------------------------------------------------------------------- */

step('Copying resources (web client + migrations)');

const webDist = path.join(root, 'apps', 'web', 'dist');
if (!existsSync(path.join(webDist, 'index.html'))) {
  throw new Error(`Web client build not found at ${webDist}`);
}
cpSync(webDist, path.join(resourcesDir, 'web'), { recursive: true });

const drizzleDir = path.join(root, 'apps', 'server', 'drizzle');
if (!existsSync(path.join(drizzleDir, 'meta', '_journal.json'))) {
  throw new Error(`Migrations not found at ${drizzleDir}. Run: npm run db:generate`);
}
cpSync(drizzleDir, path.join(resourcesDir, 'drizzle'), { recursive: true });

// Standalone pages, copied verbatim. Both have to render before any server exists, so
// neither can be part of the bundled client.
for (const page of ['connect.html', 'splash.html', 'overlay.html']) {
  cpSync(path.join(desktopDir, 'src', page), path.join(buildDir, page));
}

// The window icon, used before packaging replaces it with the .ico.
const iconSource = path.join(desktopDir, 'assets', 'icon.png');
if (existsSync(iconSource)) {
  cpSync(iconSource, path.join(buildDir, 'icon.png'));
}

step('Staging complete');
if (process.env.ROCKSCORD_SERVER_URL) {
  console.log(`  baked server: ${process.env.ROCKSCORD_SERVER_URL}`);
}
console.log(`  app root : ${buildDir}`);
console.log(`  resources: ${resourcesDir}`);
console.log('\nNext: npm run dist -w @rockscord/desktop');
