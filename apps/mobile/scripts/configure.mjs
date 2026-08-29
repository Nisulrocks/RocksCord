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

import { readFileSync, writeFileSync } from 'node:fs';
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

console.log(`RocksCord ${version}  (versionCode ${versionCode})`);
