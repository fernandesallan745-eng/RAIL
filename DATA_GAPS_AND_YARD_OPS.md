# Indian Railways Internal Data Gaps & Yard Operations Specification

> **GATI — SIH 2026, PS 26028**  
> *Grounded Reference on Private/Enterprise Railway Telemetry, Operational Blindspots, and GATI's Mathematical Proxy Architecture.*

---

## 1. Executive Summary: The Terminal & Yard "Dark Zone"

Traditional passenger train ETA systems (such as public NTES or commercial booking apps) model rail journeys strictly as **one-dimensional motion along a track**. They track:
$$\text{Current Position} \to \text{Line-Haul Speed} \to \text{Next Station Arrival}$$

However, in real-world Indian Railways (IR) operations, **over 35% to 50% of compounding passenger delays originate NOT on the open track**, but in:
1. **Inbound Rake Turnaround (RSA)**: Waiting for an incoming train to arrive before the outgoing train can physically exist.
2. **Coaching Yard / Pit-Line Maintenance**: Primary maintenance (PM) water refilling, electrical checking, and bio-toilet evacuation.
3. **Locomotive Reversal & Run-Around**: Engine detachment, loop-line bypass, re-coupling, and mandatory air brake continuity testing at junction stations.
4. **Crew Change Operations**: Breathalyzer sign-on/sign-off, caution order briefings, and brake-feel tests at divisional crew lobbies.
5. **Terminal Platform Clearance & Yard Throat Interlocking**: Trains held at the Outer / Home signal because preceding departures foul the ladder tracks or occupy the booked platform.

Because these operations occur in yards, lobbies, and interlocking circuits, their telemetry is locked inside proprietary CRIS (Centre for Railway Information Systems) enterprise databases and is **completely absent from public APIs**.

This document audits all non-public railway data systems, explains why they are restricted, analyzes the operational blindspots, and defines the **deterministic and stochastic proxies GATI uses to model them today**.

---

## 2. Audit of Non-Public Indian Railways Enterprise Systems

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CRIS ENTERPRISE INTRANET (RESTRICTED)                │
│                                                                        │
│   ┌───────────────┐  ┌───────────────┐  ┌──────────────────────────┐   │
│   │     COIS      │  │     ICMS      │  │           CMS            │   │
│   │ Rake Position │  │ Rake Linking  │  │   Crew Roster & Lobbies  │   │
│   │ Pit-Line Slots│  │ Spare Rakes   │  │   10h/12h Rule Safety    │   │
│   └───────┬───────┘  └───────┬───────┘  └─────────────┬────────────┘   │
│           │                  │                        │                │
│   ┌───────┴───────┐  ┌───────┴───────┐  ┌─────────────┴────────────┐   │
│   │     FOIS      │  │      TMS      │  │      RTIS (Raw 1-Hz)     │   │
│   │ Freight Slots │  │ Electronic    │  │ Unfiltered NavIC GPS     │   │
│   │ Loop Priority │  │ Interlocking  │  │ Throttle / Brake / Notch │   │
│   └───────────────┘  └───────────────┘  └──────────────────────────┘   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ PUBLIC BOUNDARY
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 PUBLIC RAILRADAR / NTES / OPEN DATA                     │
│                                                                        │
│  • Scheduled & Actual Station Timestamps (Delayed / Coarse)            │
│  • Last Known Station Code                                             │
│  • Booked Platform Number (Static, often changes on ground)            │
│  • Return Train Number (Static timetable pairing)                      │
│                                                                        │
│  MISSING: Yard movement, pit status, loco detachment, crew BA stamps,  │
│           point/switch locking, signal aspects.                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Comprehensive Breakdown of Private Data Systems

### 3.1 COIS (Coaching Operations Information System)
* **What it tracks**:
  * Real-time physical rake composition (individual coach barcodes, AC/Sleeper sequence, inspection saloon attachment).
  * Pit-line slot allocation (Washing line #1, #2, #3 schedule).
  * Primary Maintenance (PM) and Secondary Maintenance (SM) entry/exit timestamps.
  * Sick-line detachments (defective bogies, flat wheels, air-conditioning failure).
* **Why it is not public**:
  * Internal railway asset management; exposes rolling stock maintenance backlogs, safety defect flags, and depot capacities.
* **Operational Blindspot**:
  * If a rake is delayed inside the washing yard due to a water pump outage or delayed pit clearing, an external app sees the train as "Not Started" at the platform with zero explanation.
* **GATI Proxy / Heuristic**:
  * **Turnaround Invariant Rule**: Encode standard PM (360 min / 6 hours) and SM (90–120 min) time buffers. If inbound train arrives with less than the minimum maintenance window before booked departure, enforce the departure delay floor.

---

### 3.2 ICMS (Integrated Coaching Management System)
* **What it tracks**:
  * Multi-day Rake Sharing Arrangements (RSA) across train numbers (e.g., Train 12051 $\to$ 12052 $\to$ 12051).
  * "Scratch Rake" / Spare Rake deployment orders by the Chief Passenger Transportation Manager (CPTM).
  * Emergency rake diversion and short-termination orders.
* **Why it is not public**:
  * Strategic managerial control system; changes hourly during operational disruptions.
* **Operational Blindspot**:
  * If incoming train $A$ is 5 hours late, GATI would project train $B$ to depart 5 hours late. However, if CPTM attaches a "spare rake" kept in the yard sidings, train $B$ might depart right on time!
* **GATI Proxy / Heuristic**:
  * Rake Pairing Tracker with **Spare Rake Detection**: If actual platform placement or departure happens while the parent inbound rake is still en-route, flag: `"SPARE_RAKE_DEPLOYED_BY_CONTROL"`, resetting origin delay to zero.

---

### 3.3 CMS (Crew Management System)
* **What it tracks**:
  * Loco Pilot (LP), Assistant Loco Pilot (ALP), and Train Manager (Guard) rosters.
  * Breathalyzer (BA) sign-on and sign-off timestamps at station crew lobbies.
  * Statutory running duty hour limits (10-hour rule, 12-hour emergency ceiling under Railway Servants Hours of Employment Regulations - HOER).
* **Why it is not public**:
  * Confidential employee personnel data and safety compliance records.
* **Operational Blindspot**:
  * If an incoming crew runs out of duty hours while waiting in an outer loop, the train cannot move until relief crew travels to the train, causing an abrupt 45–90 minute dead halt with zero track congestion.
* **GATI Proxy / Heuristic**:
  * **Crew Change Lobby Dwell Floor**: Enforce a mandatory minimum 8–10 minute physical dwell floor at known divisional crew change hubs (e.g., Panvel `PNVL`, Ratnagiri `RN`, Madgaon `MAO`).
  * **HOER Expiry Risk Flag**: When a train accumulates $>90$ minutes of cumulative delay in a section, flag high risk of crew expiration at the next lobby.

---

### 3.4 Station Interlocking, Signal Aspects & TMS (Train Management System)
* **What it tracks**:
  * Electronic Interlocking (EI) and Route Relay Interlocking (RRI) ladder tracks at yard throats.
  * Point/switch positions (Normal vs. Reverse).
  * Signal aspects (Red, Yellow, Double Yellow, Green).
  * Track circuit and Digital Axle Counter (DAC) block occupancies.
* **Why it is not public**:
  * High-security, safety-critical signalling infrastructure. Public access to real-time switch states or interlocking routes is strictly prohibited for railway physical and cyber security.
* **Operational Blindspot**:
  * Outer signal holds: A train running at 100 km/h arrives at the yard outer boundary exactly on time, but is forced to wait 20 minutes at the Home Signal because an empty rake is shunting across the ladder tracks into the car shed.
* **GATI Proxy / Heuristic**:
  * **Terminal Platform Conflict Engine**: Model each station platform as a spatial block of capacity = 1. If Train $A$ is booked on Platform 1 until 15:10, and Train $B$ is arriving at 15:08, enforce an interlocking release buffer ($\Delta t_{\text{interlock}} \ge 4\text{ min}$) before Train $B$'s platform arrival timestamp.

---

### 3.5 RTIS (Real-Time Train Information System) High-Frequency Raw Telemetry
* **What it tracks**:
  * High-frequency (1-Hz) NavIC / GPS raw sensor packets direct from loco rooftop units.
  * Master Controller notch positions, traction motor current, regenerative brake status, and emergency brake pipe pressure drop.
* **Why it is not public**:
  * High bandwidth, raw internal telemetry stream managed between CRIS and ISRO; public APIs only receive filtered, downsampled station-arrival/departure events (RailRadar/NTES).
* **Operational Blindspot**:
  * We cannot see instantaneous acceleration curves, deceleration profiles, or whether the driver has notched up or applied dynamic brakes.
* **GATI Proxy / Heuristic**:
  * **Kinematic Curvature & Gradient Integration**: Compute the physical permissible speed ceiling ($V_{\text{curve}} = 4.58\sqrt{R}$) and historical segment run times rather than guessing instantaneous driver throttle notches.

---

### 3.6 Locomotive Link & Shunting Engine Operations
* **What it tracks**:
  * Specific locomotive assignments (e.g., WAP-7 #30452 from Kalyan Shed vs. WDG-4D from Hubli Shed).
  * Shunting engine availability in the yard.
  * Dead loco haulage and electrical pantograph testing.
* **Why it is not public**:
  * Internal traction distribution managed by the Power Controller / Chief Loco Inspector.
* **Operational Blindspot**:
  * Lack of visibility into whether a shunting loco is actively coupled to pull an empty rake from the yard onto the platform.
* **GATI Proxy / Heuristic**:
  * **Physical Locomotive Reversal Minimum**: Enforce a non-compressible **25 to 30 minute dwell floor** whenever track geometry or route sequence dictates a heading reversal ($180^\circ$ direction flip), matching RDSO standard operating rules for CBC coupling, BP/FP air charging ($5.0 / 6.0 \text{ kg/cm}^2$), and continuity drop tests.

---

## 4. Operational Comparison Matrix

| Feature / Operation | Official CRIS Enterprise System | Public Feed Availability | Impact on Traditional ETA | GATI Heuristic / Mathematical Proxy | Feasibility in GATI |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Inbound Rake Delay** | ICMS / COIS | **No** (Only static `returnTrain`) | Fails to predict origin delay; assumes train departs on time | `RakeSharingManager`: Inbound Arrival ETA + Min Turnaround Buffer $\to$ Earliest Departure | **BUILT (Phase 1)** |
| **Loco Reversal / Run-Around** | Power Controller / TMS | **No** (Only timetable halt time) | Predicts impossible 5-10 min departures when 25 min is physically required | `LocoReversalManager`: Geometric $\Delta\theta \ge 135^\circ$ + IR reversal junction table $\implies$ 25m floor | **BUILT (Phase 1)** |
| **Crew Handover Dwell** | CMS (Crew Management) | **No** (Zero crew data) | Treats divisional halts as ordinary passenger stops | `CrewChangeManager`: 8-10 min non-compressible dwell floor at divisional crew lobbies | **BUILT (Phase 1)** |
| **Terminal Platform Clearance** | TMS / Station Master Dairy | **Partial** (Booked platform only) | Trains arrive on time in model, but sit for 20m at outer signal in reality | `PlatformConflictManager`: Detects overlapping platform dwell + 4 min route release buffer | **BUILT (Phase 1)** |
| **Pit Line / Washing Line** | COIS Washing Line Module | **No** | Cannot verify if rake is physically clean or staged | Standard PM buffer (360m) / SM buffer (90m) based on train rake classification | **BUILT (Phase 1)** |
| **Dynamic Platform Change** | Station Master TMS Interlocking | **No** (Announced on PA system only) | Predicts false platform conflicts if controller reroutes train to empty loop | Fallback to multi-platform station capacity pool | **BUILT (Phase 2)** |
| **Emergency Spare Rake** | CPTM Order / ICMS | **No** | High false delay if spare rake deployed | Dynamic departure override (`SPARE_RAKE_DETECTED`) when actual departure precedes inbound | **BUILT (Phase 1)** |
| **Signal Aspect / Red Signals** | Electronic Interlocking | **Strictly Forbidden** (Safety Critical) | Misses red signal deceleration waves | Macroscopic section headway and conflict detector ([`conflict.py`](file:///Users/fernandes/code/railsync/conflict.py)) | **BUILT (Phase 5)** |

---

## 5. What We Are Building Right Now (Zero Private Data Required)

Because GATI operates under the principle of **scientific realism and data honesty**, we do not hallucinate private CRIS telemetry. Instead, we implement the deterministic physical laws and Indian Railways operating rules that govern yard and terminal operations:

1. **[`yard_operations.py`](file:///Users/fernandes/code/railsync/yard_operations.py)**:
   * **`RakeSharingManager`**: Inbound delay propagation via cached `returnTrain` linkages and standard IR turnaround buffers.
   * **`LocoReversalManager`**: Heading vector reversal detection ($\Delta \theta \ge 135^\circ$) with mandatory 25-minute brake test and run-around floors.
   * **`CrewChangeManager`**: Divisional crew change dwell enforcement (8–10 min at PNVL, RN, MAO).
   * **`PlatformConflictManager`**: Single-capacity platform block clearance model to predict outer signal holding.
2. **Integration into GATI Pipeline**:
   * Evaluated as an upstream and station-level constraint layer in [`eta_model.py`](file:///Users/fernandes/code/railsync/eta_model.py) and exposed via `/eta/{train}` API.
