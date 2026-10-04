"""Road-maintenance staff API: the roads assigned to you, inspections, repairs, notes and photo evidence.

Maintenance employees only ever see and change the roads an administrator assigned to them (403 otherwise).
Administrators can use the same endpoints on every road. Normal users get 403 everywhere here.
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import MaintenancePriority, RepairEvidence, Road, RoadAssignment, RoadReport, User
from ..schemas import MaintenanceUpdate, StaffNote
from ..security import RateLimit, get_db, require_staff
from ..services.images import ImageError, decode_upload, save_jpeg
from ..services.maintenance_ops import add_note, apply_update, assignee_names
from ..services.queries import iso, report_dict, road_detail, road_summaries

router = APIRouter(prefix="/staff", tags=["Maintenance staff"])
_upload_limit = RateLimit(30, 60)

STAFF_STATUSES = ("inspected", "repair_planned", "repair_completed")  # "pending" can only be restored by an administrator


def _scope(db: Session, user: User) -> list[int] | None:
    """Ids of the roads this person may work on; None means every road (administrators)."""
    if user.role == "admin":
        return None
    return list(db.scalars(select(RoadAssignment.road_id).where(RoadAssignment.user_id == user.id)))


def _road_for(db: Session, user: User, road_id: int) -> Road:
    road = db.get(Road, road_id)
    if road is None:
        raise HTTPException(404, "Road not found")
    scope = _scope(db, user)
    if scope is not None and road_id not in scope:
        raise HTTPException(403, "This road is not assigned to you.")
    return road


def _rows(db: Session, request: Request, user: User) -> list[dict]:
    state = request.app.state.app_state
    scope = _scope(db, user)
    rows = road_summaries(db, state) if scope is None else road_summaries(db, state, scope)
    rows = [r for r in rows if r["has_data"]]
    notes = {m.road_id: m.notes for m in db.scalars(select(MaintenancePriority).where(MaintenancePriority.road_id.in_([r["id"] for r in rows])))} if rows else {}
    ev = dict(db.execute(select(RepairEvidence.road_id, func.count()).where(RepairEvidence.road_id.in_([r["id"] for r in rows])).group_by(RepairEvidence.road_id)).all()) if rows else {}
    who = assignee_names(db, [r["id"] for r in rows])
    for r in rows:
        r.pop("geometry", None)
        r["notes"] = notes.get(r["id"], "")
        r["evidence_count"] = ev.get(r["id"], 0)
        r["assigned_to"] = who.get(r["id"])
    return rows


def _evidence(db: Session, road_id: int) -> list[dict]:
    rows = db.execute(
        select(RepairEvidence, User.full_name, User.username).outerjoin(User, User.id == RepairEvidence.user_id)
        .where(RepairEvidence.road_id == road_id).order_by(RepairEvidence.created_at.desc())
    ).all()
    return [
        {"id": e.id, "kind": e.kind, "caption": e.caption, "url": f"/media/{e.image_path}", "created_at": iso(e.created_at), "by": full or username or "former employee"}
        for e, full, username in rows
    ]


@router.get("/summary", summary="Counts for the maintenance dashboard")
def summary(request: Request, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    rows = _rows(db, request, user)
    count = lambda pred: sum(1 for r in rows if pred(r))  # noqa: E731
    open_rows = [r for r in rows if r["maintenance_status"] != "repair_completed"]
    return {
        "scope": "all" if user.role == "admin" else "assigned",
        "assigned_roads": len(rows),
        "immediate": count(lambda r: r["priority_category"] == "Immediate" and r["maintenance_status"] != "repair_completed"),
        "high_priority": count(lambda r: r["priority_category"] == "High Priority" and r["maintenance_status"] != "repair_completed"),
        "awaiting_inspection": count(lambda r: r["maintenance_status"] == "pending"),
        "inspected": count(lambda r: r["maintenance_status"] == "inspected"),
        "repair_planned": count(lambda r: r["maintenance_status"] == "repair_planned"),
        "repairs_completed": count(lambda r: r["maintenance_status"] == "repair_completed"),
        "evidence_uploaded": sum(r["evidence_count"] for r in rows),
        "top_roads": sorted(open_rows, key=lambda r: -(r["priority_score"] or 0))[:5],
    }


@router.get("/roads", summary="Roads assigned to you (all roads for administrators)")
def roads(
    request: Request,
    status: Literal["pending", "inspected", "repair_planned", "repair_completed"] | None = None,
    q: str | None = None,
    sort: Literal["priority", "severity", "risk", "road"] = "priority",
    order: Literal["asc", "desc"] = "desc",
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
):
    rows = _rows(db, request, user)
    if status:
        rows = [r for r in rows if r["maintenance_status"] == status]
    if q:
        rows = [r for r in rows if q.lower() in r["name"].lower()]
    key = {"priority": "priority_score", "severity": "current_severity", "risk": "risk", "road": "name"}[sort]
    rows.sort(key=lambda r: (r[key] is None, r[key] if r[key] is not None else 0), reverse=(order == "desc"))
    return rows


@router.get("/roads/{road_id}", summary="One assigned road with its reports, notes and evidence")
def road(road_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    _road_for(db, user, road_id)
    detail = road_detail(db, request.app.state.app_state, road_id, admin=True)  # notes and photos: this is their road
    detail["evidence"] = _evidence(db, road_id)
    detail["assigned_to"] = assignee_names(db, [road_id]).get(road_id)
    return detail


@router.patch("/roads/{road_id}/status", summary="Update the inspection / repair status")
def update_status(road_id: int, body: MaintenanceUpdate, request: Request, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    road = _road_for(db, user, road_id)
    if user.role != "admin" and body.status not in STAFF_STATUSES:
        raise HTTPException(422, "Maintenance staff can mark a road inspected, repair planned or repair completed.")
    row = apply_update(db, request.app.state.app_state, road, status=body.status, notes=body.notes, planned_date=body.planned_date, actor=user)
    row["assigned_to"] = assignee_names(db, [road_id]).get(road_id)
    return row


@router.post("/roads/{road_id}/notes", status_code=201, summary="Add a maintenance note")
def add_road_note(road_id: int, body: StaffNote, db: Session = Depends(get_db), user: User = Depends(require_staff)):
    road = _road_for(db, user, road_id)
    return {"road_id": road_id, "notes": add_note(db, road, body.note, user)}


@router.post("/roads/{road_id}/evidence", status_code=201, summary="Upload a photo as inspection / repair evidence", dependencies=[Depends(_upload_limit)])
def upload_evidence(
    road_id: int,
    request: Request,
    image: UploadFile = File(..., description="JPEG, PNG or WebP photo"),
    kind: Literal["inspection", "repair"] = Form("repair"),
    caption: str = Form("", max_length=300),
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
):
    _road_for(db, user, road_id)
    settings = request.app.state.app_state.settings
    data = image.file.read(settings.uploads.max_bytes + 1)
    try:
        bgr = decode_upload(data, settings.uploads)  # real image, size/dimension limits, EXIF/GPS stripped
    except ImageError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None
    rel = f"evidence/{road_id}/{uuid.uuid4().hex}.jpg"
    save_jpeg(bgr, settings.media_dir / rel)
    ev = RepairEvidence(road_id=road_id, user_id=user.id, kind=kind, image_path=rel, caption=caption.strip())
    db.add(ev)
    db.commit()
    return {"id": ev.id, "kind": ev.kind, "caption": ev.caption, "url": f"/media/{rel}", "created_at": iso(ev.created_at), "by": user.full_name or user.username}


@router.get("/reports", summary="Damage reports on your roads")
def reports(
    road_id: int | None = None,
    level: Literal["Low", "Moderate", "High", "Critical"] | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
):
    limit = max(1, min(limit, 200))
    stmt = select(RoadReport)
    scope = _scope(db, user)
    if scope is not None:
        stmt = stmt.where(RoadReport.road_id.in_(scope))
    if road_id is not None:
        stmt = stmt.where(RoadReport.road_id == road_id)
    if level:
        stmt = stmt.where(RoadReport.severity_level == level)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(RoadReport.reported_at.desc()).offset(max(0, offset)).limit(limit)).all()
    return {"total": total, "items": [{**report_dict(r, with_images=True), "road_name": r.road.name} for r in rows]}
