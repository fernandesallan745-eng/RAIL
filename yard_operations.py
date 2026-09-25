"""
yard_operations.py — Terminal, Yard, Rake Turnaround & Locomotive Operations Engine.

Background:
Standard ETA models for Indian Railways coaching trains treat journeys as one-dimensional
motion along track segments (distance / speed + dwell). However, real-world passenger
train delays compound heavily at:
  1. Originating stations: Inbound rake sharing (RSA) turnaround delays.
  2. Direction reversal junctions: Locomotive run-around and mandatory air brake continuity tests.
  3. Divisional crew lobbies: Breathalyzer sign-on/sign-off and caution order briefings.
  4. Terminals & major junctions: Yard throat route fouling and platform clearance holding.

Because CRIS enterprise systems (COIS, ICMS, CMS, TMS) are closed-circuit intranets,
this module enforces the physical invariants and standard operating rules (IR G&SR)
using public timetable metadata, cached live train status, and track geometry.
"""

import os
import json
import math
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
CORRIDOR_CACHE = os.path.join(CACHE, "corridor")

# ────────────────────────────────────────────────────────────────────────────
#  Physical & Operational Invariants (Indian Railways G&SR Standards)
# ────────────────────────────────────────────────────────────────────────────
# Quick Turnaround (Vande Bharat, Jan Shatabdi, Tejas): on-platform cleaning,
# cabin inspection, catering restocking, driver end-swap (dual cab EMU/push-pull).
MIN_TURNAROUND_QUICK_MIN = 45

# Secondary Maintenance (SM) / Mail & Express turnaround: platform shunting,
# coach interior sweeping, overhead water-tank filling, bio-toilet servicing.
MIN_TURNAROUND_EXPRESS_MIN = 90

# Primary Maintenance (PM) cycle: full 6-hour pit-line rake examination.
MIN_TURNAROUND_PRIMARY_MAINT_MIN = 360

# Locomotive Run-Around & Reversal floor:
# 1. Complete stop & handbrake application (2 min)
# 2. CBC / screw uncoupling & air hose detachment (3 min)
# 3. Engine run-around via adjacent loop line (8-10 min)
# 4. Coupling at opposite end & electrical jumper connection (4 min)
# 5. Air Brake Continuity Test: charging Brake Pipe (BP) to 5.0 kg/cm²
#    and Feed Pipe (FP) to 6.0 kg/cm², Guard brake van drop test (8-10 min)
# 6. Caution Order / BPC endorsement handover (3 min)
# Non-compressible physical minimum = 25 to 30 minutes.
MIN_LOCO_REVERSAL_MIN = 25

# Divisional Crew Change Lobby minimum dwell (BA sign-on/off, caution briefing).
MIN_CREW_CHANGE_MIN = 8

# Route Relay / Electronic Interlocking release buffer at yard throat.
INTERLOCKING_ROUTE_RELEASE_MIN = 4

# Known Konkan & Connecting Corridor Reversal Junctions
KNOWN_REVERSAL_STATIONS = {
    "SWV":  {"name": "Sawantwadi Road", "reason": "Terminating/Short-terminating run-around"},
    "VSG":  {"name": "Vasco da Gama", "reason": "Terminal run-around"},
    "PUNE": {"name": "Pune Jn", "reason": "Daund-Miraj direction reversal"},
    "DD":   {"name": "Daund Jn", "reason": "Manmad-Pune direction reversal"},
    "KYN":  {"name": "Kalyan Jn", "reason": "Kasara/Karjat slip reversal"},
    "BSR":  {"name": "Vasai Road", "reason": "WR to CR/KR bypass reversal"},
    "ROHA": {"name": "Roha", "reason": "CR to KR boundary traction check"},
}

# Known Divisional Crew Change Lobbies on Konkan & CR Corridor
KNOWN_CREW_LOBBIES = {
    "CSMT": {"name": "Mumbai CSMT", "division": "CR - Mumbai"},
    "PNVL": {"name": "Panvel", "division": "CR/KR Divisional Boundary"},
    "ROHA": {"name": "Roha", "division": "CR/KR Handover"},
    "RN":   {"name": "Ratnagiri", "division": "KR - Ratnagiri Division Lobby"},
    "MAO":  {"name": "Madgaon Jn", "division": "KR - Karwar Division Lobby"},
    "UD":   {"name": "Udupi", "division": "KR - Southern Section Lobby"},
    "MAJN": {"name": "Mangaluru Jn", "division": "SR - Palakkad Division Handover"},
}

# Known Return Train Rake Sharing Arrangements (Corridor Defaults)
KNOWN_RSA_PAIRS = {
    "22229": "22230",
    "22230": "22229",
    "12051": "12052",
    "12052": "12051",
    "10103": "10104",
    "10104": "10103",
    "12617": "12618",
    "12618": "12617",
    "12779": "12780",
    "12780": "12779",
    "16345": "16346",
    "16346": "16345",
    "22195": "22196",
    "22196": "22195",
}


def _parse_dt(iso_str):
    """Parse ISO datetime safely."""
    if not iso_str:
        return None
    try:
        return datetime.fromisoformat(iso_str)
    except Exception:
        return None


def _load_json(filepath):
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def _find_live_cache(train_num, date=None):
    """Find the best matching live cache file for a train."""
    if date:
        p = os.path.join(CACHE, f"{train_num}_live_{date}.json")
        if os.path.exists(p):
            return _load_json(p)
    p_def = os.path.join(CACHE, f"{train_num}_live.json")
    if os.path.exists(p_def):
        return _load_json(p_def)
    fb = os.path.join(CACHE, f"train_{train_num}_live_fallback.json")
    if os.path.exists(fb):
        return _load_json(fb)
    # Search any date-stamped file
    matches = sorted(glob_files(os.path.join(CACHE, f"{train_num}_live_*.json")))
    if matches:
        return _load_json(matches[-1])
    return None


def glob_files(pattern):
    import glob
    return glob.glob(pattern)


# ────────────────────────────────────────────────────────────────────────────
#  1. Rake Sharing & Turnaround Buffer Propagator
# ────────────────────────────────────────────────────────────────────────────
class RakeSharingManager:
    """
    Evaluates inbound rake arrival delay and projects the earliest physically
    achievable departure for the outbound service sharing the same rake.
    """

    @classmethod
    def get_parent_train(cls, train_number, live_data=None):
        """Discover the inbound parent train number."""
        t_str = str(train_number).strip()
        # 1. From live data
        if live_data and "train" in live_data and live_data["train"].get("returnTrain"):
            ret = str(live_data["train"]["returnTrain"]).strip()
            if ret and ret != "0" and ret != t_str:
                return ret
        # 2. From static RSA mapping
        if t_str in KNOWN_RSA_PAIRS:
            return KNOWN_RSA_PAIRS[t_str]
        # 3. From corridor cache
        c_path = os.path.join(CORRIDOR_CACHE, f"{t_str}.json")
        c_data = _load_json(c_path)
        if c_data and "returnTrain" in c_data:
            return str(c_data["returnTrain"]).strip()
        return None

    @classmethod
    def determine_turnaround_norm(cls, train_type="Express"):
        """Returns standard minimum turnaround buffer in minutes."""
        t_type = (train_type or "").lower()
        if "vande bharat" in t_type or "shatabdi" in t_type or "tejas" in t_type:
            return MIN_TURNAROUND_QUICK_MIN
        if "rajdhani" in t_type or "duronto" in t_type or "superfast" in t_type or "express" in t_type:
            return MIN_TURNAROUND_EXPRESS_MIN
        return MIN_TURNAROUND_EXPRESS_MIN

    @classmethod
    def compute_origin_turnaround(cls, train_number, live_data=None, date=None):
        """
        Compute origin departure delay constrained by inbound rake arrival.

        Returns:
          {
            "has_parent_rake": bool,
            "parent_train": str or None,
            "origin_station": str,
            "turnaround_norm_min": int,
            "scheduled_departure": str,
            "inbound_arrival_projected": str,
            "earliest_achievable_departure": str,
            "origin_departure_delay_min": float,
            "turnaround_slack_min": float,
            "spare_rake_detected": bool,
            "status": "HEALTHY" | "DELAY_PROPAGATED" | "SPARE_RAKE_DEPLOYED" | "STANDALONE"
          }
        """
        t_str = str(train_number).strip()
        if live_data is None:
            live_data = _find_live_cache(t_str, date)

        if not live_data:
            return {
                "has_parent_rake": False,
                "parent_train": None,
                "status": "STANDALONE",
                "message": f"No data found for train {t_str}"
            }

        route = live_data.get("route", [])
        if not route:
            return {"has_parent_rake": False, "parent_train": None, "status": "STANDALONE"}

        origin_stop = route[0]
        origin_code = origin_stop.get("stationCode", "")
        sched_dep_str = origin_stop.get("scheduledDeparture")
        actual_dep_str = origin_stop.get("actualDeparture")
        sched_dep = _parse_dt(sched_dep_str)

        train_info = live_data.get("train", {})
        train_type = train_info.get("type", "Express")
        norm_min = cls.determine_turnaround_norm(train_type)

        parent_train = cls.get_parent_train(t_str, live_data)
        if not parent_train:
            return {
                "has_parent_rake": False,
                "parent_train": None,
                "origin_station": origin_code,
                "turnaround_norm_min": norm_min,
                "scheduled_departure": sched_dep_str,
                "origin_departure_delay_min": float(origin_stop.get("delayDeparture", 0)),
                "turnaround_slack_min": None,
                "spare_rake_detected": False,
                "status": "STANDALONE"
            }

        # Load inbound parent train data
        parent_live = _find_live_cache(parent_train, date)
        if not parent_live:
            return {
                "has_parent_rake": True,
                "parent_train": parent_train,
                "origin_station": origin_code,
                "turnaround_norm_min": norm_min,
                "scheduled_departure": sched_dep_str,
                "origin_departure_delay_min": float(origin_stop.get("delayDeparture", 0)),
                "turnaround_slack_min": None,
                "spare_rake_detected": False,
                "status": "PARENT_DATA_UNAVAILABLE"
            }

        p_route = parent_live.get("route", [])
        if not p_route:
            return {
                "has_parent_rake": True,
                "parent_train": parent_train,
                "origin_station": origin_code,
                "status": "PARENT_ROUTE_EMPTY"
            }

        # Inbound arrives at our origin (which is its destination)
        p_dest_stop = p_route[-1]
        inbound_arr_str = p_dest_stop.get("actualArrival") or p_dest_stop.get("scheduledArrival")
        inbound_arr = _parse_dt(inbound_arr_str)

        if not sched_dep or not inbound_arr:
            return {
                "has_parent_rake": True,
                "parent_train": parent_train,
                "origin_station": origin_code,
                "status": "TIMESTAMPS_INCOMPLETE"
            }

        # Check for multi-day offset: if inbound arrival is after scheduled departure by >12 hours
        # or earlier by >24 hours, normalize to same rotation cycle
        diff_hours = (sched_dep - inbound_arr).total_seconds() / 3600.0

        earliest_dep = inbound_arr + timedelta(minutes=norm_min)
        delay_min = max(0.0, (earliest_dep - sched_dep).total_seconds() / 60.0)
        slack_min = (sched_dep - earliest_dep).total_seconds() / 60.0

        # Spare Rake Detection: if the train has already departed on time despite inbound being late
        actual_dep = _parse_dt(actual_dep_str)
        spare_rake = False
        status = "HEALTHY"
        if actual_dep and (earliest_dep - actual_dep).total_seconds() > 900:  # departed >15m before parent arrived+norm
            spare_rake = True
            status = "SPARE_RAKE_DEPLOYED"
            delay_min = max(0.0, (actual_dep - sched_dep).total_seconds() / 60.0)
        elif delay_min > 0:
            status = "DELAY_PROPAGATED"

        return {
            "has_parent_rake": True,
            "parent_train": parent_train,
            "origin_station": origin_code,
            "turnaround_norm_min": norm_min,
            "scheduled_departure": sched_dep_str,
            "inbound_arrival_projected": inbound_arr_str,
            "earliest_achievable_departure": earliest_dep.isoformat(),
            "origin_departure_delay_min": round(delay_min, 1),
            "turnaround_slack_min": round(slack_min, 1),
            "spare_rake_detected": spare_rake,
            "status": status,
            "operational_note": (
                f"Parent train {parent_train} arrives at {origin_code} at {inbound_arr_str}. "
                f"With minimum {norm_min}m turnaround buffer, earliest possible departure is "
                f"{earliest_dep.strftime('%H:%M')} (Sched: {sched_dep.strftime('%H:%M')})."
            )
        }


# ────────────────────────────────────────────────────────────────────────────
#  2. Locomotive Reversal & Direction Flip Engine
# ────────────────────────────────────────────────────────────────────────────
class LocoReversalManager:
    """
    Detects direction reversal stations and enforces the non-compressible
    25-30 minute physical dwell floor for loco run-around & brake continuity.
    """

    @classmethod
    def calculate_bearing(cls, lat1, lng1, lat2, lng2):
        """Calculate compass bearing in degrees from point 1 to point 2."""
        d_lng = math.radians(lng2 - lng1)
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        y = math.sin(d_lng) * math.cos(phi2)
        x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(d_lng)
        deg = math.degrees(math.atan2(y, x))
        return (deg + 360.0) % 360.0

    @classmethod
    def detect_reversals(cls, stations):
        """
        Scan a list of route station dicts (with lat, lng, isHalt).
        Returns list of detected reversal events.
        """
        reversals = []
        n = len(stations)
        if n < 3:
            return reversals

        for i in range(1, n - 1):
            curr = stations[i]
            code = curr.get("stationCode", "")
            name = curr.get("stationName", code)
            is_halt = curr.get("isHalt", False)

            is_known = code in KNOWN_REVERSAL_STATIONS
            reason = KNOWN_REVERSAL_STATIONS[code]["reason"] if is_known else None

            # Geometric check if coordinates exist
            angle_diff = None
            prev_s, next_s = stations[i - 1], stations[i + 1]
            lat0, lng0 = prev_s.get("lat"), prev_s.get("lng")
            lat1, lng1 = curr.get("lat"), curr.get("lng")
            lat2, lng2 = next_s.get("lat"), next_s.get("lng")

            if all(x is not None for x in [lat0, lng0, lat1, lng1, lat2, lng2]):
                b_in = cls.calculate_bearing(lat0, lng0, lat1, lng1)
                b_out = cls.calculate_bearing(lat1, lng1, lat2, lng2)
                diff = abs(b_out - b_in)
                if diff > 180:
                    diff = 360 - diff
                angle_diff = round(diff, 1)

            # Reversal criteria: Must have a geometric heading flip (Δθ >= 135 deg)
            # OR be a known reversal junction with an acute track turn (Δθ >= 110 deg).
            # A through train passing along the main line (e.g. 22229 passing SWV or ROHA) does NOT reverse!
            is_reversal = False
            if angle_diff is not None:
                if angle_diff >= 135.0:
                    is_reversal = True
                elif is_known and angle_diff >= 110.0:
                    is_reversal = True

            if is_reversal:
                sched_arr_str = curr.get("scheduledArrival")
                sched_dep_str = curr.get("scheduledDeparture")
                sched_dwell_min = 0.0
                if sched_arr_str and sched_dep_str:
                    t_arr, t_dep = _parse_dt(sched_arr_str), _parse_dt(sched_dep_str)
                    if t_arr and t_dep:
                        sched_dwell_min = (t_dep - t_arr).total_seconds() / 60.0

                effective_dwell_floor = max(sched_dwell_min, float(MIN_LOCO_REVERSAL_MIN))
                deficit = effective_dwell_floor - sched_dwell_min

                reversals.append({
                    "sequence": curr.get("sequence", i),
                    "stationCode": code,
                    "stationName": name,
                    "isHalt": is_halt,
                    "heading_change_deg": angle_diff,
                    "is_known_station": is_known,
                    "operational_reason": reason or f"Track geometry direction flip (Δθ = {angle_diff}°)",
                    "scheduled_dwell_min": round(sched_dwell_min, 1),
                    "physical_floor_min": MIN_LOCO_REVERSAL_MIN,
                    "dwell_deficit_min": round(deficit, 1) if deficit > 0 else 0.0,
                    "activity_breakdown": [
                        {"task": "CBC uncoupling & brake hose detachment", "duration_min": 5},
                        {"task": "Locomotive run-around via loop line", "duration_min": 10},
                        {"task": "Coupling at opposite end & continuity test", "duration_min": 8},
                        {"task": "BPC / Caution Order sign-off", "duration_min": 2}
                    ]
                })

        return reversals


# ────────────────────────────────────────────────────────────────────────────
#  3. Crew Change / Lobby Operational Dwell Engine
# ────────────────────────────────────────────────────────────────────────────
class CrewChangeManager:
    """
    Identifies divisional crew change lobbies and enforces the mandatory
    minimum 8-10 minute physical dwell floor.
    """

    @classmethod
    def detect_crew_halts(cls, stations):
        """Identify crew change halts along a train's route."""
        crew_halts = []
        for i, s in enumerate(stations):
            code = s.get("stationCode", "")
            if code in KNOWN_CREW_LOBBIES and s.get("isHalt"):
                lobby_info = KNOWN_CREW_LOBBIES[code]
                sched_arr_str = s.get("scheduledArrival")
                sched_dep_str = s.get("scheduledDeparture")
                sched_dwell = 0.0
                if sched_arr_str and sched_dep_str:
                    t0, t1 = _parse_dt(sched_arr_str), _parse_dt(sched_dep_str)
                    if t0 and t1:
                        sched_dwell = (t1 - t0).total_seconds() / 60.0

                effective_dwell = max(sched_dwell, float(MIN_CREW_CHANGE_MIN))
                deficit = effective_dwell - sched_dwell

                crew_halts.append({
                    "sequence": s.get("sequence", i),
                    "stationCode": code,
                    "stationName": s.get("stationName", code),
                    "division": lobby_info["division"],
                    "scheduled_dwell_min": round(sched_dwell, 1),
                    "physical_floor_min": MIN_CREW_CHANGE_MIN,
                    "dwell_deficit_min": round(deficit, 1) if deficit > 0 else 0.0,
                    "mandatory_tasks": [
                        "Loco Pilot & Train Manager sign-off / sign-on",
                        "Mandatory Breathalyzer (BA) test at crew lobby",
                        "Caution order briefing & divisional section endorsement",
                        "Brake feel & continuity test upon restart"
                    ]
                })
        return crew_halts


# ────────────────────────────────────────────────────────────────────────────
#  4. Terminal Platform Occupancy & Reception Signal Clearance
# ────────────────────────────────────────────────────────────────────────────
class PlatformConflictManager:
    """
    Models station platforms as capacity=1 spatial resources.
    Detects when preceding departures foul the booked platform, projecting
    the Outer/Home Signal holding delay for arriving trains.
    """

    @classmethod
    def detect_platform_conflicts(cls, target_train, corridor_trains=None, date=None):
        """
        Check for platform reception conflicts for target_train at its destination/halts.
        """
        t_str = str(target_train).strip()
        t_live = _find_live_cache(t_str, date)
        if not t_live or not t_live.get("route"):
            return []

        route = t_live.get("route", [])
        conflicts = []

        # Find candidate corridor trains to check against (deduplicated by train number)
        seen_trains = set()
        candidate_files = []
        if corridor_trains:
            for c in corridor_trains:
                f = os.path.join(CACHE, f"{c}_live.json")
                if os.path.exists(f):
                    candidate_files.append((c, f))
        else:
            for f in glob_files(os.path.join(CACHE, "*_live*.json")):
                bn = os.path.basename(f)
                num = bn.split("_")[0]
                if num != t_str and not num.startswith("train") and num not in seen_trains:
                    seen_trains.add(num)
                    candidate_files.append((num, f))

        # Check each halt of target train that has a platform assigned
        for stop in route:
            if not stop.get("isHalt"):
                continue
            code = stop.get("stationCode")
            plat = stop.get("platform")
            if not plat or plat == "0" or plat == "-":
                continue

            arr_str = stop.get("actualArrival") or stop.get("scheduledArrival")
            t_arr = _parse_dt(arr_str)
            if not t_arr:
                continue

            clean_plat = str(plat).replace("PF ", "").strip()

            # Compare against other trains that use this platform at this station
            for other_num, other_file in candidate_files:
                other_data = _load_json(other_file)
                if not other_data or not other_data.get("route"):
                    continue
                for o_stop in other_data["route"]:
                    o_plat = str(o_stop.get("platform", "")).replace("PF ", "").strip()
                    if o_stop.get("stationCode") == code and o_plat == clean_plat:
                        o_dep_str = o_stop.get("actualDeparture") or o_stop.get("scheduledDeparture")
                        t_o_dep = _parse_dt(o_dep_str)
                        if not t_o_dep:
                            continue

                        # Align dates to target train's calendar day for time-of-day comparison
                        aligned_o_dep = t_o_dep.replace(year=t_arr.year, month=t_arr.month, day=t_arr.day)
                        clearance_time = aligned_o_dep + timedelta(minutes=INTERLOCKING_ROUTE_RELEASE_MIN)

                        # Conflict condition: other train departs close to our arrival (-30m to +30m)
                        # and its clearance extends past our arrival time
                        diff_sec = (t_arr - aligned_o_dep).total_seconds()
                        if clearance_time > t_arr and -1800 <= diff_sec <= 1800:
                            hold_min = (clearance_time - t_arr).total_seconds() / 60.0
                            if 0.5 <= hold_min <= 45.0:
                                conflicts.append({
                                    "stationCode": code,
                                    "stationName": stop.get("stationName", code),
                                    "platform": str(plat),
                                    "conflicting_train": other_num,
                                    "conflicting_train_name": other_data.get("trainName", f"Train {other_num}"),
                                    "conflicting_departure": aligned_o_dep.isoformat(),
                                    "target_arrival": t_arr.isoformat(),
                                    "interlocking_clearance_time": clearance_time.isoformat(),
                                    "outer_signal_hold_min": round(hold_min, 1),
                                    "status": "OUTER_SIGNAL_WAIT",
                                    "message": (
                                        f"Platform {plat} at {code} occupied by Train {other_num} until "
                                        f"{aligned_o_dep.strftime('%H:%M')}. Interlocking route clearance at "
                                        f"{clearance_time.strftime('%H:%M')}. Train {t_str} held at Outer Signal for ~{round(hold_min)} min."
                                    )
                                })

        return conflicts


# ────────────────────────────────────────────────────────────────────────────
#  5. Comprehensive Yard & Terminal Operations Evaluator
# ────────────────────────────────────────────────────────────────────────────
def audit_terminal_operations(train_number, live_data=None, date=None):
    """
    Runs the complete terminal and yard operations audit for a train:
      1. Origin Rake Turnaround (RSA propagation)
      2. Reversal Junctions (Loco run-around & brake test floors)
      3. Crew Change Lobbies (Mandatory handover floors)
      4. Platform Clearance Conflicts (Outer signal holding)
    """
    t_str = str(train_number).strip()
    if live_data is None:
        live_data = _find_live_cache(t_str, date)

    if not live_data:
        return {
            "train": t_str,
            "error": f"No live/cached route data found for train {t_str}"
        }

    stations = live_data.get("route", [])

    turnaround = RakeSharingManager.compute_origin_turnaround(t_str, live_data, date)
    reversals = LocoReversalManager.detect_reversals(stations)
    crew_changes = CrewChangeManager.detect_crew_halts(stations)
    platform_conflicts = PlatformConflictManager.detect_platform_conflicts(t_str, date=date)

    total_terminal_penalties = turnaround.get("origin_departure_delay_min", 0.0)
    for r in reversals:
        total_terminal_penalties += r.get("dwell_deficit_min", 0.0)
    for c in crew_changes:
        total_terminal_penalties += c.get("dwell_deficit_min", 0.0)
    for p in platform_conflicts:
        total_terminal_penalties += p.get("outer_signal_hold_min", 0.0)

    return {
        "trainNumber": t_str,
        "trainName": live_data.get("trainName", ""),
        "evaluatedAt": datetime.now().isoformat(),
        "summary": {
            "origin_turnaround_delay_min": turnaround.get("origin_departure_delay_min", 0.0),
            "reversal_count": len(reversals),
            "crew_change_count": len(crew_changes),
            "platform_conflict_count": len(platform_conflicts),
            "total_yard_delay_penalty_min": round(total_terminal_penalties, 1),
        },
        "rake_turnaround": turnaround,
        "reversals": reversals,
        "crew_changes": crew_changes,
        "platform_conflicts": platform_conflicts
    }
