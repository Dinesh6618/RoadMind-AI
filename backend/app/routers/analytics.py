import json
from collections import Counter, defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from roadmind_ai.detection.types import DISPLAY_NAMES
from roadmind_ai.severity import LEVELS

from ..database import utcnow
from ..models import DamageDetection, Repair, Road, RoadReport, RouteOption, RouteQuery, User
from ..security import get_db, require_admin
from ..services.queries import road_summaries

router = APIRouter(prefix="/analytics", tags=["Analytics"])
PENDING = ("pending", "inspected", "repair_planned")


def _brief(r: dict) -> dict:
    return {
        "id": r["id"], "name": r["name"], "zone": r["zone"], "risk_percent": r["risk_percent"],
        "current_severity": r["current_severity"], "severity_level": r["severity_level"],
        "priority_category": r["priority_category"], "maintenance_status": r["maintenance_status"],
    }


def _coverage(db: Session, known: int) -> dict:
    total = db.scalar(select(func.count(Road.id))) or 0
    return {"network_segments": total, "segments_with_data": known, "data_coverage": round(known / total, 4) if total else 0.0}


@router.get("/public-summary", summary="Headline numbers for the home page")
def public_summary(request: Request, db: Session = Depends(get_db)):
    sums = road_summaries(db, request.app.state.app_state)
    return {
        **_coverage(db, len(sums)),
        "total_roads": len(sums),
        "total_reports": db.scalar(select(func.count(RoadReport.id))) or 0,
        "critical_roads": sum(1 for s in sums if s["state"] == "CRITICAL"),
        "high_risk_roads": sum(1 for s in sums if s["state"] == "HIGH_RISK"),
        "repairs_completed": db.scalar(select(func.count(Repair.id)).where(Repair.status == "completed")) or 0,
    }


@router.get("/overview", summary="Admin overview counters")
def overview(request: Request, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    state = request.app.state.app_state
    sums = road_summaries(db, state)
    flag = state.settings.risk.deterioration_flag_threshold
    now = utcnow()
    return {
        **_coverage(db, len(sums)),
        "total_roads": len(sums),  # roads with RoadMind data; every figure below is computed over these only
        "total_reports": db.scalar(select(func.count(RoadReport.id))) or 0,
        "reports_last_7_days": db.scalar(select(func.count(RoadReport.id)).where(RoadReport.reported_at >= now - timedelta(days=7))) or 0,
        "critical_roads": sum(1 for s in sums if s["state"] == "CRITICAL"),
        "high_risk_roads": sum(1 for s in sums if s["state"] == "HIGH_RISK"),  # the map's orange state (High severity)
        "high_predicted_risk_roads": sum(1 for s in sums if s["risk_level"] == "HIGH"),  # model says >= 70 % chance of worsening
        "repairs_completed": db.scalar(select(func.count(Repair.id)).where(Repair.status == "completed")) or 0,
        "under_inspection": sum(1 for s in sums if s["maintenance_status"] == "inspected"),
        "by_state": {**dict(Counter(s["state"] for s in sums)), "UNKNOWN": max(0, (db.scalar(select(func.count(Road.id))) or 0) - len(sums))},
        "predicted_deteriorations": sum(1 for s in sums if s["risk"] is not None and s["risk"] >= flag),
        "pending_maintenance": sum(1 for s in sums if s["maintenance_status"] in PENDING and s["priority_category"] != "Monitor"),
        "average_severity": round(sum(s["current_severity"] for s in sums) / max(1, len(sums)), 1),
        "by_status": dict(Counter(s["maintenance_status"] for s in sums)),
        "by_category": dict(Counter(s["priority_category"] for s in sums)),
        "deterioration_threshold": flag,
    }


@router.get("/damage", summary="Damage analytics")
def damage(request: Request, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    sums = road_summaries(db, request.app.state.app_state)
    now = utcnow()

    by_type = [
        {"label": lab, "name": DISPLAY_NAMES.get(lab, lab), "count": n}
        for lab, n in db.execute(select(DamageDetection.label, func.count()).group_by(DamageDetection.label).order_by(func.count().desc())).all()
    ]
    sev_counts = dict(db.execute(select(RoadReport.severity_level, func.count()).group_by(RoadReport.severity_level)).all())
    by_severity = [{"level": lv, "count": sev_counts.get(lv, 0)} for lv in LEVELS]
    roads_by_level = Counter(s["severity_level"] for s in sums)

    zones: dict[str, dict] = defaultdict(lambda: {"roads": 0, "reports": 0, "severity_sum": 0.0, "critical": 0})
    for s in sums:
        z = zones[s["zone"]]
        z["roads"] += 1
        z["reports"] += s["report_count"]
        z["severity_sum"] += s["current_severity"]
        z["critical"] += s["severity_level"] in ("High", "Critical")
    by_location = sorted(
        (
            {"zone": k, "roads": v["roads"], "reports": v["reports"], "avg_severity": round(v["severity_sum"] / v["roads"], 1), "high_or_critical_roads": int(v["critical"])}
            for k, v in zones.items()
        ),
        key=lambda x: x["reports"],
        reverse=True,
    )
    top_roads = [
        {"id": s["id"], "name": s["name"], "reports": s["report_count"], "current_severity": s["current_severity"], "severity_level": s["severity_level"]}
        for s in sorted(sums, key=lambda s: s["report_count"], reverse=True)[:8]
    ]

    weeks = 26
    start = (now - timedelta(days=weeks * 7)).replace(hour=0, minute=0, second=0, microsecond=0)
    buckets = [{"week_start": (start + timedelta(days=7 * i)).date().isoformat(), "reports": 0, "sev_sum": 0.0} for i in range(weeks)]
    for reported_at, score in db.execute(select(RoadReport.reported_at, RoadReport.severity_score).where(RoadReport.reported_at >= start)).all():
        i = min(weeks - 1, int((reported_at - start).total_seconds() // (7 * 86400)))
        buckets[i]["reports"] += 1
        buckets[i]["sev_sum"] += score
    over_time = [
        {"week_start": b["week_start"], "reports": b["reports"], "avg_severity": round(b["sev_sum"] / b["reports"], 1) if b["reports"] else None}
        for b in buckets
    ]
    return {
        "by_type": by_type,
        "by_severity": by_severity,
        "roads_by_level": [{"level": lv, "count": roads_by_level.get(lv, 0)} for lv in LEVELS],
        "by_location": by_location,
        "top_roads": top_roads,
        "over_time": over_time,
    }


@router.get("/predictions", summary="Prediction analytics")
def prediction_analytics(request: Request, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    state = request.app.state.app_state
    sums = [s for s in road_summaries(db, state) if s["risk"] is not None]
    groups = {}
    for lv in ("HIGH", "MEDIUM", "LOW"):
        rows = sorted((s for s in sums if s["risk_level"] == lv), key=lambda s: s["risk"], reverse=True)
        groups[lv.lower()] = {"count": len(rows), "roads": [_brief(r) for r in rows[:12]]}
    metrics = None
    path = state.settings.resolve(state.settings.risk.metrics_path)
    if path.exists():
        metrics = json.loads(path.read_text(encoding="utf-8"))
    return {
        "levels": groups,
        "thresholds": {"high": state.settings.risk.high_threshold, "medium": state.settings.risk.medium_threshold},
        "model_metrics": metrics,
    }


def _pair(q: RouteQuery) -> tuple[str, str]:
    return (q.origin_name or f"{q.origin_lat:.3f}, {q.origin_lng:.3f}", q.dest_name or f"{q.dest_lat:.3f}, {q.dest_lng:.3f}")


@router.get("/routes", summary="Route analytics")
def route_analytics(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    queries = db.scalars(select(RouteQuery).order_by(RouteQuery.created_at.desc())).all()
    roads = {r.id: r for r in db.scalars(select(Road))}

    avoided: Counter = Counter()
    pair_stats: dict[tuple[str, str], dict] = defaultdict(lambda: {"n": 0, "fast_risk": 0.0, "rec_risk": 0.0, "alt": 0, "extra_km": 0.0, "risk_drop": 0.0})
    for q in queries:
        fastest = next((o for o in q.options if o.is_fastest), None)
        rec = next((o for o in q.options if o.recommendation == "Recommended"), None)
        for o in q.options:
            if o.recommendation == "Avoid":
                avoided.update(o.damaged_road_ids or [])
        # trips whose routes have (almost) no RoadMind data say nothing about road condition
        if not fastest or not rec or fastest.data_coverage < 0.15:
            continue
        st = pair_stats[_pair(q)]
        st["n"] += 1
        st["fast_risk"] += fastest.risk
        st["rec_risk"] += rec.risk
        if rec.id != fastest.id:
            st["alt"] += 1
            st["extra_km"] += rec.distance_km - fastest.distance_km
            st["risk_drop"] += fastest.risk - rec.risk

    avoided_roads = [
        {"road_id": rid, "name": roads[rid].name, "times_avoided": n, "current_severity": roads[rid].current_severity}
        for rid, n in avoided.most_common(8)
        if rid in roads
    ]
    affected = sorted(
        (
            {"origin": k[0], "destination": k[1], "queries": v["n"], "fastest_route_risk_percent": round(100 * v["fast_risk"] / v["n"]), "recommended_route_risk_percent": round(100 * v["rec_risk"] / v["n"])}
            for k, v in pair_stats.items()
        ),
        key=lambda x: (x["fastest_route_risk_percent"], x["queries"]),
        reverse=True,
    )[:6]
    alternatives = sorted(
        (
            {
                "origin": k[0], "destination": k[1], "times_recommended": v["alt"],
                "avg_extra_km": round(v["extra_km"] / v["alt"], 2), "avg_risk_reduction_points": round(100 * v["risk_drop"] / v["alt"]),
            }
            for k, v in pair_stats.items()
            if v["alt"]
        ),
        key=lambda x: x["times_recommended"],
        reverse=True,
    )[:6]
    return {
        "total_queries": len(queries),
        "queries_last_7_days": sum(1 for q in queries if q.created_at >= utcnow() - timedelta(days=7)),
        "avoided_roads": avoided_roads,
        "most_affected_routes": affected,
        "recommended_alternatives": alternatives,
    }
