"""Emergency Route Mode - additions only; the existing user pages, authentication and routes are untouched.

    GET  /api/emergency/nearby        hospitals / fire stations / police stations near a point, with real distance and travel time
    POST /api/emergency/route         the best AVAILABLE route to an emergency destination (verified closures are a hard exclusion)
    GET  /api/emergency/events        live road events (closures first) for the map and for monitoring
    POST /api/emergency/route-status  is an active route still clear? (road events only - database, no Google call)

Public like the normal route planner (a person in an emergency must not be stopped by a login screen); rate-limited per client because
Google calls cost money. Nothing here invents places, traffic, closures or travel times.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from ..schemas import EmergencyRouteRequest, RouteStatusRequest
from ..security import RateLimit, get_db
from ..services import emergency as svc
from ..services import events as ev_service
from ..services.routing import emergency as routing
from ..services.routing.types import RoutingUnavailable

log = logging.getLogger("roadmind.emergency")
router = APIRouter(prefix="/emergency", tags=["Emergency route"])
_nearby_limit = RateLimit(30, 60)
_route_limit = RateLimit(20, 60)
_status_limit = RateLimit(90, 60)


@router.get("/nearby", summary="Nearby hospitals, fire stations or police stations", dependencies=[Depends(_nearby_limit)])
def nearby(
    request: Request,
    kind: Literal["hospital", "fire_station", "police"],
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    limit: int | None = Query(None, ge=1, le=20),
    radius_km: float | None = Query(None, gt=0, le=50),
    db: Session = Depends(get_db),
):
    """Real places from Google Places (when `GOOGLE_MAPS_API_KEY` is set) or OpenStreetMap - never invented. Each has the straight-line
    `distance_km` and, for the nearest few, `route_distance_km` + `eta_min` from the Google Route Matrix (`eta_traffic_aware: true`) or
    RoadMind's own routing (`false`); `eta_min: null` = no travel time could be computed. `open_now`, `opening_hours` and `has_emergency`
    are only present when the source states them."""
    engine = request.app.state.app_state.route_engine
    try:
        return svc.find_nearby(engine, db, kind, lat, lng, radius_m=radius_km * 1000 if radius_km else None, limit=limit)
    except svc.PlacesUnavailable:
        raise HTTPException(503, f"Unable to find nearby {svc.KINDS[kind]['plural']} right now.") from None


@router.post("/route", summary="Best available emergency route", dependencies=[Depends(_route_limit)])
def emergency_route(body: EmergencyRouteRequest, request: Request, db: Session = Depends(get_db)):
    """Gets traffic-aware routes (Google when configured), checks each against RoadMind road condition and the live road events, and
    **excludes every route with a verified live closure** (`status: "UNAVAILABLE"`, never recommended - if all are closed nothing is
    recommended). The rest are ranked by the configurable Emergency Route Score (travel time 45 %, traffic 20 %, road damage 15 %,
    flood 10 %, other road risk 10 %; unavailable parts are left out). The shortest route does not automatically win.
    `alert` carries the 🚧 notice and the alternative when the route the driver would take (or `current`) is closed."""
    engine = request.app.state.app_state.route_engine
    try:
        return routing.calculate_emergency(
            engine, db, (body.origin.lat, body.origin.lng), (body.destination.lat, body.destination.lng),
            origin_name=body.origin.name, destination_name=body.destination.name, destination_kind=body.destination_kind,
            current=body.current.model_dump() if body.current else None,
        )
    except RoutingUnavailable as exc:
        log.warning("Emergency route failed: %s", exc)
        raise HTTPException(503 if exc.retryable else 422, f"Unable to calculate the route right now. {exc}" if exc.retryable else str(exc)) from None


@router.get("/events", summary="Live road events for emergency routing (closures first)")
def emergency_events(
    request: Request,
    south: float | None = None, west: float | None = None, north: float | None = None, east: float | None = None,
    db: Session = Depends(get_db),
):
    """The same live events as `/road-events/active` (expired, resolved and rejected ones never appear), closures first, with how many
    of them are verified closures - the only events that make a route unavailable."""
    settings = request.app.state.app_state.settings
    given = [v is not None for v in (south, west, north, east)]
    if any(given) and not all(given):
        raise HTTPException(422, "Give all of south, west, north, east - or none of them.")
    ev_service.expire_due(db, settings=settings)
    rows = ev_service.live_events(db, settings, bbox=(south, west, north, east) if all(given) else None)
    items = sorted((ev_service.serialize(e, settings) for e in rows), key=lambda i: (not i["is_blocking"], i["verification_status"] != "VERIFIED", i["age_minutes"]))
    return {
        "items": items, "count": len(items), "blocking_count": sum(1 for i in items if i["is_blocking"]),
        "updated_at": ev_service.utcnow().isoformat(), "refresh_seconds": settings.emergency.status_interval_s,
    }


@router.post("/route-status", summary="Is the active route still clear?", dependencies=[Depends(_status_limit)])
def route_status(body: RouteStatusRequest, request: Request, db: Session = Depends(get_db)):
    """Cheap (database only, no Google call) so an app can ask every `next_check_s` seconds while a route is active. `BLOCKED`: a verified
    closure now lies on the route - ask `/emergency/route` for an alternative. `CHANGED`: events on the route appeared or ended since
    planning (`known_event_ids` = those at planning time; `event_ids` in the answer = those now). `OK`: no change."""
    settings = request.app.state.app_state.settings
    return svc.route_status(db, settings, body.geometry, body.known_event_ids)
