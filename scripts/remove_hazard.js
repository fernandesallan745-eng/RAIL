#!/usr/bin/env node
/**
 * scripts/remove_hazard.js — delete a hazard report by id, plus its photo.
 *
 * WHY A SEPARATE SCRIPT FROM seed_hazards.js --clear
 * -------------------------------------------------
 * `--clear` removes only rows flagged `isSynthetic: true`, on purpose: it must never
 * be able to wipe a real reporter's submission. That safety is exactly what makes it
 * useless for the case this script exists for — a report filed through the real form
 * while testing, which is `isSynthetic: false` and therefore renders with NO demo
 * badge. Such a row is indistinguishable from a genuine sighting on the map and in
 * the operator's queue, so it is the one kind of leftover that must be removable.
 *
 * WHY NOT AN HTTP ROUTE
 * ---------------------
 * `rejected` is how a report stops mattering in production: the row, the audit trail
 * and the reporter's credibility history all survive it. Deletion destroys all three.
 * A delete endpoint — even token-guarded — would let one request erase the evidence
 * that a human decision was ever made, so this stays a local operator command.
 *
 * RESTART THE GATEWAY AFTERWARDS.
 * -------------------------------
 * hazardStore.js holds the store in memory (see its header). A running `npm run
 * server` has its own copy and will flush it back over this edit on its next write,
 * silently resurrecting the row. This script cannot reach into that process, so it
 * says so on exit rather than leaving the caller to discover it.
 *
 *   node scripts/remove_hazard.js <id> [<id> ...]
 *   node scripts/remove_hazard.js --list
 */
import {
  allReports, findReport, removeReport, HAZARD_CATEGORIES, STORE_PATH,
} from '../src/services/hazardStore.js';

const args = process.argv.slice(2);

const describe = (r) => {
  const label = HAZARD_CATEGORIES[r.category]?.label || r.category;
  return `${r.id}  ${String(r.status).padEnd(12)} ${label.padEnd(24)} `
    + `${r.isSynthetic ? 'SYNTHETIC' : 'REAL     '} `
    + `@ ${Number(r.lat).toFixed(5)},${Number(r.lng).toFixed(5)}`
    + (r.photoPath ? `  photo=${r.photoPath}` : '');
};

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/remove_hazard.js <id> [<id> ...]');
  console.log('       node scripts/remove_hazard.js --list');
  console.log(`\nStore: ${STORE_PATH}`);
  process.exit(args.length === 0 ? 1 : 0);
}

if (args.includes('--list')) {
  const reports = allReports();
  console.log(`${reports.length} report(s) in ${STORE_PATH}:\n`);
  for (const r of reports) console.log('  ' + describe(r));
  const real = reports.filter((r) => !r.isSynthetic);
  console.log(`\n${real.length} carry isSynthetic:false and render with NO demo badge.`);
  process.exit(0);
}

// Resolve every id BEFORE removing any, so a typo in the second argument does not
// leave the store half-edited. §8: print what will happen, then what happened.
const targets = [];
let missing = 0;
for (const id of args) {
  const r = findReport(id);
  if (!r) { console.error(`  not found: ${id}`); missing += 1; continue; }
  targets.push(r);
}
if (missing) {
  console.error(`\nRefusing to remove anything — ${missing} id(s) did not resolve.`);
  console.error('Run with --list to see the ids actually in the store.');
  process.exit(1);
}

console.log(`Removing ${targets.length} report(s) from ${STORE_PATH}:\n`);
for (const r of targets) console.log('  ' + describe(r));
console.log('');

let removed = 0;
let photosDeleted = 0;
for (const r of targets) {
  const res = removeReport(r.id);
  if (!res.removed) { console.error(`  FAILED ${r.id}: ${res.reason}`); continue; }
  removed += 1;
  if (res.photo.deleted) photosDeleted += 1;
  console.log(`  removed ${r.id}   saved=${res.saved}   `
    + `photo=${res.photo.deleted ? 'deleted' : res.photo.reason}   `
    + `remaining=${res.remaining}`);
}

console.log(`\n${removed} report(s) removed, ${photosDeleted} photo(s) deleted.`);
console.log(`${allReports().length} report(s) remain.`);
console.log(`\nRESTART the gateway (npm run server) if it is running — it holds the`);
console.log(`store in memory and would otherwise write its stale copy back over this.`);
