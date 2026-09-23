"""
scripts/ingest_historical_corpus.py — Multi-train historical delay corpus manager.

Expands and audits the historical delay training corpus (N) for Indian Railways
trains.

Key capabilities:
1. Normalizes and promotes cached fallback runs into canonical
   .cache/{train}_live_{date}.json files.
2. Audits all cached dated runs for real-time delay signal vs zero-echo.
3. (Optional) Safely fetches missing historical dates from RailRadar API
   with strict rate-limiting and quota preservation.
4. Generates corpus health and quantile distribution summaries.
"""

import os
import sys
import glob
import json
import time
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, ".cache")

# Load environment variables from .env
env_path = os.path.join(ROOT, ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

sys.path.insert(0, ROOT)


def promote_existing_fallbacks():
    """
    Scans .cache/ for live snapshots or fallback files and promotes valid
    dated runs into canonical .cache/{train}_live_{date}.json format.
    """
    promoted = []
    
    # 1. Inspect {train}_live.json files
    for p in glob.glob(os.path.join(CACHE, "*_live.json")):
        base = os.path.basename(p)
        train = base.replace("_live.json", "")
        if not train.isdigit():
            continue
        try:
            with open(p) as f:
                d = json.load(f)
            data = d.get("data") if isinstance(d.get("data"), dict) else d
            dt = data.get("startDate")
            if dt and len(dt) == 10 and dt.startswith("20"):
                canonical = os.path.join(CACHE, f"{train}_live_{dt}.json")
                if not os.path.exists(canonical):
                    with open(canonical, "w") as fp:
                        json.dump(data, fp, indent=2)
                    promoted.append((train, dt, base, canonical))
        except Exception as e:
            print(f"Warning parsing {p}: {e}")

    # 2. Inspect train_{train}_live_fallback.json files
    for p in glob.glob(os.path.join(CACHE, "train_*_live_fallback.json")):
        base = os.path.basename(p)
        train = base.replace("train_", "").replace("_live_fallback.json", "")
        if not train.isdigit():
            continue
        try:
            with open(p) as f:
                d = json.load(f)
            data = d.get("data") if isinstance(d.get("data"), dict) else d
            dt = data.get("startDate")
            if dt and len(dt) == 10 and dt.startswith("20"):
                canonical = os.path.join(CACHE, f"{train}_live_{dt}.json")
                if not os.path.exists(canonical):
                    with open(canonical, "w") as fp:
                        json.dump(data, fp, indent=2)
                    promoted.append((train, dt, base, canonical))
        except Exception as e:
            print(f"Warning parsing {p}: {e}")

    return promoted


def audit_train_corpus(train):
    """
    Audits all dated runs for a train, distinguishing real delay actuals
    from zero-echo timetable clones.
    """
    pattern = os.path.join(CACHE, f"{train}_live_20*.json")
    files = sorted(glob.glob(pattern))
    runs = []

    for path in files:
        dt = os.path.basename(path).replace(f"{train}_live_", "").replace(".json", "")
        with open(path) as f:
            j = json.load(f)
        rt = j.get("route", [])
        halts = [s for s in rt if s.get("isHalt")]
        nz_arr = sum(1 for s in rt if s.get("delayArrival"))
        nz_dep = sum(1 for s in rt if s.get("delayDeparture"))
        mism = sum(
            1 for s in rt for a, b in [("scheduledArrival", "actualArrival"), ("scheduledDeparture", "actualDeparture")]
            if s.get(a) and s.get(b) and s[a] != s[b]
        )
        has_real_signal = bool((nz_arr or nz_dep or mism) and len(halts) >= 2 and halts[-1].get("delayArrival") is not None)
        final_delay = halts[-1].get("delayArrival") if halts else None

        runs.append({
            "date": dt,
            "status": j.get("status"),
            "tracking_mode": j.get("trackingMode"),
            "reported_delay": j.get("delayMinutes"),
            "final_delay": final_delay,
            "has_real_signal": has_real_signal,
            "halts_count": len(halts),
            "non_zero_arrivals": nz_arr,
        })

    return runs


def print_audit_summary():
    # Find all trains with any dated runs in .cache/
    all_trains = sorted({
        os.path.basename(p).split("_live_")[0]
        for p in glob.glob(os.path.join(CACHE, "*_live_20*.json"))
        if os.path.basename(p).split("_live_")[0].isdigit()
    })

    print("=" * 80)
    print(f"HISTORICAL TRAINING CORPUS AUDIT ({len(all_trains)} trains found)")
    print("=" * 80)
    print(f"{'Train':<8} {'Total (N)':<10} {'Real Signal':<14} {'Zero Echo':<12} {'Dates Available'}")
    print("-" * 80)

    total_real = 0
    total_samples = 0

    for t in all_trains:
        runs = audit_train_corpus(t)
        real_count = sum(1 for r in runs if r["has_real_signal"])
        echo_count = len(runs) - real_count
        dates_str = ", ".join(r["date"] for r in runs[:4])
        if len(runs) > 4:
            dates_str += f", +{len(runs) - 4} more"
        total_real += real_count
        total_samples += len(runs)
        badge = "✅" if real_count > 0 else "⚠️"
        print(f"{t:<8} {len(runs):<10} {real_count:<14} {echo_count:<12} {badge} {dates_str}")

    print("-" * 80)
    print(f"TOTALS: {total_samples} historical runs across {len(all_trains)} trains ({total_real} with real delay signal)\n")


def fetch_missing_dates(train, count=3):
    """
    Safely fetches missing historical completed runs for a train.
    Respects rate-limiting, handles missing credentials gracefully.
    """
    try:
        from railradar_client import RailRadarClient
        client = RailRadarClient()
    except Exception as e:
        print(f"Skipping live fetch (RailRadarClient unavailable: {e})")
        return []

    today = date.today()
    candidates = []
    # Probe past 4 weeks
    for days_ago in range(1, 28):
        dt = (today - timedelta(days=days_ago)).isoformat()
        target_file = os.path.join(CACHE, f"{train}_live_{dt}.json")
        if not os.path.exists(target_file):
            candidates.append(dt)

    to_fetch = candidates[:count]
    if not to_fetch:
        print(f"No missing candidate dates to fetch for train {train}.")
        return []

    print(f"Attempting to fetch {len(to_fetch)} missing dates for train {train}...")
    fetched = []
    for dt_str in to_fetch:
        print(f"  Fetching {train} on {dt_str}...", end=" ", flush=True)
        try:
            data = client.get_live_status(train, date=dt_str, geometry=False)
            if data and data.get("route"):
                target_file = os.path.join(CACHE, f"{train}_live_{dt_str}.json")
                with open(target_file, "w") as fp:
                    json.dump(data, fp, indent=2)
                fetched.append(dt_str)
                print("saved ✅")
            else:
                print("no data returned ⚠️")
            time.sleep(1.5)  # Rate limiting spacing
        except Exception as err:
            print(f"failed ❌ ({err})")
            break

    return fetched


if __name__ == "__main__":
    print("Promoting existing cached fallbacks into canonical dated runs...")
    promoted = promote_existing_fallbacks()
    if promoted:
        print(f"Promoted {len(promoted)} runs:")
        for t, d, src, dst in promoted:
            print(f"  Train {t} on {d} from {src}")
    else:
        print("  All cached runs are already in canonical format.")
    print()

    # Optional CLI args: python3 scripts/ingest_historical_corpus.py [train] [--fetch N]
    args = sys.argv[1:]
    train_arg = None
    fetch_n = 0
    for i, a in enumerate(args):
        if a == "--fetch" and i + 1 < len(args):
            fetch_n = int(args[i + 1])
        elif a.isdigit():
            train_arg = a

    if train_arg and fetch_n > 0:
        fetch_missing_dates(train_arg, count=fetch_n)

    print_audit_summary()
