"""Road events and community road reports.

    GET   /road-events/active          what is happening on the roads right now (public; the map's blockage layer)
    GET   /road-events                 every event with its review state (staff)
    POST  /road-events                 record an event / mark a road blocked or reopened (staff -> verified at once)
    PATCH /road-events/{id}            change description, duration (construction progress), radius (staff)
    PATCH /road-events/{id}/verify     verify or reject a report (staff)
    PATCH /road-events/{id}/resolve    the road is open again / the work is done (staff)
    POST  /road-events/{id}/evidence   attach a photo (staff)
    POST  /road-reports                a community report: pothole, crack, flooding, accident, blocked road, construction,
                                       dangerous condition (photo, GPS, description) -> damage pipeline or a PENDING event
    GET   /road-reports                community event reports waiting for / past review (staff)
    GET   /road-reports/mine           what you reported and what became of it

Staff = administrators and road-maintenance employees. Community reports never block anything by themselves: they are
PENDING until staff verify them (see services/events.py).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import RoadEvent, User
from ..schemas import EventResolve, EventUpdate, EventVerify, RoadEventCreate
from ..security import RateLimit, current_user, get_db, optional_user, require_staff
from ..services import events as svc
from ..services import images
from ..services.images import ImageError
from .reports import require_reporter, store_damage_report

router = APIRouter(tags=["Road events & reports"])
_limit = RateLimit(30, 60)

REPORT_TYPES = ("POTHOLE", "CRACK", "FLOODING", "ACCIDENT", "BLOCKED_ROAD", "CONSTRUCTION", "DANGEROUS_CONDITION")
DAMAGE_REPORT_TYPES = ("POTHOLE", "CRACK", "DANGEROUS_CONDITION")  # a photo of these goes through the AI damage detector


def _settings(request: Request):
    return request.app.state.app_state.settings


def _bbox(south, west, north, east):
    given = [v is not None for v in (south, west, north, east)]
    if any(given) and not all(given):
        raise HTTPException(422, "Give all of south, west, north, east - or none of them.")
    return (south, west, north, east) if all(given) else None


def _get(db: Session, event_id: int) -> RoadEvent:
    ev = db.get(RoadEvent, event_id)
    if ev is None:
        raise HTTPException(404, "Road event not found.")
    return ev


def _save_evidence(settings, data: bytes) -> str:
    """Validate (a real image, size limits, EXIF stripped) and store a photo under media/events/."""
    try:
        bgr = images.decode_upload(data, settings.uploads)
        rel = f"events/{uuid.uuid4().hex}.jpg"
        images.save_jpeg(bgr, settings.media_dir / rel)
    except ImageError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None
    return rel


def _out(db: Session, settings, events: list[RoadEvent], *, staff: bool) -> list[dict]:
    names = svc.user_names(db, events) if staff else {}
    now = None
    return [svc.serialize(e, settings, staff=staff, now=now, names=names) for e in events]


# ------------------------------------------------------------------------------- read
@router.get("/road-events/active", summary="Active road events (blockages, closures, construction...)")
def active_events(
    request: Request,
    south: float | None = None, west: float | None = None, north: float | None = None, east: float | None = None,
    verified_only: bool = False,
    db: Session = Depends(get_db),
):
    """What is happening on the roads right now. Includes unverified community reports (clearly marked
    `verification_status: "PENDING"`) unless `verified_only`. Events that have expired or been resolved are never returned."""
    settings = _settings(request)
    svc.expire_due(db, settings=settings)
    rows = svc.live_events(db, settings, bbox=_bbox(south, west, north, east), verified_only=verified_only)
    items = _out(db, settings, rows, staff=False)
    return {
        "items": items,
        "count": len(items),
        "blocked_count": sum(1 for i in items if i["is_blocking"]),
        "updated_at": svc.utcnow().isoformat(),
        "refresh_seconds": settings.events.refresh_seconds,
    }


@router.get("/road-events", summary="All road events with their review state (staff)")
def list_events(
    request: Request,
    verification: Literal["PENDING", "VERIFIED", "REJECTED"] | None = None,
    status: Literal["ACTIVE", "RESOLVED", "EXPIRED"] | None = None,
    event_type: str | None = None,
    source: Literal["user", "staff"] | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: User = Depends(require_staff),
):
    settings = _settings(request)
    svc.expire_due(db, settings=settings)
    stmt = select(RoadEvent)
    if verification:
        stmt = stmt.where(RoadEvent.verification_status == verification)
    if status:
        stmt = stmt.where(RoadEvent.status == status)
    if event_type:
        stmt = stmt.where(RoadEvent.event_type == event_type.upper())
    if source:
        stmt = stmt.where(RoadEvent.source == source)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    # reports that need a decision first, then the newest
    rows = list(db.scalars(stmt.order_by((RoadEvent.verification_status != "PENDING"), RoadEvent.created_at.desc()).offset(offset).limit(limit)))
    return {"total": total, "items": _out(db, settings, rows, staff=True), "types": svc.EVENT_TYPES}


# ------------------------------------------------------------------------------ write (staff)
@router.post("/road-events", status_code=201, summary="Record a road event (staff; verified at once)")
def create_event(body: RoadEventCreate, request: Request, db: Session = Depends(get_db), staff: User = Depends(require_staff)):
    """Mark a road blocked / closed, record construction, an accident, flooding or severe damage - or `ROAD_REOPENED`, which also
    resolves the live blockages around that point. Staff are authorised, so the event is VERIFIED immediately; it still
    expires (`hours` / `expires_at`, else the default for its type)."""
    settings = _settings(request)
    ev = svc.create_event(
        db, settings, event_type=body.event_type, lat=body.lat, lng=body.lng, description=body.description, road_name=body.road_name,
        user=staff, staff=True, hours=body.hours, expires_at=body.expires_at, radius_m=body.radius_m, geometry=body.geometry,
    )
    return svc.serialize(ev, settings, staff=True, names=svc.user_names(db, [ev]))


@router.patch("/road-events/{event_id}", summary="Update an event (staff)")
def update_event(event_id: int, body: EventUpdate, request: Request, db: Session = Depends(get_db), staff: User = Depends(require_staff)):
    settings = _settings(request)
    ev = _get(db, event_id)
    if body.description is not None:
        ev.description = body.description.strip()
    if body.road_name is not None:
        ev.road_name = body.road_name.strip()
    if body.event_type is not None:
        ev.event_type = body.event_type
    if body.radius_m is not None:
        ev.radius_m = min(body.radius_m, settings.events.max_radius_m)
    if body.hours is not None or body.expires_at is not None:
        ev.expires_at = svc._expiry(settings, ev.event_type, svc.utcnow(), body.hours, body.expires_at)
        if ev.status == "EXPIRED":  # extending an expired event makes it current again
            ev.status = "ACTIVE"
    db.commit()
    return svc.serialize(ev, settings, staff=True, names=svc.user_names(db, [ev]))


@router.patch("/road-events/{event_id}/verify", summary="Verify or reject a report (staff)")
def verify_event(event_id: int, body: EventVerify, request: Request, db: Session = Depends(get_db), staff: User = Depends(require_staff)):
    """`approved: true` -> VERIFIED: it now counts strongly in route recommendations (and `hours` can set how long it lasts).
    `approved: false` -> REJECTED: a false or mistaken report; it stops counting at once."""
    settings = _settings(request)
    ev = svc.verify(db, settings, _get(db, event_id), staff, approved=body.approved, note=body.note, hours=body.hours)
    return svc.serialize(ev, settings, staff=True, names=svc.user_names(db, [ev]))


@router.patch("/road-events/{event_id}/resolve", summary="The road is open again / the work is done (staff)")
def resolve_event(event_id: int, body: EventResolve, request: Request, db: Session = Depends(get_db), staff: User = Depends(require_staff)):
    settings = _settings(request)
    ev = svc.resolve(db, _get(db, event_id), staff, body.note)
    return svc.serialize(ev, settings, staff=True, names=svc.user_names(db, [ev]))


@router.post("/road-events/{event_id}/evidence", summary="Attach a photo as evidence (staff)", dependencies=[Depends(_limit)])
def add_evidence(event_id: int, request: Request, image: UploadFile = File(...), db: Session = Depends(get_db), staff: User = Depends(require_staff)):
    settings = _settings(request)
    ev = _get(db, event_id)
    ev.evidence_path = _save_evidence(settings, image.file.read(settings.uploads.max_bytes + 1))
    db.commit()
    return svc.serialize(ev, settings, staff=True, names=svc.user_names(db, [ev]))


# ------------------------------------------------------------------------ community reports
@router.post("/road-reports", status_code=201, summary="Report a road problem (pothole, crack, flooding, accident, blocked road, construction, dangerous condition)", dependencies=[Depends(_limit)])
def submit_road_report(
    request: Request,
    report_type: Literal["POTHOLE", "CRACK", "FLOODING", "ACCIDENT", "BLOCKED_ROAD", "CONSTRUCTION", "DANGEROUS_CONDITION"] = Form(...),
    lat: float = Form(..., ge=-90, le=90),
    lng: float = Form(..., ge=-180, le=180),
    road_name: str = Form("", max_length=160),
    description: str = Form("", max_length=1000),
    image: UploadFile | None = File(None, description="JPEG, PNG or WebP photo (required for potholes and cracks)"),
    reported_at: datetime | None = Form(None),
    db: Session = Depends(get_db),
    user: User | None = Depends(optional_user),
):
    """One door for every kind of report. The location and time are stored with it.

    * **POTHOLE / CRACK** (photo required) and **DANGEROUS_CONDITION** (photo optional): the photo is run through the RoadMind AI
      damage detector and becomes a damage report that updates the road's condition, risk and maintenance priority
      (`kind: "damage"`). A dangerous condition additionally raises a PENDING *severe damage* event for staff to review.
    * **BLOCKED_ROAD / FLOODING / ACCIDENT / CONSTRUCTION**: becomes a PENDING road event (`kind: "event"`), with the photo kept as
      evidence. It is shown on the map as *unverified* and only nudges route scores until authorised staff verify it.
    Guests cannot store reports while `auth.require_login_to_report` is on.
    """
    state = request.app.state.app_state
    settings = state.settings
    require_reporter(state, user)
    data = image.file.read(settings.uploads.max_bytes + 1) if image is not None and image.filename else b""
    result: dict = {"report_type": report_type}

    if report_type in ("POTHOLE", "CRACK") and not data:
        raise HTTPException(422, "A photo is needed so RoadMind's AI can check the damage.")
    if report_type in DAMAGE_REPORT_TYPES and data:
        result["kind"] = "damage"
        result["damage"] = store_damage_report(
            db, state, user, image_bytes=data, lat=lat, lng=lng, road_name=road_name, description=description,
            reported_at=reported_at, severity_confirmation=None,
        )
        result["message"] = "Thank you - the photo was analysed and the road's condition was updated."
    if report_type in svc.REPORT_TO_EVENT:  # blocked / flooded / accident / construction / dangerous condition
        evidence = _save_evidence(settings, data) if data and report_type != "DANGEROUS_CONDITION" else None
        ev = svc.create_event(
            db, settings, event_type=svc.REPORT_TO_EVENT[report_type], lat=lat, lng=lng, description=description, road_name=road_name,
            user=user, staff=False, evidence_path=evidence,
        )
        result["kind"] = result.get("kind") or "event"
        result["event"] = svc.serialize(ev, settings, staff=False)
        result["message"] = result.get("message") or "Thank you - your report is waiting for verification by authorised staff. Until then it is shown as unverified."
    return result


@router.get("/road-reports", summary="Community event reports (staff)")
def list_road_reports(
    request: Request,
    verification: Literal["PENDING", "VERIFIED", "REJECTED"] | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: User = Depends(require_staff),
):
    """Reports people sent in (not events staff entered themselves). Verify or reject them with /road-events/{id}/verify."""
    return list_events(request, verification=verification, status=None, event_type=None, source="user", limit=limit, offset=offset, db=db, _=_)


@router.get("/road-reports/mine", summary="What you reported, and what became of it")
def my_road_reports(request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)):
    settings = _settings(request)
    rows = list(db.scalars(select(RoadEvent).where(RoadEvent.reported_by_id == user.id).order_by(RoadEvent.created_at.desc()).limit(100)))
    return {"items": _out(db, settings, rows, staff=False)}
