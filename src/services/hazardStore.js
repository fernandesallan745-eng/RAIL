/**
 * Hazard report store — Phase 7 persistence.
 *
 * WHY A JSON FILE, AND WHY NOT IN .cache/
 * ---------------------------------------
 * `.cache/` is the offline corpus the entire model reads and would cost ~1,000
 * upstream RailRadar requests to rebuild — admin.controller.js already treats
 * writing there as a destructive action no browser may trigger. Hazard reports are
 * NEW data that is ours, not cached upstream data, so they live in src/data/
 * beside speed-history.json.
 *
 * The production stack in CLAUDE.md §7 is PostgreSQL + TimescaleDB. This file is
 * the prototype's stand-in and is deliberately shaped like a table (flat rows,
 * immutable ids, an append-only audit trail) so the migration is a port, not a
 * redesign. It is NOT a database: no concurrent-writer safety beyond the atomic
 * rename below, and the whole store is held in memory.
 *
 * WRITE SAFETY
 * ------------
 * tmp + renameSync, copied from src/services/railradar.js:204 — "so a crash
 * mid-write cannot leave a truncated JSON behind." rename(2) is atomic within a
 * filesystem, so a reader sees either the old file or the new one, never a
 * half-written one. A hazard store that can be corrupted by a badly-timed Ctrl+C
 * is worse than no store, because the corruption is silent until the next boot.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STORE_PATH = path.join(__dirname, '../data/hazards.json');
export const PHOTO_DIR = path.join(__dirname, '../data/hazard-photos');

/**
 * Report categories. A FIXED list, validated server-side.
 *
 * Free-text categories would make the `independentReports` corroboration signal
 * meaningless — two people describing the same landslide as "landslide" and
 * "rocks on track" would never cluster, so real corroboration would score zero.
 * The fixed list is what makes clustering possible at all.
 *
 * `requiresImmediateAttention` marks the categories an operator would want surfaced
 * first. It orders the queue. It does NOT dispatch anything (CLAUDE.md §2).
 */
export const HAZARD_CATEGORIES = {
  'engine-failure':     { label: 'Engine / loco failure',     requiresImmediateAttention: true },
  'obstruction':        { label: 'Track obstruction',         requiresImmediateAttention: true },
  'landslide':          { label: 'Landslide / rockfall',      requiresImmediateAttention: true },
  'flooding':           { label: 'Flooding / waterlogging',   requiresImmediateAttention: true },
  'fire':               { label: 'Fire / smoke',              requiresImmediateAttention: true },
  'track-damage':       { label: 'Visible track damage',      requiresImmediateAttention: true },
  'signal-failure':     { label: 'Signal failure',            requiresImmediateAttention: false },
  'overcrowding':       { label: 'Severe overcrowding',       requiresImmediateAttention: false },
  'medical':            { label: 'Medical emergency',         requiresImmediateAttention: true },
  'unusual-stop':       { label: 'Unexplained prolonged halt', requiresImmediateAttention: false },
  'other':              { label: 'Other',                     requiresImmediateAttention: false },
};

/**
 * The status ladder. The MACHINE'S CEILING IS `corroborated`.
 *
 *   logged → candidate → corroborated ─╫→ confirmed   (human only)
 *                                      ╫→ rejected    (human only)
 *
 * CLAUDE.md §2, non-negotiable: "All conflict alerts and hazard escalations require
 * human confirmation (Section Controller / Control Room Operator)." Expressing that
 * as a state machine rather than a promise means the code cannot drift from the
 * claim — MACHINE_ASSIGNABLE is the enforcement, and hazardConfidence.js may only
 * ever return a status from it.
 */
export const MACHINE_ASSIGNABLE = ['logged', 'candidate', 'corroborated'];
export const HUMAN_ONLY = ['confirmed', 'rejected'];
export const ALL_STATUSES = [...MACHINE_ASSIGNABLE, ...HUMAN_ONLY];

const EMPTY_STORE = {
  _meta: {
    schema: 'gati-hazards-v1',
    note: 'Crowdsourced hazard reports. confirmed/rejected are reachable only through '
        + 'a human admin decision — see MACHINE_ASSIGNABLE in src/services/hazardStore.js.',
    createdAt: null,
  },
  reports: [],
};

let store = null;

/** Read the store from disk once, then serve from memory. */
export function loadStore() {
  if (store) return store;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      // Tolerate a hand-edited file that lost its wrapper, but never invent rows.
      store = {
        _meta: parsed._meta || { ...EMPTY_STORE._meta },
        reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      };
    } else {
      store = { ...EMPTY_STORE, _meta: { ...EMPTY_STORE._meta, createdAt: new Date().toISOString() }, reports: [] };
    }
  } catch (e) {
    // A corrupt store must be LOUD. Serving an empty one silently would look
    // identical to "nobody has reported anything" — the VERIFIED #9 failure, where
    // a legitimate-looking zero hides a broken layer.
    console.error(`\x1b[31m[Hazards] hazards.json is unreadable (${e.message}). `
      + `Serving an EMPTY store — existing reports are NOT lost, the file was not overwritten. `
      + `Fix or remove ${STORE_PATH}.\x1b[0m`);
    store = { ...EMPTY_STORE, _meta: { ...EMPTY_STORE._meta, loadError: e.message }, reports: [] };
  }
  return store;
}

/** Persist atomically. Returns false on failure rather than throwing into a request. */
export function saveStore() {
  if (!store) return false;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    store._meta.updatedAt = new Date().toISOString();
    store._meta.count = store.reports.length;
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, STORE_PATH);   // atomic — see header
    return true;
  } catch (e) {
    console.error(`\x1b[31m[Hazards] Could not persist hazards.json: ${e.message}\x1b[0m`);
    return false;
  }
}

export const allReports = () => loadStore().reports;

export const findReport = (id) => loadStore().reports.find((r) => r.id === id) || null;

/** Short, collision-resistant, and readable aloud in a demo. */
export const newReportId = () => `hz_${crypto.randomBytes(4).toString('hex')}`;

/**
 * A device pseudonym, derived so the raw value never needs storing.
 *
 * The client generates a random id in localStorage; we keep only its hash. That is
 * enough to tell two reporters apart — which is all `independentReports` and
 * `reporterCredibility` need — without holding anything that identifies a person.
 * Anonymous reporting is also the point: a passenger should not need an account to
 * report a landslide.
 */
export const hashDevice = (deviceId) =>
  crypto.createHash('sha256').update(String(deviceId || 'anonymous')).digest('hex').slice(0, 16);

export function appendReport(report) {
  loadStore().reports.push(report);
  saveStore();
  return report;
}

/**
 * Record a human decision. Append-only audit trail.
 *
 * An approval nobody can trace is not a human confirmation, it is an anonymous
 * state change — so every decision keeps who, when, the previous status and
 * whether the actor was authenticated. `tokenState` records 'verified' vs
 * 'unverified' rather than silently accepting both, because when GATI_ADMIN_TOKEN
 * is unset anyone on the LAN can approve and the record must say so.
 */
export function recordDecision(id, { decision, actor, tokenState, note, previousStatus }) {
  const report = findReport(id);
  if (!report) return null;

  // `previousStatus` is supplied BY THE CALLER, not read from report.status here.
  //
  // report.status is only a persisted HINT for machine statuses — the real one is
  // recomputed from the current peer set on every read (VERIFIED #21/#29: a derived
  // value must never be trusted from disk). So the stored field can say `candidate`
  // while the queue the operator actually clicked said `corroborated`, and writing
  // the stale one into the audit trail would misrecord what the human was looking
  // at when they decided. The controller has already scored the report, so it knows
  // the effective status and passes it in.
  //
  // The fallback is only for a caller that has no scoring available; it is labelled
  // so a wrong value can never look authoritative.
  const recordedPrevious = previousStatus === undefined ? report.status : previousStatus;
  report.status = decision;                 // 'confirmed' | 'rejected'
  report.decidedAt = new Date().toISOString();

  report.auditTrail = report.auditTrail || [];
  report.auditTrail.push({
    at: report.decidedAt,
    // Named `decision` to match the API field an operator submits. It was `action`,
    // which meant the wire and the audit record used two names for one thing — the
    // sort of mismatch a reader only discovers by crashing on it.
    decision,
    previousStatus: recordedPrevious,
    previousStatusBasis: previousStatus === undefined ? 'persisted-hint' : 'effective',
    actor: actor || 'unknown',
    tokenState,                             // 'verified' | 'unverified'
    note: note || null,
  });

  saveStore();
  return { report, previousStatus: recordedPrevious };
}

/**
 * Remove a report and its photo. OPERATOR TOOL ONLY — deliberately not routed.
 *
 * There is no HTTP path to this and there must not be one. `rejected` is how a
 * report stops mattering: it keeps the row, keeps the audit trail, and keeps the
 * reporter's credibility history, so a wrong report still teaches the model
 * something. Deletion destroys all three, which is why the admin console can only
 * reject — a public or even token-guarded delete endpoint would let one request
 * erase the evidence that a decision was ever made.
 *
 * What it is for: removing a report created while TESTING, so invented incidents
 * do not sit in the store the map and the queue render. A test report is worse than
 * synthetic seed data because it carries `isSynthetic: false` and therefore renders
 * with NO demo badge — it is indistinguishable from a real sighting.
 *
 * Deletes the photo in the same call on purpose. Removing the row alone orphans the
 * file in hazard-photos/, and an orphan is unreachable but still on disk — the kind
 * of residue nobody finds until the directory is inexplicably large.
 */
export function removeReport(id) {
  const s = loadStore();
  const idx = s.reports.findIndex((r) => r.id === id);
  if (idx === -1) return { removed: false, reason: 'not-found' };

  const [report] = s.reports.splice(idx, 1);

  // Report the photo outcome separately from the row outcome. A failed unlink must
  // not read as a failed removal, and a silent catch would hide a permissions
  // problem that leaves the file behind.
  let photo = { path: null, deleted: false, reason: 'no-photo' };
  if (report.photoPath) {
    const abs = path.join(PHOTO_DIR, path.basename(report.photoPath));
    try {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        photo = { path: abs, deleted: true, reason: null };
      } else {
        photo = { path: abs, deleted: false, reason: 'already-absent' };
      }
    } catch (e) {
      photo = { path: abs, deleted: false, reason: e.message };
    }
  }

  const saved = saveStore();
  return { removed: true, saved, report, photo, remaining: s.reports.length };
}

/** Test seam: drop the in-memory copy so the next read re-reads disk. */
export function _resetStoreCache() {
  store = null;
}
