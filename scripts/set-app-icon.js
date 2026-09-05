import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Installs a source PNG as the iOS app icon.
//
// Xcode 14+ asset catalogues take a SINGLE 1024x1024 icon and derive every other
// size at build time, so `AppIcon.appiconset/Contents.json` lists exactly one
// image. That makes this a one-file swap rather than the old 15-size grind — but
// the one file has hard requirements, and Xcode reports them as an opaque
// "unassigned children" warning rather than saying what is wrong. So validate here.

const [sourceArg, ...flags] = process.argv.slice(2);

if (!sourceArg) {
  console.error('Usage: npm run ios:icon -- <path-to-logo> [--crop-margin <percent>]');
  console.error('');
  console.error('Accepts any format sips reads (PNG, WebP, JPEG, HEIC). The source should be');
  console.error('square and at least 1024x1024. iOS applies its own rounded-corner mask, so');
  console.error('artwork with corners already rounded gets masked twice — use --crop-margin');
  console.error('to trim the flat border first.');
  process.exit(1);
}

const source = path.resolve(sourceArg);
try {
  await fs.access(source);
} catch {
  console.error(`No such file: ${source}`);
  process.exit(1);
}

const cropIndex = flags.indexOf('--crop-margin');
const cropMarginPercent = cropIndex === -1 ? 0 : Number(flags[cropIndex + 1]);
if (cropIndex !== -1 && (!Number.isFinite(cropMarginPercent) || cropMarginPercent < 0 || cropMarginPercent >= 50)) {
  console.error('--crop-margin takes a percent between 0 and 50.');
  process.exit(1);
}

const sips = (args) => execFileSync('/usr/bin/sips', args, { encoding: 'utf8' });

// `sips -g` prints "key: value" lines; a missing property is reported as
// "<key>: (null)" rather than omitted, so parse defensively. Reading properties
// works on WebP/HEIC as well as PNG, so probe before deciding on a conversion.
function probe(file) {
  const out = sips(['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', '-g', 'format', file]);
  const read = (key) => out.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1] ?? null;
  return {
    width: Number(read('pixelWidth')),
    height: Number(read('pixelHeight')),
    hasAlpha: read('hasAlpha') === 'yes',
    format: read('format'),
  };
}

const src = probe(source);
console.log(`Source: ${path.relative(process.cwd(), source)}`);
console.log(`  ${src.width}x${src.height}  format=${src.format}  hasAlpha=${src.hasAlpha}`);

if (!Number.isFinite(src.width) || !Number.isFinite(src.height)) {
  console.error('Could not read the image dimensions — is this actually an image file?');
  process.exit(1);
}
if (src.width !== src.height) {
  console.error(`Not square (${src.width}x${src.height}). iOS icons must be 1:1; crop it first.`);
  process.exit(1);
}
if (src.width < 1024) {
  console.error(`Only ${src.width}px wide. Upscaling to 1024 would ship a blurry icon —`);
  console.error('export the logo at 1024x1024 or larger and re-run.');
  process.exit(1);
}

const destination = path.resolve('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');

// Skip sips entirely when the source is already exactly what the catalogue wants.
// Worth special-casing because a re-encode is pure loss here, and because sips
// cannot write files at all under some sandboxes — a plain copy still can.
const needsWork =
  cropMarginPercent > 0 || src.width !== 1024 || src.hasAlpha || src.format !== 'png';

if (!needsWork) {
  await fs.copyFile(source, destination);
  console.log('  already 1024x1024 opaque PNG — copied without re-encoding');
} else {
  const work = path.join(process.env.TMPDIR || '/tmp', `gati-appicon-${process.pid}.png`);
  sips(['-s', 'format', 'png', source, '--out', work]);

  if (cropMarginPercent > 0) {
    const keep = Math.round(src.width * (1 - (cropMarginPercent * 2) / 100));
    sips(['--cropToHeightWidth', String(keep), String(keep), work]);
    console.log(`  cropped ${cropMarginPercent}% from each edge -> ${keep}x${keep}`);
  }

  if (probe(work).width !== 1024) {
    sips(['-z', '1024', '1024', work]);
    console.log('  resized to 1024x1024');
  }

  // App icons must be fully opaque. A transparent icon renders with black showing
  // through the mask on device and is rejected outright by App Store validation.
  // sips cannot composite, so flatten via a max-quality JPEG round trip.
  if (probe(work).hasAlpha) {
    const flat = work.replace(/\.png$/, '.jpg');
    sips(['-s', 'format', 'jpeg', '-s', 'formatOptions', 'best', work, '--out', flat]);
    sips(['-s', 'format', 'png', flat, '--out', work]);
    await fs.rm(flat, { force: true });
    console.log('  flattened alpha channel (icons must be opaque)');
  }

  await fs.copyFile(work, destination);
  await fs.rm(work, { force: true });
}

const final = probe(destination);
console.log(`Installed -> ${path.relative(process.cwd(), destination)}`);
console.log(`  ${final.width}x${final.height}  hasAlpha=${final.hasAlpha}`);
console.log('');
console.log('Xcode caches app icons aggressively. If the home screen still shows the old');
console.log('one, delete the app from the phone and Run again.');
