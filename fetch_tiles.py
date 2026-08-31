#!/usr/bin/env python3
"""
fetch_tiles.py — build the offline raster tile pack for the RailSync live map.

WHY
    The 1 Sep demo may run on weak or no wifi. `public/offline-tiles.js` serves
    each basemap tile from a local pack first and only falls back to a CDN when
    the tile is missing. This script builds that pack:

        public/tiles/<layer>/<z>/<x>/<y>.png

    Run it ONCE on a network-connected machine. It is cache-first and resumable:
    tiles already on disk are skipped, so re-running costs nothing and an
    interrupted run can simply be repeated.

TILE SOURCE — READ THIS
    Bulk-downloading tiles is forbidden by most public tile servers. This script
    therefore REFUSES to target the CDNs the live map uses online (Esri
    ArcGIS, CartoDB, OpenRailwayMap) — those are fine for interactive browsing,
    not for bundling. Use a provider whose terms permit offline/bundled caching:
    MapTiler, Stadia Maps and Thunderforest all allow it on their free tiers
    with an API key. Pass one of the keyed presets, or any permitted template
    via --url-template.

    Whatever you pick, its attribution must stay visible in the UI. The script
    prints the required attribution string at the end of a run.

EXAMPLES
    # 1. See the tile count and estimated size first (no network, no download)
    python3 fetch_tiles.py --source maptiler-streets --key KEY --dry-run

    # 2. Build it
    python3 fetch_tiles.py --source maptiler-streets --key KEY --max-zoom 11 --yes

    # 3. Any other permitted source
    python3 fetch_tiles.py --url-template 'https://example/{z}/{x}/{y}.png' \
        --layer dark --attribution '(c) Example' --yes
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from threading import Lock
from urllib.parse import urlsplit

# ── Defaults ────────────────────────────────────────────────────────────────
# Konkan Railway corridor: Mumbai (CSMT ~19.0N) → Goa → Mangalore (~12.9N),
# padded a little so panning off-route doesn't hit empty tiles immediately.
DEFAULT_BBOX = (12.5, 72.6, 19.3, 75.1)  # min_lat, min_lng, max_lat, max_lng
DEFAULT_MIN_ZOOM = 6
DEFAULT_MAX_ZOOM = 12
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "tiles")
DEFAULT_AVG_TILE_KB = 22.0  # rough PNG basemap average; satellite runs larger

USER_AGENT = "RailSync-SIH2026-offline-pack/1.0 (student project; contact via repo)"

# ── Source presets ──────────────────────────────────────────────────────────
# 'layer' is the default output directory name, chosen to line up with the layer
# names app.js requests: satellite / satellite-labels / dark / railway.
PRESETS = {
    "maptiler-satellite": {
        "url": "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}",
        "layer": "satellite",
        "needs_key": True,
        "attribution": "© MapTiler © OpenStreetMap contributors",
    },
    "maptiler-streets": {
        "url": "https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}",
        "layer": "dark",
        "needs_key": True,
        "attribution": "© MapTiler © OpenStreetMap contributors",
    },
    "maptiler-dark": {
        "url": "https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key={key}",
        "layer": "dark",
        "needs_key": True,
        "attribution": "© MapTiler © OpenStreetMap contributors",
    },
    "stadia-dark": {
        "url": "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}.png?api_key={key}",
        "layer": "dark",
        "needs_key": True,
        "attribution": "© Stadia Maps © OpenMapTiles © OpenStreetMap contributors",
    },
    "thunderforest-transport": {
        "url": "https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey={key}",
        "layer": "railway",
        "needs_key": True,
        "attribution": "Maps © Thunderforest, Data © OpenStreetMap contributors",
    },
    # Public OSM: the OSMF Tile Usage Policy discourages bulk downloading.
    # Gated below (single connection, 1s delay, hard tile cap) and only for
    # small dev packs. Prefer a keyed preset for anything real.
    "osm": {
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "layer": "dark",
        "needs_key": False,
        "attribution": "© OpenStreetMap contributors",
        "gated": True,
    },
}

# Hosts we will not bulk-download from. Bundling their tiles breaks their terms
# even though the live map is allowed to display them interactively. Matched by
# exact host or suffix, so {s}. subdomains are caught too (a.basemaps.cartocdn.com).
BLOCKED_SUFFIXES = [
    ("arcgisonline.com", "Esri ArcGIS Online (no bulk caching under Esri's terms)"),
    ("basemaps.cartocdn.com", "CARTO basemaps (no bulk caching under CARTO's terms)"),
    ("cartodb-basemaps-a.global.ssl.fastly.net", "CARTO basemaps (no bulk caching)"),
    ("tiles.openrailwaymap.org", "OpenRailwayMap volunteer tile server (no bulk downloading)"),
]

OSM_GATE_MAX_TILES = 5000

# ── Slippy-map math ─────────────────────────────────────────────────────────


def lng_to_x(lng: float, zoom: int) -> float:
    return (lng + 180.0) / 360.0 * (2 ** zoom)


def lat_to_y(lat: float, zoom: int) -> float:
    """Web-Mercator (EPSG:3857) latitude -> tile Y. Clamped to the projection's
    valid band; Mercator is undefined at the poles."""
    lat = max(min(lat, 85.05112878), -85.05112878)
    rad = math.radians(lat)
    return (1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * (2 ** zoom)


def tile_range(bbox, zoom: int):
    """Return (x_min, x_max, y_min, y_max) inclusive tile indices covering bbox."""
    min_lat, min_lng, max_lat, max_lng = bbox
    n = 2 ** zoom
    x_min = int(math.floor(lng_to_x(min_lng, zoom)))
    x_max = int(math.floor(lng_to_x(max_lng, zoom)))
    # y is inverted: max latitude gives the smaller y.
    y_min = int(math.floor(lat_to_y(max_lat, zoom)))
    y_max = int(math.floor(lat_to_y(min_lat, zoom)))
    clamp = lambda v: max(0, min(n - 1, v))  # noqa: E731
    return clamp(x_min), clamp(x_max), clamp(y_min), clamp(y_max)


def enumerate_tiles(bbox, min_zoom: int, max_zoom: int):
    for zoom in range(min_zoom, max_zoom + 1):
        x_min, x_max, y_min, y_max = tile_range(bbox, zoom)
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                yield zoom, x, y


def per_zoom_counts(bbox, min_zoom: int, max_zoom: int):
    rows = []
    for zoom in range(min_zoom, max_zoom + 1):
        x_min, x_max, y_min, y_max = tile_range(bbox, zoom)
        nx, ny = x_max - x_min + 1, y_max - y_min + 1
        rows.append((zoom, nx, ny, nx * ny, (x_min, x_max), (y_min, y_max)))
    return rows


# ── URL building ────────────────────────────────────────────────────────────


def build_url(template: str, zoom: int, x: int, y: int, key: str, subdomains: str) -> str:
    n = 2 ** zoom
    sub = subdomains[abs(x + y) % len(subdomains)] if subdomains else ""
    return (
        template.replace("{z}", str(zoom))
        .replace("{x}", str(x))
        .replace("{y}", str(y))
        .replace("{-y}", str(n - 1 - y))  # TMS-order sources
        .replace("{s}", sub)
        .replace("{r}", "")  # never request @2x: doubles pack size for no gain
        .replace("{key}", key or "")
    )


def assert_source_allowed(template: str, preset_name: str | None) -> None:
    host = (urlsplit(template.replace("{s}.", "")).hostname or "").lower()
    for suffix, reason in BLOCKED_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            sys.exit(
                f"\nRefusing to bulk-download from {suffix}.\n"
                f"  Reason: {reason}\n\n"
                "  The live map may display these tiles interactively, but caching them\n"
                "  to disk in bulk breaks the provider's terms. Use a source that permits\n"
                "  offline caching instead:\n"
                "    --source maptiler-streets --key <KEY>\n"
                "    --source stadia-dark      --key <KEY>\n"
                "    --source thunderforest-transport --key <KEY>\n"
                "  or a self-hosted render via --url-template.\n"
            )


# ── Fetching ────────────────────────────────────────────────────────────────


class Stats:
    def __init__(self) -> None:
        self.lock = Lock()
        self.done = 0
        self.skipped = 0
        self.failed = 0
        self.bytes = 0

    def bump(self, field: str, amount: int = 1) -> None:
        with self.lock:
            setattr(self, field, getattr(self, field) + amount)


def tile_path(out_dir: str, layer: str, zoom: int, x: int, y: int) -> str:
    # Local layout is ALWAYS .png/XYZ regardless of the source's extension or
    # order, because offline-tiles.js requests exactly /tiles/<layer>/z/x/y.png.
    return os.path.join(out_dir, layer, str(zoom), str(x), f"{y}.png")


def fetch_one(args, template: str, stats: Stats, tile) -> None:
    zoom, x, y = tile
    dest = tile_path(args.out, args.layer, zoom, x, y)

    # Cache-first: a non-empty existing tile is never re-fetched (resumable).
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        stats.bump("skipped")
        return

    url = build_url(template, zoom, x, y, args.key, args.subdomains)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    last_error = None
    for attempt in range(1, args.retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=args.timeout) as response:
                payload = response.read()
            if not payload:
                raise ValueError("empty response body")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            tmp = dest + ".part"
            with open(tmp, "wb") as handle:
                handle.write(payload)
            os.replace(tmp, dest)  # atomic: no half-written tile survives a Ctrl-C
            stats.bump("done")
            stats.bump("bytes", len(payload))
            if args.delay:
                time.sleep(args.delay)
            return
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}"
            # 4xx other than 429 will not fix themselves — stop retrying.
            if exc.code != 429 and 400 <= exc.code < 500:
                break
            time.sleep(min(2 ** attempt, 10))
        except Exception as exc:  # noqa: BLE001 - network/IO variety
            last_error = str(exc)
            time.sleep(min(2 ** attempt, 10))

    stats.bump("failed")
    print(f"  ! z{zoom}/{x}/{y} failed: {last_error}", file=sys.stderr)


# ── CLI ─────────────────────────────────────────────────────────────────────


def parse_bbox(text: str):
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(
            "bbox must be 'min_lat,min_lng,max_lat,max_lng'"
        )
    try:
        min_lat, min_lng, max_lat, max_lng = (float(p) for p in parts)
    except ValueError:
        raise argparse.ArgumentTypeError("bbox values must be numbers") from None
    if min_lat >= max_lat or min_lng >= max_lng:
        raise argparse.ArgumentTypeError("bbox needs min < max on both axes")
    return (min_lat, min_lng, max_lat, max_lng)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build the offline raster tile pack for the RailSync live map.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run with --dry-run first: it prints tile counts and estimated size "
        "without touching the network.",
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--source", choices=sorted(PRESETS), help="tile source preset")
    source.add_argument(
        "--url-template",
        help="explicit tile URL template using {z}/{x}/{y} (also {s}, {-y}, {key})",
    )
    parser.add_argument("--key", default="", help="provider API key, for keyed presets")
    parser.add_argument("--layer", help="output dir name under public/tiles/ (default: per preset)")
    parser.add_argument("--attribution", default="", help="attribution to print for --url-template")
    parser.add_argument("--bbox", type=parse_bbox, default=DEFAULT_BBOX,
                        help="min_lat,min_lng,max_lat,max_lng (default: Konkan corridor)")
    parser.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM)
    parser.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM)
    parser.add_argument("--out", default=DEFAULT_OUT, help="pack root (default: public/tiles)")
    parser.add_argument("--concurrency", type=int, default=4, help="parallel requests (default 4)")
    parser.add_argument("--delay", type=float, default=0.1, help="seconds between requests per worker")
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--subdomains", default="abc", help="values for a {s} token")
    parser.add_argument("--avg-tile-kb", type=float, default=DEFAULT_AVG_TILE_KB,
                        help=f"size estimate per tile (default {DEFAULT_AVG_TILE_KB:g} KB)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan and exit; makes no network requests")
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    if args.min_zoom > args.max_zoom:
        return fail("--min-zoom cannot exceed --max-zoom")
    if not 0 <= args.min_zoom <= 20 or not 0 <= args.max_zoom <= 20:
        return fail("zoom levels must be between 0 and 20")

    # ── Resolve the source ──
    preset = PRESETS.get(args.source) if args.source else None
    if preset:
        template = preset["url"]
        attribution = preset["attribution"]
        default_layer = preset["layer"]
        if preset["needs_key"] and not args.key and not args.dry_run:
            return fail(f"--source {args.source} needs --key <API_KEY>")
    elif args.url_template:
        template = args.url_template
        attribution = args.attribution
        default_layer = None
        if not args.layer:
            return fail("--url-template also needs --layer <name>")
    else:
        return fail(
            "pick a source: --source {" + ",".join(sorted(PRESETS)) + "} or --url-template\n"
            "  (see --help; --dry-run works without one only if you pass a preset)"
        )

    args.layer = args.layer or default_layer
    assert_source_allowed(template, args.source)

    # Preset NAME or a neutral placeholder — never `template`, which carries the
    # API key. pack.json is served publicly at /tiles/pack.json.
    source_label = args.source or "custom --url-template"

    rows = per_zoom_counts(args.bbox, args.min_zoom, args.max_zoom)
    total = sum(row[3] for row in rows)
    est_mb = total * args.avg_tile_kb / 1024.0

    # ── Report the plan ──
    min_lat, min_lng, max_lat, max_lng = args.bbox
    print("=" * 72)
    print("RailSync offline tile pack")
    print("=" * 72)
    print(f"  source      : {args.source or 'custom --url-template'}")
    print(f"  layer (out) : {os.path.join(args.out, args.layer)}")
    print(f"  bbox        : lat {min_lat} .. {max_lat}, lng {min_lng} .. {max_lng}")
    print(f"  zooms       : z{args.min_zoom} .. z{args.max_zoom}")
    print()
    print(f"  {'zoom':>4}  {'x range':>13}  {'y range':>13}  {'grid':>9}  {'tiles':>7}  {'est':>8}")
    print("  " + "-" * 62)
    for zoom, nx, ny, count, xr, yr in rows:
        print(
            f"  {zoom:>4}  {f'{xr[0]}-{xr[1]}':>13}  {f'{yr[0]}-{yr[1]}':>13}"
            f"  {f'{nx}x{ny}':>9}  {count:>7}  {count * args.avg_tile_kb / 1024.0:>7.1f}M"
        )
    print("  " + "-" * 62)
    print(f"  {'total':>4}  {'':>13}  {'':>13}  {'':>9}  {total:>7}  {est_mb:>7.1f}M")
    print()
    print(f"  Size is an ESTIMATE at {args.avg_tile_kb:g} KB/tile; satellite imagery runs")
    print("  larger, flat vector-derived basemaps smaller. Adjust --avg-tile-kb.")

    # Count what already exists so a resumed run reports honest remaining work.
    existing = sum(
        1
        for zoom, x, y in enumerate_tiles(args.bbox, args.min_zoom, args.max_zoom)
        if os.path.exists(tile_path(args.out, args.layer, zoom, x, y))
    )
    if existing:
        print(f"\n  {existing} of {total} tiles already on disk and will be skipped.")

    if args.dry_run:
        print("\n  --dry-run: nothing downloaded, nothing written.")
        return 0

    # ── Gate for policy-restricted sources ──
    if preset and preset.get("gated"):
        print()
        print("  ! WARNING: the OSM Foundation Tile Usage Policy discourages bulk")
        print("    downloading from tile.openstreetmap.org. Use it only for a small")
        print("    dev pack; use a keyed provider for anything you demo repeatedly.")
        if total > OSM_GATE_MAX_TILES:
            return fail(
                f"{total} tiles exceeds the {OSM_GATE_MAX_TILES}-tile cap for --source osm.\n"
                "  Lower --max-zoom, shrink --bbox, or use a keyed provider."
            )
        args.concurrency = 1
        args.delay = max(args.delay, 1.0)
        print("    Forcing --concurrency 1 and --delay 1.0 to stay polite.")

    remaining = total - existing
    if remaining == 0:
        print("\n  Pack is already complete. Nothing to do.")
        # Still (re)write the manifest — the tiles alone do nothing if pack.json
        # is missing or was deleted, since that is what enables the layer.
        manifest_path = write_manifest(args, source_label, attribution, existing)
        print(f"  Manifest refreshed: {manifest_path}")
        return 0

    if not args.yes:
        print()
        answer = input(f"  Download {remaining} tiles (~{remaining * args.avg_tile_kb / 1024.0:.1f} MB)? [y/N] ")
        if answer.strip().lower() not in {"y", "yes"}:
            print("  Aborted.")
            return 1

    # ── Fetch ──
    print(f"\n  Fetching with concurrency={args.concurrency}, delay={args.delay}s ...")
    stats = Stats()
    started = time.time()
    tiles = list(enumerate_tiles(args.bbox, args.min_zoom, args.max_zoom))

    try:
        with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
            futures = {pool.submit(fetch_one, args, template, stats, t): t for t in tiles}
            completed = 0
            for _ in as_completed(futures):
                completed += 1
                if completed % 50 == 0 or completed == len(tiles):
                    pct = completed / len(tiles) * 100
                    print(
                        f"    {completed}/{len(tiles)} ({pct:.0f}%)  "
                        f"new={stats.done} skipped={stats.skipped} failed={stats.failed}",
                        flush=True,
                    )
    except KeyboardInterrupt:
        print("\n  Interrupted. Re-run the same command to resume.", file=sys.stderr)
        return 130

    elapsed = time.time() - started
    print()
    print("=" * 72)
    print(f"  Downloaded {stats.done} tiles ({stats.bytes / 1048576.0:.1f} MB actual) "
          f"in {elapsed:.0f}s")
    print(f"  Skipped (already present): {stats.skipped}")
    print(f"  Failed: {stats.failed}")
    if stats.failed:
        print("  Re-run the same command to retry only the failures.")
    if attribution:
        print()
        print("  ATTRIBUTION — this must stay visible in the UI:")
        print(f"    {attribution}")
        print("    Add it to the layer's `attribution` option in public/app.js initMap().")

    # Register the layer so the browser serves it locally. Written even after a
    # partial run: offline-tiles.js falls back to the CDN per-tile, so gaps are
    # covered online and only truly-missing tiles show the placeholder offline.
    on_disk = existing + stats.done
    if on_disk:
        manifest_path = write_manifest(args, source_label, attribution, on_disk)
        print()
        print(f"  Wrote {manifest_path} — layer '{args.layer}' registered "
              f"(z{args.min_zoom}-z{args.max_zoom}, {on_disk} tiles).")
        print("  No code change needed: the map reads this manifest on load and")
        print(f"  caps native zoom at z{args.max_zoom}, upscaling above it instead of")
        print("  showing blank tiles offline.")
    print("=" * 72)
    return 0 if stats.failed == 0 else 1


def write_manifest(args, source_label: str, attribution: str, on_disk: int) -> str:
    """Write/merge <out>/pack.json, the manifest public/offline-tiles.js reads.

    Without this file the browser has no way to know a pack exists, so it would
    have to try a local tile first and eat a 404 for every single tile — ~350
    console errors on one page load. With it, only layers actually present are
    served locally, and `maxZoom` configures Leaflet's maxNativeZoom
    automatically (no constant to hand-edit in app.js after a build).

    Merged, not overwritten: building `dark` after `satellite` must not delete
    the satellite entry.
    """
    path = os.path.join(args.out, "pack.json")
    manifest = {"generator": "fetch_tiles.py", "layers": {}}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                existing = json.load(handle)
            if isinstance(existing.get("layers"), dict):
                manifest = existing
                manifest.setdefault("generator", "fetch_tiles.py")
        except (OSError, ValueError):
            # Corrupt manifest: start clean rather than abort the whole run.
            print("  ! existing pack.json unreadable — rewriting it from scratch.")

    manifest["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest["layers"][args.layer] = {
        "minZoom": args.min_zoom,
        "maxZoom": args.max_zoom,
        "bbox": list(args.bbox),
        "tiles": on_disk,
        "source": source_label,
        "attribution": attribution,
    }

    os.makedirs(args.out, exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)  # atomic: a torn manifest would disable the pack
    return path


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
