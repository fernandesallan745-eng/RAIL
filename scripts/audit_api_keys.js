#!/usr/bin/env node
/**
 * Ask UPSTREAM which RailRadar keys are actually exhausted.
 *
 * WHY THIS EXISTS
 * ---------------
 * `.cache/rr_quota.json` is NOT authoritative and must not be used to decide
 * which key to delete. Two independent reasons, both measured on 2026-09-13:
 *
 *   1. It counts only what THIS checkout sent. Upstream marked a key spent while
 *      the local counter read 67 — so real usage can exceed the recorded number
 *      by any amount, and a low counter does not mean a live key.
 *   2. Its `perKey` array is positional, and the position of a key is its order
 *      in `.env`. Add a key anywhere but the end and every counter after it now
 *      describes a different key. A 7-entry counter file against an 11-key .env
 *      cannot be aligned by inspection at all.
 *
 * So the only trustworthy source is upstream's own answer. This script asks it,
 * one key at a time, and reports by FINGERPRINT (sha256 prefix) and .env line —
 * never by key value.
 *
 * COST
 * ----
 * One request per LIVE key. An exhausted key is refused by upstream with a
 * "monthly quota" 429; whether that refusal is itself billed is upstream's
 * business and not something this script can observe, so treat the cost as
 * "up to 1 request per key" rather than assuming refusals are free.
 *
 * Requests are spaced ~7s apart. RailRadar's real ceiling is 10 req/min and it
 * is the limit every 429 in this project's history has actually hit; if that
 * ceiling is per-account rather than per-key, firing 11 probes back-to-back
 * would trip it and make live keys look rate-limited. Spacing removes the
 * ambiguity from the result.
 *
 * USAGE
 * -----
 *   node scripts/audit_api_keys.js            # probe every key
 *   node scripts/audit_api_keys.js --dry-run  # list keys + plan, no network
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { config } from '../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

const DRY_RUN = process.argv.includes('--dry-run');
const SPACING_MS = 7000;
/** Cheapest known endpoint: a single train's static record. */
const PROBE_URL = '/trains/12051';

const fp = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 10);

/** Map each loaded key to the .env line it came from, so output is actionable. */
function envLineFor(keyValue) {
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const name = t.slice(0, t.indexOf('=')).trim();
    const val = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (name.startsWith('RAILRADAR_API_KEY') && val === keyValue) return i + 1;
  }
  return null;
}

/**
 * Classify one key. Mirrors the interceptor in src/services/railradar.js
 * deliberately: the same three response shapes, the same 'monthly quota'
 * substring test. If that classifier changes, change this one with it.
 */
async function probe(key) {
  try {
    const res = await axios.get(PROBE_URL, {
      baseURL: config.railRadar.baseUrl,
      timeout: 15000,
      headers: { Authorization: `Bearer ${key}` },
      validateStatus: () => true,
    });

    const data = res.data;
    const rawMsg =
      data?.error?.message ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      '';

    if (res.status === 200) return { verdict: 'LIVE', detail: 'answered 200' };
    if (res.status === 401) return { verdict: 'INVALID', detail: 'rejected as bad key (401)' };
    if (res.status === 429) {
      const monthly = rawMsg.toLowerCase().includes('monthly quota');
      return monthly
        ? { verdict: 'EXHAUSTED', detail: `upstream says monthly quota: "${rawMsg}"` }
        : { verdict: 'RATE-LIMITED', detail: `burst limit, not monthly: "${rawMsg}" — re-run, this key's state is UNKNOWN` };
    }
    return { verdict: 'UNKNOWN', detail: `HTTP ${res.status}${rawMsg ? `: ${rawMsg}` : ''}` };
  } catch (e) {
    return { verdict: 'UNKNOWN', detail: `no response: ${e.message}` };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const keys = config.railRadar.apiKeys;
  if (!keys.length) {
    console.error('No RAILRADAR_API_KEY found in .env — nothing to audit.');
    process.exit(1);
  }

  console.log(`\nRailRadar key audit — ${keys.length} keys loaded from .env`);
  console.log(`Probe endpoint: ${config.railRadar.baseUrl}${PROBE_URL}`);
  console.log(`Spacing: ${SPACING_MS / 1000}s between probes (upstream ceiling is 10 req/min)\n`);

  const rows = keys.map((k, i) => ({ pos: i, fpr: fp(k), line: envLineFor(k), key: k }));

  if (DRY_RUN) {
    console.log('--dry-run: no network. Keys that WOULD be probed:\n');
    console.log('  pos  .env line  fingerprint');
    console.log('  ' + '-'.repeat(38));
    for (const r of rows) console.log(`  ${String(r.pos).padEnd(4)} ${String(r.line ?? '?').padEnd(10)} ${r.fpr}`);
    console.log(`\n  Estimated wall time: ~${Math.round((rows.length * SPACING_MS) / 1000)}s`);
    console.log('  Cost: up to 1 upstream request per key.\n');
    return;
  }

  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    process.stdout.write(`  [${i + 1}/${rows.length}] pos ${r.pos} (line ${r.line ?? '?'}, ${r.fpr}) ... `);
    const out = await probe(r.key);
    console.log(`${out.verdict}  — ${out.detail}`);
    results.push({ ...r, ...out });
    if (i < rows.length - 1) await sleep(SPACING_MS);
  }

  const by = (v) => results.filter((r) => r.verdict === v);
  const exhausted = by('EXHAUSTED');
  const live = by('LIVE');
  const unclear = results.filter((r) => !['EXHAUSTED', 'LIVE'].includes(r.verdict));

  console.log('\n' + '='.repeat(58));
  console.log(`RESULT: ${live.length} live, ${exhausted.length} exhausted, ${unclear.length} unclear`);
  console.log('='.repeat(58));

  if (exhausted.length) {
    console.log('\nEXHAUSTED — safe to delete these .env lines:');
    for (const r of exhausted.sort((a, b) => (b.line ?? 0) - (a.line ?? 0))) {
      console.log(`  line ${r.line ?? '?'}   ${r.fpr}`);
    }
    console.log('\n  Delete HIGHEST line number first, so earlier line numbers stay valid.');
  } else {
    console.log('\nNo key was confirmed exhausted. Delete nothing.');
  }

  if (live.length) {
    console.log('\nLIVE — keep:');
    for (const r of live) console.log(`  line ${r.line ?? '?'}   ${r.fpr}`);
  }

  if (unclear.length) {
    console.log('\nUNCLEAR — do NOT delete these; re-run to resolve:');
    for (const r of unclear) console.log(`  line ${r.line ?? '?'}   ${r.fpr}   ${r.verdict}: ${r.detail}`);
  }

  console.log('\nAfter deleting, the positional counters in .cache/rr_quota.json no longer');
  console.log('describe the surviving keys. Delete that file — it rebuilds on next start:');
  console.log('  rm .cache/rr_quota.json\n');
}

main().catch((e) => {
  console.error('audit failed:', e.message);
  process.exit(1);
});
