/**
 * Icon pipeline: `npm run icons`
 *
 * Takes one source PNG and produces every size the app needs — the Electron window and
 * installer icon, the web favicons, and the installer wizard's own artwork — so the whole
 * visual identity comes from a single file you can swap and re-run.
 *
 * Source (first match wins):
 *   assets/icon-source.png
 *   "RocksCord Icon.png" in the repo root
 *
 * PNG decoding and encoding are done here rather than with an image library because the
 * only operations needed are "inflate, undo the row filters, average some pixels, deflate
 * again" — all of which Node's zlib already provides. Adding sharp would mean a ~10 MB
 * native dependency for one build-time task.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* -------------------------------------------------------------------------- */
/* PNG decode                                                                  */
/* -------------------------------------------------------------------------- */

/** Paeth predictor, from the PNG specification. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a non-interlaced, 8-bit PNG into `{ width, height, pixels }` RGBA. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('Not a PNG file.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported.');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    // 4 length + 4 type + data + 4 CRC
    offset += 12 + length;
  }

  if (bitDepth !== 8) {
    throw new Error(`Only 8-bit PNGs are supported (this one is ${bitDepth}-bit).`);
  }

  // Bytes per pixel in the *encoded* data, which the filters operate on.
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);
  if (colorType === 3 && !palette) throw new Error('Palette PNG with no PLTE chunk.');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));

    // Undo the per-scanline filter, in place.
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;

      switch (filter) {
        case 0: break;
        case 1: row[i] = (row[i] + left) & 0xff; break;
        case 2: row[i] = (row[i] + up) & 0xff; break;
        case 3: row[i] = (row[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error(`Unknown PNG filter type ${filter}.`);
      }
    }

    // Expand whatever colour type this is into RGBA.
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      const source = x * channels;

      if (colorType === 6) {
        row.copy(out, target, source, source + 4);
      } else if (colorType === 2) {
        row.copy(out, target, source, source + 3);
        out[target + 3] = 255;
      } else if (colorType === 0) {
        out[target] = out[target + 1] = out[target + 2] = row[source];
        out[target + 3] = 255;
      } else if (colorType === 4) {
        out[target] = out[target + 1] = out[target + 2] = row[source];
        out[target + 3] = row[source + 1];
      } else {
        const index = row[source];
        out[target] = palette[index * 3];
        out[target + 1] = palette[index * 3 + 1];
        out[target + 2] = palette[index * 3 + 2];
        out[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }

    previous = row;
  }

  return { width, height, pixels: out };
}

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Box-filter downscale.
 *
 * Colour is averaged *weighted by alpha*. Averaging RGB straight would pull transparent
 * pixels (whose RGB is usually black) into the result and leave a dark fringe around the
 * icon's edges — very visible against a light taskbar.
 */
function resize(source, targetSize) {
  const { width, height, pixels } = source;
  const out = Buffer.alloc(targetSize * targetSize * 4);

  const scaleX = width / targetSize;
  const scaleY = height / targetSize;

  for (let y = 0; y < targetSize; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));

    for (let x = 0; x < targetSize; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let alphaSum = 0;
      let count = 0;

      for (let sy = y0; sy < y1 && sy < height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < width; sx += 1) {
          const i = (sy * width + sx) * 4;
          const a = pixels[i + 3];
          r += pixels[i] * a;
          g += pixels[i + 1] * a;
          b += pixels[i + 2] * a;
          alphaSum += a;
          count += 1;
        }
      }

      const target = (y * targetSize + x) * 4;
      if (alphaSum === 0) {
        out[target + 3] = 0;
        continue;
      }
      out[target] = Math.round(r / alphaSum);
      out[target + 1] = Math.round(g / alphaSum);
      out[target + 2] = Math.round(b / alphaSum);
      out[target + 3] = Math.round(alphaSum / count);
    }
  }

  return { width: targetSize, height: targetSize, pixels: out };
}

/* -------------------------------------------------------------------------- */
/* PNG encode                                                                  */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // Filter 0 (None). These are small images and zlib handles them well.
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

const SOURCE_CANDIDATES = [
  path.join(root, 'assets', 'icon-source.png'),
  path.join(root, 'RocksCord Icon.png'),
];

const sourcePath = SOURCE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!sourcePath) {
  console.error(
    `\nNo source icon found. Put a square PNG at one of:\n${SOURCE_CANDIDATES.map(
      (c) => `  ${c}`,
    ).join('\n')}\n`,
  );
  process.exit(1);
}

console.log(`\nSource: ${sourcePath}`);

const decoded = decodePng(readFileSync(sourcePath));
console.log(`        ${decoded.width}x${decoded.height}\n`);

if (decoded.width !== decoded.height) {
  console.warn('Warning: the source is not square, so the output will be distorted.\n');
}

/** Keep the original alongside the code so the pipeline is reproducible from the repo. */
const canonicalSource = path.join(root, 'assets', 'icon-source.png');
mkdirSync(path.dirname(canonicalSource), { recursive: true });
if (path.resolve(sourcePath) !== canonicalSource) {
  copyFileSync(sourcePath, canonicalSource);
  console.log(`Copied source to assets/icon-source.png\n`);
}

const OUTPUTS = [
  // electron-builder derives the Windows .ico and the installer art from this.
  { file: path.join(root, 'apps', 'desktop', 'assets', 'icon.png'), size: 512 },
  // Web: the browser tab, and the in-app brand mark.
  { file: path.join(root, 'apps', 'web', 'public', 'icon-512.png'), size: 512 },
  { file: path.join(root, 'apps', 'web', 'public', 'icon-192.png'), size: 192 },
  { file: path.join(root, 'apps', 'web', 'public', 'favicon-32.png'), size: 32 },

  /*
   * Android launcher icons, one per density bucket.
   *
   * Both names in each bucket are written from the same square source. `ic_launcher_round`
   * is what launchers that mask icons into circles reach for, and a missing one is not
   * substituted -- it renders as the default green robot, on the one screen where the app
   * has to look like itself.
   *
   * `-v26` adaptive icons are deliberately left alone: they are vector XML referencing a
   * foreground and background layer, which this pipeline has no business generating from a
   * flat PNG.
   */
  ...[
    ['mdpi', 48],
    ['hdpi', 72],
    ['xhdpi', 96],
    ['xxhdpi', 144],
    ['xxxhdpi', 192],
  ].flatMap(([density, size]) =>
    ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'].map((name) => ({
      file: path.join(
        root, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res',
        `mipmap-${density}`, name,
      ),
      size,
    })),
  ),
];

for (const { file, size } of OUTPUTS) {
  mkdirSync(path.dirname(file), { recursive: true });
  const png = encodePng(resize(decoded, size));
  writeFileSync(file, png);
  console.log(
    `  ${String(size).padStart(4)}px  ${(png.length / 1024).toFixed(1).padStart(7)} KB  ${path
      .relative(root, file)
      .replace(/\\/g, '/')}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Installer artwork                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The installer's artwork has to be BMP: NSIS predates PNG support for these slots and
 * still will not read anything else. BMP is the easier format of the two anyway — no
 * compression and no checksums, just pixels stored in a slightly awkward order.
 */

/** A blank RGBA canvas. */
function canvas(width, height) {
  return { width, height, pixels: Buffer.alloc(width * height * 4) };
}

/**
 * Fill with a vertical gradient, plus an optional soft radial glow.
 *
 * Both are computed per pixel rather than approximated with bands. The whole panel is
 * under 60,000 pixels, and banding across a dark gradient is exactly the artefact that
 * makes an installer look thrown together.
 */
function paintBackdrop(target, { top, bottom, glow, glowAt, glowRadius }) {
  const { width, height, pixels } = target;

  for (let y = 0; y < height; y += 1) {
    const t = height === 1 ? 0 : y / (height - 1);

    for (let x = 0; x < width; x += 1) {
      let r = top[0] + (bottom[0] - top[0]) * t;
      let g = top[1] + (bottom[1] - top[1]) * t;
      let b = top[2] + (bottom[2] - top[2]) * t;

      if (glow) {
        const dx = x - glowAt[0];
        const dy = y - glowAt[1];
        // Smooth falloff: full strength at the centre, nothing at the radius.
        const distance = Math.sqrt(dx * dx + dy * dy) / glowRadius;
        if (distance < 1) {
          const strength = (1 - distance) ** 2 * 0.55;
          r += (glow[0] - r) * strength;
          g += (glow[1] - g) * strength;
          b += (glow[2] - b) * strength;
        }
      }

      const i = (y * width + x) * 4;
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      pixels[i + 3] = 255;
    }
  }

  return target;
}

/** Alpha-composite an RGBA image onto the canvas at (originX, originY). */
function blit(target, source, originX, originY) {
  for (let y = 0; y < source.height; y += 1) {
    const ty = originY + y;
    if (ty < 0 || ty >= target.height) continue;

    for (let x = 0; x < source.width; x += 1) {
      const tx = originX + x;
      if (tx < 0 || tx >= target.width) continue;

      const si = (y * source.width + x) * 4;
      const alpha = source.pixels[si + 3] / 255;
      if (alpha === 0) continue;

      const ti = (ty * target.width + tx) * 4;
      for (let c = 0; c < 3; c += 1) {
        target.pixels[ti + c] = Math.round(
          source.pixels[si + c] * alpha + target.pixels[ti + c] * (1 - alpha),
        );
      }
      target.pixels[ti + 3] = 255;
    }
  }

  return target;
}

/**
 * 24-bit uncompressed BMP.
 *
 * Two quirks of the format, either of which silently produces garbage if missed: rows are
 * stored bottom-to-top, and every row is padded to a multiple of four bytes.
 */
function encodeBmp({ width, height, pixels }) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imageSize = rowSize * height;
  const fileHeaderSize = 14;
  const infoHeaderSize = 40;

  const buffer = Buffer.alloc(fileHeaderSize + infoHeaderSize + imageSize);

  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(fileHeaderSize + infoHeaderSize, 10); // where the pixels start

  buffer.writeUInt32LE(infoHeaderSize, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26); // colour planes
  buffer.writeUInt16LE(24, 28); // bits per pixel
  buffer.writeUInt32LE(imageSize, 34);
  buffer.writeInt32LE(2835, 38); // ~72 DPI horizontally
  buffer.writeInt32LE(2835, 42); // ~72 DPI vertically

  const dataStart = fileHeaderSize + infoHeaderSize;
  for (let y = 0; y < height; y += 1) {
    const sourceRow = height - 1 - y; // bottom-up
    let offset = dataStart + y * rowSize;

    for (let x = 0; x < width; x += 1) {
      const i = (sourceRow * width + x) * 4;
      buffer[offset] = pixels[i + 2]; // B
      buffer[offset + 1] = pixels[i + 1]; // G
      buffer[offset + 2] = pixels[i]; // R
      offset += 3;
    }
  }

  return buffer;
}

// The app's own palette, so the installer does not look like a different product.
const SURFACE_TOP = [12, 13, 20];
const SURFACE_BOTTOM = [26, 22, 48];
const ACCENT = [108, 92, 255];

/** The tall panel beside the welcome and finish pages. 164x314 is fixed by NSIS. */
function buildSidebar() {
  const width = 164;
  const height = 314;
  const iconSize = 92;
  const iconY = 78;

  const panel = paintBackdrop(canvas(width, height), {
    top: SURFACE_TOP,
    bottom: SURFACE_BOTTOM,
    glow: ACCENT,
    glowAt: [width / 2, iconY + iconSize / 2],
    glowRadius: 132,
  });

  return blit(panel, resize(decoded, iconSize), Math.round((width - iconSize) / 2), iconY);
}

/** The small strip in the header of every other page. 150x57, also fixed. */
function buildHeader() {
  const width = 150;
  const height = 57;
  const iconSize = 40;

  /*
   * White rather than the dark panel: NSIS draws this into the wizard's header band,
   * which Windows paints light. A dark image there reads as a mis-sized black rectangle
   * rather than as branding.
   */
  const strip = paintBackdrop(canvas(width, height), {
    top: [255, 255, 255],
    bottom: [255, 255, 255],
  });

  return blit(
    strip,
    resize(decoded, iconSize),
    width - iconSize - 10,
    Math.round((height - iconSize) / 2),
  );
}

const desktopAssets = path.join(root, 'apps', 'desktop', 'assets');
mkdirSync(desktopAssets, { recursive: true });

const sidebarBmp = encodeBmp(buildSidebar());
const headerBmp = encodeBmp(buildHeader());

const BITMAPS = [
  // electron-builder finds these by name inside the buildResources directory.
  { file: path.join(desktopAssets, 'installerSidebar.bmp'), data: sidebarBmp, label: '164x314' },
  { file: path.join(desktopAssets, 'uninstallerSidebar.bmp'), data: sidebarBmp, label: '164x314' },
  { file: path.join(desktopAssets, 'installerHeader.bmp'), data: headerBmp, label: ' 150x57' },
];

for (const { file, data, label } of BITMAPS) {
  writeFileSync(file, data);
  console.log(
    `  ${label}  ${(data.length / 1024).toFixed(1).padStart(7)} KB  ${path
      .relative(root, file)
      .replace(/\\/g, '/')}`,
  );
}

console.log('\nIcons and installer artwork written.\n');
