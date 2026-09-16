"""
verify_hazards.py — invariant checks for the crowdsourced-hazard layer (Phase 7).

Offline, no API calls, **zero upstream RailRadar requests**.  Re-run after any
change to hazard_layer.py, hazardConfidence.js or hazardStore.js.

Mirrors verify_conflicts.py: every check is a property that must hold for ANY
store and ANY train, so a regression shows up as a FAIL rather than as a
plausible-looking wrong number.

    python3 verify_hazards.py

WHY THIS FILE SHELLS OUT TO NODE
--------------------------------
The layer is split across two languages and this harness tests BOTH halves of it
as they actually run:

  * the ETA side (`hazard_layer.py`) is Python — called directly;
  * the confidence engine (`src/services/hazardConfidence.js`) is JavaScript, and
    it is the file that decides whether a report is `logged`, `candidate` or
    `corroborated`.

Re-implementing those five components in Python to test them here would be
testing a COPY.  The copy would pass while the engine drifted away from it, which
is the failure this file exists to catch.  So H3–H5 drive the real module through
`node --input-type=module` and assert on its output.
"""
import json
import math
import os
import subprocess
import sys
import tempfile

import eta_model
import hazard_layer as hz

HERE = os.path.dirname(os.path.abspath(__file__))

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
    return cond


# ────────────────────────────────────────────────────────────────────────────
#  The node probe — drives the REAL confidence engine, not a re-implementation
# ────────────────────────────────────────────────────────────────────────────
PROBE_JS = r"""
const repo = process.env.GATI_REPO;
const conf  = await import(`file://${repo}/src/services/hazardConfidence.js`);
const store = await import(`file://${repo}/src/services/hazardStore.js`);

const out = {
  tuning: conf.TUNING,
  machineAssignable: store.MACHINE_ASSIGNABLE,
  humanOnly: store.HUMAN_ONLY,
  categories: Object.keys(store.HAZARD_CATEGORIES),
  corridor: conf.corridorAvailable(),
};

// H1 — classify() over the whole confidence domain, plus the two illegal targets.
out.classifySweep = [];
for (let i = 0; i <= 100; i++) {
  const c = i / 100;
  out.classifySweep.push([Number(c.toFixed(2)), conf.classify(c)]);
}
// Extremes and out-of-domain values: must still never yield a human-only status.
for (const c of [-1, 0, 1, 2, 1e9]) out.classifySweep.push([c, conf.classify(c)]);

// A fixture on the corridor: the coordinates of a real confirmed landslide report.
const ON_CORRIDOR = { lat: 18.40121, lng: 73.22094 };
const at = (min) => new Date(Date.UTC(2026, 8, 14, 6, min)).toISOString();

const mk = (id, dev, over = {}) => ({
  id, deviceHash: dev, category: 'landslide', status: 'logged',
  lat: ON_CORRIDOR.lat, lng: ON_CORRIDOR.lng, reportedAt: at(0),
  description: '', photoPath: null, ...over,
});

// H5a — three reports, ONE device. The obvious way to fake corroboration.
const sameDevice = [mk('s1', 'devA'), mk('s2', 'devA', { reportedAt: at(5) }),
                    mk('s3', 'devA', { reportedAt: at(9) })];
out.sameDevice = conf.scoreIndependentReports(sameDevice[0], sameDevice);

// H5b — three reports, three devices, same place and window.
const multiDevice = [mk('m1', 'devA'), mk('m2', 'devB', { reportedAt: at(5) }),
                     mk('m3', 'devC', { reportedAt: at(9) })];
out.multiDevice = conf.scoreIndependentReports(multiDevice[0], multiDevice);

// H5c — the saturation curve, pinned value by value.
out.curve = [];
for (let n = 1; n <= 6; n++) {
  const peers = [];
  for (let k = 0; k < n; k++) peers.push(mk(`c${k}`, `dev${k}`, { reportedAt: at(k) }));
  const r = conf.scoreIndependentReports(peers[0], peers);
  out.curve.push([n, r.independentDevices, r.score]);
}

// H5d — a peer that a human REJECTED must corroborate nothing.
const withRejected = [mk('r1', 'devA'), mk('r2', 'devB', { status: 'rejected', reportedAt: at(4) })];
out.rejectedPeer = conf.scoreIndependentReports(withRejected[0], withRejected);

// H4 — plausibility on the corridor vs deliberately off it.
out.plausOn  = conf.scoreCorridorPlausibility(mk('p1', 'devA'));
out.plausOff = conf.scoreCorridorPlausibility(
  mk('p2', 'devA', { lat: ON_CORRIDOR.lat, lng: ON_CORRIDOR.lng + 0.10 }));   // ~10.5 km east
// Must clear corridorFarM (5000 m). lng+0.05 is only ~4963 m projected here —
// still on the near→far ramp (score ≈0.01), which made H4 fail while looking
// like a "~5.3 km → ~0" case. lng+0.055 lands past the far threshold.
out.plausFar = conf.scoreCorridorPlausibility(
  mk('p3', 'devA', { lat: ON_CORRIDOR.lat, lng: ON_CORRIDOR.lng + 0.055 }));  // ~5.8 km east
out.plausNear = conf.scoreCorridorPlausibility(
  mk('p4', 'devA', { lat: ON_CORRIDOR.lat, lng: ON_CORRIDOR.lng + 0.02 }));   // ~2.1 km east

// H3 — full scoreReport over a spread of fixtures, for the component-sum check.
const fixtures = [
  ['bare',        [mk('f1', 'devA')]],
  ['photo+desc',  [mk('f2', 'devA', { photoPath: 'x.jpg', description: 'Boulders across both tracks near the cutting.' })]],
  ['corroborated', multiDevice],
  ['same-device',  sameDevice],
  ['off-corridor', [mk('f3', 'devA', { lat: ON_CORRIDOR.lat, lng: ON_CORRIDOR.lng + 0.10 })]],
];
out.scored = fixtures.map(([label, peers]) => [label, conf.scoreReport(peers[0], peers)]);

// H10 — the honesty flags the UI renders.
out.flags = conf.scoreReport(mk('h1', 'devA'), [mk('h1', 'devA')]);

console.log(JSON.stringify(out));
"""


def node_probe():
    env = dict(os.environ, GATI_REPO=HERE)
    p = subprocess.run(["node", "--input-type=module", "-e", PROBE_JS],
                       capture_output=True, text=True, env=env, cwd=HERE)
    if p.returncode != 0:
        print("node probe FAILED — the confidence engine could not be driven:")
        print(p.stderr.strip()[:4000])
        sys.exit(1)
    return json.loads(p.stdout)


print("=== Driving the real confidence engine (node) ===")
js = node_probe()
T = js["tuning"]
print(f"  corridor reference : available={js['corridor']['available']} "
      f"vertices={js['corridor']['referenceVertices']} trains={js['corridor']['corridorTrains']}")
print(f"  machine-assignable : {js['machineAssignable']}")
print(f"  human-only         : {js['humanOnly']}")
print(f"  categories         : {len(js['categories'])} — {', '.join(js['categories'])}")
print(f"  thresholds         : candidate ≥ {T['candidateAt']}, corroborated ≥ {T['corroboratedAt']}")
print(f"  weights            : {T['weights']}")


# ────────────────────────────────────────────────────────────────────────────
#  H1 — the machine's ceiling is `corroborated`
# ────────────────────────────────────────────────────────────────────────────
# CLAUDE.md §2, the non-negotiable one: "All conflict alerts and hazard
# escalations require human confirmation."  Expressed as a state machine, that
# means classify() may never return `confirmed` or `rejected` for ANY input —
# not merely for the inputs we happen to have data for.
print("\n=== H1  machine status never exceeds `corroborated` ===")
seen = {}
for c, status in js["classifySweep"]:
    check(status in js["machineAssignable"],
          f"H1: classify({c}) returned {status!r}, which is not machine-assignable")
    check(status not in js["humanOnly"],
          f"H1: classify({c}) returned the HUMAN-ONLY status {status!r} — auto-escalation")
    seen.setdefault(status, []).append(c)
for status in ("logged", "candidate", "corroborated"):
    vals = seen.get(status, [])
    dom = f"{min(vals):g} … {max(vals):g}" if vals else "never produced"
    print(f"  {status:<13} {len(vals):>3} inputs   {dom}")
check(set(seen) == {"logged", "candidate", "corroborated"},
      f"H1: classify produced {sorted(seen)}, expected exactly the 3 machine statuses")
# The ladder must actually be ordered, not merely legal.
check(max(seen["logged"]) < T["candidateAt"], "H1: a `logged` input sat above the candidate threshold")
check(min(seen["corroborated"]) >= T["corroboratedAt"], "H1: a `corroborated` input sat below its threshold")
print(f"  ceiling holds over {len(js['classifySweep'])} inputs including -1, 2 and 1e9")


# ────────────────────────────────────────────────────────────────────────────
#  H2 — only `confirmed` reports reach the ETA
# ────────────────────────────────────────────────────────────────────────────
# The gate that makes H1 worth anything: even a report the machine scored at the
# top of its range must not move a single minute until a human says so.
print("\n=== H2  only human-`confirmed` reports reach the ETA ===")
all_statuses = js["machineAssignable"] + js["humanOnly"]
synthetic = [{"id": f"syn_{s}", "status": s, "category": "landslide",
              "lat": 18.40121, "lng": 73.22094} for s in all_statuses]
eligible, skipped = hz.confirmed_reports(synthetic)
elig_status = sorted({r["status"] for r in eligible})
check(elig_status == ["confirmed"],
      f"H2: statuses reaching the ETA are {elig_status}, expected ['confirmed']")
print(f"  statuses offered  : {all_statuses}")
print(f"  reached the ETA   : {elig_status}")
for s in skipped:
    print(f"  skipped {s['id']:<18} {s['reason']}"
          + (f" (status={s.get('status')})" if s.get("status") else ""))
check(len(eligible) + len(skipped) == len(synthetic),
      "H2: a report was neither applied nor given a skip reason (silent drop)")
# `corroborated` is the machine's ceiling and must be explicitly refused here.
corr = [s for s in skipped if s.get("status") == "corroborated"]
check(len(corr) == 1 and corr[0]["reason"] == "not-human-confirmed",
      "H2: `corroborated` (the machine ceiling) was not refused with a reason")

# And the same gate over the REAL store, whatever is in it today.
reports, meta, unavail = hz.load_store()
check(unavail is None, f"H2: real store unavailable: {unavail}")
real_elig, real_skip = hz.confirmed_reports(reports)
by_status = {}
for r in reports:
    by_status[r.get("status")] = by_status.get(r.get("status"), 0) + 1
print(f"  real store        : {len(reports)} reports {by_status}")
print(f"  ETA-eligible      : {len(real_elig)} "
      f"({', '.join(r['id'] for r in real_elig) or 'none'})")
check(all(r.get("status") == "confirmed" for r in real_elig),
      "H2: a non-confirmed report from the real store reached the ETA")
# A category with no speed-cap meaning must be refused even when confirmed.
check(all(r["category"] in hz.HAZARD_SPEED_CAP_KMH for r in real_elig),
      "H2: a category with no defined speed cap reached the ETA")


# ────────────────────────────────────────────────────────────────────────────
#  H3 — components sum to the reported total, under renormalisation
# ────────────────────────────────────────────────────────────────────────────
# The plan says "confidence components sum to the reported total".  They do not
# sum naively: an unavailable component is excluded from BOTH numerator and
# denominator (a missing cache file must not be scored as a zero — VERIFIED #4's
# zero-echo rule).  So the invariant is the renormalised one, and it must also be
# asserted that `weightUsed` really equals the weight of the available components.
print("\n=== H3  components reconcile with the total (weightUsed renormalisation) ===")
print(f"  {'fixture':<14} {'conf':>6} {'recomputed':>11} {'wUsed':>6}  unavailable")
for label, s in js["scored"]:
    num = 0.0
    wsum = 0.0
    for key, comp in s["components"].items():
        w = T["weights"][key]
        if comp["score"] is None:
            check(key in s["componentsUnavailable"],
                  f"H3[{label}]: {key} scored null but is not in componentsUnavailable")
            continue
        check(key not in s["componentsUnavailable"],
              f"H3[{label}]: {key} has a score but is listed unavailable")
        check(0.0 <= comp["score"] <= 1.0,
              f"H3[{label}]: {key} score {comp['score']} outside [0,1]")
        num += comp["score"] * w
        wsum += w
    recomputed = num / wsum if wsum > 0 else 0.0
    check(abs(recomputed - s["confidence"]) < 0.0015,
          f"H3[{label}]: components give {recomputed:.4f}, payload says {s['confidence']}")
    check(abs(wsum - s["weightUsed"]) < 1e-6,
          f"H3[{label}]: weightUsed {s['weightUsed']} != available weight {wsum:.3f}")
    check(len(s["components"]) == 5,
          f"H3[{label}]: {len(s['components'])} components, expected 5")
    # Every component must carry its own basis label, not just a number.
    for key, comp in s["components"].items():
        check(bool(comp.get("basis")), f"H3[{label}]: {key} has no basis label")
    print(f"  {label:<14} {s['confidence']:>6.3f} {recomputed:>11.4f} {s['weightUsed']:>6.2f}  "
          f"{s['componentsUnavailable'] or '—'}")
check(abs(sum(T["weights"].values()) - 1.0) < 1e-9,
      f"H3: weights sum to {sum(T['weights'].values())}, expected 1.0")
print(f"  weights sum to {sum(T['weights'].values()):.2f} over 5 components")


# ────────────────────────────────────────────────────────────────────────────
#  H4 — an off-corridor report scores ~0 on plausibility
# ────────────────────────────────────────────────────────────────────────────
print("\n=== H4  plausibility falls to ~0 away from the track ===")
for label, key in (("on the corridor", "plausOn"), ("~2.1 km off", "plausNear"),
                   ("~5.8 km off", "plausFar"), ("~10.5 km off", "plausOff")):
    p = js[key]
    print(f"  {label:<18} offset {str(p['offsetM']):>7} m  score {p['score']}  basis {p['basis']}")
on, near, far, off = js["plausOn"], js["plausNear"], js["plausFar"], js["plausOff"]
check(on["score"] == 1, f"H4: an on-corridor report scored {on['score']}, expected 1")
check(on["offsetM"] <= T["corridorNearM"],
      f"H4: the on-corridor fixture is {on['offsetM']} m out, beyond corridorNearM")
# The far cases are the point of the check: ~0, or explicitly excluded — never a
# middling score that would let a hoax kilometres from any track look plausible.
for label, p in (("5.8 km", far), ("10.5 km", off)):
    check(p["score"] == 0 or p["score"] is None,
          f"H4: a report {label} from the track scored {p['score']} on plausibility")
check(near["score"] is None or 0 < near["score"] < 1,
      f"H4: the 2.1 km fixture scored {near['score']}; expected the ramp between near and far")
check(on["basis"] == "perpendicular-projection",
      f"H4: plausibility basis is {on['basis']!r}, not perpendicular projection (VERIFIED #11/#24)")
# Monotonic: further from the track can never score higher.
seq = [p["score"] for p in (on, near, far, off) if p["score"] is not None]
check(all(a >= b for a, b in zip(seq, seq[1:])),
      f"H4: plausibility is not monotonic in distance: {seq}")
print(f"  monotonic in distance: {seq}")


# ────────────────────────────────────────────────────────────────────────────
#  H5 — two reports from the SAME device are not independent
# ────────────────────────────────────────────────────────────────────────────
# The obvious way to fake corroboration.  If this invariant breaks, one person
# with one phone can drive a report to `corroborated` on their own.
print("\n=== H5  same-device reports do not corroborate each other ===")
sd, md = js["sameDevice"], js["multiDevice"]
print(f"  3 reports / 1 device : independentDevices={sd['independentDevices']} score={sd['score']}")
print(f"  3 reports / 3 devices: independentDevices={md['independentDevices']} score={md['score']}")
check(sd["independentDevices"] == 1,
      f"H5: 3 same-device reports counted as {sd['independentDevices']} independent devices")
check(sd["score"] == 0,
      f"H5: same-device cluster scored {sd['score']} on independence, expected 0")
check(md["independentDevices"] == 3,
      f"H5: 3 distinct devices counted as {md['independentDevices']}")
check(md["score"] > sd["score"],
      "H5: distinct devices scored no higher than one device repeating itself")
check(sd["basis"] == "distinct-device-hashes",
      f"H5: independence basis is {sd['basis']!r}")

rp = js["rejectedPeer"]
print(f"  peer already rejected: independentDevices={rp['independentDevices']} score={rp['score']}")
check(rp["independentDevices"] == 1,
      "H5: a human-REJECTED peer was counted as independent corroboration")

# The saturation curve, pinned value by value.  These exact numbers are quoted in
# the engine's comment; pinning them here is what stops the two from drifting.
print(f"  {'devices':>7} {'score':>7}   (saturating, never reaches 1)")
expected_curve = {1: 0.0, 2: 0.4, 3: 0.667, 4: 0.75, 5: 0.8, 6: 0.833}
prev = -1.0
for n, devices, score in js["curve"]:
    print(f"  {devices:>7} {score:>7.3f}")
    check(devices == n, f"H5: curve fixture with {n} devices reported {devices}")
    check(abs(score - expected_curve[n]) < 0.001,
          f"H5: {n} devices scores {score}, engine comment documents {expected_curve[n]}")
    check(score > prev or n == 1, f"H5: independence score not monotonic at n={n}")
    check(score < 1.0, f"H5: independence saturated to {score} at n={n} — it must never reach 1")
    prev = score
check(js["curve"][0][2] == 0.0, "H5: a lone reporter scored above 0 on independence")


# ────────────────────────────────────────────────────────────────────────────
#  H6 — exactly one audit entry per human decision
# ────────────────────────────────────────────────────────────────────────────
# "An approval that cannot be audited is not a human confirmation."  Two entries
# for one decision would be as wrong as none: the trail is the evidence.
print("\n=== H6  exactly one audit entry per human decision ===")
human_decided = [r for r in reports if r.get("status") in js["humanOnly"]]
machine_only = [r for r in reports if r.get("status") in js["machineAssignable"]]
print(f"  human-decided {len(human_decided)}, machine-status {len(machine_only)}")
for r in human_decided:
    trail = r.get("auditTrail") or []
    check(len(trail) == 1,
          f"H6: {r['id']} is {r['status']} with {len(trail)} audit entries, expected exactly 1")
    for e in trail:
        check(e.get("decision") == r["status"],
              f"H6: {r['id']} status {r['status']} but audit records {e.get('decision')!r}")
        for field in ("at", "actor", "tokenState", "previousStatus", "previousStatusBasis"):
            check(e.get(field) is not None, f"H6: {r['id']} audit entry missing {field}")
        # VERIFIED #21/#29: the previous status must be the RECOMPUTED effective
        # one, never a persisted hint that may describe a different moment.
        check(e.get("previousStatusBasis") == "effective",
              f"H6: {r['id']} previousStatusBasis is {e.get('previousStatusBasis')!r}, expected 'effective'")
        check(e.get("actor") in ("operator", "unverified"),
              f"H6: {r['id']} unexpected actor {e.get('actor')!r}")
    if trail:
        e = trail[0]
        print(f"  {r['id']}  {e['previousStatus']:>12} → {e['decision']:<9} "
              f"actor={e['actor']:<10} tokenState={e['tokenState']}")
for r in machine_only:
    trail = r.get("auditTrail") or []
    check(len(trail) == 0,
          f"H6: {r['id']} has machine status {r['status']} but carries {len(trail)} audit entries")
print(f"  machine-status reports carry 0 audit entries: "
      f"{all(not (r.get('auditTrail') or []) for r in machine_only)}")
# The token value itself must never be persisted.
raw = open(hz.STORE_PATH, encoding="utf-8").read()
token = (os.environ.get("GATI_ADMIN_TOKEN") or "").strip()
if token:
    check(token not in raw, "H6: the admin token VALUE was persisted into the hazard store")
    print("  admin token value absent from the store on disk: True")


# ────────────────────────────────────────────────────────────────────────────
#  H7 — the cap applies to the hazard's sub-span, NOT block-wide (VERIFIED #6)
# ────────────────────────────────────────────────────────────────────────────
# The specific bug the curvature layer was already caught by: applying a block's
# worst restriction across the whole block overstated the penalty by ~2,200×.
# Assert it rather than trust it.
print("\n=== H7  the restriction is a sub-span, not the whole block (VERIFIED #6) ===")
fixture = {
    "_meta": {"schema": "gati-hazards-v1", "note": "verify_hazards.py fixture", "count": 1},
    "reports": [{
        "id": "hz_verify01", "category": "landslide", "status": "confirmed",
        "lat": 18.40121, "lng": 73.22094,
        "reportedAt": "2026-09-14T06:00:00.000Z", "deviceHash": "verify",
        "description": "fixture", "photoPath": None, "isSynthetic": True,
        "auditTrail": [{"at": "2026-09-14T06:05:00.000Z", "decision": "confirmed",
                        "actor": "operator", "tokenState": "verified",
                        "previousStatus": "logged", "previousStatusBasis": "effective"}],
    }],
}
with tempfile.TemporaryDirectory() as td:
    fpath = os.path.join(td, "hazards.json")
    with open(fpath, "w", encoding="utf-8") as fh:
        json.dump(fixture, fh)

    with_hz = eta_model.compute_eta("22229", hazards=True, hazard_store_path=fpath)
    hit = [s for s in with_hz["segments"] if s["hazard_penalty_min"] > 0]
    check(len(hit) >= 1, "H7: the fixture hazard produced no penalty on any block — layer not wired")
    for s in hit:
        block_km = s["distance_km"]
        restricted = sum(d["overlap_km"] for d in s["hazard_restrictions"])
        v_normal = s["effective_speed_kmh"]
        cap = min(d["cap_kmph"] for d in s["hazard_restrictions"])
        actual = s["hazard_penalty_min"]
        # The counterfactual: the same cap applied across the ENTIRE block.
        blockwide = block_km * (60.0 / min(v_normal, cap) - 60.0 / v_normal)
        ratio = blockwide / actual if actual > 0 else float("inf")
        print(f"  block {s['from']}→{s['to']}  {block_km:.1f} km at {v_normal:.1f} km/h, cap {cap:.0f}")
        print(f"    restricted span     : {restricted:.3f} km "
              f"({restricted / block_km * 100:.2f}% of the block)")
        print(f"    penalty charged     : {actual:.3f} min")
        print(f"    if applied BLOCK-WIDE: {blockwide:.1f} min  ({ratio:.0f}× larger)")
        check(restricted <= 2 * hz.HAZARD_SPAN_HALF_KM + 1e-6,
              f"H7: restricted span {restricted:.3f} km exceeds the ±{hz.HAZARD_SPAN_HALF_KM} km half-width")
        check(restricted < block_km * 0.05,
              f"H7: the restriction covers {restricted / block_km:.1%} of the block — that is block-wide")
        check(ratio > 20,
              f"H7: block-wide would be only {ratio:.1f}× the charged penalty — the sub-span gate is not binding")
        # The arithmetic itself, reconciled from the printed intermediates (§8).
        recomputed = sum(d["overlap_km"] * (60.0 / d["applied_speed_kmh"]
                                            - 60.0 / d["normal_speed_kmh"])
                         for d in s["hazard_restrictions"])
        check(abs(recomputed - actual) < 0.01,
              f"H7: per-span detail gives {recomputed:.3f} min, segment reports {actual:.3f}")
        check(s["hazard_basis"] == ["hz_verify01"],
              f"H7: hazard_basis is {s['hazard_basis']}, must name the contributing reports")

    # A hazard can never make a train faster, on any block.
    for s in with_hz["segments"]:
        check(s["hazard_penalty_min"] >= 0,
              f"H7: negative hazard penalty {s['hazard_penalty_min']} on {s['from']}→{s['to']}")

    # ── H8 — overlapping spans merge to the MOST RESTRICTIVE, never summed ──
    # Two people reporting one landslide must not cost twice the minutes: the
    # same double-count trap as summing cumulative delayArrival (VERIFIED #9).
    print("\n=== H8  overlapping reports merge to the tightest cap, never summed ===")
    two = json.loads(json.dumps(fixture))
    second = json.loads(json.dumps(fixture["reports"][0]))
    second.update({"id": "hz_verify02", "category": "flooding", "deviceHash": "verify2",
                   "lat": 18.40121, "lng": 73.22094})
    two["reports"].append(second)
    two["_meta"]["count"] = 2
    tpath = os.path.join(td, "hazards_two.json")
    with open(tpath, "w", encoding="utf-8") as fh:
        json.dump(two, fh)

    both = eta_model.compute_eta("22229", hazards=True, hazard_store_path=tpath)
    one_total = with_hz["totals"]["hazard_penalty_min"]
    both_total = both["totals"]["hazard_penalty_min"]
    caps = {"landslide": hz.HAZARD_SPEED_CAP_KMH["landslide"],
            "flooding": hz.HAZARD_SPEED_CAP_KMH["flooding"]}
    print(f"  landslide cap {caps['landslide']:.0f} km/h, flooding cap {caps['flooding']:.0f} km/h "
          f"— co-located, identical spans")
    print(f"  one report   : {one_total:.3f} min over {with_hz['hazard_layer']['restricted_km']:.3f} km")
    print(f"  both reports : {both_total:.3f} min over {both['hazard_layer']['restricted_km']:.3f} km")
    check(abs(both_total - one_total) < 0.01,
          f"H8: two co-located reports cost {both_total:.3f} min vs {one_total:.3f} for one — summed, not merged")
    check(abs(both["hazard_layer"]["restricted_km"]
              - with_hz["hazard_layer"]["restricted_km"]) < 0.01,
          "H8: restricted km grew when a second report was added to the same place")
    for s in both["segments"]:
        for d in s["hazard_restrictions"]:
            check(d["cap_kmph"] == min(caps.values()),
                  f"H8: merged span took cap {d['cap_kmph']}, expected the tightest {min(caps.values())}")
            check(len(d["report_ids"]) == 2,
                  f"H8: merged span names {d['report_ids']}, expected both reports")
    print(f"  merged cap   : {min(caps.values()):.0f} km/h (the tightest), both ids on the span")

    # ── H9 — hazards=False reproduces §4b byte-identically ──────────────────
    # The conflicts=False contract.  Anything less means the layer leaked into
    # the default path that every number in CLAUDE.md §4b depends on.
    print("\n=== H9  hazards=False is byte-identical to the default path ===")
    base = eta_model.compute_eta("22229")
    off = eta_model.compute_eta("22229", hazards=False, hazard_store_path=fpath)
    b = dict(base)
    o = dict(off)
    b.pop("hazard_layer", None)
    o.pop("hazard_layer", None)
    bj = json.dumps(b, sort_keys=True)
    oj = json.dumps(o, sort_keys=True)
    check(bj == oj, "H9: hazards=False changed the payload versus the default call")
    print(f"  payload identical outside `hazard_layer`: {bj == oj}  ({len(bj)} bytes compared)")
    # Key is `predicted_eta_min`, not `eta_min` — the latter is absent and used
    # to KeyError the whole harness after H8 had already passed.
    for key in ("running_min", "historical_delay_min", "dwell_min", "predicted_eta_min"):
        bv, ov = base["totals"].get(key), off["totals"].get(key)
        check(bv == ov, f"H9: totals.{key} moved {bv} → {ov} with hazards=False")
        print(f"    totals.{key:<22} {bv}")
    check(base["totals"]["hazard_penalty_min"] == 0.0,
          f"H9: default path charges {base['totals']['hazard_penalty_min']} hazard minutes")
    check(base["hazard_layer"]["enabled"] is False,
          "H9: the default path reports the hazard layer as enabled")
    # §4b's own gate numbers, asserted here so this file fails if the layer moves them.
    check(abs(base["totals"]["predicted_eta_min"] - 615.7) < 0.15,
          f"H9: block-mode ETA is {base['totals']['predicted_eta_min']}, §4b says 615.7")
    print(f"  §4b block-mode ETA unchanged: {base['totals']['predicted_eta_min']} (expected 615.7)")

    # ── H7b — prove the zero is wired, not broken (VERIFIED #9) ─────────────
    # With no confirmed hazards the contribution is legitimately 0.0, which is
    # indistinguishable from a dead layer.  Show it move.
    print("\n=== H7b  the zero layer is wired — a confirmed hazard moves the ETA ===")
    eta_off = base["totals"]["predicted_eta_min"]
    eta_on = with_hz["totals"]["predicted_eta_min"]
    print(f"  no confirmed hazard : {eta_off:.1f} min")
    print(f"  one confirmed hazard: {eta_on:.1f} min   (+{eta_on - eta_off:.3f})")
    check(eta_on > eta_off, "H7b: a confirmed hazard did not move the ETA at all")
    check(abs((eta_on - eta_off) - one_total) < 0.02,
          f"H7b: ETA moved {eta_on - eta_off:.3f} but the layer reports {one_total:.3f}")
    check(with_hz["hazard_layer"]["enabled"] is True and with_hz["hazard_layer"]["available"] is True,
          "H7b: the layer did not report itself enabled and available")
    check(with_hz["hazard_layer"]["applied_reports"] == ["hz_verify01"],
          f"H7b: applied_reports is {with_hz['hazard_layer']['applied_reports']}")


# ────────────────────────────────────────────────────────────────────────────
#  H10 — honesty flags present on both halves of the layer
# ────────────────────────────────────────────────────────────────────────────
# §5e's rule, applied to Phase 7: a heuristic must say it is one, wherever it
# surfaces.  These are rendered by the UI and must not be quietly dropped.
print("\n=== H10  honesty flags present in every payload ===")
print("  confidence engine (JS):")
for key, want in (("confidenceModelIsHeuristic", True),
                  ("trainPresenceBasis", "scheduled"),
                  ("decisionSupportOnly", True)):
    got = js["flags"].get(key)
    check(got == want, f"H10: scoreReport.{key} is {got!r}, expected {want!r}")
    print(f"    {key} = {got}")
check(bool(js["flags"].get("note")), "H10: scoreReport carries no explanatory note")
check(js["flags"]["thresholds"]["corroboratedAt"] == T["corroboratedAt"],
      "H10: thresholds are not surfaced in the payload")

layer = hz.build("22229", eta_model.load_schedule("22229")[1])
print("  ETA layer (Python):")
for key, want in (("capsAreHeuristic", True),
                  ("capsBasis", "our-heuristic-not-official-tsr"),
                  ("requiresHumanConfirmation", True),
                  ("appliedStatuses", ["confirmed"]),
                  ("machineStatusesIgnored", ["logged", "candidate", "corroborated"]),
                  ("decisionSupportOnly", True),
                  ("upstreamRequestCost", 0)):
    got = layer.get(key)
    check(got == want, f"H10: hazard_layer.{key} is {got!r}, expected {want!r}")
    print(f"    {key} = {got}")
check(layer["spanHalfWidthKm"] == hz.HAZARD_SPAN_HALF_KM, "H10: spanHalfWidthKm not surfaced")

# The two implementations must agree on which statuses may reach the ETA.
check(sorted(layer["machineStatusesIgnored"]) == sorted(js["machineAssignable"]),
      f"H10: Python ignores {layer['machineStatusesIgnored']} but JS may assign {js['machineAssignable']} "
      "— the two halves disagree on the human-confirmation boundary")
check(layer["appliedStatuses"] == ["confirmed"] and "confirmed" in js["humanOnly"],
      "H10: the ETA applies a status the JS side does not reserve for humans")
print(f"  JS machine-assignable == Python machine-ignored: "
      f"{sorted(layer['machineStatusesIgnored']) == sorted(js['machineAssignable'])}")

# A missing store is `unavailable`, never an empty list (VERIFIED #9).
_r, _m, reason = hz.load_store(os.path.join(tempfile.gettempdir(), "definitely-not-a-store.json"))
check(reason == "hazard-store-absent",
      f"H10: a missing store reported {reason!r}, not an explicit unavailable reason")
print(f"  missing store → {reason!r} (not a silent empty list)")


print()
if fails:
    print(f"FAILED ({len(fails)}):")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("ALL CHECKS PASSED")
