"""OpenStreetMap road network: fetch (Overpass API), parse, split at junctions and store.

Map data (c) OpenStreetMap contributors, available under the Open Database Licence (ODbL).

The network is the BASE LAYER. Importing it creates road segments with no RoadMind condition data
(`has_data` false = UNKNOWN); condition information is added later, only where reports exist.
"""

from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import NetworkConfig, Settings
from ..geo import SegmentIndex, polyline_length_m
from ..models import NetworkArea, Place, Repair, Road, RoadReport
from . import road_classes

log = logging.getLogger("roadmind.osm")

ATTRIBUTION = "Map data (c) OpenStreetMap contributors (ODbL)"
USER_AGENT = "RoadMind-AI/1.0 (college project)"

DRIVABLE = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|"
    "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
)
SKIPPED_SERVICE = {"parking_aisle", "driveway", "drive-through"}
FACILITY_KINDS = {"school", "hospital", "college", "university", "clinic"}
PLACE_AMENITIES = "hospital|clinic|college|university|school|bus_station"
FACILITY_RADIUS_M = 260.0


class NetworkImportError(RuntimeError):
    """The road network could not be fetched or imported (offline, rate-limited, area too large...)."""


# ------------------------------------------------------------------ data classes
@dataclass
class WaySpec:
    id: int
    nodes: list[int]
    coords: list[tuple[float, float]]
    name: str
    highway: str
    oneway: int  # 0 two-way, 1 forward, -1 reverse (normalised to forward later)


@dataclass
class SegmentSpec:
    way_id: int
    seq: int
    node_a: int
    node_b: int
    coords: list[tuple[float, float]]
    name: str
    highway: str
    oneway: int  # 0 or 1 (reverse ways are flipped so 1 always means "in geometry order")


@dataclass
class ImportResult:
    ways: int = 0
    segments_added: int = 0
    segments_replaced: int = 0
    segments_kept: int = 0
    places_added: int = 0
    notes: list[str] = field(default_factory=list)


# --------------------------------------------------------------------- fetching
def roads_query(bbox: tuple[float, float, float, float]) -> str:
    s, w, n, e = bbox
    return f'[out:json][timeout:90];way["highway"~"^({DRIVABLE})$"]({s},{w},{n},{e});out geom;'


def places_query(bbox: tuple[float, float, float, float]) -> str:
    s, w, n, e = bbox
    box = f"({s},{w},{n},{e})"
    return (
        f'[out:json][timeout:60];(nw["amenity"~"^({PLACE_AMENITIES})$"]["name"]{box};'
        f'nw["railway"="station"]["name"]{box};nw["amenity"="marketplace"]["name"]{box};'
        f'nw["shop"="mall"]["name"]{box};);out center;'
    )


def fetch_overpass(query: str, urls: Iterable[str], timeout_s: float) -> dict:
    """POST an Overpass query, trying each mirror in turn."""
    errors = []
    for url in urls:
        try:
            resp = httpx.post(url, data={"data": query}, timeout=timeout_s, headers={"User-Agent": USER_AGENT})
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            errors.append(f"{url}: {exc}")
    raise NetworkImportError("Could not reach the OpenStreetMap data service (" + "; ".join(errors) + ")")


def fetch_area(bbox: tuple[float, float, float, float], cfg: NetworkConfig, timeout_s: float | None = None) -> dict:
    """Download roads and places for a bounding box (south, west, north, east) as one cacheable extract."""
    timeout = timeout_s or cfg.overpass_timeout_s
    roads = fetch_overpass(roads_query(bbox), cfg.overpass_urls, timeout)
    try:
        places = fetch_overpass(places_query(bbox), cfg.overpass_urls, timeout)
    except NetworkImportError:
        places = {"elements": []}  # places are optional; the road network is what matters
    return {
        "bbox": list(bbox),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "attribution": ATTRIBUTION,
        "roads": roads,
        "places": places,
    }


# ----------------------------------------------------------------------- parsing
def _oneway(tags: dict) -> int:
    v = str(tags.get("oneway", "")).lower()
    if v in ("yes", "true", "1"):
        return 1
    if v in ("-1", "reverse"):
        return -1
    if tags.get("junction") in ("roundabout", "circular"):
        return 1
    if v == "" and str(tags.get("highway", "")).startswith("motorway"):
        return 1
    return 0


def parse_ways(overpass: dict) -> list[WaySpec]:
    """Drivable ways with full geometry. Ways closed to motor traffic are skipped."""
    out = []
    for el in overpass.get("elements", []):
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        highway = tags.get("highway", "")
        nodes, geom = el.get("nodes") or [], el.get("geometry") or []
        if highway not in DRIVABLE.split("|") or len(nodes) < 2 or len(nodes) != len(geom) or any(g is None for g in geom):
            continue
        if tags.get("access") in ("no", "private") or tags.get("motor_vehicle") in ("no", "private"):
            continue
        if highway == "service" and tags.get("service") in SKIPPED_SERVICE:
            continue
        out.append(
            WaySpec(
                id=int(el["id"]),
                nodes=[int(n) for n in nodes],
                coords=[(float(g["lat"]), float(g["lon"])) for g in geom],
                name=(tags.get("name:en") or tags.get("name") or tags.get("ref") or "").strip(),
                highway=highway,
                oneway=_oneway(tags),
            )
        )
    return out


def split_ways(ways: list[WaySpec]) -> list[SegmentSpec]:
    """Cut every way at junctions (nodes shared with another way, or reused by the same way) so each
    segment runs between two intersections or dead ends."""
    uses: Counter[int] = Counter()
    for w in ways:
        uses.update(w.nodes)
    segments = []
    for w in ways:
        cut = [0] + [i for i in range(1, len(w.nodes) - 1) if uses[w.nodes[i]] >= 2] + [len(w.nodes) - 1]
        for seq, (i, j) in enumerate(zip(cut, cut[1:])):
            coords, na, nb, oneway = w.coords[i : j + 1], w.nodes[i], w.nodes[j], w.oneway
            if len(coords) < 2 or coords[0] == coords[-1] and len(coords) < 3:
                continue
            if oneway == -1:  # normalise: geometry always runs in the direction of travel
                coords, na, nb, oneway = coords[::-1], nb, na, 1
            segments.append(SegmentSpec(w.id, seq, na, nb, coords, w.name, w.highway, oneway))
    return segments


def parse_places(overpass: dict) -> list[dict]:
    out = []
    for el in overpass.get("elements", []):
        tags = el.get("tags") or {}
        name = (tags.get("name:en") or tags.get("name") or "").strip()
        lat = el.get("lat") if el.get("type") == "node" else (el.get("center") or {}).get("lat")
        lng = el.get("lon") if el.get("type") == "node" else (el.get("center") or {}).get("lon")
        if not name or lat is None or lng is None:
            continue
        kind = tags.get("amenity") or ("station" if tags.get("railway") == "station" else "mall" if tags.get("shop") == "mall" else "place")
        if kind == "bus_station":
            kind = "station"
        out.append({"osm_id": f"{el['type']}/{el['id']}", "name": name[:160], "kind": kind, "lat": float(lat), "lng": float(lng)})
    return out


def zone_for(lat: float, lng: float, bbox: tuple[float, float, float, float]) -> str:
    """Coarse compass zone inside the imported area (for the 'damage by location' chart)."""
    s, w, n, e = bbox
    r, c = (lat - s) / max(n - s, 1e-9), (lng - w) / max(e - w, 1e-9)
    ns = "South" if r < 1 / 3 else "North" if r >= 2 / 3 else ""
    ew = "West" if c < 1 / 3 else "East" if c >= 2 / 3 else ""
    return f"{ns}-{ew}" if ns and ew else (ns or ew or "Central")


# ----------------------------------------------------------------------- storing
def _bounds(coords) -> tuple[float, float, float, float]:
    lats = [p[0] for p in coords]
    lngs = [p[1] for p in coords]
    return min(lats), max(lats), min(lngs), max(lngs)


def _make_road(seg: SegmentSpec, bbox, cfg: NetworkConfig) -> Road:
    _, traffic, age = road_classes.defaults_for(seg.highway)
    mid = seg.coords[len(seg.coords) // 2]
    lo_lat, hi_lat, lo_lng, hi_lng = _bounds(seg.coords)
    return Road(
        name=road_classes.display_name(seg.name, seg.highway)[:160],
        zone=zone_for(mid[0], mid[1], bbox),
        highway=seg.highway,
        oneway=seg.oneway,
        geometry=[[round(a, 6), round(b, 6)] for a, b in seg.coords],
        length_m=round(polyline_length_m(seg.coords), 1),
        osm_way_id=seg.way_id,
        osm_seq=seg.seq,
        node_a=seg.node_a,
        node_b=seg.node_b,
        min_lat=lo_lat, max_lat=hi_lat, min_lng=lo_lng, max_lng=hi_lng,
        age_years=age,
        daily_traffic=traffic,
        rainfall_mm_30d=cfg.default_rainfall_mm,
        source="osm",
    )


def _chunks(items: list, n: int = 500):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def import_extract(db: Session, settings: Settings, extract: dict) -> ImportResult:
    """Store an Overpass extract: road segments, places, and the number of schools/hospitals near each new road."""
    cfg = settings.network
    bbox = tuple(float(v) for v in extract["bbox"])
    result = ImportResult()
    ways = parse_ways(extract.get("roads") or {})
    segments = split_ways(ways)
    result.ways = len(ways)

    by_way: dict[int, list[SegmentSpec]] = defaultdict(list)
    for s in segments:
        by_way[s.way_id].append(s)

    existing: dict[int, list[Road]] = defaultdict(list)
    for chunk in _chunks(list(by_way)):
        for road in db.scalars(select(Road).where(Road.osm_way_id.in_(chunk))):
            existing[road.osm_way_id].append(road)
    old_ids = [r.id for rows in existing.values() for r in rows]
    referenced: set[int] = set()
    for chunk in _chunks(old_ids):
        referenced |= set(db.scalars(select(RoadReport.road_id).where(RoadReport.road_id.in_(chunk))))
        referenced |= set(db.scalars(select(Repair.road_id).where(Repair.road_id.in_(chunk))))

    new_roads: list[Road] = []
    for way_id, segs in by_way.items():
        old = existing.get(way_id)
        if old:
            same = {(r.osm_seq, r.node_a, r.node_b) for r in old} == {(s.seq, s.node_a, s.node_b) for s in segs}
            if same:
                result.segments_kept += len(old)
                continue
            if any(r.id in referenced for r in old):  # never discard geometry that carries RoadMind data
                result.segments_kept += len(old)
                continue
            for r in old:
                db.delete(r)
            db.flush()
            result.segments_replaced += len(old)
        new_roads.extend(_make_road(s, bbox, cfg) for s in segs)
    db.add_all(new_roads)
    db.flush()
    result.segments_added = len(new_roads)

    known = set(db.scalars(select(Place.osm_id)))
    places = [p for p in parse_places(extract.get("places") or {}) if p["osm_id"] not in known]
    seen: set[str] = set()
    for p in places:
        if p["osm_id"] not in seen:
            db.add(Place(**p))
            seen.add(p["osm_id"])
    result.places_added = len(seen)
    db.flush()

    _count_facilities(db, new_roads, [p for p in parse_places(extract.get("places") or {}) if p["kind"] in FACILITY_KINDS])
    db.add(NetworkArea(south=bbox[0], west=bbox[1], north=bbox[2], east=bbox[3], segments=len(new_roads), source=extract.get("source", "overpass")))
    db.commit()
    return result


def _count_facilities(db: Session, roads: list[Road], facilities: list[dict]) -> None:
    """Schools, hospitals and colleges within ~260 m of each new road (feeds the priority score)."""
    if not roads or not facilities:
        return
    index = SegmentIndex([(r.id, r.geometry) for r in roads])
    counts: Counter[int] = Counter()
    pts = np.array([[f["lat"], f["lng"]] for f in facilities])
    # chunk the points so the (points x segments) distance matrix stays small on big imports
    for start in range(0, len(pts), 40):
        d = index.distances(pts[start : start + 40])
        for row in d:
            counts.update(int(i) for i in np.unique(index.road_ids[row <= FACILITY_RADIUS_M]))
    by_id = {r.id: r for r in roads}
    for rid, n in counts.items():
        by_id[rid].facilities_nearby = n
    db.flush()


# -------------------------------------------------------------- high-level entry points
def covered(db: Session, bbox: tuple[float, float, float, float]) -> bool:
    s, w, n, e = bbox
    return db.scalar(
        select(func.count(NetworkArea.id)).where(NetworkArea.south <= s, NetworkArea.west <= w, NetworkArea.north >= n, NetworkArea.east >= e)
    ) > 0


def ensure_network(db: Session, settings: Settings) -> ImportResult | None:
    """On first start load the bundled extract (or, failing that, fetch the default area)."""
    if db.scalar(select(func.count(Road.id)).where(Road.source == "osm")):
        return None
    cfg = settings.network
    path = settings.resolve(cfg.source_file)
    if path.exists():
        extract = json.loads(path.read_text(encoding="utf-8"))
        extract["source"] = "file"
        log.info("Importing OpenStreetMap road network from %s", path)
        return import_extract(db, settings, extract)
    if cfg.remote_enabled:
        try:
            log.info("No bundled extract at %s - fetching the default area from OpenStreetMap...", path)
            extract = fetch_area(tuple(cfg.default_bbox), cfg)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(extract), encoding="utf-8")
            except OSError:
                pass
            return import_extract(db, settings, extract)
        except NetworkImportError as exc:
            log.warning("Road network unavailable: %s", exc)
    return None


def import_bbox(db: Session, settings: Settings, bbox: tuple[float, float, float, float], *, timeout_s: float | None = None) -> ImportResult:
    """Import the network for an area from OpenStreetMap (skipped if the area is already loaded)."""
    cfg = settings.network
    s, w, n, e = bbox
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise NetworkImportError("Invalid area.")
    if max(n - s, e - w) > cfg.max_import_span_deg:
        raise NetworkImportError(f"That area is too large to import at once (limit {cfg.max_import_span_deg} degrees per side). Zoom in and try again.")
    if covered(db, bbox):
        return ImportResult(notes=["already loaded"])
    if not cfg.remote_enabled:
        raise NetworkImportError("Importing new areas is disabled on this server.")
    return import_extract(db, settings, fetch_area(bbox, cfg, timeout_s))


def bbox_around(lat: float, lng: float, radius_m: float) -> tuple[float, float, float, float]:
    import math

    dlat = radius_m / 111_320.0
    dlng = radius_m / (111_320.0 * max(0.1, math.cos(math.radians(lat))))
    return (lat - dlat, lng - dlng, lat + dlat, lng + dlng)


def save_extract(path: Path, extract: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(extract, separators=(",", ":")), encoding="utf-8")
