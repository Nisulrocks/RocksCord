/**
 * Stamp the Android project with the monorepo's version before a build.
 *
 * Gradle keeps `versionName` and `versionCode` in `build.gradle`, which is checked in and
 * knows nothing about `package.json`. Left alone it ships every APK as "1.0", so the
 * about screen, the launcher, and any bug report all disagree with the release the file
 * came from.
 *
 * `versionCode` has to be a single increasing integer -- Android refuses to install an
 * APK whose code is lower than the one already present -- so the semantic version is
 * folded into one: 1.2.3 becomes 10203. That leaves room for 99 patches and 99 minors per
 * major, and stays ordered the way the version string does.
 *
 * Run by `npm run build:apk`; safe to run repeatedly.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const repoRoot = path.resolve(mobileRoot, '..', '..');

const { version } = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!match) {
  console.error(`Cannot read a version out of "${version}".`);
  process.exit(1);
}

const [, major, minor, patch] = match.map(Number);
if (minor > 99 || patch > 99) {
  // Silently wrapping would produce a code that sorts *below* its predecessor, and the
  // symptom of that is "the update will not install" long after the cause.
  console.error(
    `Version ${version} does not fit the versionCode scheme: minor and patch must be <= 99.`,
  );
  process.exit(1);
}
const versionCode = major * 10000 + minor * 100 + patch;

const gradlePath = path.join(mobileRoot, 'android', 'app', 'build.gradle');
const original = readFileSync(gradlePath, 'utf8');

const updated = original
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);

if (updated !== original) writeFileSync(gradlePath, updated);

/* -------------------------------------------------------------------------- */
/* Resource checks                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to build a `<bitmap>` that points at a launcher icon.
 *
 * From API 26 `@mipmap/ic_launcher` resolves to the adaptive-icon XML, which is not a
 * bitmap. `<bitmap android:src="@mipmap/ic_launcher">` therefore compiles cleanly and
 * throws `Resources$NotFoundException` at runtime -- and when the drawable in question is
 * a window background, that happens before the activity draws, so the app opens and
 * closes instantly with nothing on screen and nothing in the build output.
 *
 * aapt cannot catch it, because the reference is only invalid once resolved on a device.
 * This is the cheapest thing that can, and it is here rather than in a lint config so it
 * runs on every build including a plain `npm run build:apk`.
 */
function checkBitmapReferences() {
  const resDir = path.join(mobileRoot, 'android', 'app', 'src', 'main', 'res');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.xml')) continue;

      const body = readFileSync(full, 'utf8')
        // Comments discuss this exact trap by name; matching them would be self-defeating.
        .replace(/<!--[\s\S]*?-->/g, '');

      for (const tag of body.match(/<bitmap\b[^>]*>/g) ?? []) {
        if (/android:src\s*=\s*"@mipmap\//.test(tag)) {
          offenders.push(path.relative(mobileRoot, full));
        }
      }
    }
  };

  walk(resDir);

  if (offenders.length > 0) {
    console.error(
      'A <bitmap> refers to @mipmap/... in:\n' +
        offenders.map((f) => `  ${f}`).join('\n') +
        '\n\nLauncher icons are adaptive-icon XML from API 26, not bitmaps, so this\n' +
        'crashes on launch. Point it at a plain PNG drawable instead.',
    );
    process.exit(1);
  }
}

checkBitmapReferences();

console.log(`RocksCord ${version}  (versionCode ${versionCode})`);
