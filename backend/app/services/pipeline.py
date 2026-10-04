"""The report-to-priority pipeline.

  image -> detection -> severity -> (match a road segment of the network) -> store
        -> road condition history -> deterioration-risk prediction -> maintenance priority

Only roads that HAVE RoadMind data get a prediction and a priority. A segment with no data stays
UNKNOWN: nothing is predicted or ranked for it, and it is never treated as good or as damaged.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from roadmind_ai import severity as severity_mod
from roadmind_ai.detection import annotate

from ..database import utcnow
from ..geo import SegmentIndex, polyline_length_m, short_segment_around
from ..models import DamageDetection, MaintenancePriority, Prediction, Road, RoadConditionHistory, RoadReport
from . import condition, images, osm
from .priority import compute_priority
from .state import AppState

log = logging.getLogger("roadmind.pipeline")
M_PER_DEG = 111_320.0


def latest_predictions(db: Session, road_ids: Iterable[int] | None = None) -> dict[int, Prediction]:
    """Most recent stored prediction per road."""
    sub = select(func.max(Prediction.id)).group_by(Prediction.road_id)
    stmt = select(Prediction).where(Prediction.id.in_(sub))
    if road_ids is not None:
        stmt = stmt.where(Prediction.road_id.in_(list(road_ids)))
    return {p.road_id: p for p in db.scalars(stmt)}


def _chunks(items: list, n: int = 500):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def refresh_roads(
    db: Session,
    state: AppState,
    roads: list[Road],
    *,
    now: datetime | None = None,
    record_history: bool = False,
    history_event: str = "report",
) -> None:
    """Recompute data status, severity, predicted risk and maintenance priority for the given roads."""
    if not roads:
        return
    now = now or utcnow()
    cfg = state.settings
    reports_by_road: dict[int, list[RoadReport]] = {r.id: [] for r in roads}
    for chunk in _chunks(list(reports_by_road)):
        for rep in db.scalars(select(RoadReport).where(RoadReport.road_id.in_(chunk))):
            reports_by_road[rep.road_id].append(rep)

    known: list[Road] = []
    rows: list[dict] = []
    for road in roads:
        reps = reports_by_road[road.id]
        road.last_report_at = max((r.reported_at for r in reps), default=None)
        road.has_data = condition.has_condition_data(road, reps, now, cfg.condition)
        if not road.has_data:  # no recent data: back to UNKNOWN
            road.current_severity = 0.0
            continue
        feats = condition.build_features(road, reps, now, cfg.condition)
        road.current_severity = feats["current_severity"]
        known.append(road)
        rows.append(feats)

    predictions = state.predictor.predict_many(rows)
    for road, feats, pred in zip(known, rows, predictions):
        db.add(
            Prediction(
                road_id=road.id,
                created_at=now,
                risk=pred.risk,
                risk_level=pred.level,
                model_name=pred.model_name,
                model_version=pred.model_version,
                features={k: round(float(v), 3) for k, v in feats.items()},
                factors=pred.factors,
            )
        )
        result = compute_priority(
            severity=feats["current_severity"],
            risk=pred.risk,
            reports_recent=int(feats["reports_90d"]),
            daily_traffic=road.daily_traffic,
            facilities=road.facilities_nearby,
            months_since_repair=feats["months_since_repair"],
            cfg=cfg.priority,
        )
        mp = road.priority or db.scalar(select(MaintenancePriority).where(MaintenancePriority.road_id == road.id))
        if mp is None:
            mp = MaintenancePriority(road_id=road.id, status="pending")
            db.add(mp)
        mp.priority_score = result.score
        mp.category = result.category
        mp.recommended_action = result.action
        mp.components = result.components
        mp.updated_at = now
        if record_history:
            db.add(
                RoadConditionHistory(
                    road_id=road.id,
                    recorded_at=now,
                    severity=feats["current_severity"],
                    report_count=len(reports_by_road[road.id]),
                    event=history_event,
                )
            )
    db.flush()


def refresh_all(db: Session, state: AppState) -> int:
    """Re-score every road that has (or had) RoadMind data. Roads that are UNKNOWN are left alone."""
    ids = set(db.scalars(select(Road.id).where(Road.has_data.is_(True)))) | set(db.scalars(select(RoadReport.road_id).distinct()))
    n = 0
    for chunk in _chunks(sorted(ids)):
        roads = list(db.scalars(select(Road).where(Road.id.in_(chunk))))
        refresh_roads(db, state, roads)
        n += len(roads)
    return n


def _nearby_roads(db: Session, lat: float, lng: float, radius_m: float) -> list[Road]:
    import math

    dlat = radius_m / M_PER_DEG
    dlng = radius_m / (M_PER_DEG * max(0.1, math.cos(math.radians(lat))))
    return list(
        db.scalars(
            select(Road).where(Road.max_lat >= lat - dlat, Road.min_lat <= lat + dlat, Road.max_lng >= lng - dlng, Road.min_lng <= lng + dlng)
        )
    )


def match_road(db: Session, lat: float, lng: float, radius_m: float) -> tuple[Road, float] | None:
    """Nearest road segment within `radius_m` of the point, with its distance."""
    roads = _nearby_roads(db, lat, lng, radius_m * 1.5)
    if not roads:
        return None
    ids, dists = SegmentIndex([(r.id, r.geometry) for r in roads]).nearest([(lat, lng)])
    if dists[0] > radius_m:
        return None
    return next(r for r in roads if r.id == int(ids[0])), float(dists[0])


def match_or_create_road(db: Session, state: AppState, lat: float, lng: float, road_name: str | None) -> tuple[Road, bool, bool]:
    """Attach a report to the road segment it is on.

    Returns (road, created_stub, network_loaded). If no segment is near the point, the road network
    around it is fetched from OpenStreetMap (when enabled) and matching is retried; only if that also
    fails is a short stub road created at the point.
    """
    radius = state.settings.condition.match_radius_m
    found = match_road(db, lat, lng, radius)
    loaded = False
    if found is None and state.settings.network.remote_enabled:
        cfg = state.settings.network
        try:
            res = osm.import_bbox(db, state.settings, osm.bbox_around(lat, lng, cfg.auto_import_radius_m), timeout_s=cfg.auto_import_timeout_s)
            loaded = res.segments_added > 0
        except osm.NetworkImportError as exc:
            log.info("Could not load the road network around %.5f,%.5f: %s", lat, lng, exc)
        found = match_road(db, lat, lng, radius)
    if found is not None:
        return found[0], False, loaded

    name = (road_name or "").strip() or f"Reported road near {lat:.4f}, {lng:.4f}"
    geometry = short_segment_around(lat, lng)
    road = Road(
        name=name[:160],
        zone="Other",
        highway="residential",
        geometry=geometry,
        length_m=round(polyline_length_m(geometry), 1),
        min_lat=min(p[0] for p in geometry), max_lat=max(p[0] for p in geometry),
        min_lng=min(p[1] for p in geometry), max_lng=max(p[1] for p in geometry),
        age_years=12.0,  # unknown - neutral defaults, flagged as estimated in the API
        daily_traffic=3000,
        facilities_nearby=0,
        rainfall_mm_30d=state.settings.network.default_rainfall_mm,
        source="user",
    )
    db.add(road)
    db.flush()
    return road, True, False


@dataclass
class ReportOutcome:
    report: RoadReport
    road: Road
    road_created: bool
    network_loaded: bool
    detection_result: object
    severity: severity_mod.SeverityResult
    prediction: Prediction
    priority: MaintenancePriority
    previous_priority: float | None
    was_unknown: bool
    annotated_url: str | None


def analyze_image(state: AppState, data: bytes):
    """Detection only (no storage)."""
    bgr = images.decode_upload(data, state.settings.uploads)
    result = state.detector.detect(bgr)
    return bgr, result


def create_report(
    db: Session,
    state: AppState,
    *,
    image_bytes: bytes,
    lat: float,
    lng: float,
    road_name: str | None,
    description: str,
    reported_at: datetime | None,
    user_severity: str | None,
    reporter_id: int | None = None,
) -> ReportOutcome:
    bgr, result = analyze_image(state, image_bytes)
    now = utcnow()
    road, created, loaded = match_or_create_road(db, state, lat, lng, road_name)
    was_unknown = not road.has_data
    previous = road.priority.priority_score if road.priority else None

    window_start = now - timedelta(days=state.settings.severity.history_window_days)
    recent = db.scalar(select(func.count(RoadReport.id)).where(RoadReport.road_id == road.id, RoadReport.reported_at >= window_start)) or 0
    sev = severity_mod.assess(result.detections, result.width, result.height, recent, state.settings.severity)

    token = uuid.uuid4().hex
    rel_orig, rel_annot = f"reports/{token}.jpg", f"reports/{token}_annotated.jpg"
    media = state.settings.media_dir
    images.save_jpeg(bgr, media / rel_orig)
    images.save_jpeg(annotate(bgr, result.detections), media / rel_annot)
    try:
        report = RoadReport(
            road_id=road.id,
            reporter_id=reporter_id,
            lat=lat,
            lng=lng,
            description=description.strip(),
            reported_at=min(reported_at or now, now),
            created_at=now,
            image_path=rel_orig,
            annotated_path=rel_annot,
            detector=result.detector,
            damage_count=result.count,
            damage_summary=sev.summary,
            severity_score=sev.score,
            severity_level=sev.level,
            severity_breakdown=sev.breakdown,
            user_severity=user_severity,
            source="user",
        )
        db.add(report)
        db.flush()
        for d in result.detections:
            db.add(
                DamageDetection(
                    report_id=report.id,
                    label=d.label,
                    confidence=d.confidence,
                    x1=d.x1, y1=d.y1, x2=d.x2, y2=d.y2,
                    area_ratio=round(d.area_ratio(result.width, result.height), 5),
                )
            )
        db.flush()
        refresh_roads(db, state, [road], now=now, record_history=True)
        mp = db.scalar(select(MaintenancePriority).where(MaintenancePriority.road_id == road.id))
        if mp.status == "repair_completed" and sev.score > 30:
            mp.status = "pending"  # new damage after a completed repair re-opens the road
        db.commit()
    except Exception:
        db.rollback()
        (media / rel_orig).unlink(missing_ok=True)
        (media / rel_annot).unlink(missing_ok=True)
        raise

    pred = latest_predictions(db, [road.id])[road.id]
    return ReportOutcome(report, road, created, loaded, result, sev, pred, mp, previous, was_unknown, f"/media/{rel_annot}")
