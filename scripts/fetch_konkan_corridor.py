"""
fetch_konkan_corridor.py — Step 1-3 of the Konkan corridor dataset build.

Fetches, for every station on the corridor, the trains that HALT there
(`/stations/{code}/trains`), plus checkpoint-pair sweeps
(`/trains/between/{a}/{b}`) to catch trains that run the line WITHOUT stopping.
Those non-stopping trains matter most: they are often the highest-priority
services on the section, so they are the ones most likely to force our train
into a loop — and a station-board-only approach misses every one of them.

    python3 scripts/fetch_konkan_corridor.py --dry-run     # plan + quota, no network
    python3 scripts/fetch_konkan_corridor.py               # fetch (resumable)
    python3 scripts/fetch_konkan_corridor.py --scope konkan  # skip Mumbai suburban

RESUMABLE BY DESIGN.  Each response is written to its own file under
`.cache/corridor_raw/` the moment it arrives, and an existing file is skipped
on the next run.  A 429 or a Ctrl-C therefore costs nothing already paid for —
re-running picks up exactly where it stopped.  This is deliberate: the whole
sweep is ~134 requests against a 1,000/month quota, and one key on this project
has already been exhausted for real (CLAUDE.md 5b).

PACING.  RailRadar's binding limit is **10 requests per minute** — that ceiling,
not the monthly tier, is what every 429 in this project's history actually hit.
Default spacing is 6.5 s (~9.2 req/min).  Do not lower it to "save time": a 429
costs a cooldown far longer than the seconds saved, and burns the request anyway.

This script only FETCHES.  Merging, tagging and classification happen offline in
build_konkan_dataset.py, so re-deriving the dataset never re-spends quota.
"""
import os, sys, json, time, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---------------------------------------------------------------------------
# .env loading, and the reason this is not a one-liner.
#
# `.env` carries FIVE `RAILRADAR_API_KEY=` lines. The Node gateway reads them
# all into `apiKeys[]` and rotates; the Python client only ever takes one, and a
# plain setdefault loop hands it the FIRST line — which on this project is the
# key whose monthly allowance is already exhausted (CLAUDE.md 5b, verified
# 2026-09-04). So the keys are collected in file order and selected explicitly
# by index, and the fetch rotates to the next one on a monthly-quota wall.
#
# Key VALUES are never printed. Only a last-4 fingerprint, which is enough to
# confirm WHICH key is in use without putting a credential in the terminal.
# ---------------------------------------------------------------------------
env_path = os.path.join(ROOT, ".env")
ENV_KEYS = []
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if k == "RAILRADAR_API_KEY":
                ENV_KEYS.append(v)          # order matters — index 0 is exhausted
            else:
                os.environ.setdefault(k, v)

sys.path.insert(0, ROOT)


def fingerprint(key):
    return f"...{key[-4:]}" if key and len(key) >= 4 else "(too short)"


def is_monthly_quota(exc):
    """
    True when a 429 means the MONTHLY allowance is gone, not that we burst.

    The two failures share one status code and need opposite responses: a
    per-minute limit clears in seconds (back off), a monthly allowance does not
    reset until next month (backoff can never recover it — rotate). The only way
    to tell them apart is the upstream's own wording, and RailRadar phrases the
    reason in three different shapes, so all three are checked.
    """
    resp = getattr(exc, "response", None)
    if resp is None or resp.status_code != 429:
        return False
    try:
        body = resp.json()
    except Exception:                        # noqa: BLE001 — non-JSON body
        return "monthly quota" in (resp.text or "").lower()
    msg = ""
    err = body.get("error")
    if isinstance(err, dict):
        msg = str(err.get("message") or "")
    elif isinstance(err, str):
        msg = err
    msg = f"{msg} {body.get('message') or ''}"
    return "monthly quota" in msg.lower()

CACHE = os.path.join(ROOT, ".cache")
RAW = os.path.join(CACHE, "corridor_raw")
STATIONS_JSON = os.path.join(ROOT, "src", "data", "konkan-corridor-stations.json")

# ---------------------------------------------------------------------------
# Checkpoint selection for the non-stopping sweep.
#
# `/trains/between/A/B` returns trains running A->B whether or not they halt at
# intermediate stations, so consecutive checkpoints spanning the corridor cover
# the through traffic.  Spacing is a trade-off: too wide and a pair spans a
# junction where trains join/leave the corridor; too narrow and each extra pair
# is another request.  Every 6th station, floor of 15 pairs, is the compromise —
# and the junctions (PNVL, ROHA, MAO, and the terminus TOK) are pinned in
# regardless of where the every-6th stride happens to land, because those are
# exactly the places corridor traffic changes composition.
# ---------------------------------------------------------------------------
PINNED = ["PNVL", "ROHA", "RN", "MAO", "KAWR", "UD", "TOK"]
STRIDE = 6


def load_station_list():
    with open(STATIONS_JSON) as f:
        return json.load(f)


def pick_checkpoints(codes):
    chosen = set(codes[::STRIDE]) | {c for c in PINNED if c in codes} | {codes[0], codes[-1]}
    return [c for c in codes if c in chosen]      # keep corridor order


def raw_path(kind, key):
    return os.path.join(RAW, f"{kind}_{key}.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--dry-run", action="store_true",
                    help="print the plan and the quota estimate; make no requests")
    ap.add_argument("--scope", choices=["all", "konkan"], default="all",
                    help="'konkan' skips the Mumbai suburban stations before PNVL "
                         "(they are double line, where a meet needs no hold)")
    ap.add_argument("--spacing", type=float, default=6.5,
                    help="seconds between requests (default 6.5 = ~9.2/min, "
                         "under RailRadar's 10/min ceiling)")
    ap.add_argument("--force", action="store_true",
                    help="refetch stations already on disk (spends quota again)")
    ap.add_argument("--key-index", type=int, default=1,
                    help="which RAILRADAR_API_KEY line from .env to start on "
                         "(0-based). Defaults to 1: index 0's monthly allowance "
                         "is already exhausted on this project")
    args = ap.parse_args()

    meta = load_station_list()
    codes = [s["code"] for s in meta["stations"]]

    if args.scope == "konkan":
        i = codes.index("PNVL")
        codes = codes[i:]

    checkpoints = pick_checkpoints(codes)
    pairs = list(zip(checkpoints[:-1], checkpoints[1:]))

    os.makedirs(RAW, exist_ok=True)
    have_st = {c for c in codes if os.path.exists(raw_path("station", c))}
    have_pr = {f"{a}_{b}" for a, b in pairs if os.path.exists(raw_path("between", f"{a}_{b}"))}

    todo_st = [c for c in codes if args.force or c not in have_st]
    todo_pr = [(a, b) for a, b in pairs
               if args.force or f"{a}_{b}" not in have_pr]
    total = len(todo_st) + len(todo_pr) + 1          # +1 for the categories lookup

    print(f"Scope: {args.scope}  ({len(codes)} stations)")
    print(f"Step 2  station boards      : {len(todo_st):>4} to fetch "
          f"({len(have_st)} already cached)")
    print(f"Step 3  checkpoint pairs    : {len(todo_pr):>4} to fetch "
          f"({len(have_pr)} already cached)")
    print(f"        checkpoints         : {len(checkpoints)} -> {' '.join(checkpoints)}")
    print(f"Step 5  categories lookup   :    1")
    print(f"{'':8}{'':24}{'-'*4}")
    print(f"        ESTIMATED REQUESTS  : {total:>4}   of a 1,000/month quota "
          f"({total/10:.1f}%)")
    print(f"        at {args.spacing}s spacing        : ~{total*args.spacing/60:.0f} min wall clock")

    # Largest gap between consecutive checkpoints, in station count — a wide gap
    # is where a non-stopping train could slip through the Step 3 sweep.
    idx = [codes.index(c) for c in checkpoints]
    gaps = [(b - a, checkpoints[k], checkpoints[k+1])
            for k, (a, b) in enumerate(zip(idx[:-1], idx[1:]))]
    worst = max(gaps)
    print(f"        widest checkpoint gap: {worst[0]} stations "
          f"({worst[1]}-{worst[2]})")

    if args.dry_run:
        print("\n--dry-run: no requests made, nothing written.")
        return 0

    if total > 150:
        print(f"\nSTOP: {total} requests exceeds the 150 threshold. Narrow --scope "
              f"or fetch in batches.")
        return 1

    from railradar_client import RailRadarClient

    if not ENV_KEYS:
        # Fall back to a real exported variable — the client reads the env itself.
        if not os.environ.get("RAILRADAR_API_KEY"):
            print("\nERROR: no RAILRADAR_API_KEY in .env or the environment.")
            return 2
        keyring = [os.environ["RAILRADAR_API_KEY"]]
        start = 0
        print(f"\nKey source: RAILRADAR_API_KEY from the environment "
              f"({fingerprint(keyring[0])})")
    else:
        if not 0 <= args.key_index < len(ENV_KEYS):
            print(f"\nERROR: --key-index {args.key_index} out of range; "
                  f".env has {len(ENV_KEYS)} key(s) (0-{len(ENV_KEYS)-1}).")
            return 2
        # Rotation order starts at --key-index and wraps, but never revisits the
        # keys BEFORE it: index 0 is skipped on purpose, so wrapping back onto it
        # would spend a request that is guaranteed to 429.
        keyring = ENV_KEYS[args.key_index:]
        start = args.key_index
        print(f"\nKeys in .env: {len(ENV_KEYS)}  |  starting on index "
              f"{args.key_index} ({fingerprint(keyring[0])})  |  "
              f"{len(keyring)} available before exhaustion")
        if args.key_index > 0:
            print(f"  skipping index 0-{args.key_index-1} (exhausted monthly "
                  f"allowance — see CLAUDE.md 5b)")

    ki = 0
    try:
        client = RailRadarClient(api_key=keyring[ki])
    except ValueError as e:
        print(f"\nERROR: {e}")
        return 2

    print(f"\nFetching. Each response is written before the next request, so "
          f"Ctrl-C is safe and re-running resumes.\n")

    spent, failed = 0, []

    def paced(label, fn, out):
        """
        One request, written immediately, with the pacing sleep AFTER it.

        On a MONTHLY quota wall the key is retired and the request is retried
        once on the next key — waiting cannot recover a monthly allowance, so
        backoff would only burn the clock. A per-minute 429 is left to the
        caller's spacing, which is already under the 10/min ceiling.
        """
        nonlocal spent, ki, client
        for attempt in range(len(keyring) - ki):
            try:
                data = fn()
            except Exception as e:                   # noqa: BLE001 — report, continue
                spent += 1
                if is_monthly_quota(e) and ki + 1 < len(keyring):
                    ki += 1
                    client = RailRadarClient(api_key=keyring[ki])
                    print(f"  KEY   index {start+ki-1} hit its MONTHLY quota -> "
                          f"rotating to index {start+ki} "
                          f"({fingerprint(keyring[ki])})")
                    time.sleep(args.spacing)
                    continue                         # retry this same request
                msg = f"{type(e).__name__}: {e}"
                failed.append((label, msg))
                print(f"  FAIL  {label:<28} {msg[:70]}")
                time.sleep(args.spacing)
                return None
            with open(out, "w") as f:
                json.dump(data, f)
            spent += 1
            return data
        failed.append((label, "all keys exhausted"))
        print(f"  FAIL  {label:<28} all keys exhausted")
        return None

    for n, code in enumerate(todo_st, 1):
        d = paced(f"station {code}", lambda: client.get_station_trains(code),
                  raw_path("station", code))
        if d is not None:
            # Response shape is not documented as stable, so report what arrived
            # rather than assuming a key — the merge step parses defensively too.
            n_tr = len(d) if isinstance(d, list) else len(d.get("trains", d) or [])
            print(f"  ok    station {code:<8} {n_tr:>4} trains   "
                  f"[{n}/{len(todo_st)}, {spent} req]")
        if n < len(todo_st) or todo_pr:
            time.sleep(args.spacing)

    for n, (a, b) in enumerate(todo_pr, 1):
        key = f"{a}_{b}"
        # NOTE: `client` is looked up at CALL time, not bound as a default arg —
        # paced() may have rotated it to the next key by then.
        d = paced(f"between {a}-{b}", lambda: client.get_trains_between(a, b),
                  raw_path("between", key))
        if d is not None:
            n_tr = len(d) if isinstance(d, list) else len(d.get("trains", d) or [])
            print(f"  ok    between {key:<16} {n_tr:>4} trains   "
                  f"[{n}/{len(todo_pr)}, {spent} req]")
        time.sleep(args.spacing)

    cat_out = raw_path("lookup", "categories")
    if args.force or not os.path.exists(cat_out):
        if paced("categories", lambda: client.get_train_categories(), cat_out) is not None:
            print(f"  ok    categories lookup")

    print(f"\nRequests spent this run: {spent}  "
          f"(finished on key index {start+ki}, {fingerprint(keyring[ki])})")
    if failed:
        print(f"Failed ({len(failed)}) — re-run to retry just these:")
        for label, why in failed:
            print(f"  - {label}: {why}")
    print(f"Raw responses in {RAW}")
    print("Next (offline, no quota): python3 scripts/build_konkan_dataset.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
