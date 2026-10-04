from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import MaintenancePriority, Road, RoadAssignment, User
from ..schemas import AssignRoad, MaintenanceUpdate
from ..security import get_db, require_admin
from ..services import accounts
from ..services.maintenance_ops import apply_update, assignee_names
from ..services.pipeline import refresh_all
from ..services.queries import road_summaries

router = APIRouter(prefix="/maintenance", tags=["Maintenance (admin)"])

SORT_KEYS = {
    "priority": "priority_score",
    "severity": "current_severity",
    "risk": "risk",
    "reports": "report_count",
    "road": "name",
    "last_report": "last_report_at",
}


@router.get("/priorities", summary="Roads ranked by maintenance priority")
def priorities(
    request: Request,
    sort: Literal["priority", "severity", "risk", "reports", "road", "last_report"] = "priority",
    order: Literal["asc", "desc"] = "desc",
    category: Literal["Immediate", "High Priority", "Medium Priority", "Monitor"] | None = None,
    status: Literal["pending", "inspected", "repair_planned", "repair_completed"] | None = None,
    q: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    rows = road_summaries(db, request.app.state.app_state)
    if category:
        rows = [r for r in rows if r["priority_category"] == category]
    if status:
        rows = [r for r in rows if r["maintenance_status"] == status]
    if q:
        rows = [r for r in rows if q.lower() in r["name"].lower()]
    key = SORT_KEYS[sort]
    rows.sort(key=lambda r: (r[key] is None, r[key] if r[key] is not None else 0), reverse=(order == "desc"))
    notes = {m.road_id: m.notes for m in db.scalars(select(MaintenancePriority))}
    who = assignee_names(db, [r["id"] for r in rows])
    for r in rows:
        r["notes"] = notes.get(r["id"], "")
        r["assigned_to"] = who.get(r["id"])
        r.pop("geometry", None)
    return rows


@router.get("/assignees", summary="Maintenance employees roads can be assigned to")
def assignees(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    counts = accounts.assigned_counts(db)
    staff = db.scalars(
        select(User).where(User.role == "maintenance", User.is_active.is_(True), User.email_verified_at.is_not(None)).order_by(User.full_name, User.username)
    )
    return [{"id": u.id, "name": u.full_name or u.username, "email": u.email, "assigned_roads": counts.get(u.id, 0)} for u in staff]


@router.put("/{road_id}/assignment", summary="Assign a road to a maintenance employee (or clear the assignment)")
def assign_road(road_id: int, body: AssignRoad, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    road = db.get(Road, road_id)
    if road is None:
        raise HTTPException(404, "Road not found")
    existing = db.scalar(select(RoadAssignment).where(RoadAssignment.road_id == road_id))
    if body.user_id is None:
        if existing is not None:
            db.delete(existing)
            db.commit()
        return {"road_id": road_id, "assigned_to": None}
    person = db.get(User, body.user_id)
    if person is None or person.role != "maintenance" or not person.is_active or person.email_verified_at is None:
        raise HTTPException(422, "Roads can only be assigned to an active, verified maintenance employee.")
    if existing is None:
        db.add(RoadAssignment(road_id=road_id, user_id=person.id, assigned_by_id=admin.id))
    else:
        existing.user_id, existing.assigned_by_id, existing.assigned_at = person.id, admin.id, datetime.now(timezone.utc)
    db.commit()
    return {"road_id": road_id, "assigned_to": {"id": person.id, "name": person.full_name or person.username}}


@router.patch("/{road_id}", summary="Mark inspected / repair planned / repair completed and add notes")
def update_maintenance(
    road_id: int,
    body: MaintenanceUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    road = db.get(Road, road_id)
    if road is None:
        raise HTTPException(404, "Road not found")
    row = apply_update(db, request.app.state.app_state, road, status=body.status, notes=body.notes, planned_date=body.planned_date, actor=admin)
    row["assigned_to"] = assignee_names(db, [road_id]).get(road_id)
    return row


@router.post("/refresh", summary="Recompute severity, risk and priority for every road")
def refresh(request: Request, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    n = refresh_all(db, request.app.state.app_state)
    db.commit()
    return {"roads_refreshed": n}
