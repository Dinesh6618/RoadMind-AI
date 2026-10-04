import base64
from datetime import datetime, timezone
from typing import Literal

import cv2
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from roadmind_ai import severity as severity_mod
from roadmind_ai.detection import annotate

from ..models import RoadReport, User
from ..security import RateLimit, current_user, get_db, optional_admin, optional_user, require_admin
from ..services import pipeline
from ..services.images import ImageError
from ..services.queries import report_dict, road_summaries

router = APIRouter(tags=["Reports & detection"])
_limit = RateLimit(30, 60)


def _read_upload(image: UploadFile, max_bytes: int) -> bytes:
    data = image.file.read(max_bytes + 1)  # never buffer more than the limit
    return data


def _describe(sev, result) -> str:
    """One plain sentence for the result screen."""
    if not result.count:
        return "No potholes or cracks were found in this photo."
    covered = round(sum(d.area_ratio(result.width, result.height) for d in result.detections) * 100)
    areas = f"{result.count} damaged area{'s' if result.count > 1 else ''}"
    return f"{sev.summary} detected. {areas.capitalize()} found, covering roughly {max(1, min(covered, 100))}% of the photo; overall severity is {sev.level.lower()}."


def _detection_payload(result, severity_cfg) -> dict:
    return {
        "detector": result.detector,
        "experimental": True,
        "note": result.note,
        "image": {"width": result.width, "height": result.height},
        "count": result.count,
        "detections": [
            {
                "label": d.label,
                "label_display": d.display_name,
                "confidence": d.confidence,
                "confidence_percent": round(d.confidence * 100),
                "bbox": {"x1": round(d.x1, 1), "y1": round(d.y1, 1), "x2": round(d.x2, 1), "y2": round(d.y2, 1)},
                "area_ratio": round(d.area_ratio(result.width, result.height), 4),
                "severity_score": ds[0],
                "severity_level": ds[1],
            }
            for d in result.detections
            for ds in [severity_mod.detection_severity(d, result.width, result.height, severity_cfg)]
        ],
    }


@router.post("/detect", summary="Detect road damage in an image (not stored)", dependencies=[Depends(_limit)])
def detect(request: Request, image: UploadFile = File(..., description="JPEG, PNG or WebP road photo")):
    """Runs the damage detector and severity model on one image without saving anything.

    Returns the detections, an experimental severity score and the annotated image as a data URL.
    """
    state = request.app.state.app_state
    try:
        bgr, result = pipeline.analyze_image(state, _read_upload(image, state.settings.uploads.max_bytes))
    except ImageError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None
    sev = severity_mod.assess(result.detections, result.width, result.height, 0, state.settings.severity)
    ok, buf = cv2.imencode(".jpg", annotate(bgr, result.detections), [cv2.IMWRITE_JPEG_QUALITY, 85])
    return {
        **_detection_payload(result, state.settings.severity),
        "severity": {
            "score": sev.score, "level": sev.level, "summary": sev.summary, "description": _describe(sev, result),
            "breakdown": sev.breakdown, "disclaimer": sev.disclaimer,
        },
        "annotated_image": "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode() if ok else None,
    }


@router.post("/reports", status_code=201, summary="Submit a road-damage report", dependencies=[Depends(_limit)])
def submit_report(
    request: Request,
    image: UploadFile = File(..., description="JPEG, PNG or WebP road photo"),
    lat: float = Form(..., ge=-90, le=90),
    lng: float = Form(..., ge=-180, le=180),
    road_name: str = Form("", max_length=160),
    description: str = Form("", max_length=1000),
    reported_at: datetime | None = Form(None, description="ISO date/time of the observation (defaults to now)"),
    severity_confirmation: Literal["low", "moderate", "high", "critical", "not_sure"] | None = Form(None),
    db: Session = Depends(get_db),
    user: User | None = Depends(optional_user),
):
    """Runs the full pipeline: detection -> severity -> location match -> stored history ->
    deterioration-risk prediction -> maintenance priority.

    Guests can browse, plan routes and try the detector (`/detect`), but storing a report needs an account
    (`auth.require_login_to_report`, on by default). A report is linked to your account so you can find it under
    "My reports" (no personal details are ever shown with a report).
    The optional `severity_confirmation` is stored for reviewers but never changes the AI score.
    """
    state = request.app.state.app_state
    if user is None and state.settings.auth.require_login_to_report:
        raise HTTPException(401, "Please log in or create a free account to submit a damage report.", headers={"WWW-Authenticate": "Bearer"})
    if reported_at is not None and reported_at.tzinfo is None:
        reported_at = reported_at.replace(tzinfo=timezone.utc)
    try:
        o = pipeline.create_report(
            db, state,
            image_bytes=_read_upload(image, state.settings.uploads.max_bytes),
            lat=lat, lng=lng, road_name=road_name, description=description,
            reported_at=reported_at, user_severity=severity_confirmation, reporter_id=user.id if user else None,
        )
    except ImageError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None

    road = road_summaries(db, state, [o.road.id])[0]
    return {
        "report_id": o.report.id,
        "created_at": o.report.created_at.isoformat(),
        "message": "Damage detected" if o.detection_result.count else "No road damage detected in this image",
        "damage_detected": o.detection_result.count > 0,
        "location": {
            "lat": lat, "lng": lng, "road_id": o.road.id, "road_name": o.road.name, "highway": o.road.highway,
            "new_road_created": o.road_created,  # no network near the point: a short stub road was made
            "network_loaded": o.network_loaded,  # the road network around the point was fetched from OpenStreetMap
            "road_was_unknown": o.was_unknown,  # this report is the first condition data RoadMind has for the road
        },
        "detection": {**_detection_payload(o.detection_result, state.settings.severity), "annotated_image_url": o.annotated_url},
        "severity": {
            "score": o.severity.score,
            "level": o.severity.level,
            "summary": o.severity.summary,
            "description": _describe(o.severity, o.detection_result),
            "breakdown": o.severity.breakdown,
            "reporter_confirmation": severity_confirmation,
            "disclaimer": o.severity.disclaimer,
        },
        "road": road,
        "prediction": {
            "risk": o.prediction.risk,
            "risk_percent": round(o.prediction.risk * 100),
            "level": o.prediction.risk_level,
            "factors": o.prediction.factors,
            "model": f"{o.prediction.model_name} v{o.prediction.model_version}",
            "note": "A probability estimate of further deterioration - not a guaranteed outcome.",
        },
        "priority": {
            "score": o.priority.priority_score,
            "category": o.priority.category,
            "action": o.priority.recommended_action,
            "previous_score": o.previous_priority,
            "status": o.priority.status,
        },
    }


@router.get("/reports", summary="List reports (admin)")
def list_reports(
    road_id: int | None = None,
    level: Literal["Low", "Moderate", "High", "Critical"] | None = None,
    source: Literal["user", "seed"] | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    limit = max(1, min(limit, 200))
    stmt = select(RoadReport)
    if road_id is not None:
        stmt = stmt.where(RoadReport.road_id == road_id)
    if level:
        stmt = stmt.where(RoadReport.severity_level == level)
    if source:
        stmt = stmt.where(RoadReport.source == source)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(RoadReport.reported_at.desc()).offset(max(0, offset)).limit(limit)).all()
    return {"total": total, "items": [{**report_dict(r, with_images=True), "road_name": r.road.name} for r in rows]}


@router.get("/reports/mine", summary="Reports you submitted while signed in")
def my_reports(limit: int = 50, offset: int = 0, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Any signed-in user (administrators included) sees only their own reports, with their own photos."""
    limit = max(1, min(limit, 100))
    stmt = select(RoadReport).where(RoadReport.reporter_id == user.id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(RoadReport.reported_at.desc()).offset(max(0, offset)).limit(limit)).all()
    return {"total": total, "items": [{**report_dict(r, with_images=True), "road_name": r.road.name} for r in rows]}


@router.get("/reports/{report_id}", summary="One report")
def get_report(report_id: int, db: Session = Depends(get_db), admin: User | None = Depends(optional_admin)):
    rep = db.get(RoadReport, report_id)
    if rep is None:
        raise HTTPException(404, "Report not found")
    return {**report_dict(rep, with_images=admin is not None), "road_name": rep.road.name}
