#!/usr/bin/env node
/**
 * scripts/seed_hazards.js — labelled synthetic hazard reports for the demo.
 *
 * WHY THIS EXISTS
 * ---------------
 * An empty confidence map cannot be demoed or evaluated: every panel renders its
 * "nothing reported" branch, and a reviewer cannot tell a working scorer from a
 * broken one. A *labelled* synthetic set can be. Every row carries
 * `isSynthetic: true`, the UI renders a DEMO badge from it, and
 * `--clear` removes exactly those rows and nothing else.
 *
 * WHY IT SEEDS ONLY `logged`
 * --------------------------
 * The status ladder is the safety claim (CLAUDE.md §2, hazardStore.MACHINE_ASSIGNABLE).
 * Writing `candidate` or `corroborated` straight to disk would hand-place reports on
 * rungs the scorer is supposed to earn, and then a demo of the scorer would be a demo
 * of this file. So it seeds the bottom rung and lets hazardConfidence.js score them —
 * what you see in the queue is the real engine's output.
 *
 * `confirmed` is not seeded at all, by the same argument, one step stronger: it is
 * HUMAN_ONLY. The ETA-feedback demo confirms a report by POSTing a real decision
 * through the admin route, which also exercises the audit trail.
 *
 * COORDINATES ARE REAL
 * --------------------
 * Every lat/lng below was read out of the cached Konkan route polyline via
 * `corridor_geometry.point_at_corridor_km()`, not invented. A hazard 4 km from the
 * track would score ~0 on corridorPlausibility and would make the seeded set look
 * like a scorer failure. The canonical km each was sampled at is in the comment.
 *
 * Usage:
 *   node scripts/seed_hazards.js            # add the synthetic set
 *   node scripts/seed_hazards.js --clear    # remove ONLY isSynthetic rows
 *   node scripts/seed_hazards.js --list     # show what is in the store
 */
import {
  loadStore, saveStore, allReports, newReportId, hashDevice, _resetStoreCache,
  HAZARD_CATEGORIES,
} from '../src/services/hazardStore.js';

const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * The scenarios. Each is chosen to exercise one branch of the scorer, so the
 * seeded queue doubles as a visible test of it.
 */
const SCENARIOS = [
  // ── 1. Three independent devices, one landslide, tight time cluster ──────
  // Mid PNVL→KHED: the 175 km block VERIFIED #6 measured curvature's ~2,200×
  // block-wide overstatement on. A ±0.5 km hazard span here is the sub-span test.
  // Sampled at canonical km 12.0.
  { key: 'landslide-cluster', category: 'landslide', device: 'demo-device-alpha',
    lat: 18.399876, lng: 73.219887, minsAgo: 18,
    description: 'Rocks and mud across the down line after heavy overnight rain. Train stopped short of it.' },
  { key: 'landslide-cluster', category: 'landslide', device: 'demo-device-bravo',
    lat: 18.401210, lng: 73.220940, minsAgo: 13,
    description: 'Landslip on the ghat section, debris covering both rails.' },
  { key: 'landslide-cluster', category: 'landslide', device: 'demo-device-charlie',
    lat: 18.398402, lng: 73.218755, minsAgo: 9,
    description: 'Boulder fall near the cutting, track blocked.' },

  // ── 2. TWO REPORTS, ONE DEVICE — the obvious way to fake corroboration ───
  // Must NOT score as independent. This is the invariant verify_hazards.py asserts,
  // and seeding it means the failure would be visible in the demo queue too.
  { key: 'same-device-pair', category: 'flooding', device: 'demo-device-delta',
    lat: 17.367000, lng: 73.531231, minsAgo: 25,
    description: 'Water over the rails near the culvert.' },
  { key: 'same-device-pair', category: 'flooding', device: 'demo-device-delta',
    lat: 17.367450, lng: 73.531800, minsAgo: 22,
    description: 'Still flooded, water level rising.' },

  // ── 3. A single uncorroborated sighting ─────────────────────────────────
  // Should sit at the bottom of the queue. One person seeing something is the
  // normal case and must not escalate on its own.
  { key: 'lone-obstruction', category: 'obstruction', device: 'demo-device-echo',
    lat: 16.707948, lng: 73.619717, minsAgo: 40,
    description: 'Cattle on the track near the level crossing.' },

  // ── 4. Engine failure — real, urgent, and NOT a speed restriction ───────
  // Exercises the category gate in hazard_layer.HAZARD_SPEED_CAP_KMH: this is
  // exactly the class of incident the user asked for ("engine failure... which
  // cannot be detected through software"), it belongs in the queue, and it must
  // still contribute 0.0 km of track restriction because it says nothing about
  // the state of the track.
  { key: 'engine-failure', category: 'engine-failure', device: 'demo-device-foxtrot',
    lat: 15.942052, lng: 73.737775, minsAgo: 6,
    description: 'Loco shut down, train stationary between stations for 20 minutes. No announcement.' },

  // ── 5. Off-corridor control ─────────────────────────────────────────────
  // Inside the validity bbox (so it is accepted) but ~60 km from any track, so
  // corridorPlausibility must score near zero. A scorer that rates this highly is
  // broken, and without a negative control that would be invisible.
  { key: 'off-corridor', category: 'track-damage', device: 'demo-device-golf',
    lat: 17.900000, lng: 74.900000, minsAgo: 30,
    description: 'Control report: deliberately far from the alignment.' },
];

function buildReport(s) {
  return {
    id: newReportId(),
    category: s.category,
    lat: Number(s.lat.toFixed(6)),
    lng: Number(s.lng.toFixed(6)),
    description: s.description,
    reportedAt: minsAgo(s.minsAgo),
    clientReportedAt: null,
    deviceHash: hashDevice(s.device),
    // NO PHOTO IS SEEDED, deliberately. A fabricated JPEG is evidence of nothing,
    // and a photoPath pointing at a file that does not exist would 404 the photo
    // endpoint mid-demo. So `evidence` scores 0 for every synthetic row — the one
    // component the seed set cannot exercise, and it is better to leave it visibly
    // unexercised than to fake it.
    photoPath: null,
    photoWriteFailed: false,
    trainNumber: null,
    accuracyM: 25,
    locationSource: 'gps',
    status: 'logged',          // bottom rung only — see header
    isSynthetic: true,         // the DEMO badge reads this
    scenario: s.key,           // seed-only field, for the audit output below
    auditTrail: [],
  };
}

const args = process.argv.slice(2);
_resetStoreCache();
const store = loadStore();

if (args.includes('--list')) {
  const rs = allReports();
  console.log(`${rs.length} report(s) in the store:`);
  for (const r of rs) {
    console.log(`  ${r.id}  ${r.isSynthetic ? '[SYNTHETIC]' : '[REAL]     '}  `
      + `${(r.status || '?').padEnd(12)} ${(r.category || '?').padEnd(15)} `
      + `${r.lat},${r.lng}`);
  }
  process.exit(0);
}

if (args.includes('--clear')) {
  const before = store.reports.length;
  // Filter on the FLAG, never on "everything" or on a date window. A real report
  // sitting beside the synthetic ones must survive this command — the whole point
  // of the flag is that the two sets are separable.
  store.reports = store.reports.filter((r) => !r.isSynthetic);
  const removed = before - store.reports.length;
  saveStore();
  console.log(`Removed ${removed} synthetic report(s). ${store.reports.length} real report(s) kept.`);
  process.exit(0);
}

const existingSynthetic = store.reports.filter((r) => r.isSynthetic).length;
if (existingSynthetic > 0) {
  console.log(`${existingSynthetic} synthetic report(s) already present. `
    + `Run with --clear first to reseed, or --list to inspect.`);
  process.exit(0);
}

const added = SCENARIOS.map(buildReport);
store.reports.push(...added);
saveStore();

// §8: print the intermediate numbers, not just "done".
console.log(`Seeded ${added.length} synthetic hazard report(s), all status=logged.\n`);
const byScenario = {};
for (const r of added) (byScenario[r.scenario] ||= []).push(r);
for (const [key, rs] of Object.entries(byScenario)) {
  const devices = new Set(rs.map((r) => r.deviceHash));
  console.log(`  ${key}`);
  console.log(`    reports ${rs.length}, distinct devices ${devices.size}`
    + (rs.length > 1 && devices.size === 1 ? '   <- must NOT count as independent' : ''));
  for (const r of rs) {
    const label = HAZARD_CATEGORIES[r.category]?.label || r.category;
    console.log(`      ${r.id}  ${label}  @ ${r.lat},${r.lng}`);
  }
}
console.log(`\nStatuses are machine-scored on read — none was written above 'logged'.`);
console.log(`'confirmed' is HUMAN_ONLY: approve from /admin to move one.`);
console.log(`Remove with: node scripts/seed_hazards.js --clear`);
