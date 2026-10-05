"""What the map needs besides the base map.

The real-world roads, names and traffic come from Google Maps in the browser (or OpenStreetMap tiles when Google is not set
up). RoadMind adds only its own intelligence on top, so every endpoint here is an OVERLAY: an empty answer is a normal answer
("no RoadMind data for this area"), never a reason to hide the map.

    GET /api/map/config        which map engine to use (the browser key only - never the server key), defaults, refresh interval
    GET /api/road-conditions   RoadMind condition of the roads that HAVE data (viewport filter) - nothing else
    GET /api/traffic           where live traffic can come from right now (it is drawn by Google, never invented here)
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import utcnow
from ..models import DamageDetection, Road, RoadReport
from ..security import get_db
from ..services import network as net
from ..services.queries import iso, road_summaries

router = APIRouter(tags=["Map data"])

DEFAULT_CENTER = {"lat": 13.0735, "lng": 80.2645}
NO_DATA = "No RoadMind condition data available in this area."


def _traffic_status(settings) -> dict:
    layer = bool(settings.google_js_api_key)
    routing = bool(settings.google_api_key)
    if layer or routing:
        message = "Live traffic comes from Google Maps." + ("" if layer else " (The map layer needs GOOGLE_MAPS_JS_API_KEY.)") + ("" if routing else " (Traffic-aware routes need GOOGLE_MAPS_API_KEY.)")
    else:
        message = "Live traffic unavailable: Google Maps is not set up."
    return {"provider": "google" if (layer or routing) else None, "layer_available": layer, "routing_available": routing, "message": message}


@router.get("/map/config", summary="Map engine, defaults and refresh interval")
def map_config(request: Request, db: Session = Depends(get_db)):
    """Tells the page whether to use Google Maps (a browser key is configured) or the OpenStreetMap fallback. Only the
    *browser* key (`GOOGLE_MAPS_JS_API_KEY`) is ever returned - it is public by nature and must be restricted by HTTP referrer in
    Google Cloud. The server key (`GOOGLE_MAPS_API_KEY`, Routes API) never leaves the server."""
    state = request.app.state.app_state
    settings = state.settings
    info = net.network_info(db, state)
    center = info["center"]
    return {
        "google": {"js_api_key": settings.google_js_api_key or None, "routes_enabled": bool(settings.google_api_key)},
        "traffic": _traffic_status(settings),
        "default_center": {"lat": center[0], "lng": center[1]} if center else DEFAULT_CENTER,
        "default_zoom": 14,
        "tiles": info["tiles"],
        "simulated_data": info["simulated_data"],
        "refresh_seconds": settings.events.refresh_seconds,
    }


@router.get("/traffic", summary="Where live traffic information comes from")
def traffic(request: Request):
    """Live traffic is Google's: the Traffic Layer in the browser and the traffic-aware Routes API on the server. RoadMind stores
    and fabricates none of it, so this only reports what is available."""
    return _traffic_status(request.app.state.app_state.settings)


@router.get("/road-conditions", summary="RoadMind condition of the roads that have data (overlay only)")
def road_conditions(
    request: Request,
    south: float | None = Query(None, ge=-90, le=90),
    west: float | None = Query(None, ge=-180, le=180),
    north: float | None = Query(None, ge=-90, le=90),
    east: float | None = Query(None, ge=-180, le=180),
    limit: int = Query(4000, ge=1, le=10000),
    db: Session = Depends(get_db),
):
    """Only roads for which RoadMind HAS condition data are returned - Google (or the tile map) supplies every other road, and
    a road that is missing here is simply "condition data unavailable", never good and never damaged. With no box, all of them."""
    state = request.app.state.app_state
    settings = state.settings
    stmt = select(Road.id).where(Road.has_data.is_(True))
    if None not in (south, west, north, east):
        stmt = stmt.where(Road.max_lat >= south, Road.min_lat <= north, Road.max_lng >= west, Road.min_lng <= east)
    ids = list(db.scalars(stmt.order_by(Road.current_severity.desc()).limit(limit)))
    total = db.scalar(select(func.count(Road.id)).where(Road.has_data.is_(True))) or 0
    now = utcnow()
    base = {"updated_at": now.isoformat(), "refresh_seconds": settings.events.refresh_seconds, "total_with_data": total}
    if not ids:
        return {**base, "items": [], "count": 0, "counts": {}, "last_report_at": None, "simulated_data": False, "message": NO_DATA}

    since = now - timedelta(days=settings.condition.history_window_days)
    per_label = db.execute(
        select(RoadReport.road_id, DamageDetection.label, func.count(), func.avg(DamageDetection.confidence))
        .join(DamageDetection, DamageDetection.report_id == RoadReport.id)
        .where(RoadReport.road_id.in_(ids), RoadReport.reported_at >= since)
        .group_by(RoadReport.road_id, DamageDetection.label)
    ).all()
    facts: dict[int, dict] = {}
    for rid, label, n, conf in per_label:
        f = facts.setdefault(rid, {"potholes": 0, "cracks": 0, "n": 0, "conf": 0.0})
        f["potholes"] += n if label == "pothole" else 0
        f["cracks"] += n if label.endswith("crack") else 0
        f["n"] += n
        f["conf"] += float(conf or 0) * n

    items = []
    for s in road_summaries(db, state, ids, with_geometry=True):
        f = facts.get(s["id"], {})
        mid = s["geometry"][len(s["geometry"]) // 2]
        items.append(
            {
                "id": s["id"], "road_id": s["id"], "name": s["name"], "road_name": s["name"], "highway": s["highway"],
                "lat": mid[0], "lng": mid[1],
                "geometry": [[round(p[0], 6), round(p[1], 6)] for p in s["geometry"]],
                "length_m": round(s["length_m"]),
                "state": s["state"], "state_label": s["state_label"],
                "damage_type": s["damage_type"],
                "severity": None if s["current_severity"] is None else round(s["current_severity"]),
                "severity_level": s["severity_level"],
                "risk": s["risk"], "risk_percent": s["risk_percent"], "risk_level": s["risk_level"],
                "ai_confidence": round(f["conf"] / f["n"], 3) if f.get("n") else None,
                "pothole_count": f.get("potholes", 0), "crack_count": f.get("cracks", 0),
                "report_count": s["report_count"], "reports_90d": s["reports_90d"], "last_report_at": s["last_report_at"],
                "maintenance_status": s["maintenance_status"], "maintenance_status_label": s["maintenance_status_label"],
                "priority_category": s["priority_category"], "simulated": s["simulated"],
            }
        )
    counts: dict[str, int] = {}
    for it in items:
        counts[it["state"]] = counts.get(it["state"], 0) + 1
    last = max((it["last_report_at"] for it in items if it["last_report_at"]), default=None)
    simulated = any(it["simulated"] for it in items)
    return {**base, "items": items, "count": len(items), "counts": counts, "last_report_at": last, "simulated_data": simulated, "message": None}
