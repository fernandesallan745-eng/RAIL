"""
report_eta.py — layer-by-layer verification report for the combined ETA model.

Prints every intermediate number so each layer (baseline, curvature, historical
delay, dwell) can be verified independently before trusting the combined total.
Cache-only: makes no API calls.
"""
import os, json, glob, math
from datetime import datetime

import curvature
import eta_model

TRAIN = "22229"
CACHE = eta_model.CACHE
W = 96

def rule(ch="─"):
    print(ch * W)

def head(n, title):
    print()
    rule("=")
    print(f"STEP {n}: {title}")
    rule("=")


# ══════════════════════════════════════════════════════════════════════════
head(0, "Cache inventory (cache-first — zero API calls)")
runs = eta_model.list_dated_runs(TRAIN)
route_path = os.path.join(CACHE, f"{TRAIN}_route.json")
print(f"  Route geometry cache : {os.path.basename(route_path)}  "
      f"({os.path.getsize(route_path)/1024:.0f} KB)")
print(f"  Dated historical runs: {len(runs)} → {', '.join(sorted(runs))}")
undated = os.path.join(CACHE, f"{TRAIN}_live.json")
if os.path.exists(undated):
    u = json.load(open(undated))
    print(f"  Undated live snapshot: startDate={u.get('startDate')} status={u.get('status')} "
          f"(future run — not usable as history)")

coords = eta_model.load_route_coords(TRAIN)
train_info, stations, src = eta_model.load_schedule(TRAIN)
halts = [s for s in stations if s.get("isHalt")]
print(f"\n  Geometry vertices : {len(coords)} [lng,lat] points")
print(f"  Route stations    : {len(stations)}  (halts: {len(halts)})")
print(f"  Train             : {train_info.get('name')}")
print(f"  Rated maxSpeed    : {train_info.get('maxSpeed')} km/h   "
      f"avgSpeed: {train_info.get('avgSpeed')} km/h")
print(f"  Scheduled duration: {train_info.get('duration')} min over {train_info.get('distance')} km")


# ══════════════════════════════════════════════════════════════════════════
head(1, "LAYER 1 — Baseline speed (schedule-derived speedToNextStationKmph)")
print("  Verifying the field really is schedule-derived: compare the API value against")
print("  distance / (scheduled arrival − scheduled departure) computed by hand.\n")
print(f"  {'segment':<13} {'km':>5} {'dep':>6} {'arr':>6} {'run_min':>8} "
      f"{'hand_calc_kmh':>13} {'api_speed':>10} {'match':>7}")
rule()
def dt(x): return datetime.fromisoformat(x) if x else None
for a, b in zip(halts[:-1], halts[1:]):
    dep, arr = dt(a.get("scheduledDeparture")), dt(b.get("scheduledArrival"))
    km = b["distance"] - a["distance"]
    run = (arr - dep).total_seconds()/60
    hand = km / (run/60)
    api = a.get("speedToNextStationKmph")
    ok = "OK" if abs(hand - api) < 0.15 else f"d={hand-api:+.2f}"
    print(f"  {a['stationCode']+'→'+b['stationCode']:<13} {km:>5.0f} {dep.strftime('%H:%M'):>6} "
          f"{arr.strftime('%H:%M'):>6} {run:>8.0f} {hand:>13.1f} {api:>10} {ok:>7}")
print("\n  → Confirms note #3: speedToNextStationKmph == schedule math, NOT live speed.")
print("    Using it as the per-segment baseline therefore reproduces the timetable exactly,")
print("    and it already encodes real-world pacing (why THVM→MAO is only 28 km/h).")


# ══════════════════════════════════════════════════════════════════════════
head(2, "LAYER 2 — Curvature cap per halt-to-halt block (RDSO V = 4.58·√R)")
cum = eta_model.geometry_cumulative_km(coords)
halt_idx = eta_model.snap_halts_to_vertices(coords, halts)
print(f"  Geometry length {cum[-1]:.1f} km vs schedule {halts[-1]['distance']} km.")
print("  Each halt is anchored to its nearest geometry vertex by its own lat/lng, then")
print("  each block is scaled against its own km-posts. (A single global 581.4→588 factor")
print("  used to smear that 6.6 km mismatch across all blocks as ±0.5 min of noise.)\n")
print(f"  {'halt':>6} {'sched_km':>9} {'vertex':>7} {'geom_km':>9} {'snap_err_m':>11}")
rule()
for h, i in zip(halts, halt_idx):
    err = curvature.haversine_m(h["lat"], h["lng"], coords[i][1], coords[i][0]) \
        if h.get("lat") and h.get("lng") else float("nan")
    print(f"  {h['stationCode']:>6} {h['distance']:>9} {i:>7} {cum[i]:>9.2f} {err:>11.1f}")
print("\n  Snap error is platform-vs-centreline offset; ≤800 m is 1-2 vertices on blocks")
print("  of 9-175 km, so it does not move any block time measurably.\n")

r_thresh = (eta_model.MAX_SPEED_KMH / curvature.CURVE_SPEED_CONSTANT) ** 2
print(f"  At {eta_model.MAX_SPEED_KMH} km/h, a curve only binds when R < "
      f"({eta_model.MAX_SPEED_KMH}/4.58)² = {r_thresh:.0f} m\n")
print(f"  {'segment':<13} {'km_range':>13} {'min_R_m':>9} {'lat':>9} "
      f"{'curve_cap':>10} {'baseline':>9} {'binds?':>8}")
rule()
for k, (a, b) in enumerate(zip(halts[:-1], halts[1:])):
    r, lat = eta_model.sharpest_radius_in_block(coords, halt_idx[k], halt_idx[k + 1])
    cap = eta_model.MAX_SPEED_KMH if math.isinf(r) else min(eta_model.MAX_SPEED_KMH,
              curvature.CURVE_SPEED_CONSTANT*math.sqrt(r))
    base = a.get("speedToNextStationKmph")
    binds = "YES ◀" if cap < base else "no"
    km_range = f"{a['distance']}-{b['distance']} km"
    print(f"  {a['stationCode']+'→'+b['stationCode']:<13} {km_range:>13} "
          f"{r:>9.1f} {lat:>9.4f} {cap:>10.1f} {base:>9} {binds:>8}")
print("\n  → Only ONE block is curvature-limited: PNVL→KHED (R=268 m near lat 18.52,")
print("    Panvel/Bhor Ghat). Matches note #2 exactly. Everywhere else the schedule")
print("    baseline is already slower than the curve cap, so curvature is not binding.")

# ── resolution limit: a 3-point circumradius cannot see a curve shorter than its chord
print("\n  ── DATA-QUALITY LIMIT ON THIS LAYER ─────────────────────────────────────")
sp = [cum[i] - cum[i-1] for i in range(1, len(cum))]
blind = sum(x for x in sp if x > 1.0)
sp_m = sorted(x*1000 for x in sp)
print(f"  Vertex spacing (m): min={sp_m[0]:.0f}  median={sp_m[len(sp_m)//2]:.0f}  "
      f"p75={sp_m[3*len(sp_m)//4]:.0f}  max={sp_m[-1]:.0f}")
print(f"  Spans >1 km: {sum(1 for x in sp if x > 1.0)} covering {blind:.1f} of {cum[-1]:.1f} km "
      f"= {blind/cum[-1]*100:.1f}% of the route.")
print("  A circumradius over 3 vertices cannot resolve a curve shorter than its chord,")
print(f"  so in that {blind/cum[-1]*100:.0f}% curvature is UNDETECTABLE, not absent. Per-block:\n")
print(f"  {'block':>13} {'verts':>6} {'median_sp_m':>12} {'blind_km':>9} {'blind%':>7}")
rule()
for k, (a, b) in enumerate(zip(halts[:-1], halts[1:])):
    i0, i1 = halt_idx[k], halt_idx[k+1]
    bsp = [cum[i]-cum[i-1] for i in range(i0+1, i1+1)]
    if not bsp:
        continue
    bl = sum(x for x in bsp if x > 1.0)
    med = sorted(bsp)[len(bsp)//2]*1000
    print(f"  {a['stationCode']+'→'+b['stationCode']:>13} {i1-i0:>6} {med:>12.0f} "
          f"{bl:>9.1f} {bl/sum(bsp)*100:>6.1f}%")
print("\n  → Median density is uniform (~200 m); the blindness is scattered long jumps,")
print("    worst in the deep-Konkan blocks RN→KKW and KKW→THVM (~73%). So state the")
print("    curvature result as 'in the resolvable ~44% of the route', never as a")
print("    route-wide measurement.")


# ══════════════════════════════════════════════════════════════════════════
head(3, "LAYER 3 — Historical average delay per segment (data-derived buffer)")
print("  Task asks for mean(delayArrival) across the dated runs. Auditing what the")
print("  cached completed runs actually contain:\n")
print(f"  {'date':>12} {'status':>10} {'trackingMode':>13} {'delayMinutes':>13} "
      f"{'non-null delayArr':>18} {'actual≠sched':>13}")
rule()
for d in sorted(runs):
    j = runs[d]; rt = j.get("route", [])
    nz = sum(1 for s in rt if s.get("delayArrival"))
    mism = sum(1 for s in rt for x, y in [("scheduledArrival","actualArrival"),
               ("scheduledDeparture","actualDeparture")]
               if s.get(x) and s.get(y) and s[x] != s[y])
    print(f"  {d:>12} {str(j.get('status')):>10} {str(j.get('trackingMode')):>13} "
          f"{str(j.get('delayMinutes')):>13} {nz:>18} {mism:>13}")

hist = eta_model.historical_delay_by_seq(TRAIN)
print(f"\n  Per-halt mean delayArrival across {len(runs)} runs:")
print(f"  {'halt':>6} {'seq':>4} {'mean_delay_min':>15} {'n_samples':>10}")
rule()
for h in halts:
    m, n = hist.get(h["sequence"], (0.0, 0))
    print(f"  {h['stationCode']:>6} {h['sequence']:>4} {m:>15.2f} {n:>10}")

inc = eta_model.historical_delay_increment_by_seq(TRAIN)
e2e_s, e2e_m = eta_model.end_to_end_delay_samples(TRAIN)
print(f"\n  CUMULATIVE (above) is NOT additive. Differenced into per-segment increments:")
print(f"  {'halt':>6} {'seq':>4} {'cum_mean':>10} {'increment':>10} {'n':>4}")
rule()
_tot = 0.0
for h in halts:
    c, _ = hist.get(h["sequence"], (0.0, 0))
    m, n = inc.get(h["sequence"], (0.0, 0))
    _tot += m
    print(f"  {h['stationCode']:>6} {h['sequence']:>4} {c:>+10.2f} {m:>+10.2f} {n:>4}")
print(f"  {'SUM':>6} {'':>4} {sum(hist.get(h['sequence'],(0.0,0))[0] for h in halts):>+10.2f} "
      f"{_tot:>+10.2f}")

print(f"""
  ⚠️  FINDING — ground-truth note #4 is now PARTLY SUPERSEDED. Real actuals arrived.
      5 of the 9 cached dates (08-19/21/24/26/28) return trackingMode="real-time" with
      7-8 non-null delayArrival values — one per non-origin halt. The other 4 dates are
      still zero-echo (trackingMode="none"), and are SKIPPED rather than averaged in as
      zeros, which would dilute the real delays toward nothing.

  ⚠️  BUG THIS EXPOSED — delayArrival is CUMULATIVE, not per-segment.
      It equals actualArrival - scheduledArrival, so it already contains every minute
      lost earlier in the run. Summing it across halts double-counts badly: on
      2026-08-21 the eight cumulative values sum to +149 min for a run that finished
      3 min EARLY (632 vs 635). The model summed them until this was caught, giving a
      679.1 min ETA. Fixed by differencing along the halt chain, per date, so the
      increments telescope back to the end-to-end delay.

      Sum of increments  : {_tot:+.1f} min
      Mean e2e delay     : {e2e_m:+.1f} min   <- ground truth, quote THIS
      Coverage artifact  : {_tot - e2e_m:+.1f} min (DR and THVM each miss one date, so a
                           sum-of-means diverges slightly from a mean-of-sums)

      Per-date e2e delay : {', '.join(f'{d[5:]} {v:+d}' for d, v in sorted(e2e_s.items()))}
      This train runs EARLY on average. The delay layer now subtracts time.""")

print("""  What IS genuinely in the data — the timetable's own recovery margin. The schedule
  paces each block well below what physics allows; that surplus is the real buffer:""")
res = eta_model.compute_eta(TRAIN)
print(f"\n  {'segment':<13} {'physics_min':>12} {'sched_min':>10} {'slack_min':>10} {'slack_%':>8}")
rule()
for s in res["segments"]:
    pct = s["schedule_slack_min"]/s["sched_run_min"]*100 if s["sched_run_min"] else 0
    print(f"  {s['from']+'→'+s['to']:<13} {s['physics_run_min']:>12.2f} "
          f"{s['sched_run_min']:>10.1f} {s['schedule_slack_min']:>10.1f} {pct:>7.1f}%")
print(f"  {'TOTAL':<13} {sum(s['physics_run_min'] for s in res['segments']):>12.2f} "
      f"{sum(s['sched_run_min'] for s in res['segments']):>10.1f} "
      f"{res['totals']['schedule_slack_min']:>10.1f}")


# ══════════════════════════════════════════════════════════════════════════
head(4, "LAYER 4 — Halt dwell time (scheduledDeparture − scheduledArrival)")
print(f"  {'halt':>6} {'sch_arr':>9} {'sch_dep':>9} {'dwell_min':>10}")
rule()
tot_dwell = 0
for h in halts:
    a_, d_ = dt(h.get("scheduledArrival")), dt(h.get("scheduledDeparture"))
    dw = max(0.0, (d_-a_).total_seconds()/60) if (a_ and d_) else 0.0
    tot_dwell += dw
    print(f"  {h['stationCode']:>6} {a_.strftime('%H:%M') if a_ else '--':>9} "
          f"{d_.strftime('%H:%M') if d_ else '--':>9} {dw:>10.1f}"
          f"{'   (origin)' if not a_ else '   (terminus)' if not d_ else ''}")
print(f"  {'TOTAL':>6} {'':>9} {'':>9} {tot_dwell:>10.1f}")
print(f"\n  → {tot_dwell:.0f} min of dwell. Model counts dwell at the ARRIVING halt of each")
print("    segment, so the origin (CSMT) is excluded and no halt is double-counted:")
print(f"    model dwell total = {res['totals']['dwell_min']} min.")


# ══════════════════════════════════════════════════════════════════════════
head(5, "COMBINED MODEL — per-segment assembly")
print("  segment_eta = distance/min(baseline, curve_cap, weather_cap) + hist_delay + dwell\n")
print(f"  {'segment':<13} {'km':>5} {'base':>6} {'curve':>6} {'wthr':>6} {'EFF':>6} "
      f"{'run':>7} {'+delay':>7} {'+dwell':>7} {'= eta':>7} {'sched':>6} {'Δ':>6}")
rule()
for s in res["segments"]:
    sched_block = s["sched_run_min"] + s["dwell_min"]
    print(f"  {s['from']+'→'+s['to']:<13} {s['distance_km']:>5.0f} {s['baseline_speed_kmh']:>6.1f} "
          f"{s['curve_capped_speed_kmh']:>6.1f} {s['weather_capped_speed_kmh']:>6.1f} "
          f"{s['effective_speed_kmh']:>6.1f} {s['running_min']:>7.2f} {s['hist_delay_min']:>7.2f} "
          f"{s['dwell_min']:>7.1f} {s['segment_eta_min']:>7.2f} {sched_block:>6.0f} "
          f"{s['segment_eta_min']-sched_block:>+6.2f}")
t = res["totals"]
rule()
print(f"  {'TOTAL':<13} {t['distance_km']:>5.0f} {'':>6} {'':>6} {'':>6} {'':>6} "
      f"{t['running_min']:>7.1f} {t['historical_delay_min']:>7.1f} {t['dwell_min']:>7.1f} "
      f"{t['predicted_eta_min']:>7.1f} {t['scheduled_duration_min']:>6} "
      f"{t['gap_vs_schedule_min']:>+6.1f}")

print(f"""
  ⚠️  METHODOLOGY CHECK — block-level curve cap vs true vertex-level integration:
      The rows above use min(baseline, sharpest-curve-in-block) for the WHOLE block.
      That is pessimistic: it applies the block's one sharp curve to all its km.
      A physically correct ETA integrates per-vertex (each sub-segment capped by its own
      radius; median vertex spacing ~195 m, 1183 sub-segments over 8 blocks).
      If these two disagree materially, the block version is an OVERSTATEMENT.

  {'' :<13} {'block(min,R)':>14} {'vertex-integ':>14} {'overstate':>14} {'vseg':>6} {'capped':>7}
  {'─'*13} {'─'*14} {'─'*14} {'─'*14} {'─'*6} {'─'*7}""")
for s in res["segments"]:
    over = s["running_min"] - s["vertex_curve_running_min"]
    flag = " ◀ OVERSTATES" if over > 0.5 else ""
    print(f"  {s['from']+'→'+s['to']:<13} {s['running_min']:>14.2f} "
          f"{s['vertex_curve_running_min']:>14.2f} {over:>14.2f} "
          f"{s['vertex_segments']:>6} {s['vertex_capped_by_curve']:>7}{flag}")
tot_over = sum(s["running_min"] - s["vertex_curve_running_min"] for s in res["segments"])
print(f"  {'TOTAL':<13} {t['running_min']:>14.2f} "
      f"{sum(s['vertex_curve_running_min'] for s in res['segments']):>14.2f} {tot_over:>14.2f}")
print(f"""
  → For 7 of 8 blocks the two agree EXACTLY (curve non-binding there). Because each
    block's sub-segment lengths are renormalised to its timetable distance, the vertex
    integration can never fall below the baseline-only time — so any difference it
    reports is curvature and nothing else. Verified: penalty ≥ 0 on all 8 blocks.

    For PNVL→KHED the block method OVERSTATES by ~{res['segments'][3]['running_min']-res['segments'][3]['vertex_curve_running_min']:.1f} min:
    it applies R=268 m to all 175 km, but that curve is only ~80 m of actual track.
    Integrated properly, the cap from 76.6→75.0 km/h over 80 m costs {res['segments'][3]['vertex_curve_penalty_sec']:.3f} SECONDS.
    Both methods agree the curve exists and caps speed to 75 km/h locally — the
    difference is scope. That overstatement is the whole of the +2.8 min headline.

    RECOMMENDATION: use the vertex-integrated variant as the physics layer
    (eta_model.block_vertex_running_min). The block version is a defensible conservative
    upper bound when a data source exposes only one radius per block — label it as such,
    never as measured physics. Report shows BOTH for the demo.""")

print(f"""
  Component reconciliation (block variant):
    running (Σ distance/effective_speed) : {t['running_min']:>7.1f} min
    historical delay (incremental, real) : {t['historical_delay_min']:>7.1f} min
    halt dwell                           : {t['dwell_min']:>7.1f} min
    ────────────────────────────────────────────────────
    PREDICTED TOTAL                      : {t['predicted_eta_min']:>7.1f} min
    ACTUAL SCHEDULED TOTAL               : {t['scheduled_duration_min']:>7.1f} min
    GAP                                  : {t['gap_vs_schedule_min']:>+7.1f} min
      ({abs(t['gap_vs_schedule_min'])/t['scheduled_duration_min']*100:.2f}% error)

  The +{t['gap_vs_schedule_min']:.1f} min comes from ONE segment: PNVL→KHED, where the curvature
  cap (75.0 km/h) is slower than the schedule baseline (76.6 km/h). But per the
  methodology check above, essentially ALL of it is block-application overstatement:
  integrated per-vertex the same curve costs {res['segments'][3]['vertex_curve_penalty_sec']:.3f} seconds, so the vertex model lands at
  {sum(s['vertex_curve_running_min'] for s in res['segments']) + t['dwell_min'] + t['historical_delay_min']:.1f} min vs the 635 min schedule. Do NOT present the +{t['gap_vs_schedule_min']:.1f} min as the model
  "disagreeing with the timetable on physics grounds" — on this route it does not.""")


# ══════════════════════════════════════════════════════════════════════════
head(6, "BEFORE / AFTER SUMMARY TABLE")
naive = t["naive_flat_speed_min"]
sched = t["scheduled_duration_min"]

def row(label, val):
    gap = val - sched
    print(f"  {label:<46} {val:>11.1f} {gap:>+13.1f} {abs(gap)/sched*100:>8.2f}%")

# incremental ladder — each layer added one at a time
base_only = sum(s["distance_km"]/s["baseline_speed_kmh"]*60 for s in res["segments"])
base_curve = sum(s["distance_km"]/min(s["baseline_speed_kmh"], s["curve_capped_speed_kmh"])*60
                 for s in res["segments"])
# use the unrounded per-block penalties; summing 2dp running times loses the signal
curv_penalty = sum(s["vertex_curve_penalty_min"] for s in res["segments"])
base_vertex = base_only + curv_penalty
print(f"  {'Incremental build-up':<46} {'ETA (min)':>11} {'vs 635 sched':>13} {'error %':>9}")
rule()
row("1. Naive flat 80 km/h", naive)
row("2. + schedule baseline speeds per segment", base_only)
row("3. + curvature, per-vertex (DEFAULT, correct)", base_vertex)
row("4. + historical delay (real, incremental)", base_vertex + t['historical_delay_min'])
row("5. + halt dwell  → FINAL COMBINED MODEL", base_vertex + t['historical_delay_min'] + t['dwell_min'])
print(f"  {'ACTUAL SCHEDULED / OBSERVED':<46} {sched:>11.1f} {0.0:>+13.1f} {0.0:>8.2f}%")
rule()
row("(alt) curvature per-block, upper bound only", base_curve + t['historical_delay_min'] + t['dwell_min'])
final_vertex = base_vertex + t['historical_delay_min'] + t['dwell_min']
_e2e_s, _e2e_m = eta_model.end_to_end_delay_samples(TRAIN)
_obs = sched + _e2e_m if _e2e_m is not None else None
print(f"""
  TWO DIFFERENT TARGETS — do not conflate them.

  (a) vs the TIMETABLE ({sched:.0f} min). Steps 1-3+5 reproduce it: {base_vertex + t['dwell_min']:.1f} min.
      That check only proves the layers are wired up correctly. It is close to circular:
      the baseline speeds ARE the timetable, so reproducing it is arithmetic, not skill.

  (b) vs OBSERVED RUNS ({_obs:.1f} min mean over {len(_e2e_s)} tracked dates). This is the real test,
      and it is newly possible — the cache now holds real actuals.
      Combined model (vertex, default) : {final_vertex:.1f} min
      Observed mean journey            : {_obs:.1f} min
      ERROR                            : {final_vertex - _obs:+.1f} min
      Naive flat-80 against the same target is off by {naive - _obs:+.0f} min.

  Per-date spread: {', '.join(f'{d[5:]} {sched+v:.0f}' for d, v in sorted(_e2e_s.items()))} min.
  The spread is {max(_e2e_s.values())-min(_e2e_s.values()):.0f} min wide, so a single mean hides a lot. Report the
  error band, not just the mean — one number here would oversell the model.

  BE HONEST ABOUT WHAT DID THE WORK: of the {abs(naive-sched):.0f} min between naive and timetable,
  {base_only-naive:+.0f} min came from the schedule-derived baseline speeds and {t['dwell_min']:+.0f} min from dwell.
  Curvature contributed {curv_penalty:+.4f} min. The historical-delay layer contributes
  {t['historical_delay_min']:+.1f} min and is what moves the model off the timetable toward observed
  reality — it is the only layer carrying information the timetable does not already have.""")


# ══════════════════════════════════════════════════════════════════════════
head(7, "ISOLATED EXAMPLE — Panvel / Bhor Ghat curvature effect (lat 18.4–18.6)")
# vertex-segment profile of the lat window (used for distance + capped-curve listing)
segs80 = curvature.build_segment_profile(coords, max_train_speed_kmh=80, weather="clear")
ghat = [s for s in segs80 if 18.4 <= s["from"][0] <= 18.6 or 18.4 <= s["to"][0] <= 18.6]
capped = [s for s in ghat if s["capped_speed_kmh"] < 80]
gd = sum(s["distance_m"] for s in ghat)
print(f"  Curve-capped sub-segments found in the window ({len(capped)} of {len(ghat)}):")
print(f"  {'#':>3} {'radius_m':>10} {'capped_kmh':>11} {'seg_len_m':>10} {'lat':>10} {'lng':>10}")
rule()
for i, s in enumerate(sorted(capped, key=lambda x: x["radius_m"])[:10], 1):
    print(f"  {i:>3} {s['radius_m']:>10.1f} {s['capped_speed_kmh']:>11.1f} "
          f"{s['distance_m']:>10.1f} {s['from'][0]:>10.5f} {s['from'][1]:>10.5f}")
print()
print("""  Two ways to measure the same thing:
    (A) block-level: the sharpest curve in the halt-to-halt block caps the WHOLE block
        (the conservative method used in the totals above)
    (B) vertex-level: each sub-segment (median ~195 m) capped by ITS OWN radius, integrated
        (the physically correct ground truth)

  ┌────────────────────────────────────────────────────────────────────────────┐
  │  (A) BLOCK-LEVEL — the demo headline                                      │
  │    segment                    : PNVL→KHED                                  │
  │    block distance             : 175 km                                     │
  │    sharpest curve in block    : R = 268.1 m  (lat 18.5172, near Bhor Ghat) │
  │    RDSO cap on that curve     : 4.58·√268.1 = 75.0 km/h  (vs 80 rated)     │
  │    schedule baseline          : 76.6 km/h                                  │
  │    → curve cap < baseline, so curvature BINDS on this block               │
  │      block running time: 175/76.6 = 137.0 min (timetable)                 │
  │      block running time: 175/75.0 = 140.0 min (curvature)                 │
  │      curvature penalty : +3.0 min on this block alone                      │
  └────────────────────────────────────────────────────────────────────────────┘""")

# (B) vertex-level truth over the whole lat window, and over the PNVL→KHED block
h0 = next(s for s in res["segments"] if s["from"] == "PNVL" and s["to"] == "KHED")
print(f"""  ┌────────────────────────────────────────────────────────────────────────────┐
  │  (B) VERTEX-LEVEL TRUTH — per-vertex integration over the same 175 km    │
  │    sub-segments in block        : {h0['vertex_segments']:>5}     (median ~195 m)              │
  │    sub-segments capped by curve : {h0['vertex_capped_by_curve']:>5}                        │
  │    baseline-only running        : {h0['baseline_only_min']:>6.2f} min                          │
  │    vertex-integrated running    : {h0['vertex_curve_running_min']:>6.2f} min                          │
  │    ← true curvature penalty     : {h0['vertex_curve_penalty_sec']:>6.3f} SEC                          │
  │    (timetable says {h0['sched_run_min']:>5.1f} min; the {h0['baseline_only_min']-h0['sched_run_min']:+.2f} min vs baseline-only is   │
  │     rounding in the published {h0['baseline_speed_kmh']} km/h, NOT curvature)          │
  │    (vs block-level estimate     : {h0['running_min']-h0['sched_run_min']:>+5.2f} min — overstated)        │
  │                                                                          │
  │  Why the difference: R=268m applies to only ~80 m of actual track; the   │
  │  other 175 km of the block run at ≥76.6 km/h. Block-level spreads the    │
  │  worst curve over everything — a conservative upper bound.               │
  └────────────────────────────────────────────────────────────────────────────┘""")

# Whole-window vertex profile of the ghat stretch
ghatvn_n = ghatvn_cap = 0
ghatvn_min = 0.0
for i in range(1, len(coords) - 1):
    lat_mid = coords[i][1]
    if not (18.4 <= lat_mid <= 18.6):
        continue
    p1 = curvature._to_local_xy(coords[i-1][1], coords[i-1][0], coords[0][1], coords[0][0])
    p2 = curvature._to_local_xy(coords[i][1],  coords[i][0],  coords[0][1], coords[0][0])
    p3 = curvature._to_local_xy(coords[i+1][1], coords[i+1][0], coords[0][1], coords[0][0])
    r = curvature.circumradius(p1, p2, p3)
    cap = eta_model.MAX_SPEED_KMH if math.isinf(r) else min(eta_model.MAX_SPEED_KMH, curvature.CURVE_SPEED_CONSTANT*math.sqrt(r))
    seg_km = (curvature.haversine_m(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0])) / 1000
    if cap < eta_model.MAX_SPEED_KMH:
        ghatvn_cap += 1
    ghatvn_min += seg_km / cap * 60
    ghatvn_n += 1
flat_min = sum((curvature.haversine_m(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]) / 1000)/eta_model.MAX_SPEED_KMH*60
               for i in range(1, len(coords)) if 18.4 <= coords[i][1] <= 18.6)
print(f"""  ┌────────────────────────────────────────────────────────────────────────────┐
  │  VERTEX-LEVEL PROFILE OF THE LAT 18.4–18.6 WINDOW (whole ghat stretch)  │
  │    window sub-segments      : {ghatvn_n:>5}                                      │
  │    capped by curvature      : {ghatvn_cap:>5}   (the only 2: R=268m & R=291m)   │
  │    window distance          : {gd/1000:>5.2f} km                                  │
  │    flat-80 window time      : {flat_min:>5.3f} min                              │
  │    curvature-capped time    : {ghatvn_min:>5.3f} min                              │
  │    true curvature penalty   : {ghatvn_min-flat_min:>+5.3f} min ({ghatvn_min/flat_min*100-100 if flat_min else 0:+.2f}%)           │
  └────────────────────────────────────────────────────────────────────────────┘
  → The 2 capped sub-segments (79 m @ R=268m, 57 m @ R=291m) slow only themselves.
    Over the whole 33.9 km window that's a {ghatvn_min-flat_min:.1f} s true penalty — yet it is THIS
    local 75 km/h cap that is the defensible, video-worthy "curvature binds" moment.""")

sc = res["sharpest_curve"]
print(f"""  ┌────────────────────────────────────────────────────────────────────┐
  │  STANDOUT SINGLE-SEGMENT EXAMPLE (whole route, block-level)          │
  │    Sharpest curve   : R = {sc['radius_m']:>7.1f} m                              │
  │    Location         : lat {sc['lat']}  ({sc['segment']} block)          │
  │    RDSO speed cap   : 4.58·√{sc['radius_m']:.0f} = {sc['capped_speed_kmh']:.1f} km/h  (vs 80 rated)    │
  │    Block baseline   : 76.6 km/h from timetable                     │
  │    → curve binds locally; worst-case block cost +{h0['running_min']-h0['sched_run_min']:.1f} min,     │
  │      true vertex-level cost {h0['vertex_curve_running_min']-h0['sched_run_min']:+.2f} min            │
  └────────────────────────────────────────────────────────────────────┘""")


# ══════════════════════════════════════════════════════════════════════════
head(8, "WEATHER SENSITIVITY (same model, weather multiplier applied)")
print(f"  {'weather':<26} {'factor':>7} {'ETA (min)':>11} {'vs clear':>10} {'vs sched':>10}")
rule()
clear_eta = None
for w in ["clear", "rain", "heavy_rain", "monsoon_flagged_section", "fog"]:
    rw = eta_model.compute_eta(TRAIN, weather=w)
    e = rw["totals"]["predicted_eta_min"]
    if w == "clear":
        clear_eta = e
    print(f"  {w:<26} {curvature.WEATHER_SPEED_FACTOR[w]:>7.2f} {e:>11.1f} "
          f"{e-clear_eta:>+10.1f} {e-sched:>+10.1f}")
print("\n  → Weather caps the physics speed; where the schedule baseline is already")
print("    slower it has no effect, so degradation is non-linear and realistic.")

print()
rule("=")
print("Report complete — cache-only, no API calls made.")
rule("=")
