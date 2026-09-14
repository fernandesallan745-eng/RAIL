#!/usr/bin/env node
/**
 * Phase 7 gateway verifier — drives the REAL Express app in-process.
 *
 * WHY IN-PROCESS RATHER THAN OVER A PORT
 * --------------------------------------
 * This repo's dev sandbox denies `listen` on both 0.0.0.0 and 127.0.0.1, and
 * src/server.js binds all interfaces deliberately (§5d — the iOS app must reach the
 * gateway over the LAN), so that bind is correct and must not be "fixed" to make a test
 * pass. Instead this driver hands synthetic req/res pairs to `app(req, res)`.
 *
 * It imports the actual app, NOT a hand-rebuilt one. That is the whole point: the photo
 * body limit is split across two files — a path-scoped express.json() in src/server.js
 * mounted ahead of the global parser, plus the route-level parser in api.routes.js — and
 * neither half works alone. A verifier that reconstructed the middleware stack would test
 * its own reconstruction and could not catch that ordering bug.
 *
 * ISOLATION: the live store is moved aside for the run and restored in a finally block, so
 * the numbers are deterministic (confidence is peer-relative — pre-existing reports would
 * change every score) and a developer's real reports survive a verification run.
 *
 * Prints every intermediate component score, not just totals (CLAUDE.md §8).
 * Costs ZERO upstream RailRadar requests.
 *
 *   node scripts/verify_hazards_api.js
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import zlib from 'zlib';
import crypto from 'crypto';
import { Readable } from 'stream';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── Environment, set BEFORE the app is imported ─────────────────────────────────────
// ESM hoists static imports above all statements, so the app MUST come in through a
// dynamic import below or these assignments would land too late to matter.
process.env.NODE_ENV = 'test';                      // silences morgan (src/server.js:37)
process.env.HAZARD_SUBMIT_PER_WINDOW = '20';        // headroom for the abuse cases
process.env.HAZARD_SUBMIT_WINDOW_MIN = '15';
// dotenv does not overwrite pre-set variables, so the above win over .env.

// ── Assertions ──────────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  \x1b[31m✘ ${label}\x1b[0m${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n\x1b[1m\x1b[36m${t}\x1b[0m`);
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── A genuinely valid 1×1 PNG, built here rather than pasted ────────────────────────
// decodePhoto checks MAGIC BYTES, so a stub would satisfy the API — but the photo
// round-trip below serves these bytes back, and the browser step later has to display
// them, so it is worth generating something real.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const makePng = () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);            // width
  ihdr.writeUInt32BE(1, 4);            // height
  ihdr[8] = 8;                         // bit depth
  ihdr[9] = 0;                         // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};
const PNG = makePng();
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

// ── In-process request injection ────────────────────────────────────────────────────
let hazardPosts = 0;
const injectApp = (app) => (method, url, { headers = {}, body, rawBody } = {}) =>
  new Promise((resolve, reject) => {
    if (method.toUpperCase() === 'POST' && url.startsWith('/api/hazards')) hazardPosts += 1;

    // Enough of a socket for req.ip (proxy-addr reads connection.remoteAddress, which
    // express-rate-limit's default keyGenerator depends on) without a real one.
    const socket = {
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      writable: true,
      readable: false,
      encrypted: false,
      destroyed: false,
      on() {}, once() {}, removeListener() {}, emit() {}, end() {}, destroy() {},
      setTimeout() {}, setNoDelay() {}, setKeepAlive() {}, cork() {}, uncork() {},
      write() { return true; },
    };

    const payload = rawBody !== undefined
      ? (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)))
      : (body === undefined ? null : Buffer.from(JSON.stringify(body)));

    const req = new Readable({ read() {} });
    req.method = method.toUpperCase();
    req.url = url;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.socket = socket;
    req.connection = socket;
    req.rawHeaders = [];
    req.headers = { host: '127.0.0.1:5050' };
    for (const [k, v] of Object.entries(headers)) req.headers[k.toLowerCase()] = v;
    if (payload) {
      // body-parser's typeis.hasBody() needs one of these, and raw-body uses
      // content-length to trip its limit before reading the stream.
      req.headers['content-length'] = String(payload.length);
      if (!req.headers['content-type']) req.headers['content-type'] = 'application/json';
    }

    const res = new http.ServerResponse(req);
    Object.defineProperty(res, 'writable', { value: true, writable: true, configurable: true });

    // Capture at write/end rather than attaching a socket: OutgoingMessage._writeRaw
    // would otherwise buffer into outputData and we would have to unpick the serialised
    // HTTP frame to read the body back.
    const chunks = [];
    let settled = false;
    res.write = (chunk, enc, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'));
      if (typeof cb === 'function') cb();
      return true;
    };
    res.end = (chunk, enc, cb) => {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'));
      if (typeof cb === 'function') cb();
      if (settled) return res;
      settled = true;
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON — keep raw */ }
      resolve({
        status: res.statusCode,
        headers: Object.fromEntries(
          Object.entries(res.getHeaders()).map(([k, v]) => [k.toLowerCase(), v])
        ),
        json,
        text,
        raw,
      });
      return res;
    };

    try {
      app(req, res);
    } catch (e) {
      reject(e);
      return;
    }
    if (payload) { req.push(payload); }
    req.push(null);
  });

// ── Store isolation ─────────────────────────────────────────────────────────────────
const store = await import('../src/services/hazardStore.js');
const { STORE_PATH, PHOTO_DIR } = store;

const BACKUP = path.join(process.env.TMPDIR || '/tmp', `gati-hazard-backup-${Date.now()}`);
const hadStore = fs.existsSync(STORE_PATH);
const hadPhotos = fs.existsSync(PHOTO_DIR);
fs.mkdirSync(BACKUP, { recursive: true });
if (hadStore) fs.copyFileSync(STORE_PATH, path.join(BACKUP, 'hazards.json'));
if (hadPhotos) fs.cpSync(PHOTO_DIR, path.join(BACKUP, 'photos'), { recursive: true });
if (hadStore) fs.rmSync(STORE_PATH);
if (hadPhotos) fs.rmSync(PHOTO_DIR, { recursive: true, force: true });
store._resetStoreCache();

const restore = () => {
  try {
    fs.rmSync(STORE_PATH, { force: true });
    fs.rmSync(PHOTO_DIR, { recursive: true, force: true });
    if (hadStore) fs.copyFileSync(path.join(BACKUP, 'hazards.json'), STORE_PATH);
    if (hadPhotos) fs.cpSync(path.join(BACKUP, 'photos'), PHOTO_DIR, { recursive: true });
    fs.rmSync(BACKUP, { recursive: true, force: true });
  } catch (e) {
    console.error(`\x1b[31mRESTORE FAILED — backup kept at ${BACKUP}: ${e.message}\x1b[0m`);
  }
};

// ── Import the real app, filtering only the sandbox's EPERM bind line ───────────────
// The filter stays installed for the WHOLE run, not just the import: app.listen()'s
// failure surfaces through server.on('error'), which fires on a later tick, so
// restoring console.error straight after the import let the stack trace through and
// reported bindDenied=false for a bind that had in fact been denied.
const realError = console.error;
let bindDenied = false;
console.error = (...args) => {
  const s = args.map(String).join(' ');
  if (s.includes('listen EPERM') || (s.includes('Server error') && s.includes('EPERM'))) {
    bindDenied = true;
    return;
  }
  realError(...args);
};
const { config } = await import('../src/config/env.js');
const { default: app } = await import('../src/server.js');
// Let the deferred listen error land before anything is reported.
await new Promise((r) => setTimeout(r, 50));

const inject = injectApp(app);
const cacheHash = () =>
  execSync("find .cache -name '*.json' | sort | xargs md5 -q | md5", { cwd: REPO })
    .toString().trim();

let exitCode = 0;
try {
  console.log('\n\x1b[1mGATI Phase 7 — hazard gateway verification (in-process)\x1b[0m');
  console.log(`  app imported from src/server.js · port bind denied by sandbox: ${bindDenied}`);
  console.log(`  store isolated: ${STORE_PATH.replace(REPO + '/', '')} (backup ${hadStore ? 'taken' : 'none needed'})`);
  const cacheBefore = cacheHash();
  console.log(`  .cache/ content hash before: ${cacheBefore}`);

  const RATNAGIRI = { lat: 17.00311, lng: 73.35727 };

  // ── 1. Submit, and the corroboration ladder ───────────────────────────────────────
  section('1. Submit + peer-relative confidence (§2 USP 5: independent report count)');

  const submit = (over = {}) => inject('POST', '/api/hazards', {
    body: {
      category: 'landslide',
      lat: RATNAGIRI.lat,
      lng: RATNAGIRI.lng,
      description: 'Boulders and mud across the down line, speed < 20 kmph past the site',
      locationSource: 'gps',
      accuracyM: 12,
      ...over,
    },
  });

  const r1 = await submit({ deviceId: 'device-a' });
  check('POST /api/hazards → 201', r1.status === 201, `got ${r1.status} ${r1.text.slice(0, 200)}`);
  check('response carries decisionSupportOnly', r1.json?.decisionSupportOnly === true);
  check('submitter cannot choose a status (starts machine-scored)',
    ['logged', 'candidate', 'corroborated'].includes(r1.json?.data?.status),
    `status=${r1.json?.data?.status}`);
  check('photoPath / deviceHash never reach the wire',
    r1.json?.data?.photoPath === undefined && r1.json?.data?.deviceHash === undefined);

  const printComponents = (label, scored) => {
    const s = scored.scoring;
    console.log(`\n  \x1b[1m${label}\x1b[0m  confidence=\x1b[1m${s.confidence.toFixed(3)}\x1b[0m  `
      + `machineStatus=\x1b[1m${s.machineStatus}\x1b[0m  weightUsed=${s.weightUsed.toFixed(2)}`);
    for (const [name, c] of Object.entries(s.components)) {
      const sc = c.score === null ? ' null' : c.score.toFixed(3);
      console.log(`    ${name.padEnd(22)} score=${sc}  weight=${String(s.weights[name]).padEnd(5)}`
        + `  basis=${c.basis}${c.detail ? `  (${c.detail})` : ''}`);
    }
    if (s.componentsUnavailable?.length) {
      console.log(`    componentsUnavailable: ${s.componentsUnavailable.join(', ')} `
        + '(EXCLUDED from the weight, not scored as zero — VERIFIED #9)');
    }
  };
  printComponents('report 1 (device-a, alone)', r1.json.data);

  // Weighted sum must reconcile against the reported total over the AVAILABLE weight.
  const reconciles = (scored) => {
    const s = scored.scoring;
    let acc = 0;
    let w = 0;
    for (const [name, c] of Object.entries(s.components)) {
      if (c.score === null) continue;
      acc += s.weights[name] * c.score;
      w += s.weights[name];
    }
    return { expected: w > 0 ? acc / w : 0, weightSeen: w, reported: s.confidence };
  };
  const rec1 = reconciles(r1.json.data);
  check('confidence reconciles from its own components',
    near(rec1.expected, rec1.reported, 5e-3),
    `Σ(w·s)/w = ${rec1.expected.toFixed(4)} vs reported ${rec1.reported.toFixed(4)}`);
  check('weightUsed equals the weight of available components',
    near(rec1.weightSeen, r1.json.data.scoring.weightUsed, 1e-6),
    `${rec1.weightSeen} vs ${r1.json.data.scoring.weightUsed}`);

  const r2 = await submit({ deviceId: 'device-b' });
  const r3 = await submit({ deviceId: 'device-c' });
  printComponents('report 1 as re-scored after 2 more witnesses', (await (async () => {
    const list = await inject('GET', '/api/hazards');
    return list.json.data.reports.find((x) => x.id === r1.json.data.id);
  })()));

  const conf = async (id) => {
    const list = await inject('GET', '/api/hazards');
    return list.json.data.reports.find((x) => x.id === id);
  };
  const after3 = await conf(r1.json.data.id);
  console.log(`\n  ladder: 1 device → ${r1.json.data.scoring.confidence.toFixed(3)} `
    + `(${r1.json.data.scoring.machineStatus})  →  3 devices → `
    + `${after3.scoring.confidence.toFixed(3)} (${after3.scoring.machineStatus})`);
  check('a new witness RAISES an existing report\'s confidence (peer-relative rescore)',
    after3.scoring.confidence > r1.json.data.scoring.confidence,
    `${r1.json.data.scoring.confidence} → ${after3.scoring.confidence}`);
  check('3 independent devices reach corroborated',
    after3.scoring.machineStatus === 'corroborated',
    `machineStatus=${after3.scoring.machineStatus}`);
  check('statusSource says machine-score before any human acts',
    after3.statusSource === 'machine-score');

  // The obvious way to fake corroboration.
  const beforeDup = (await conf(r1.json.data.id)).scoring.components.independentReports.score;
  const dup = await submit({ deviceId: 'device-a', description: 'same phone reporting twice' });
  const afterDup = (await conf(r1.json.data.id)).scoring.components.independentReports.score;
  console.log(`\n  independentReports for report 1: ${beforeDup.toFixed(3)} before a duplicate `
    + `from device-a, ${afterDup.toFixed(3)} after`);
  check('a SECOND report from the same deviceId does not add independence',
    near(beforeDup, afterDup, 1e-9),
    `${beforeDup} → ${afterDup}`);
  check('duplicate submission is still accepted (logged, not silently dropped)',
    dup.status === 201);

  // ── 2. Machine ceiling ────────────────────────────────────────────────────────────
  section('2. The machine ceiling is `corroborated` (CLAUDE.md §2, non-negotiable)');
  const all = await inject('GET', '/api/hazards');
  const overCeiling = all.json.data.reports.filter(
    (r) => !['logged', 'candidate', 'corroborated'].includes(r.machineStatus)
  );
  check('no machineStatus anywhere exceeds corroborated', overCeiling.length === 0,
    overCeiling.map((r) => `${r.id}=${r.machineStatus}`).join(', '));
  check('machineCeiling is declared in the payload',
    all.json.data.machineCeiling === 'corroborated');
  check('humanOnlyStatuses declared', Array.isArray(all.json.data.humanOnlyStatuses)
    && all.json.data.humanOnlyStatuses.join(',') === 'confirmed,rejected');

  section('3. Honesty block is present and correctly valued (§5e/§5g)');
  const d = all.json.data;
  check('confidenceModelIsHeuristic: true', d.confidenceModelIsHeuristic === true);
  check("trainPresenceBasis: 'scheduled' (VERIFIED #3 — no live speed in this source)",
    d.trainPresenceBasis === 'scheduled');
  check('decisionSupportOnly: true', d.decisionSupportOnly === true);
  check('adminAuthenticated reflects the unset token', d.adminAuthenticated === false);
  check('corridor scoring availability is reported',
    d.corridor && typeof d.corridor.available === 'boolean',
    JSON.stringify(d.corridor));
  console.log(`  corridor: ${JSON.stringify(d.corridor)}`);
  console.log(`  counts: ${JSON.stringify(d.counts)}`);
  check('rows are ordered by confidence, highest first',
    d.reports.every((r, i) => i === 0
      || d.reports[i - 1].scoring.confidence >= r.scoring.confidence));

  // ── 4. Validation / abuse ─────────────────────────────────────────────────────────
  section('4. Validation and abuse paths');
  const badCat = await submit({ deviceId: 'device-e', category: 'alien-invasion' });
  check('unknown category → 422 invalid-category',
    badCat.status === 422 && badCat.json?.reason === 'invalid-category',
    `${badCat.status} ${badCat.json?.reason}`);
  check('the rejection lists the valid categories',
    Array.isArray(badCat.json?.validCategories) && badCat.json.validCategories.length === 11,
    `${badCat.json?.validCategories?.length} listed`);

  const nullIsland = await submit({ deviceId: 'device-e', lat: 0, lng: 0 });
  check('0,0 (failed geolocation) → 422 coordinates-outside-corridor-region',
    nullIsland.status === 422 && nullIsland.json?.reason === 'coordinates-outside-corridor-region',
    `${nullIsland.status} ${nullIsland.json?.reason}`);

  const noCoords = await submit({ deviceId: 'device-e', lat: 'not-a-number', lng: undefined });
  check('non-numeric coordinates → 422 invalid-coordinates',
    noCoords.status === 422 && noCoords.json?.reason === 'invalid-coordinates',
    `${noCoords.status} ${noCoords.json?.reason}`);

  const fakeImage = await submit({
    deviceId: 'device-e',
    photo: `data:image/jpeg;base64,${Buffer.from('this is not an image at all').toString('base64')}`,
  });
  check('text bytes behind an image/jpeg data URL → 422 photo-bytes-are-not-an-image',
    fakeImage.status === 422 && fakeImage.json?.reason === 'photo-bytes-are-not-an-image',
    `${fakeImage.status} ${fakeImage.json?.reason}`);

  const ctrl = await submit({
    deviceId: 'device-f',
    description: `null byte and a bell but keep speed < 20 kmph`,
  });
  check('control bytes stripped, angle brackets PRESERVED (renderer escapes, not the store)',
    ctrl.status === 201
      && !/[ --]/.test(ctrl.json.data.description)
      && ctrl.json.data.description.includes('speed < 20 kmph'),
    JSON.stringify(ctrl.json?.data?.description));

  const longDesc = await submit({ deviceId: 'device-f', description: 'x'.repeat(5000) });
  check(`description clamped to ${config.hazards.maxDescriptionChars} chars`,
    longDesc.json?.data?.description?.length === config.hazards.maxDescriptionChars,
    `got ${longDesc.json?.data?.description?.length}`);

  const clockLie = await submit({
    deviceId: 'device-g',
    clientReportedAt: '1999-01-01T00:00:00.000Z',
  });
  check('reportedAt is the SERVER clock, not the client\'s claim',
    new Date(clockLie.json.data.reportedAt).getFullYear() >= 2026
      && clockLie.json.data.clientReportedAt === '1999-01-01T00:00:00.000Z',
    `reportedAt=${clockLie.json?.data?.reportedAt}`);

  // ── 5. Photo pipeline ─────────────────────────────────────────────────────────────
  section('5. Photo: magic-byte accept, store-resolved filename, round-trip');
  const withPhoto = await submit({ deviceId: 'device-h', photo: PNG_DATA_URL });
  check('valid PNG accepted → 201', withPhoto.status === 201, `${withPhoto.status}`);
  check('hasPhoto true and photoUrl points at the route (not a static path)',
    withPhoto.json?.data?.hasPhoto === true
      && withPhoto.json.data.photoUrl === `/api/hazards/${withPhoto.json.data.id}/photo`);
  check('photo did NOT land under public/ (it would ship inside the IPA — §5d)',
    !fs.existsSync(path.join(REPO, 'public', 'hazard-photos')));

  const photoGet = await inject('GET', `/api/hazards/${withPhoto.json.data.id}/photo`);
  check('GET photo → 200 image/png', photoGet.status === 200
    && photoGet.headers['content-type'] === 'image/png',
    `${photoGet.status} ${photoGet.headers['content-type']}`);
  check('X-Content-Type-Options: nosniff on user-supplied bytes',
    photoGet.headers['x-content-type-options'] === 'nosniff');
  check('bytes round-trip identically', photoGet.raw.equals(PNG),
    `${photoGet.raw.length} bytes vs ${PNG.length}`);

  const noPhoto = await inject('GET', `/api/hazards/${r1.json.data.id}/photo`);
  check('report without a photo → 404 no-photo',
    noPhoto.status === 404 && noPhoto.json?.reason === 'no-photo',
    `${noPhoto.status} ${noPhoto.json?.reason}`);

  const traversal = await inject('GET', '/api/hazards/..%2F..%2F.env/photo');
  check('path traversal in the id → 404 report-not-found (filename comes from the store)',
    traversal.status === 404 && traversal.json?.reason === 'report-not-found',
    `${traversal.status} ${traversal.json?.reason}`);
  check('.env was not served', !traversal.text.includes('RAILRADAR_API_KEY'));

  // ── 6. Body limit is SCOPED, not global ───────────────────────────────────────────
  section('6. Body limit is scoped to /api/hazards (two-file fix — server.js + api.routes.js)');
  const big = JSON.stringify({
    category: 'other', lat: RATNAGIRI.lat, lng: RATNAGIRI.lng,
    deviceId: 'device-i', description: 'p'.repeat(200 * 1024),
  });
  const bigOk = await inject('POST', '/api/hazards', { rawBody: big });
  console.log(`  ${Math.round(big.length / 1024)} KB body → /api/hazards: ${bigOk.status}`);
  check('a 200 KB body is accepted on /api/hazards (global default is 100 KB)',
    bigOk.status === 201, `${bigOk.status} ${bigOk.text.slice(0, 160)}`);

  const bigElsewhere = await inject('POST', '/api/admin/cache/flush', { rawBody: big });
  console.log(`  ${Math.round(big.length / 1024)} KB body → /api/admin/cache/flush: ${bigElsewhere.status}`);
  check('the SAME body is rejected on another /api route → limit really is scoped',
    bigElsewhere.status === 413,
    `${bigElsewhere.status} — if 200, the raised limit leaked globally`);

  const tooBig = JSON.stringify({
    category: 'other', lat: RATNAGIRI.lat, lng: RATNAGIRI.lng,
    deviceId: 'device-i', description: 'q'.repeat(1300 * 1024),
  });
  const over = await inject('POST', '/api/hazards', { rawBody: tooBig });
  console.log(`  ${Math.round(tooBig.length / 1024)} KB body → /api/hazards: ${over.status} `
    + `(limit ${Math.round(config.hazards.maxBodyBytes / 1024)} KB)`);
  check('over the hazard limit → 413, not a crash', over.status === 413, `${over.status}`);

  const hugePhoto = await submit({
    deviceId: 'device-i',
    photo: `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(700 * 1024, 0x41)]).toString('base64')}`,
  });
  check(`decoded photo over ${Math.round(config.hazards.maxPhotoBytes / 1024)} KB → 422 photo-too-large`,
    hugePhoto.status === 422 && hugePhoto.json?.reason === 'photo-too-large',
    `${hugePhoto.status} ${hugePhoto.json?.reason}`);

  // ── 7. Human decision — unauthenticated (degrade loudly) ──────────────────────────
  section('7. Human decision with GATI_ADMIN_TOKEN unset — works, but LOUDLY');
  check('token is genuinely unset for this run', config.hazards.adminToken === '');

  const target = r1.json.data.id;
  const machineBefore = (await conf(target)).machineStatus;
  const persistedBefore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    .reports.find((r) => r.id === target).status;
  console.log(`  status as the operator sees it: ${machineBefore} · `
    + `status persisted on disk: ${persistedBefore}`
    + `${machineBefore === persistedBefore ? '' : '   ← they disagree, which is the bug'}`);
  const dec = await inject('POST', `/api/admin/hazards/${target}/decision`, {
    body: { decision: 'confirmed', note: 'Section Controller confirmed by phone.' },
  });
  check('decision accepted → 200', dec.status === 200, `${dec.status} ${dec.text.slice(0, 200)}`);
  console.log(`  statusBefore=${dec.json?.statusBefore} (${dec.json?.statusBeforeBasis}) `
    + `statusAfter=${dec.json?.statusAfter} `
    + `machineStatusAtDecision=${dec.json?.machineStatusAtDecision} `
    + `confidenceAtDecision=${dec.json?.confidenceAtDecision?.toFixed(3)}`);
  check('statusBefore is the status the operator SAW, not the stale persisted hint',
    dec.json?.statusBefore === machineBefore && dec.json?.statusAfter === 'confirmed',
    `${dec.json?.statusBefore} → ${dec.json?.statusAfter}, operator saw ${machineBefore}`);
  check('statusBeforeBasis labels it machine-score for a first decision',
    dec.json?.statusBeforeBasis === 'machine-score', dec.json?.statusBeforeBasis);
  check("tokenState recorded as 'unverified'", dec.json?.tokenState === 'unverified');
  check('authWarning present and names the risk',
    typeof dec.json?.authWarning === 'string'
      && /without authentication/i.test(dec.json.authWarning));
  check('exactly one audit entry added', dec.json?.auditEntriesAdded === 1
    && dec.json?.auditTrailLength === 1,
    `added=${dec.json?.auditEntriesAdded} length=${dec.json?.auditTrailLength}`);
  check('appliesToEta true for a confirm', dec.json?.appliesToEta === true);
  check('the confirm note states nothing was dispatched',
    /nothing has been dispatched/i.test(dec.json?.note || ''));

  const confirmed = await conf(target);
  check('a human decision OVERRIDES the machine score on read',
    confirmed.status === 'confirmed' && confirmed.statusSource === 'human-decision');
  check('the machine score is still reported alongside it (not overwritten)',
    ['logged', 'candidate', 'corroborated'].includes(confirmed.machineStatus),
    `machineStatus=${confirmed.machineStatus}`);

  const badDecision = await inject('POST', `/api/admin/hazards/${r2.json.data.id}/decision`, {
    body: { decision: 'corroborated' },
  });
  check('an operator cannot hand-set a MACHINE status → 422 invalid-decision',
    badDecision.status === 422 && badDecision.json?.reason === 'invalid-decision',
    `${badDecision.status} ${badDecision.json?.reason}`);

  const missing = await inject('POST', '/api/admin/hazards/hz_nope/decision', {
    body: { decision: 'confirmed' },
  });
  check('unknown id → 404 report-not-found',
    missing.status === 404 && missing.json?.reason === 'report-not-found');

  const rej = await inject('POST', `/api/admin/hazards/${dup.json.data.id}/decision`, {
    body: { decision: 'rejected', note: 'duplicate of the same phone' },
  });
  check('reject path works and says it cannot affect an ETA',
    rej.status === 200 && rej.json?.appliesToEta === false
      && /cannot affect/i.test(rej.json?.note || ''));

  // GET must not require auth (the map reads it) but a rejected report must stop helping.
  // Its own isolated cluster: a DIFFERENT category at a DIFFERENT km, because
  // independentReports only counts peers of the same category within the radius/window,
  // and the earlier landslide cluster kept growing as later checks submitted to it —
  // which is why an unisolated version of this test read the number going UP.
  const CHIPLUN = { lat: 17.52, lng: 73.52 };
  const flood = (deviceId) => inject('POST', '/api/hazards', {
    body: {
      category: 'flooding', lat: CHIPLUN.lat, lng: CHIPLUN.lng, deviceId,
      description: 'Water over the rails at the cutting', locationSource: 'gps',
    },
  });
  const f1 = await flood('flood-device-1');
  await flood('flood-device-2');
  const f3 = await flood('flood-device-3');
  const floodBefore = (await conf(f1.json.data.id)).scoring.components.independentReports;
  await inject('POST', `/api/admin/hazards/${f3.json.data.id}/decision`, {
    body: { decision: 'rejected', note: 'observer retracted it' },
  });
  const floodAfter = (await conf(f1.json.data.id)).scoring.components.independentReports;
  console.log(`  isolated flooding cluster at km ~${CHIPLUN.lat}: independentReports `
    + `${floodBefore.score.toFixed(3)} (${floodBefore.detail || floodBefore.note || ''}) `
    + `→ ${floodAfter.score.toFixed(3)} after one of three peers is REJECTED`);
  check('a rejected report no longer corroborates its peers',
    floodAfter.score < floodBefore.score,
    `${floodBefore.score} → ${floodAfter.score}`);

  // ── 8. Human decision — token SET ─────────────────────────────────────────────────
  section('8. Human decision with GATI_ADMIN_TOKEN set');
  config.hazards.adminToken = 'demo-operator-token';   // resolveActor reads this per call
  try {
    const noTok = await inject('POST', `/api/admin/hazards/${r3.json.data.id}/decision`, {
      body: { decision: 'confirmed' },
    });
    check('no header → 401 admin-token-required',
      noTok.status === 401 && noTok.json?.reason === 'admin-token-required',
      `${noTok.status} ${noTok.json?.reason}`);

    const wrongTok = await inject('POST', `/api/admin/hazards/${r3.json.data.id}/decision`, {
      headers: { 'x-admin-token': 'wrong-token-entirely-different-length' },
      body: { decision: 'confirmed' },
    });
    check('wrong header → 401 admin-token-invalid (no throw on unequal lengths)',
      wrongTok.status === 401 && wrongTok.json?.reason === 'admin-token-invalid',
      `${wrongTok.status} ${wrongTok.json?.reason}`);
    check('the 401 body never echoes the expected token',
      !wrongTok.text.includes('demo-operator-token'));

    const rightTok = await inject('POST', `/api/admin/hazards/${r3.json.data.id}/decision`, {
      headers: { 'x-admin-token': 'demo-operator-token' },
      body: { decision: 'confirmed', actor: 'controller-ratnagiri' },
    });
    check('correct header → 200, tokenState verified',
      rightTok.status === 200 && rightTok.json?.tokenState === 'verified',
      `${rightTok.status} ${rightTok.json?.tokenState}`);
    check('no authWarning when authenticated', rightTok.json?.authWarning === null);

    const bearer = await inject('POST', `/api/admin/hazards/${r2.json.data.id}/decision`, {
      headers: { authorization: 'Bearer demo-operator-token' },
      body: { decision: 'rejected' },
    });
    check('Authorization: Bearer accepted as well',
      bearer.status === 200 && bearer.json?.tokenState === 'verified',
      `${bearer.status} ${bearer.json?.tokenState}`);

    const listAuthed = await inject('GET', '/api/hazards');
    check('adminAuthenticated flips to true in the payload',
      listAuthed.json?.data?.adminAuthenticated === true);
    check('GET /api/hazards still needs no token (the public map reads it)',
      listAuthed.status === 200);
  } finally {
    config.hazards.adminToken = '';
  }

  // ── 9. Audit trail ────────────────────────────────────────────────────────────────
  section('9. Audit trail is append-only and attributes each decision');
  const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  const audited = raw.reports.filter((r) => (r.auditTrail || []).length > 0);
  console.log(`  ${audited.length} of ${raw.reports.length} reports carry audit entries`);
  for (const r of audited) {
    for (const e of r.auditTrail) {
      console.log(`    ${r.id}  ${String(e.decision).padEnd(9)} actor=${String(e.actor).padEnd(22)}`
        + ` tokenState=${e.tokenState}  previousStatus=${e.previousStatus}`
        + ` (${e.previousStatusBasis})`);
    }
  }
  check('every audit entry records decision, actor, tokenState and previousStatus',
    audited.every((r) => r.auditTrail.every((e) => e.decision && e.actor
      && e.tokenState && e.previousStatus !== undefined && e.at)));
  check('the audit field is named `decision`, matching the API the operator submits',
    audited.every((r) => r.auditTrail.every((e) => e.action === undefined
      && typeof e.decision === 'string')));
  check('previousStatus is the EFFECTIVE status, labelled as such (VERIFIED #21/#29)',
    audited.every((r) => r.auditTrail.every((e) => e.previousStatusBasis === 'effective')),
    'a persisted-hint basis means the audit trail recorded a screen nobody saw');
  check('a verified decision is attributed to its actor, not to "unverified"',
    audited.some((r) => r.auditTrail.some((e) => e.tokenState === 'verified'
      && e.actor === 'controller-ratnagiri')));
  check('an unauthenticated decision is recorded as unverified',
    audited.some((r) => r.auditTrail.some((e) => e.tokenState === 'unverified')));

  const secondDecision = await inject('POST', `/api/admin/hazards/${target}/decision`, {
    body: { decision: 'rejected', note: 'reversed after inspection' },
  });
  check('a reversal APPENDS rather than replacing (trail length 1 → 2)',
    secondDecision.json?.auditTrailLength === 2 && secondDecision.json?.auditEntriesAdded === 1,
    `length=${secondDecision.json?.auditTrailLength}`);
  check('the reversal records the previous human status',
    secondDecision.json?.statusBefore === 'confirmed'
      && secondDecision.json?.statusAfter === 'rejected');
  check('a reversal is labelled human-decision, not machine-score',
    secondDecision.json?.statusBeforeBasis === 'human-decision',
    secondDecision.json?.statusBeforeBasis);

  // ── 10. Status filter ─────────────────────────────────────────────────────────────
  section('10. Status filter');
  const bogus = await inject('GET', '/api/hazards?status=definitely-not-a-status');
  check('unknown status filter → 422 invalid-status-filter',
    bogus.status === 422 && bogus.json?.reason === 'invalid-status-filter',
    `${bogus.status} ${bogus.json?.reason}`);
  check('the rejection lists the valid statuses',
    bogus.json?.validStatuses?.join(',') === 'logged,candidate,corroborated,confirmed,rejected',
    JSON.stringify(bogus.json?.validStatuses));
  const onlyRejected = await inject('GET', '/api/hazards?status=rejected');
  check('?status=rejected returns only rejected rows',
    onlyRejected.json.data.reports.length > 0
      && onlyRejected.json.data.reports.every((r) => r.status === 'rejected'),
    `${onlyRejected.json?.data?.reports?.length} rows`);

  // ── 11. Health ────────────────────────────────────────────────────────────────────
  section('11. /api/health hazard block');
  const health = await inject('GET', '/api/health');
  check('/api/health → 200', health.status === 200, `${health.status}`);
  check('flat envelope, no data wrapper (§5f)', health.json?.data === undefined
    || health.json?.hazards !== undefined);
  const hz = health.json?.hazards;
  console.log(`  hazards: ${JSON.stringify(hz)}`);
  check('hazard block present with a total', hz && typeof hz.total === 'number');
  check('upstreamRequestCost declared 0', hz?.upstreamRequestCost === 0);
  check('adminTokenConfigured is a boolean flag, never the token',
    typeof hz?.adminTokenConfigured === 'boolean'
      && !JSON.stringify(health.json).includes('demo-operator-token'));
  check('no RailRadar key value anywhere in /api/health',
    !/rr_live_/.test(JSON.stringify(health.json)));

  // ── 12. Store integrity ───────────────────────────────────────────────────────────
  section('12. Store integrity and .cache/ immutability');
  check('store on disk is valid JSON with a reports array', Array.isArray(raw.reports));
  const reread = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  check('store re-reads cleanly after every write', Array.isArray(reread.reports));
  check('no stray tmp file left behind',
    !fs.existsSync(`${STORE_PATH}.tmp`) && !fs.readdirSync(path.dirname(STORE_PATH))
      .some((f) => f.startsWith('hazards.json.') && f.endsWith('.tmp')),
    fs.readdirSync(path.dirname(STORE_PATH)).join(', '));
  const cacheAfter = cacheHash();
  console.log(`  .cache/ content hash after:  ${cacheAfter}`);
  check('.cache/ byte-identical across the whole submit→approve cycle',
    cacheBefore === cacheAfter, `${cacheBefore} vs ${cacheAfter}`);

  // ── 13. Rate limiter ──────────────────────────────────────────────────────────────
  section('13. Submit limiter is wired (its own limiter, not the 2000/15min apiLimiter)');
  console.log(`  configured: ${config.hazards.submitPerWindow} per `
    + `${config.hazards.submitWindowMin} min · POSTs to /api/hazards so far: ${hazardPosts}`);
  let tripped = null;
  for (let i = 0; i < 40 && tripped === null; i += 1) {
    const r = await submit({ deviceId: `flood-${i}` });
    if (r.status === 429) tripped = { at: hazardPosts, body: r.json };
  }
  check('the limiter trips rather than accepting unbounded submits', tripped !== null);
  if (tripped) {
    console.log(`  429 at POST #${tripped.at} · reason=${tripped.body?.reason}`);
    check('429 carries the machine-readable reason code',
      tripped.body?.reason === 'hazard-submit-rate-limited', JSON.stringify(tripped.body));
    check('the 429 explains the shared-NAT case rather than just refusing',
      /one network/i.test(tripped.body?.detail || ''), tripped.body?.detail);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────────
  const finalList = await inject('GET', '/api/hazards');
  console.log('\n\x1b[1mFinal store state\x1b[0m');
  console.log(`  ${finalList.json.data.total} reports · counts `
    + `${JSON.stringify(finalList.json.data.counts)}`);

  console.log(`\n${'─'.repeat(78)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1mALL CHECKS PASSED\x1b[0m — ${passed} assertions`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failures.length} CHECK(S) FAILED\x1b[0m (${passed} passed)`);
    for (const f of failures) console.log(`  \x1b[31m✘\x1b[0m ${f}`);
    exitCode = 1;
  }
  console.log('Zero upstream RailRadar requests were made.');
} catch (err) {
  console.error(`\n\x1b[31mVERIFIER CRASHED: ${err.stack}\x1b[0m`);
  exitCode = 1;
} finally {
  console.error = realError;
  restore();
  console.log(`Store restored (${hadStore ? 'previous file put back' : 'test file removed'}).`);
}

process.exit(exitCode);
