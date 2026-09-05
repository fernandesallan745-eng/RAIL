import fs from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('node_modules/leaflet/dist');
const destination = path.resolve('public/vendor/leaflet');

// Leaflet must be vendored before `cap sync`: the iOS bundle has no CDN fallback
// worth relying on, and `public/vendor/` is gitignored, so a fresh clone has to
// build it here rather than inherit it from the repo.
try {
  await fs.access(source);
} catch {
  console.error(`Missing ${path.relative(process.cwd(), source)}.`);
  console.error('Run `npm install leaflet` (or `npm install`) first — without it the');
  console.error('iOS bundle ships no map library and renders a blank map offline.');
  process.exit(1);
}

await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.cp(source, destination, { recursive: true });

// Keep Finder metadata out of the app bundle. `cap sync` copies public/ verbatim
// into ios/App/App/public, so a stray .DS_Store ends up shipped inside the IPA.
let pruned = 0;
async function pruneDsStore(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await pruneDsStore(full);
    else if (entry.name === '.DS_Store') { await fs.rm(full); pruned += 1; }
  }
}
await pruneDsStore(path.resolve('public'));

console.log('Prepared bundled Leaflet assets for iOS.');
if (pruned > 0) console.log(`Removed ${pruned} .DS_Store file(s) from public/.`);
