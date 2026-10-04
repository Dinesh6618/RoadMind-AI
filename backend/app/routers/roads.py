from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..models import User
from ..security import get_db, optional_admin
from ..services.queries import road_detail, road_summaries

router = APIRouter(prefix="/roads", tags=["Roads & map"])


@router.get("", summary="All roads with current condition (for the map)")
def list_roads(
    request: Request,
    level: Literal["Low", "Moderate", "High", "Critical"] | None = None,
    q: str | None = None,
    db: Session = Depends(get_db),
):
    roads = road_summaries(db, request.app.state.app_state)
    if level:
        roads = [r for r in roads if r["severity_level"] == level]
    if q:
        roads = [r for r in roads if q.lower() in r["name"].lower()]
    return roads


@router.get("/{road_id}", summary="Road detail: condition, prediction, priority, history")
def get_road(road_id: int, request: Request, db: Session = Depends(get_db), admin: User | None = Depends(optional_admin)):
    detail = road_detail(db, request.app.state.app_state, road_id, admin=admin is not None)
    if detail is None:
        raise HTTPException(404, "Road not found")
    return detail
