"""Read side of the base road network: what the map asks for.

Every segment in the requested view is returned - with or without RoadMind data. Segments without
data come back as state UNKNOWN. The only thing ever left out is generalisation by zoom (small
service streets are not drawn on a city-wide view), applied to all roads alike; a road that has
RoadMind data is always included.
"""

from __future__ import annotations

from collections import Counter

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import NetworkArea, Place, Road, RoadReport
from . import condition, road_classes
from .osm import ATTRIBUTION
from .queries import iso, road_summaries
from .state import AppState


def _round(coords, nd: int = 5) -> list[list[float]]:
    return [[round(p[0], nd), round(p[1], nd)] for p in coords]


def network_in_bbox(db: Session, state: AppState, south: float, west: float, north: float, east: float, zoom: int) -> dict:
    limit = state.settings.network.max_segments_per_view
    rows = list(
        db.scalars(select(Road).where(Road.max_lat >= south, Road.min_lat <= north, Road.max_lng >= west, Road.min_lng <= east))
    )
    visible = [r for r in rows if r.has_data or road_classes.min_zoom(r.highway) <= zoom]
    truncated = len(visible) > limit
    if truncated:  # keep roads with data first, then the most important classes
        visible.sort(key=lambda r: (not r.has_data, road_classes.min_zoom(r.highway)))
        visible = visible[:limit]

    known_ids = [r.id for r in visible if r.has_data]
    summaries = {s["id"]: s for s in road_summaries(db, state, known_ids, with_geometry=False)} if known_ids else {}

    segments = []
    for r in visible:
        seg = {
            "id": r.id,
            "name": r.name,
            "highway": r.highway,
            "oneway": bool(r.oneway),
            "length_m": round(r.length_m),
            "geometry": _round(r.geometry),
            "state": "UNKNOWN",
            "state_label": "UNKNOWN",
        }
        s = summaries.get(r.id)
        if s:
            seg.update(
                state=s["state"], state_label=s["state_label"], severity=round(s["current_severity"]), severity_level=s["severity_level"],
                damage_type=s["damage_type"], report_count=s["report_count"], last_report_at=s["last_report_at"],
                risk_percent=s["risk_percent"], risk_level=s["risk_level"], priority_category=s["priority_category"],
                maintenance_status=s["maintenance_status"], maintenance_status_label=s["maintenance_status_label"],
                simulated=s["simulated"],
            )
        segments.append(seg)

    # intersections: nodes where three or more of the returned segments meet
    ends: Counter[int] = Counter()
    where: dict[int, list[float]] = {}
    for r in visible:
        for node, point in ((r.node_a, r.geometry[0]), (r.node_b, r.geometry[-1])):
            if node is not None:
                ends[node] += 1
                where[node] = [round(point[0], 5), round(point[1], 5)]
    intersections = [where[n] for n, c in ends.items() if c >= 3]

    return {
        "segments": segments,
        "intersections": intersections,
        "truncated": truncated,
        "counts": dict(Counter(s["state"] for s in segments)),
        "zoom": zoom,
        "bbox": [south, west, north, east],
    }


def network_info(db: Session, state: AppState) -> dict:
    total = db.scalar(select(func.count(Road.id))) or 0
    known = db.scalar(select(func.count(Road.id)).where(Road.has_data.is_(True))) or 0
    areas = db.execute(select(NetworkArea.south, NetworkArea.west, NetworkArea.north, NetworkArea.east)).all()
    bounds = None
    if areas:
        bounds = [min(a[0] for a in areas), min(a[1] for a in areas), max(a[2] for a in areas), max(a[3] for a in areas)]
    simulated = (db.scalar(select(func.count(RoadReport.id)).where(RoadReport.source == "seed")) or 0) > 0
    return {
        "segments": total,
        "segments_with_data": known,
        "data_coverage": round(known / total, 4) if total else 0.0,
        "bounds": bounds,
        "center": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] if bounds else None,
        "places": db.scalar(select(func.count(Place.id))) or 0,
        "simulated_data": simulated,
        "remote_import_enabled": state.settings.network.remote_enabled,
        "max_import_span_deg": state.settings.network.max_import_span_deg,
        "attribution": ATTRIBUTION,
        "tiles": {"url": state.settings.map.tile_url, "attribution": state.settings.map.attribution, "max_zoom": state.settings.map.max_zoom},
        "legend": {k: condition.STATE_LABELS[k] for k in ("GOOD", "MODERATE", "HIGH_RISK", "CRITICAL", "UNKNOWN")},
    }


def match_point(db: Session, state: AppState, lat: float, lng: float, radius_m: float | None = None) -> dict:
    """Which road segment would a report at this point be attached to? (`radius_m` widens the search,
    e.g. to find a road near the middle of the map.)"""
    from .pipeline import match_road

    found = match_road(db, lat, lng, radius_m or state.settings.condition.match_radius_m)
    if found is None:
        return {"matched": False}
    road, dist = found
    s = road_summaries(db, state, [road.id], with_geometry=False)[0]
    mid = road.geometry[len(road.geometry) // 2]
    return {
        "matched": True,
        "road_id": road.id,
        "name": road.name,
        "highway": road.highway,
        "midpoint": {"lat": mid[0], "lng": mid[1]},
        "distance_m": round(dist, 1),
        "state": s["state"],
        "state_label": s["state_label"],
        "last_report_at": iso(road.last_report_at),
    }
