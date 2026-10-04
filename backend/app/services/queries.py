"""Read models shared by the API routers (road summaries, details, report serialisation)."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from roadmind_ai.detection.types import DISPLAY_NAMES
from roadmind_ai.severity import level_for

from ..database import utcnow
from ..models import DamageDetection, MaintenancePriority, Road, RoadConditionHistory, RoadReport
from . import condition
from .pipeline import latest_predictions
from .state import AppState

STATUS_LABELS = {
    "pending": "Pending",
    "inspected": "Inspected",
    "repair_planned": "Repair planned",
    "repair_completed": "Repair completed",
}


def iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def road_summaries(db: Session, state: AppState, road_ids: list[int] | None = None, *, with_geometry: bool = True) -> list[dict]:
    """Condition summary per road. With no `road_ids` only roads that HAVE RoadMind data are returned
    (UNKNOWN roads have nothing to summarise); asking for specific ids also returns UNKNOWN ones."""
    cfg = state.settings
    now = utcnow()
    stmt = select(Road)
    stmt = stmt.where(Road.has_data.is_(True)) if road_ids is None else stmt.where(Road.id.in_(road_ids))
    roads = list(db.scalars(stmt))
    ids = [r.id for r in roads]
    if not ids:
        return []
    preds = latest_predictions(db, ids)
    prios = {m.road_id: m for m in db.scalars(select(MaintenancePriority).where(MaintenancePriority.road_id.in_(ids)))}
    total = dict(db.execute(select(RoadReport.road_id, func.count()).where(RoadReport.road_id.in_(ids)).group_by(RoadReport.road_id)).all())
    simulated = {
        rid for (rid,) in db.execute(select(RoadReport.road_id).where(RoadReport.road_id.in_(ids), RoadReport.source == "seed").distinct()).all()
    }
    since90 = now - timedelta(days=90)
    recent = dict(
        db.execute(
            select(RoadReport.road_id, func.count()).where(RoadReport.road_id.in_(ids), RoadReport.reported_at >= since90).group_by(RoadReport.road_id)
        ).all()
    )
    since_window = now - timedelta(days=cfg.condition.history_window_days)
    label_rows = db.execute(
        select(RoadReport.road_id, DamageDetection.label, func.count())
        .join(DamageDetection, DamageDetection.report_id == RoadReport.id)
        .where(RoadReport.road_id.in_(ids), RoadReport.reported_at >= since_window)
        .group_by(RoadReport.road_id, DamageDetection.label)
    ).all()
    main_label: dict[int, tuple[str, int]] = {}
    for rid, label, n in label_rows:
        if rid not in main_label or n > main_label[rid][1]:
            main_label[rid] = (label, n)

    out = []
    for r in roads:
        pred, mp = (preds.get(r.id), prios.get(r.id)) if r.has_data else (None, None)
        level = level_for(r.current_severity, cfg.severity.level_thresholds) if r.has_data else None
        state_code = condition.state_for(r.has_data, level)
        damage = main_label.get(r.id) if r.has_data else None
        out.append(
            {
                "id": r.id,
                "name": r.name,
                "zone": r.zone,
                "highway": r.highway,
                "osm_way_id": r.osm_way_id,
                **({"geometry": r.geometry} if with_geometry else {}),
                "length_m": r.length_m,
                "source": r.source,
                "has_data": r.has_data,
                "simulated": r.id in simulated,  # includes generated demo reports - not real observations
                "state": state_code,
                "state_label": condition.STATE_LABELS[state_code],
                "current_severity": r.current_severity if r.has_data else None,
                "severity_level": level,
                "damage_type": DISPLAY_NAMES.get(damage[0], damage[0]) if damage and r.current_severity >= 5 else None,
                "report_count": total.get(r.id, 0),
                "reports_90d": recent.get(r.id, 0),
                "last_report_at": iso(r.last_report_at),
                "risk": pred.risk if pred else None,
                "risk_percent": round(pred.risk * 100) if pred else None,
                "risk_level": pred.risk_level if pred else None,
                "traffic_level": condition.traffic_level(r.daily_traffic),
                "daily_traffic": r.daily_traffic,
                "facilities_nearby": r.facilities_nearby,
                "priority_score": mp.priority_score if mp else None,
                "priority_category": mp.category if mp else None,
                "recommended_action": mp.recommended_action if mp else None,
                "maintenance_status": mp.status if mp else "pending",
                "maintenance_status_label": STATUS_LABELS.get(mp.status if mp else "pending"),
                "months_since_repair": round(condition.months_since_repair(r, now), 1),
            }
        )
    return out


def report_dict(rep: RoadReport, *, with_images: bool = False, with_detections: bool = True) -> dict:
    d = {
        "id": rep.id,
        "road_id": rep.road_id,
        "reported_at": iso(rep.reported_at),
        "lat": rep.lat,
        "lng": rep.lng,
        "severity_score": rep.severity_score,
        "severity_level": rep.severity_level,
        "damage_summary": rep.damage_summary,
        "damage_count": rep.damage_count,
        "description": rep.description,
        "user_severity": rep.user_severity,
        "source": rep.source,
        "detector": rep.detector,
    }
    if with_detections:
        d["detections"] = [
            {
                "label": x.label,
                "label_display": DISPLAY_NAMES.get(x.label, x.label),
                "confidence": x.confidence,
                "bbox": {"x1": x.x1, "y1": x.y1, "x2": x.x2, "y2": x.y2},
                "area_ratio": x.area_ratio,
            }
            for x in rep.detections
        ]
    if with_images:
        d["image_url"] = f"/media/{rep.image_path}" if rep.image_path else None
        d["annotated_url"] = f"/media/{rep.annotated_path}" if rep.annotated_path else None
    return d


def road_detail(db: Session, state: AppState, road_id: int, *, admin: bool = False) -> dict | None:
    road = db.get(Road, road_id)
    if road is None:
        return None
    summary = road_summaries(db, state, [road_id])[0]
    pred = latest_predictions(db, [road_id]).get(road_id)
    mp = db.scalar(select(MaintenancePriority).where(MaintenancePriority.road_id == road_id))
    reports = list(db.scalars(select(RoadReport).where(RoadReport.road_id == road_id).order_by(RoadReport.reported_at.desc()).limit(15)))
    history = list(db.scalars(select(RoadConditionHistory).where(RoadConditionHistory.road_id == road_id).order_by(RoadConditionHistory.recorded_at)))
    detail = {
        **summary,
        "age_years": road.age_years,
        "rainfall_mm_30d": road.rainfall_mm_30d,
        "repair_count": road.repair_count,
        "last_repair_date": road.last_repair_date.isoformat() if road.last_repair_date else None,
        # age, traffic and rainfall of imported roads are estimates from the road class, not measurements
        "attributes_estimated": True,
        "stub": road.source == "user",
        "prediction": None
        if pred is None
        else {
            "risk": pred.risk,
            "risk_percent": round(pred.risk * 100),
            "level": pred.risk_level,
            "model": f"{pred.model_name} v{pred.model_version}",
            "features": pred.features,
            "factors": pred.factors,
            "created_at": iso(pred.created_at),
        },
        "priority": None
        if mp is None
        else {
            "score": mp.priority_score,
            "category": mp.category,
            "action": mp.recommended_action,
            "components": mp.components,
            "status": mp.status,
            "status_label": STATUS_LABELS.get(mp.status),
            "inspected_at": iso(mp.inspected_at),
            **({"notes": mp.notes} if admin else {}),
        },
        "history": [{"date": iso(h.recorded_at), "severity": h.severity, "reports": h.report_count, "event": h.event} for h in history],
        "repairs": [
            {"status": rp.status, "planned_date": rp.planned_date.isoformat() if rp.planned_date else None,
             "completed_date": rp.completed_date.isoformat() if rp.completed_date else None,
             **({"notes": rp.notes} if admin else {})}
            for rp in sorted(road.repairs, key=lambda x: x.completed_date or x.planned_date or x.created_at.date(), reverse=True)
        ],
        "recent_reports": [report_dict(r, with_images=admin, with_detections=False) for r in reports],
        "disclaimer": "AI-generated road-condition estimate for triage - not an official engineering assessment.",
    }
    return detail
