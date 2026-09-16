/**
 * Phase 7 — crowdsourced hazard reporting, confidence scoring, human approval.
 *
 * WHAT THIS LAYER IS FOR
 * ----------------------
 * Everything else in GATI is INFERRED: curvature from geometry, delay from timetables,
 * crossings from two schedules. None of it can see a locomotive that has failed, a
 * landslide across a cutting, or flooding at a culvert. CLAUDE.md §2 USP 5 exists for
 * exactly that gap, and per §3 this is the one data source in the whole system that is
 * "fully real, our own new data".
 *
 * COST: zero upstream RailRadar requests. Reports are ours; the corroboration signals
 * read cached timetables (VERIFIED #15's discipline — never poll for what a schedule
 * already answers). Nothing in this file can spend the 1,000 req/month tier.
 *
 * THE ONE NON-NEGOTIABLE (CLAUDE.md §2)
 * -------------------------------------
 * "All conflict alerts and hazard escalations require human confirmation (Section
 * Controller / Control Room Operator)." The scoring engine's ceiling is `corroborated`
 * (MACHINE_ASSIGNABLE in hazardStore.js, asserted inside classify()). `confirmed` and
 * `rejected` are reachable only through postDecision() below. Nothing here dispatches
 * anything, to anyone, ever.
 *
 * WHY MACHINE STATUS IS RECOMPUTED ON READ AND NOT TRUSTED FROM DISK
 * -----------------------------------------------------------------
 * A report's confidence is a function of its PEERS. The moment a second witness
 * submits, the first report's score changes — so a machine status written at submit
 * time is stale by the next submission. That is the same hazard as the conflict block
 * (VERIFIED #21) and runState (VERIFIED #29): a derived value persisted beside its
 * inputs looks authoritative long after it stopped being true.
 *
 * The resolution here is the same one those two use — recompute, don't persist a
 * verdict — with one difference: a HUMAN decision is not derived, so that one *is*
 * persisted and always wins. `status` on disk is therefore authoritative only for
 * confirmed/rejected; for anything else it is a stale hint and effectiveStatus() below
 * ignores it in favour of a fresh score.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/env.js';
import {
  HAZARD_CATEGORIES,
  MACHINE_ASSIGNABLE,
  HUMAN_ONLY,
  PHOTO_DIR,
  allReports,
  appendReport,
  findReport,
  hashDevice,
  newReportId,
  recordDecision,
  saveStore,
} from '../services/hazardStore.js';
import { scoreReport, corridorAvailable, TUNING } from '../services/hazardConfidence.js';

import heicConvert from 'heic-convert';

/**
 * Reason-coded failures, mirroring admin.controller.js's sendModelError.
 *
 * "the submission was malformed" and "the store is unwritable" are different failures
 * and must not collapse into one generic 500 — a blank form and a broken disk look
 * identical to the user otherwise (VERIFIED #9's shape, at the API layer).
 */
const fail = (res, status, reason, detail, extra = {}) =>
  res.status(status).json({ success: false, reason, detail, ...extra });

// ── Admin token ─────────────────────────────────────────────────────────────────────
/**
 * Resolve the actor's authentication state. Three outcomes, never two.
 *
 *   token unset            → { ok: true,  tokenState: 'unverified' }  ← degrades LOUDLY
 *   token set + matches    → { ok: true,  tokenState: 'verified'   }
 *   token set + mismatch   → { ok: false }                            ← 401
 *
 * Compared as SHA-256 digests because crypto.timingSafeEqual throws on unequal
 * lengths — comparing raw strings would leak the token's length through that throw,
 * and hashing first makes both sides a fixed 32 bytes. The token value itself is never
 * logged or returned (§8, same rule as the RailRadar keys).
 */
const resolveActor = (req) => {
  const expected = config.hazards.adminToken;
  const header = req.get('x-admin-token') || '';
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const supplied = (header || bearer || '').trim();

  if (!expected) {
    return {
      ok: true,
      tokenState: 'unverified',
      actor: 'unverified',
      warning: 'GATI_ADMIN_TOKEN is not set on the server, so this decision was accepted '
             + 'without authentication. Anyone on this network can confirm or reject a '
             + 'report. The decision is recorded as approvedBy:"unverified".',
    };
  }
  if (!supplied) return { ok: false, reason: 'admin-token-required' };

  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'admin-token-invalid' };

  return { ok: true, tokenState: 'verified', actor: 'operator', warning: null };
};

// ── Validation ──────────────────────────────────────────────────────────────────────
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Clean a free-text field.
 *
 * Control characters are stripped because they can corrupt the JSON store and terminal
 * output. `<` and `>` are deliberately NOT stripped: mangling "speed < 20 kmph" into
 * "speed  20 kmph" changes the meaning of an operational report, and escaping is the
 * renderer's job, not the store's. The UI must escape on output — see §5g.
 */
const cleanText = (v, maxLen) =>
  String(v == null ? '' : v).replace(CONTROL_CHARS, '').trim().slice(0, maxLen);

const finiteNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Decode a data-URL photo to bytes, verifying it really is an image.
 *
 * MAGIC BYTES ARE CHECKED, not the declared MIME type. `data:image/jpeg;base64,...` is
 * client-supplied text and says nothing about the payload — without this check any
 * bytes at all could be written to disk under a .jpg name and later served back. The
 * JPEG SOI marker (FF D8 FF) and the 8-byte PNG signature are the actual evidence.
 */
const decodePhoto = async (dataUrl) => {
  if (!dataUrl) return { ok: true, buffer: null, ext: null };
  if (typeof dataUrl !== 'string') return { ok: false, reason: 'photo-not-a-string' };

  const m = /^data:(image\/(?:jpeg|jpg|png|webp|heic|heif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return { ok: false, reason: 'photo-not-a-supported-data-url' };

  let buffer;
  try {
    buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  } catch {
    return { ok: false, reason: 'photo-base64-undecodable' };
  }
  if (!buffer.length) return { ok: false, reason: 'photo-empty' };
  if (buffer.length > config.hazards.maxPhotoBytes) {
    return {
      ok: false,
      reason: 'photo-too-large',
      detail: `decoded photo is ${Math.round(buffer.length / 1024)} KB, limit is `
            + `${Math.round(config.hazards.maxPhotoBytes / 1024)} KB. Downscale before upload.`,
    };
  }

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.length > 8 && buffer.subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buffer.length > 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const isHeic = buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'heic' &&
    buffer.subarray(8, 12).toString('ascii') === 'ftyp';

  if (!isJpeg && !isPng && !isWebp && !isHeic) {
    return {
      ok: false,
      reason: 'photo-bytes-are-not-an-image',
      detail: 'The declared MIME type was an image but the payload bytes are not a JPEG, '
            + 'PNG, WebP, or HEIC. Declared types are not trusted; magic bytes are checked.',
    };
  }

  // Convert HEIC/HEIF to JPEG for storage
  let outputBuffer = buffer;
  let outputExt = isJpeg ? 'jpg' : isPng ? 'png' : 'webp';

  if (isHeic) {
    if (heicConvert) {
      try {
        // Convert HEIC to JPEG using heic-convert (Node.js only)
        outputBuffer = await heicConvert({
          buffer: buffer,
          outputType: 'image/jpeg',
          outputQuality: 0.9,
        });
        outputExt = 'jpg';
      } catch (convertError) {
        return {
          ok: false,
          reason: 'photo-heic-conversion-failed',
          detail: `Failed to convert HEIC image to JPEG: ${convertError.message}. This may be due to missing native dependencies. Please convert to JPEG before uploading.`,
        };
      }
    } else {
      // In browser environment, provide helpful guidance for HEIC files
      return {
        ok: false,
        reason: 'photo-heic-not-supported',
        detail: 'HEIC/HEIF files are not supported in the browser. iPhone photos need to be converted to JPEG before uploading. ' +
          'You can convert using iPhone\'s Photos app (Share → Convert to JPEG) or change camera format to "Most Compatible".',
      };
    }
  }

  return { ok: true, buffer: outputBuffer, ext: outputExt };
};

// ── Derived status ──────────────────────────────────────────────────────────────────
/**
 * The report as the API reports it: stored fields + a FRESH score.
 *
 * A human decision (confirmed/rejected) is a fact and is returned as-is. Anything else
 * is rescored against the current peer set, because a peer submitted after this report
 * changes its confidence — see the header.
 */
const withScoring = (report, peers) => {
  const scoring = scoreReport(report, peers);
  const humanDecided = HUMAN_ONLY.includes(report.status);

  const { photoPath, deviceHash, ...safe } = report;

  return {
    ...safe,
    status: humanDecided ? report.status : scoring.machineStatus,
    machineStatus: scoring.machineStatus,
    statusSource: humanDecided ? 'human-decision' : 'machine-score',
    // Truthiness is all the UI needs, and the on-disk filename is not the browser's
    // business — photos are served by route, not from a static directory (see getPhoto).
    hasPhoto: Boolean(photoPath),
    photoUrl: photoPath ? `/api/hazards/${report.id}/photo` : null,
    // A short, non-reversible discriminator so the UI can show "3 distinct reporters"
    // without publishing the full device hash it clusters on.
    reporterRef: deviceHash ? deviceHash.slice(0, 6) : null,
    scoring,
  };
};

// ── POST /api/hazards ───────────────────────────────────────────────────────────────
/**
 * Public submit. The only write the public UI has ever made.
 *
 * `reportedAt` is the SERVER's clock, not the client's. The independentReports component
 * clusters on a 90-minute window, so a device with a wrong — or deliberately shifted —
 * clock could otherwise dodge or fabricate corroboration. The client's claim is kept
 * separately as `clientReportedAt` for audit, and never scored on.
 */
export const postHazard = async (req, res) => {
  try {
    const body = req.body || {};

    const category = String(body.category || '').trim();
    if (!HAZARD_CATEGORIES[category]) {
      return fail(res, 422, 'invalid-category',
        `"${category || '(missing)'}" is not a known hazard category.`,
        { validCategories: Object.keys(HAZARD_CATEGORIES) });
    }

    const lat = finiteNum(body.lat);
    const lng = finiteNum(body.lng);
    if (lat === null || lng === null) {
      return fail(res, 422, 'invalid-coordinates',
        'lat and lng are required and must be finite numbers.');
    }

    const { minLat, maxLat, minLng, maxLng } = config.hazards.bbox;
    if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) {
      // Coarse gate only. Distance from the track is SCORED, not gated — see the bbox
      // comment in src/config/env.js. This rejects the impossible (0,0 from a failed
      // geolocation call), not the merely distant.
      return fail(res, 422, 'coordinates-outside-corridor-region',
        `(${lat}, ${lng}) is outside the Konkan corridor region `
        + `(lat ${minLat}–${maxLat}, lng ${minLng}–${maxLng}). `
        + 'A failed browser geolocation call reports 0,0, which lands here.',
        { bbox: config.hazards.bbox });
    }

    const photo = await decodePhoto(body.photo);
    if (!photo.ok) {
      return fail(res, 422, photo.reason, photo.detail || 'Photo could not be accepted.');
    }

    const id = newReportId();
    let photoPath = null;
    if (photo.buffer) {
      try {
        fs.mkdirSync(PHOTO_DIR, { recursive: true });
        const filename = `${id}.${photo.ext}`;
        fs.writeFileSync(path.join(PHOTO_DIR, filename), photo.buffer);
        photoPath = filename;              // filename only — resolved against PHOTO_DIR
      } catch (e) {
        // The report is worth more than the photo. Keep the report, say the photo was
        // lost, and let `evidence` score it without one — rather than discarding a
        // landslide sighting because a directory was read-only.
        console.error(`\x1b[31m[Hazards] Could not write photo for ${id}: ${e.message}\x1b[0m`);
      }
    }

    const report = {
      id,
      category,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      description: cleanText(body.description, config.hazards.maxDescriptionChars),
      // Server clock — see the docblock.
      reportedAt: new Date().toISOString(),
      clientReportedAt: typeof body.clientReportedAt === 'string'
        ? cleanText(body.clientReportedAt, 40) : null,
      deviceHash: hashDevice(body.deviceId),
      photoPath,
      photoWriteFailed: Boolean(photo.buffer) && photoPath === null,
      trainNumber: body.trainNumber ? cleanText(body.trainNumber, 10) : null,
      accuracyM: finiteNum(body.accuracyM),
      locationSource: ['gps', 'map-tap'].includes(body.locationSource)
        ? body.locationSource : 'unspecified',
      // Machine-assignable only. A submitter cannot ask for a status, and the machine's
      // ceiling is `corroborated` — see MACHINE_ASSIGNABLE in hazardStore.js.
      status: 'logged',
      isSynthetic: false,
      auditTrail: [],
    };

    appendReport(report);

    // Scored AFTER the append so the report sees the peers it was just added to, and so
    // the response shows the same number the list endpoint will. scoreReport skips
    // `p.id === report.id`, so including it in the peer list is correct, not double-counting.
    const peers = allReports();
    const scored = withScoring(report, peers);

    // Persist the machine status as a hint only — effectiveStatus recomputes on every
    // read (see header), so this is a convenience for anyone reading the file directly.
    report.status = scored.machineStatus;
    saveStore();

    res.status(201).json({
      success: true,
      data: scored,
      decisionSupportOnly: true,
      note: 'Report logged. Confidence is a heuristic over five signals and can raise this '
          + 'to "corroborated" at most — a human controller must confirm it before it '
          + 'affects any ETA. Nothing has been dispatched.',
    });
  } catch (error) {
    fail(res, 500, 'hazard-submit-failed', error.message);
  }
};

// ── GET /api/hazards ────────────────────────────────────────────────────────────────
/**
 * List every report with its components broken out.
 *
 * Never cached (see api.routes.js): a submit or an approval changes every peer's score,
 * so even a 30 s TTL would show an operator a queue that has already moved.
 */
export const getHazards = (req, res) => {
  try {
    const peers = allReports();
    let rows = peers.map((r) => withScoring(r, peers));

    const wanted = String(req.query.status || '').trim();
    if (wanted) {
      const set = new Set(wanted.split(',').map((s) => s.trim()).filter(Boolean));
      const unknown = [...set].filter((s) => ![...MACHINE_ASSIGNABLE, ...HUMAN_ONLY].includes(s));
      if (unknown.length) {
        return fail(res, 422, 'invalid-status-filter',
          `unknown status(es): ${unknown.join(', ')}`,
          { validStatuses: [...MACHINE_ASSIGNABLE, ...HUMAN_ONLY] });
      }
      rows = rows.filter((r) => set.has(r.status));
    }

    // Highest confidence first, so the operator queue is ordered by what most needs a
    // human look. Ties break on recency.
    rows.sort((a, b) => (b.scoring.confidence - a.scoring.confidence)
      || (new Date(b.reportedAt) - new Date(a.reportedAt)));

    const counts = {};
    for (const s of [...MACHINE_ASSIGNABLE, ...HUMAN_ONLY]) counts[s] = 0;
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

    res.json({
      success: true,
      data: {
        reports: rows,
        counts,
        total: rows.length,
        categories: HAZARD_CATEGORIES,
        tuning: TUNING,
        corridor: corridorAvailable(),
        // Honesty block — the UI renders these; do not remove (§5e/§5g).
        confidenceModelIsHeuristic: true,
        trainPresenceBasis: 'scheduled',
        machineCeiling: 'corroborated',
        humanOnlyStatuses: HUMAN_ONLY,
        // NOT named `adminAuthenticated`: this says whether the SERVER requires a token,
        // not whether the caller supplied one. A UI author reading `adminAuthenticated:
        // false` would reasonably render "you are not signed in" — the exact opposite of
        // the truth, which is that no token is configured so ANYONE on this LAN can
        // approve. The same value is `adminTokenConfigured` in hazardHealth(); one value
        // must not have two names, and this is the honest one.
        adminTokenConfigured: Boolean(config.hazards.adminToken),
        decisionSupportOnly: true,
        note: 'Machine status is recomputed on every read, because a report\'s confidence '
            + 'depends on its peers and changes when a new witness submits. Human '
            + 'decisions (confirmed/rejected) are stored and always win.',
      },
    });
  } catch (error) {
    fail(res, 500, 'hazard-list-failed', error.message);
  }
};

// ── GET /api/hazards/:id/photo ──────────────────────────────────────────────────────
/**
 * Serve one report's photo.
 *
 * A ROUTE, not express.static on src/data/hazard-photos/, for two reasons:
 *   1. `cap sync` copies public/ verbatim into the iOS bundle (§5d), so user-uploaded
 *      bytes living under public/ would ship inside the IPA.
 *   2. The filename comes from the STORE, never from the URL — so `../../.env` as an id
 *      cannot resolve to anything. The containment assert below is defence in depth
 *      against a future writer that stores a path instead of a bare filename.
 */
export const getHazardPhoto = (req, res) => {
  const report = findReport(String(req.params.id || ''));
  if (!report) return fail(res, 404, 'report-not-found', 'No report with that id.');
  if (!report.photoPath) return fail(res, 404, 'no-photo', 'This report has no photo attached.');

  const resolved = path.resolve(PHOTO_DIR, path.basename(report.photoPath));
  if (!resolved.startsWith(path.resolve(PHOTO_DIR) + path.sep)) {
    return fail(res, 400, 'photo-path-outside-store', 'Refusing to serve a path outside the photo directory.');
  }
  if (!fs.existsSync(resolved)) {
    return fail(res, 404, 'photo-file-missing',
      'The report references a photo that is no longer on disk.');
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  // nosniff because these are user-supplied bytes: the magic-byte check at submit is the
  // guarantee, and this stops a browser second-guessing the Content-Type anyway.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(resolved).pipe(res);
};

// ── POST /api/admin/hazards/:id/decision ────────────────────────────────────────────
/**
 * The human confirmation. THE point of this layer.
 *
 * Mirrors flushGatewayCache: POST-only so a prefetch, crawler or mistyped URL cannot
 * fire it, and it returns the before/after status as EVIDENCE rather than asserting
 * success. Every call appends exactly one immutable audit entry.
 *
 * Only HUMAN_ONLY statuses are accepted. An operator cannot set `logged`/`candidate`/
 * `corroborated`, because those are the machine's to compute — allowing it would let a
 * hand-set status be silently overwritten by the next rescore, which is worse than
 * refusing it.
 */
export const postHazardDecision = (req, res) => {
  try {
    const actor = resolveActor(req);
    if (!actor.ok) {
      return fail(res, 401, actor.reason,
        'GATI_ADMIN_TOKEN is set on this server, so approve/reject requires a matching '
        + 'x-admin-token header.');
    }

    const id = String(req.params.id || '');
    const report = findReport(id);
    if (!report) return fail(res, 404, 'report-not-found', 'No report with that id.');

    const decision = String((req.body || {}).decision || '').trim();
    if (!HUMAN_ONLY.includes(decision)) {
      return fail(res, 422, 'invalid-decision',
        `decision must be one of ${HUMAN_ONLY.join(' | ')}. `
        + `Machine statuses (${MACHINE_ASSIGNABLE.join(', ')}) are computed, not set.`,
        { validDecisions: HUMAN_ONLY });
    }

    const note = cleanText((req.body || {}).note, 300);
    const beforeScoring = scoreReport(report, allReports());
    // The status the operator was actually looking at when they clicked — a prior HUMAN
    // decision if there is one, otherwise the freshly recomputed machine status.
    //
    // NOT report.status. That field is a persisted hint for machine statuses and is
    // recomputed from the current peer set on every read (VERIFIED #21/#29), so it can
    // read `candidate` while the queue showed `corroborated` — a new witness arriving
    // between the two is enough. Recording the stale value would make the audit trail
    // describe a screen nobody saw.
    const humanDecided = HUMAN_ONLY.includes(report.status);
    const before = humanDecided ? report.status : beforeScoring.machineStatus;

    const result = recordDecision(id, {
      decision,
      actor: cleanText((req.body || {}).actor, 60) || actor.actor,
      tokenState: actor.tokenState,
      note: note || null,
      previousStatus: before,
    });
    if (!result) return fail(res, 404, 'report-not-found', 'No report with that id.');

    const peers = allReports();
    const scored = withScoring(result.report, peers);

    res.json({
      success: true,
      data: scored,
      // Evidence, not a claim — same discipline as keysBefore/keysAfter on the cache flush.
      statusBefore: before,
      // Which kind of status `statusBefore` is, so a reader never has to guess whether a
      // decision reversed a human or overrode the machine.
      statusBeforeBasis: humanDecided ? 'human-decision' : 'machine-score',
      statusAfter: result.report.status,
      machineStatusAtDecision: beforeScoring.machineStatus,
      confidenceAtDecision: beforeScoring.confidence,
      auditEntriesAdded: 1,
      auditTrailLength: (result.report.auditTrail || []).length,
      tokenState: actor.tokenState,
      authWarning: actor.warning || null,
      appliesToEta: decision === 'confirmed',
      decisionSupportOnly: true,
      note: decision === 'confirmed'
        ? 'Confirmed by a human. This report is now eligible to cap speed on its own km '
          + 'sub-span, and only when the ETA is requested with ?hazards=true — the default '
          + 'path is unchanged. Nothing has been dispatched to any train or signalling system.'
        : 'Rejected by a human. It no longer corroborates other reports and cannot affect '
          + 'any ETA.',
    });
  } catch (error) {
    fail(res, 500, 'hazard-decision-failed', error.message);
  }
};

/** Availability block for /api/health. Cheap: counts and flags only. */
export const hazardHealth = () => {
  const reports = allReports();
  const counts = {};
  for (const s of [...MACHINE_ASSIGNABLE, ...HUMAN_ONLY]) counts[s] = 0;
  for (const r of reports) {
    const s = HUMAN_ONLY.includes(r.status) ? r.status : 'logged';
    counts[s] = (counts[s] || 0) + 1;
  }
  return {
    total: reports.length,
    // Stored-status tally. Machine statuses are recomputed per read, so only the
    // human-decided buckets here are authoritative — labelled rather than implied.
    storedStatusCounts: counts,
    confirmed: reports.filter((r) => r.status === 'confirmed').length,
    corridorScoring: corridorAvailable(),
    adminTokenConfigured: Boolean(config.hazards.adminToken),
    machineCeiling: 'corroborated',
    upstreamRequestCost: 0,
  };
};
