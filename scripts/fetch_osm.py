"""Download the OpenStreetMap road network for an area and save it as the bundled demo extract.

    python scripts/fetch_osm.py                                   # the default demo area from config/roadmind.yaml
    python scripts/fetch_osm.py --bbox 12.98 80.20 13.00 80.22    # south west north east (keep it under ~0.06 degrees)
    python scripts/fetch_osm.py --out data/osm/my_area.json       # then set network.source_file to that path

Uses the public Overpass API (please be gentle: it is a shared service). Map data (c) OpenStreetMap
contributors, ODbL. Delete backend/data/ afterwards so the new area is imported on the next start.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import load_settings  # noqa: E402
from app.services import osm  # noqa: E402


def main() -> None:
    settings = load_settings()
    cfg = settings.network
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"), default=cfg.default_bbox)
    ap.add_argument("--out", type=Path, default=settings.resolve(cfg.source_file))
    args = ap.parse_args()

    s, w, n, e = args.bbox
    if max(n - s, e - w) > cfg.max_import_span_deg:
        sys.exit(f"Area too large (limit {cfg.max_import_span_deg} degrees per side).")
    print(f"Fetching roads and places for S={s} W={w} N={n} E={e} ...")
    extract = osm.fetch_area((s, w, n, e), cfg)
    ways = osm.parse_ways(extract["roads"])
    segments = osm.split_ways(ways)
    places = osm.parse_places(extract["places"])
    osm.save_extract(args.out, extract)
    print(f"  {len(ways)} drivable ways -> {len(segments)} segments between junctions, {len(places)} named places")
    print(f"  saved to {args.out} ({args.out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
