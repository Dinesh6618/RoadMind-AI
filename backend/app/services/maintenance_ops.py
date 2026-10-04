"""Maintenance record changes shared by the administrator API and the maintenance-staff API."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import utcnow
from ..models import MaintenancePriority, Repair, Road, RoadAssignment, RoadConditionHistory, RoadReport, User
from .pipeline import refresh_roads
from .queries import road_summaries
from .state import AppState


def _priority_row(db: Session, road_id: int) -> MaintenancePriority:
    mp = db.scalar(select(MaintenancePriority).where(MaintenancePriority.road_id == road_id))
    if mp is None:
        mp = MaintenancePriority(road_id=road_id, priority_score=0, category="Monitor", recommended_action="", status="pending")
        db.add(mp)
    return mp


def _stamp(mp: MaintenancePriority, actor: User, note: str, now) -> None:
    line = f"{now:%Y-%m-%d} {actor.username}: {note}"
    mp.notes = f"{mp.notes}\n{line}" if mp.notes else line


def add_note(db: Session, road: Road, note: str, actor: User) -> str:
    """Append a dated, signed note to the road's maintenance log. Returns the whole log."""
    mp = _priority_row(db, road.id)
    _stamp(mp, actor, note.strip(), utcnow())
    db.commit()
    return mp.notes


def apply_update(db: Session, state: AppState, road: Road, *, status: str, notes: str | None, planned_date: date | None, actor: User) -> dict:
    """Mark a road inspected / repair planned / repair completed (with an optional note), then recalculate its severity,
    risk and priority. Returns the road's updated summary row (with the notes log)."""
    now = utcnow()
    mp = _priority_row(db, road.id)
    note = (notes or "").strip()
    if note:
        _stamp(mp, actor, note, now)

    open_repair = db.scalar(select(Repair).where(Repair.road_id == road.id, Repair.status == "planned").order_by(Repair.id.desc()))
    today = now.date()
    if status == "inspected":
        mp.inspected_at = now
    elif status == "repair_planned":
        mp.inspected_at = mp.inspected_at or now
        if open_repair is None:
            open_repair = Repair(road_id=road.id, status="planned", created_by=actor.username)
            db.add(open_repair)
        open_repair.planned_date = planned_date or today + timedelta(days=14)
        if note:
            open_repair.notes = note
    elif status == "repair_completed":
        repair = open_repair or Repair(road_id=road.id, created_by=actor.username, planned_date=today)
        repair.status, repair.completed_date = "completed", today
        if note:
            repair.notes = note
        db.add(repair)
        road.last_repair_date = today
        road.repair_count += 1
        total = db.scalar(select(func.count(RoadReport.id)).where(RoadReport.road_id == road.id)) or 0
        db.add(RoadConditionHistory(road_id=road.id, recorded_at=now, severity=0.0, report_count=total, event="repair"))
    mp.status = status
    db.flush()
    refresh_roads(db, state, [road], now=now)  # severity, risk and priority are recalculated after the change
    db.commit()
    row = road_summaries(db, state, [road.id])[0]
    row.pop("geometry", None)
    row["notes"] = mp.notes
    return row


def assignee_names(db: Session, road_ids: list[int]) -> dict[int, dict]:
    """road id -> {"id", "name"} of the maintenance employee responsible for it."""
    if not road_ids:
        return {}
    rows = db.execute(
        select(RoadAssignment.road_id, User.id, User.full_name, User.username)
        .join(User, User.id == RoadAssignment.user_id)
        .where(RoadAssignment.road_id.in_(road_ids))
    ).all()
    return {rid: {"id": uid, "name": full or username} for rid, uid, full, username in rows}
