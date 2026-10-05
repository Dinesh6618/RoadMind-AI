"""Road events: blockages, closures, construction, accidents, flooding, severe damage - and the road reopening.

The real road network comes from Google Maps; RoadMind only knows what people and staff report on top of it, so an
event is a place (point + radius, optionally the blocked stretch) and a time window, never "this road is blocked for ever":

  * community reports start PENDING; staff-entered events are VERIFIED at once (they are authorised);
  * every event expires (`expires_at`); an unverified one stops counting even sooner (`events.pending_hours`);
  * staff can verify, reject, update or resolve ("road reopened") an event at any time.

Only VERIFIED + ACTIVE + unexpired events *strongly* affect route recommendations (see routing/intelligence.py).
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta

import numpy as np
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import Settings
from ..database import utcnow
from ..geo import SegmentIndex, densify
from ..models import RoadEvent, User
from . import pipeline

log = logging.getLogger("roadmind.events")

EVENT_TYPES: dict[str, dict[str, str]] = {
    "ROAD_BLOCKED": {"label": "Road blocked", "headline": "🚧 BLOCKED", "emoji": "🚧"},
    "ROAD_CLOSED": {"label": "Road closed", "headline": "⛔ ROAD CLOSED", "emoji": "⛔"},
    "TEMPORARY_CLOSURE": {"label": "Temporary closure", "headline": "⛔ TEMPORARILY CLOSED", "emoji": "⛔"},
    "CONSTRUCTION": {"label": "Construction", "headline": "🚧 CONSTRUCTION", "emoji": "🚧"},
    "ACCIDENT": {"label": "Accident", "headline": "⚠️ ACCIDENT", "emoji": "⚠️"},
    "FLOODED": {"label": "Flooded road", "headline": "🌊 FLOODED", "emoji": "🌊"},
    "SEVERE_DAMAGE": {"label": "Severe road damage", "headline": "⚠️ SEVERE DAMAGE", "emoji": "🕳️"},
    "ROAD_REOPENED": {"label": "Road reopened", "headline": "✅ REOPENED", "emoji": "✅"},
}
VERIFICATION = ("PENDING", "VERIFIED", "REJECTED")
LIFECYCLE = ("ACTIVE", "RESOLVED", "EXPIRED")

# what a person can report from the app -> the event it creates (potholes / cracks are damage reports, not events)
REPORT_TO_EVENT = {
    "BLOCKED_ROAD": "ROAD_BLOCKED",
    "FLOODING": "FLOODED",
    "ACCIDENT": "ACCIDENT",
    "CONSTRUCTION": "CONSTRUCTION",
    "DANGEROUS_CONDITION": "SEVERE_DAMAGE",
}


# ----------------------------------------------------------------------------- state
def effective_expiry(ev: RoadEvent, settings: Settings) -> datetime:
    """When the event stops counting: its expiry, or - while nobody has verified it - the shorter pending window."""
    if ev.verification_status == "PENDING":
        return min(ev.expires_at, ev.created_at + timedelta(hours=settings.events.pending_hours))
    return ev.expires_at


def is_live(ev: RoadEvent, settings: Settings, now: datetime | None = None) -> bool:
    """ACTIVE, not rejected, not past its (effective) expiry. A ROAD_REOPENED note is information, never a live problem."""
    now = now or utcnow()
    if ev.status != "ACTIVE" or ev.verification_status == "REJECTED" or ev.event_type == "ROAD_REOPENED":
        return False
    return effective_expiry(ev, settings) > now


def is_blocking(ev: RoadEvent, settings: Settings, now: datetime | None = None) -> bool:
    """A verified, live blockage / closure: the only kind of event that makes a route AVOID."""
    return is_live(ev, settings, now) and ev.verification_status == "VERIFIED" and ev.event_type in settings.route_risk.hard_block_types


def expire_due(db: Session, now: datetime | None = None, settings: Settings | None = None) -> int:
    """Persist EXPIRED for active events whose time is up - and, when `settings` is given, for unverified community reports whose
    pending window is over (staff can still verify an expired report: that makes it current again). The queries check the clock
    themselves, so this is housekeeping that keeps the review queue to reports that can still matter."""
    now = now or utcnow()
    done = db.execute(update(RoadEvent).where(RoadEvent.status == "ACTIVE", RoadEvent.expires_at <= now).values(status="EXPIRED")).rowcount or 0
    if settings is not None:
        stale = now - timedelta(hours=settings.events.pending_hours)
        done += db.execute(
            update(RoadEvent).where(RoadEvent.status == "ACTIVE", RoadEvent.verification_status == "PENDING", RoadEvent.created_at <= stale).values(status="EXPIRED")
        ).rowcount or 0
    if done:
        db.commit()
    return done


def display_status(ev: RoadEvent, settings: Settings, now: datetime | None = None) -> str:
    """One word for the UI: PENDING | VERIFIED | REJECTED while it matters, else RESOLVED | EXPIRED."""
    now = now or utcnow()
    if ev.verification_status == "REJECTED":
        return "REJECTED"
    if ev.status == "RESOLVED":
        return "RESOLVED"
    if ev.status == "EXPIRED" or (ev.status == "ACTIVE" and effective_expiry(ev, settings) <= now):
        return "EXPIRED"
    return "ACTIVE" if ev.verification_status == "VERIFIED" else "PENDING"


# -------------------------------------------------------------------------- read side
def serialize(ev: RoadEvent, settings: Settings, *, staff: bool = False, now: datetime | None = None, names: dict[int, str] | None = None) -> dict:
    """The API shape. Community reporters are never named; staff see who reported / verified / resolved."""
    now = now or utcnow()
    meta = EVENT_TYPES.get(ev.event_type, {"label": ev.event_type.title(), "headline": ev.event_type, "emoji": "⚠️"})
    live = is_live(ev, settings, now)
    out = {
        "id": ev.id,
        "road_id": ev.road_id,
        "road_name": ev.road_name,
        "lat": ev.lat,
        "lng": ev.lng,
        "radius_m": ev.radius_m,
        "geometry": ev.geometry,
        "event_type": ev.event_type,
        "event_type_label": meta["label"],
        "headline": meta["headline"],
        "emoji": meta["emoji"],
        "description": ev.description,
        "reported_by": {"kind": "staff" if ev.source == "staff" else "community"},
        "created_at": ev.created_at.isoformat(),
        "expires_at": ev.expires_at.isoformat(),
        "expected_reopening_at": ev.expires_at.isoformat() if ev.event_type != "ROAD_REOPENED" else None,
        "effective_expires_at": effective_expiry(ev, settings).isoformat(),
        "verification_status": ev.verification_status,
        "verified": ev.verification_status == "VERIFIED",
        "status": ev.status,
        "display_status": display_status(ev, settings, now),
        "is_active": live,
        "is_blocking": is_blocking(ev, settings, now),
        "verified_at": ev.verified_at.isoformat() if ev.verified_at else None,
        "resolved_at": ev.resolved_at.isoformat() if ev.resolved_at else None,
        "age_minutes": max(0, int((now - ev.created_at).total_seconds() // 60)),
        "evidence_url": f"/media/{ev.evidence_path}" if ev.evidence_path else None,
    }
    if staff:
        names = names or {}
        out["reported_by"] = {"kind": "staff" if ev.source == "staff" else "community", "name": names.get(ev.reported_by_id) if ev.reported_by_id else None}
        out["verified_by"] = names.get(ev.verified_by_id) if ev.verified_by_id else None
        out["resolved_by"] = names.get(ev.resolved_by_id) if ev.resolved_by_id else None
        out["review_note"] = ev.review_note
    return out


def user_names(db: Session, events: list[RoadEvent]) -> dict[int, str]:
    ids = {i for ev in events for i in (ev.reported_by_id, ev.verified_by_id, ev.resolved_by_id) if i}
    if not ids:
        return {}
    return {u.id: (u.full_name or u.username) for u in db.scalars(select(User).where(User.id.in_(ids)))}


def live_events(
    db: Session, settings: Settings, *, bbox: tuple[float, float, float, float] | None = None, verified_only: bool = False, now: datetime | None = None
) -> list[RoadEvent]:
    """Events that count right now (see `is_live`), optionally inside a (south, west, north, east) box."""
    now = now or utcnow()
    stmt = select(RoadEvent).where(RoadEvent.status == "ACTIVE", RoadEvent.verification_status != "REJECTED", RoadEvent.expires_at > now)
    if verified_only:
        stmt = stmt.where(RoadEvent.verification_status == "VERIFIED")
    live = [ev for ev in db.scalars(stmt.order_by(RoadEvent.created_at.desc())) if is_live(ev, settings, now)]
    return [ev for ev in live if _touches(ev, bbox)] if bbox else live  # (few events are ever live at once, so this is cheap)


def _touches(ev: RoadEvent, bbox: tuple[float, float, float, float]) -> bool:
    """Does the event's extent - its blocked stretch, or its point plus radius - overlap the (south, west, north, east) box?
    A long blocked stretch whose middle is off-screen must still be returned while part of it is in view."""
    south, west, north, east = bbox
    if ev.geometry:
        lats, lngs = [p[0] for p in ev.geometry], [p[1] for p in ev.geometry]
        lo_lat, hi_lat, lo_lng, hi_lng = min(lats), max(lats), min(lngs), max(lngs)
    else:
        lo_lat = hi_lat = ev.lat
        lo_lng = hi_lng = ev.lng
    pad_lat = ev.radius_m / 111_320.0
    pad_lng = ev.radius_m / (111_320.0 * max(0.1, math.cos(math.radians(ev.lat))))
    return lo_lat - pad_lat <= north and hi_lat + pad_lat >= south and lo_lng - pad_lng <= east and hi_lng + pad_lng >= west


# ------------------------------------------------------------------------- write side
def _expiry(settings: Settings, event_type: str, now: datetime, hours: float | None, expires_at: datetime | None) -> datetime:
    cfg = settings.events
    if expires_at is not None:
        end = expires_at
    else:
        end = now + timedelta(hours=hours if hours is not None else cfg.default_hours.get(event_type, 6))
    return max(now + timedelta(minutes=5), min(end, now + timedelta(hours=cfg.max_hours)))  # never already over, never for ever


def create_event(
    db: Session,
    settings: Settings,
    *,
    event_type: str,
    lat: float,
    lng: float,
    description: str = "",
    road_name: str = "",
    user: User | None = None,
    staff: bool = False,
    hours: float | None = None,
    expires_at: datetime | None = None,
    radius_m: float | None = None,
    geometry: list | None = None,
    evidence_path: str | None = None,
) -> RoadEvent:
    """Store a road event. Staff events are verified straight away; everyone else's start PENDING.
    A ROAD_REOPENED event resolves the live blockages near it (and is itself just a record)."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"Unknown event type {event_type!r}")
    now = utcnow()
    cfg = settings.events
    road_id, name = None, (road_name or "").strip()
    found = pipeline.match_road(db, lat, lng, settings.condition.match_radius_m)
    if found is not None:  # a convenience link to RoadMind's own record of the road, when it has one
        road_id = found[0].id
        if not name and not found[0].name.lower().startswith("unnamed"):  # "Unnamed residential road" says nothing: leave it blank
            name = found[0].name
    ev = RoadEvent(
        road_id=road_id,
        road_name=name[:160],
        lat=lat,
        lng=lng,
        radius_m=min(max(float(radius_m or cfg.default_radius_m), 10.0), cfg.max_radius_m),
        geometry=[[round(p[0], 6), round(p[1], 6)] for p in geometry] if geometry else None,
        event_type=event_type,
        description=(description or "").strip()[:1000],
        reported_by_id=user.id if user else None,
        source="staff" if staff else "user",
        created_at=now,
        expires_at=_expiry(settings, event_type, now, hours, expires_at),
        verification_status="VERIFIED" if staff else "PENDING",
        status="ACTIVE",
        verified_by_id=user.id if (staff and user) else None,
        verified_at=now if staff else None,
        evidence_path=evidence_path,
    )
    if event_type == "ROAD_REOPENED":
        ev.status = "RESOLVED"  # a record, not a problem
        ev.resolved_at, ev.resolved_by_id = now, (user.id if user else None)
        for other in live_events(db, settings, now=now):
            if other.event_type != "ROAD_REOPENED" and _near(other, lat, lng, max(ev.radius_m, other.radius_m)):
                other.status, other.resolved_at, other.resolved_by_id = "RESOLVED", now, (user.id if user else None)
                other.review_note = (other.review_note or "Reopened by staff")[:300]
    db.add(ev)
    db.commit()
    log.info("Road event #%s %s created (%s) at %.5f,%.5f", ev.id, event_type, "staff, verified" if staff else "community, pending", lat, lng)
    return ev


def _near(ev: RoadEvent, lat: float, lng: float, radius_m: float) -> bool:
    from ..geo import haversine_m

    return haversine_m(ev.lat, ev.lng, lat, lng) <= radius_m


def verify(db: Session, settings: Settings, ev: RoadEvent, user: User, *, approved: bool, note: str = "", hours: float | None = None) -> RoadEvent:
    """Staff decision on a report: VERIFIED (it now counts strongly, optionally for `hours` from now) or REJECTED (false report)."""
    now = utcnow()
    ev.verified_by_id, ev.verified_at = user.id, now
    ev.review_note = (note or "").strip()[:300]
    if approved:
        ev.verification_status = "VERIFIED"
        if ev.status == "EXPIRED" or ev.expires_at <= now:  # confirming an old report: it is current again for the default time
            ev.status = "ACTIVE"
            ev.expires_at = _expiry(settings, ev.event_type, now, hours, None)
        elif hours is not None:
            ev.expires_at = _expiry(settings, ev.event_type, now, hours, None)
        if ev.status == "RESOLVED":
            ev.status, ev.resolved_at, ev.resolved_by_id = "ACTIVE", None, None
    else:
        ev.verification_status = "REJECTED"
    db.commit()
    return ev


def resolve(db: Session, ev: RoadEvent, user: User, note: str = "") -> RoadEvent:
    """The road is open again (or the work is finished): the event stops counting."""
    now = utcnow()
    ev.status, ev.resolved_at, ev.resolved_by_id = "RESOLVED", now, user.id
    if note.strip():
        ev.review_note = note.strip()[:300]
    db.commit()
    return ev


# ------------------------------------------------------------------------- route test
def route_hits(events: list[RoadEvent], polyline: list[list[float]], settings: Settings) -> list[tuple[RoadEvent, float]]:
    """Events a route runs through: (event, distance in metres) for every event whose location (or blocked stretch) the route
    passes within the event's radius. Works on any polyline - Google's, OSRM's or RoadMind's own."""
    if not events or len(polyline) < 2:
        return []
    index = SegmentIndex([(0, polyline)])
    hits = []
    for ev in events:
        pts = densify(ev.geometry, 20.0) if ev.geometry and len(ev.geometry) >= 2 else [(ev.lat, ev.lng)]
        d = float(index.distances(np.asarray(pts, float).reshape(-1, 2)).min())
        if d <= ev.radius_m:
            hits.append((ev, d))
    return hits
