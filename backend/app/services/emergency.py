"""Emergency Route Mode, part 1: nearby emergency services and the live status of an active route.

Nearby places come from a REAL map/places service and are never invented:

  1. Google Places API (New) `searchNearby` - when GOOGLE_MAPS_API_KEY is set (hospital / fire_station / police), ranked by distance;
  2. otherwise (or when Google fails) OpenStreetMap: places RoadMind already stored, plus a live Overpass query
     (`amenity=hospital|fire_station|police`) when remote access is enabled.

For the nearest few, a real travel time comes from the Google Route Matrix API (traffic-aware, ONE request for all of them) or - without
Google - from RoadMind's own routing when both points are inside the loaded network (not traffic-aware, and labelled so). When neither is
possible the place is listed with its straight-line distance only and `eta_min: null`. Availability facts (`open_now`, `opening_hours`,
`has_emergency`) are passed through only when the source actually states them; RoadMind never infers whether a hospital can take patients.
"""

from __future__ import annotations

import logging
import threading
import time

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings
from ..database import utcnow
from ..geo import haversine_m
from ..models import Place
from . import events as ev_service
from . import osm
from .routing.google import GoogleRoutesError, GoogleRoutesProvider
from .routing.types import RoutingUnavailable

log = logging.getLogger("roadmind.emergency")

KINDS: dict[str, dict[str, str]] = {
    "hospital": {"label": "Hospital", "plural": "hospitals", "emoji": "🏥", "google": "hospital", "osm": "hospital"},
    "fire_station": {"label": "Fire station", "plural": "fire stations", "emoji": "🚒", "google": "fire_station", "osm": "fire_station"},
    "police": {"label": "Police station", "plural": "police stations", "emoji": "🚓", "google": "police", "osm": "police"},
}
PLACES_FIELDS = "places.id,places.displayName,places.location,places.formattedAddress,places.currentOpeningHours.openNow,places.nationalPhoneNumber"

_cache: dict[tuple, tuple[float, list[dict], str]] = {}
_cache_lock = threading.Lock()


class PlacesUnavailable(RuntimeError):
    """No places service could be reached (Google failed and OpenStreetMap is unreachable or disabled)."""


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


# --------------------------------------------------------------------------- sources
def _google_places(settings: Settings, kind: str, lat: float, lng: float, radius_m: float, limit: int, client: httpx.Client | None) -> list[dict]:
    body = {
        "includedTypes": [KINDS[kind]["google"]],
        "maxResultCount": max(1, min(limit * 2, 20)),
        "rankPreference": "DISTANCE",
        "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": min(float(radius_m), 50000.0)}},
    }
    payload = GoogleRoutesProvider(settings.google_api_key, settings.google, client)._post(settings.google.places_url, body, PLACES_FIELDS, "Places")
    out = []
    for p in payload.get("places") or []:
        loc = p.get("location") or {}
        if "latitude" not in loc or "longitude" not in loc:
            continue
        name = ((p.get("displayName") or {}).get("text") or "").strip()
        open_now = (p.get("currentOpeningHours") or {}).get("openNow")
        out.append({
            "name": name or f"{KINDS[kind]['label']} (name not available)", "lat": loc["latitude"], "lng": loc["longitude"],
            "address": p.get("formattedAddress"), "open_now": open_now if isinstance(open_now, bool) else None, "opening_hours": None,
            "has_emergency": None, "phone": p.get("nationalPhoneNumber"), "source": "google",
        })
    return out


def _overpass_query(osm_kind: str, lat: float, lng: float, radius_m: float) -> str:
    return f'[out:json][timeout:20];nwr["amenity"="{osm_kind}"](around:{int(radius_m)},{lat:.6f},{lng:.6f});out center tags 60;'


def _osm_places(db: Session, settings: Settings, kind: str, lat: float, lng: float, radius_m: float) -> list[dict]:
    """Places RoadMind already stored + (when remote access is on) a live Overpass query. Raises PlacesUnavailable only when
    nothing at all could be consulted."""
    found: list[dict] = []
    consulted = False
    stored_kind = KINDS[kind]["osm"]
    for p in db.scalars(select(Place).where(Place.kind == stored_kind)):
        consulted = True
        found.append({"name": p.name, "lat": p.lat, "lng": p.lng, "address": None, "open_now": None, "opening_hours": None, "has_emergency": None, "phone": None, "source": "stored"})
    if settings.network.remote_enabled:
        try:
            data = osm.fetch_overpass(_overpass_query(KINDS[kind]["osm"], lat, lng, radius_m), settings.network.overpass_urls, min(settings.network.overpass_timeout_s, 25))
            consulted = True
            for el in data.get("elements", []):
                tags = el.get("tags") or {}
                point = el if "lat" in el else el.get("center") or {}
                if "lat" not in point or "lon" not in point:
                    continue
                emergency = tags.get("emergency")
                found.append({
                    "name": (tags.get("name") or "").strip() or f"{KINDS[kind]['label']} (name not available)", "lat": point["lat"], "lng": point["lon"],
                    "address": tags.get("addr:full") or None, "open_now": None, "opening_hours": tags.get("opening_hours") or None,
                    "has_emergency": {"yes": True, "no": False}.get(emergency) if emergency else None, "phone": tags.get("phone") or tags.get("contact:phone"), "source": "osm",
                })
        except osm.NetworkImportError as exc:
            log.info("Overpass places lookup failed: %s", exc)
    if not consulted:
        raise PlacesUnavailable("OpenStreetMap places could not be consulted.")
    return found


# ------------------------------------------------------------------------------ nearby
def _dedupe(items: list[dict]) -> list[dict]:
    """The same place can arrive from two sources (stored + live): keep one per name within 60 m."""
    out: list[dict] = []
    for it in sorted(items, key=lambda i: i["distance_m"]):
        if not any(o["name"].lower() == it["name"].lower() and haversine_m(o["lat"], o["lng"], it["lat"], it["lng"]) < 60 for o in out):
            out.append(it)
    return out


def _add_eta(engine, db: Session, origin: tuple[float, float], items: list[dict], settings: Settings) -> bool:
    """Real travel times for the nearest places. Returns True when they are traffic-aware (Google)."""
    head = items[: settings.emergency.eta_places]
    for it in items:
        it.update(route_distance_km=None, eta_min=None, eta_traffic_aware=False)
    if not head:
        return False
    if settings.google_api_key:
        try:
            matrix = GoogleRoutesProvider(settings.google_api_key, settings.google, getattr(engine, "google_client", None)).matrix(origin, [(i["lat"], i["lng"]) for i in head])
            for it, m in zip(head, matrix):
                if m:
                    it.update(route_distance_km=round(m["distance_m"] / 1000, 1), eta_min=max(1, round(m["duration_s"] / 60)), eta_traffic_aware=True)
            return any(m for m in matrix)
        except GoogleRoutesError as exc:
            log.warning("Route Matrix failed (%s); using RoadMind routing for travel times", exc.reason)
    graph = engine.graph(db)  # RoadMind's own network: no live traffic, so these times are labelled as such (eta_traffic_aware stays False)
    for it in head:
        try:
            if graph.covers(origin, (it["lat"], it["lng"])):
                c = graph.routes(origin, (it["lat"], it["lng"]), 1)[0]
                it.update(route_distance_km=round(c.distance_m / 1000, 1), eta_min=max(1, round(c.duration_s / 60)))
        except (RoutingUnavailable, IndexError):
            continue
    return False


def find_nearby(engine, db: Session, kind: str, lat: float, lng: float, *, radius_m: float | None = None, limit: int | None = None, with_eta: bool = True) -> dict:
    """Hospitals / fire stations / police stations near a point, nearest first, each with a real distance and - where one can be
    computed - a real travel time. Raises PlacesUnavailable when no places service can be consulted."""
    settings: Settings = engine.settings
    cfg = settings.emergency
    radius = min(float(radius_m or cfg.nearby_radius_m), 50000.0)
    limit = max(1, min(int(limit or cfg.nearby_limit), 20))
    key = (kind, round(lat, 3), round(lng, 3), int(radius), bool(settings.google_api_key), with_eta)
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < cfg.cache_seconds:
        items, source = hit[1], hit[2]
        return _response(kind, items, source, radius, [])

    notes: list[str] = []
    raw: list[dict] = []
    source = "openstreetmap"
    if settings.google_api_key:
        try:
            raw = _google_places(settings, kind, lat, lng, radius, limit, getattr(engine, "google_client", None))
            source = "google"
        except GoogleRoutesError as exc:
            log.warning("Google Places failed (%s); using OpenStreetMap places", exc.reason)
            notes.append("Google Places is temporarily unavailable; showing OpenStreetMap places instead.")
    if source != "google":
        raw = _osm_places(db, settings, kind, lat, lng, radius)
    items = []
    for p in raw:
        d = haversine_m(lat, lng, p["lat"], p["lng"])
        if d <= radius:
            items.append({**p, "kind": kind, "emoji": KINDS[kind]["emoji"], "distance_m": d, "distance_km": round(d / 1000, 1)})
    items = _dedupe(items)[:limit]
    if with_eta:
        _add_eta(engine, db, (lat, lng), items, settings)
        if all(i["eta_min"] is not None for i in items[: cfg.eta_places]) and items:
            items.sort(key=lambda i: (i["eta_min"] if i["eta_min"] is not None else 1e9, i["distance_m"]))  # nearest in TIME first
    for it in items:
        it.pop("distance_m", None)
    with _cache_lock:
        _cache[key] = (now, items, source)
    return _response(kind, items, source, radius, notes)


def _response(kind: str, items: list[dict], source: str, radius: float, notes: list[str]) -> dict:
    meta = KINDS[kind]
    return {
        "kind": kind, "label": meta["label"], "emoji": meta["emoji"], "source": source,
        "source_label": {"google": "Google Places", "openstreetmap": "OpenStreetMap"}[source],
        "items": items, "count": len(items), "radius_km": round(radius / 1000, 1),
        "eta_traffic_aware": any(i.get("eta_traffic_aware") for i in items),
        "notes": notes, "generated_at": utcnow().isoformat(),
        "message": None if items else f"No {meta['plural']} were found within {round(radius / 1000)} km of this location.",
    }


# ---------------------------------------------------------------------- active route status
def route_status(db: Session, settings: Settings, geometry: list[list[float]], known_event_ids: list[int] | None = None) -> dict:
    """Is an active route still clear? Checked against live road events only (database, no Google call), so it can run every minute.
    BLOCKED = a verified closure / blockage now lies on the route; CHANGED = events on the route appeared or ended since the route was
    planned (`known_event_ids` = the events that were on it then); OK = nothing changed."""
    now = utcnow()
    ev_service.expire_due(db, now, settings)
    live = ev_service.live_events(db, settings, now=now)
    hits = [ev for ev, _ in ev_service.route_hits(live, geometry, settings)]
    brief = lambda e: {  # noqa: E731
        "id": e.id, "event_type": e.event_type, "headline": ev_service.EVENT_TYPES[e.event_type]["headline"], "road_name": e.road_name, "lat": e.lat, "lng": e.lng,
        "verified": e.verification_status == "VERIFIED", "description": e.description, "expected_reopening_at": e.expires_at.isoformat(),
        "age_minutes": max(0, int((now - e.created_at).total_seconds() // 60)),
    }
    blocking = [e for e in hits if ev_service.is_blocking(e, settings, now)]
    known = set(known_event_ids or [])
    now_ids = {e.id for e in hits}
    appeared = [e for e in hits if e.id not in known and e not in blocking]
    ended = sorted(known - now_ids)
    if blocking:
        status, message = "BLOCKED", "A verified road closure was detected on your current route."
    elif appeared or ended:
        status, message = "CHANGED", "A road condition changed on your route."
    else:
        status, message = "OK", "No change on your route."
    return {
        "status": status, "message": message, "checked_at": now.isoformat(),
        "blocking_events": [brief(e) for e in blocking], "new_events": [brief(e) for e in appeared], "ended_event_ids": ended,
        "event_ids": sorted(now_ids), "next_check_s": settings.emergency.status_interval_s,
    }
