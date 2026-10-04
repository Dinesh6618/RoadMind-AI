"""Simulated RoadMind condition data laid over the real OpenStreetMap network, for demonstration.

IMPORTANT: the roads, names and places are real (from OpenStreetMap), but every report, severity,
repair, traffic and rainfall value created here is SIMULATED. Seeded rows carry source="seed" and
the API/UI label them "simulated". Only a minority of segments receive data (neighbourhood clusters
plus a few designed routes); everything else stays UNKNOWN - exactly as in a real deployment where
RoadMind knows about a small share of the network.

Start the server with ROADMIND_SEED_DEMO=0 for an empty, real-data-only database.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from roadmind_ai import severity as severity_mod
from roadmind_ai.detection.types import Detection

from ..database import utcnow
from ..geo import M_PER_DEG_LAT, haversine_m
from ..models import (
    DamageDetection, MaintenancePriority, Place, Repair, Road, RoadConditionHistory, RoadReport, RouteQuery,
)
from . import condition, road_classes
from .pipeline import refresh_roads
from .routing.types import RoutingUnavailable
from .state import AppState

log = logging.getLogger("roadmind.seed")
IMG_W, IMG_H = 1280, 960
FEATURED = ("station", "hospital", "college", "university", "school", "mall", "marketplace")
ELIGIBLE = ("primary", "secondary", "tertiary", "unclassified", "residential", "trunk")  # roads people report on


def _midpoint(road: Road) -> tuple[float, float]:
    return road.geometry[len(road.geometry) // 2]


def _point_on(rng: np.random.Generator, geometry: list[list[float]]) -> tuple[float, float]:
    i = int(rng.integers(0, len(geometry) - 1))
    (a, b), t = (geometry[i], geometry[i + 1]), float(rng.uniform(0.1, 0.9))
    return a[0] + (b[0] - a[0]) * t + float(rng.normal(0, 2e-5)), a[1] + (b[1] - a[1]) * t + float(rng.normal(0, 2e-5))


def _make_detections(rng: np.random.Generator, target: float, p: float) -> list[Detection]:
    """Detections whose size and type scale with the target severity (small damage stays small)."""
    if target < 8 or rng.random() > min(1.0, 0.25 + target / 40):
        return []
    n = 1 + int(target > 35) + int(target > 60) + int(target > 25 and rng.random() < 0.3)
    dets = []
    for _ in range(n):
        if target > 25 and rng.random() < 0.05 + 0.65 * p:
            label, ratio = "pothole", float(np.clip((target / 100) ** 1.6 * 0.22 * rng.uniform(0.6, 1.3), 0.004, 0.45))
        else:
            label = str(rng.choice(["longitudinal_crack", "transverse_crack", "alligator_crack", "surface_damage"], p=[0.3, 0.25, 0.3, 0.15]))
            ratio = float(rng.uniform(0.03, 0.2) * np.clip(target / 60, 0.12, 1.0))
        area = ratio * IMG_W * IMG_H
        w = float(np.sqrt(area * rng.uniform(0.6, 1.8)))
        h = area / max(w, 1.0)
        w, h = min(w, IMG_W - 2), min(h, IMG_H - 2)
        x1, y1 = float(rng.uniform(0, IMG_W - w)), float(rng.uniform(0, IMG_H - h))
        dets.append(Detection(label, round(float(np.clip(rng.normal(0.72 + 0.1 * p, 0.1), 0.35, 0.97)), 3), x1, y1, x1 + w, y1 + h))
    return dets


def _choose_story_pairs(graph, places: list[Place], rng: np.random.Generator, want: int = 2):
    """Pairs of well-known places 1.8-3.5 km apart that have at least three distinct routes."""
    featured = sorted((p for p in places if p.kind in FEATURED), key=lambda p: p.name)
    order = list(rng.permutation(len(featured)))
    used: set[int] = set()
    pairs = []
    tries = 0
    for i in order:
        for j in order:
            a, b = featured[i], featured[j]
            if a.id in used or b.id in used or i >= j or not 1800 <= haversine_m(a.lat, a.lng, b.lat, b.lng) <= 3500:
                continue
            tries += 1
            if tries > 400:
                return pairs
            try:
                paths = graph.route_road_ids((a.lat, a.lng), (b.lat, b.lng), 3)
            except RoutingUnavailable:
                continue
            if len(paths) >= 3:
                pairs.append((a, b, [set(p) for p in paths]))
                used |= {a.id, b.id}
                break
        if len(pairs) >= want:
            break
    return pairs


def seed_demo(db: Session, state: AppState) -> bool:
    """Add simulated condition data to a database that has a road network but no reports yet."""
    if not state.settings.seed_demo_data or db.scalar(select(func.count(RoadReport.id))):
        return False
    roads = list(db.scalars(select(Road).where(Road.source == "osm")))
    if len(roads) < 50:
        log.info("No road network loaded - skipping demo condition data.")
        return False
    log.info("Adding simulated condition data to %d real road segments...", len(roads))
    rng = np.random.default_rng(2024)
    now = utcnow()
    cfg = state.settings
    by_id = {r.id: r for r in roads}
    places = list(db.scalars(select(Place)))
    graph = state.route_engine.graph(db)

    # ---- which segments get data, and how damaged they are (propensity 0..1+) -------------
    propensity: dict[int, float] = {}
    story_roads: set[int] = set()
    pairs = _choose_story_pairs(graph, places, rng)
    for a, b, paths in pairs:
        # Route A (fastest) badly damaged, B in good condition, C middling. Segments shared by several
        # routes (mostly near the two ends) are kept in good shape so the contrast is clear.
        for rid in set().union(*paths):
            member = tuple(rid in p for p in paths) + (False,) * (3 - len(paths))
            if all(member[: len(paths)]):
                level = rng.uniform(0.05, 0.15)
            elif member == (True, False, False):
                level = rng.uniform(0.82, 0.95)
            elif member[0] and member[2]:
                level = rng.uniform(0.3, 0.4)
            elif member[1]:
                level = rng.uniform(0.05, 0.2)
            else:
                level = rng.uniform(0.25, 0.4)
            propensity[rid] = float(level)
            story_roads.add(rid)

    eligible = [r for r in roads if r.id not in story_roads and r.highway in ELIGIBLE and not r.name.startswith("Unnamed")]
    mids = np.array([_midpoint(r) for r in eligible])
    lat0 = float(mids[:, 0].mean())
    xy = np.stack([(mids[:, 1] - mids[:, 1].mean()) * M_PER_DEG_LAT * math.cos(math.radians(lat0)), (mids[:, 0] - lat0) * M_PER_DEG_LAT], axis=1)
    for _ in range(4):  # neighbourhood clusters where people have been reporting
        c = xy[int(rng.integers(0, len(xy)))]
        radius = float(rng.uniform(220, 380))
        level = float(rng.choice([0.10, 0.30, 0.50, 0.75], p=[0.3, 0.3, 0.25, 0.15]))
        for k in np.nonzero(np.linalg.norm(xy - c, axis=1) <= radius)[0]:
            rid = eligible[int(k)].id
            if rid not in propensity:
                propensity[rid] = float(np.clip(level + rng.normal(0, 0.12), 0.03, 0.95))

    # two busy main roads in very bad shape - the "Immediate" examples
    major = [r for r in roads if r.highway in ("primary", "secondary", "trunk") and r.id not in story_roads and r.length_m >= 120 and not r.name.startswith("Unnamed")]
    showpieces: set[int] = set()
    if major:
        for k in rng.choice(len(major), size=min(2, len(major)), replace=False):
            r = major[int(k)]
            showpieces.add(r.id)
            propensity[r.id] = 1.2
            r.daily_traffic = max(r.daily_traffic, 26000)

    # ---- repairs, reports, detections, history -------------------------------------------------
    chosen = [by_id[i] for i in propensity]
    for r in chosen:
        p = propensity[r.id]
        _, traffic0, age0 = road_classes.defaults_for(r.highway)
        r.age_years = round(float(np.clip(age0 + rng.normal(0, 5), 2, 35)), 1)
        if r.id not in showpieces:
            r.daily_traffic = int(np.clip(rng.lognormal(np.log(traffic0), 0.3), 300, 60000))
        r.rainfall_mm_30d = round(float(rng.gamma(6, cfg.network.default_rainfall_mm / 6)), 1)

        if rng.random() < 0.12:
            r.last_repair_date, r.repair_count = None, 0
        else:
            months = float(np.clip(rng.normal(6 + 30 * min(p, 1.0), 9), 7 if p > 0.4 else 1, min(r.age_years * 12, 90)))
            if r.id in showpieces:
                months = max(months, min(r.age_years * 12, 60.0))
            r.last_repair_date = (now - timedelta(days=months * 30.4)).date()
            r.repair_count = 1 + int(rng.poisson(r.age_years / 10))
            when = r.last_repair_date
            for _k in range(r.repair_count):
                db.add(Repair(road_id=r.id, status="completed", completed_date=when, planned_date=when, notes="Resurfacing / patching (simulated record)", created_by="seed"))
                when = when - timedelta(days=int(rng.uniform(540, 1100)))

        n_reports = max(1, int(rng.poisson(0.4 + 7 * p)))
        ages = sorted((float(rng.beta(1.0, 1.0 + 1.2 * (1 - p)) * 170) for _ in range(n_reports)), reverse=True)
        history: list[RoadReport] = []
        for age in ages:
            t = now - timedelta(days=age)
            target = float(np.clip(p * 100 * (0.6 + 0.4 * (1 - age / 180)) + rng.normal(0, 9), 0, 100))
            dets = _make_detections(rng, target, p) if target >= 8 else []
            recent = sum(1 for h in history if (t - h.reported_at).days <= 90)
            sev = severity_mod.assess(dets, IMG_W, IMG_H, recent, cfg.severity)
            lat, lng = _point_on(rng, r.geometry)
            rep = RoadReport(
                road_id=r.id, lat=lat, lng=lng, description="Simulated sample report (generated data)", reported_at=t, created_at=t,
                detector="seed-data", damage_count=len(dets), damage_summary=sev.summary, severity_score=sev.score,
                severity_level=sev.level, severity_breakdown=sev.breakdown, source="seed",
                detections=[
                    DamageDetection(label=d.label, confidence=d.confidence, x1=d.x1, y1=d.y1, x2=d.x2, y2=d.y2, area_ratio=round(d.area_ratio(IMG_W, IMG_H), 5))
                    for d in dets
                ],
            )
            db.add(rep)
            history.append(rep)
            cut = condition.repair_cutoff(r)
            db.add(RoadConditionHistory(
                road_id=r.id, recorded_at=t, report_count=len(history), event="seed",
                severity=condition.current_severity(history, t, cut if cut and cut <= t else None, cfg.condition),
            ))
    db.flush()

    # ---- risk prediction + priority, only for roads that now have data -----------------------
    refresh_roads(db, state, chosen, now=now)

    # ---- a realistic mix of maintenance statuses ------------------------------------------
    notes = {
        "inspected": "Site visit completed (simulated note): surface failure confirmed, awaiting scheduling.",
        "repair_planned": "Repair crew allocated (simulated note).",
    }
    prios = {m.road_id: m for m in db.scalars(select(MaintenancePriority))}
    for r in chosen:
        mp = prios.get(r.id)
        if mp is None:
            continue
        roll = rng.random()
        inspected_share, planned_share = {"Immediate": (0.3, 0.3), "High Priority": (0.25, 0.15), "Medium Priority": (0.15, 0.0)}.get(mp.category, (0.0, 0.0))
        if roll < planned_share:
            mp.status, mp.notes = "repair_planned", notes["repair_planned"]
            mp.inspected_at = now - timedelta(days=float(rng.uniform(2, 9)))
            db.add(Repair(road_id=r.id, status="planned", planned_date=(now + timedelta(days=float(rng.uniform(3, 20)))).date(), notes=notes["repair_planned"], created_by="seed"))
        elif roll < planned_share + inspected_share:
            mp.status, mp.notes = "inspected", notes["inspected"]
            mp.inspected_at = now - timedelta(days=float(rng.uniform(1, 12)))
    db.commit()

    _seed_route_queries(db, state, rng, now, places, pairs)
    log.info("Simulated data added to %d of %d segments.", len(chosen), len(roads))
    return True


def _seed_route_queries(db: Session, state: AppState, rng: np.random.Generator, now: datetime, places: list[Place], story_pairs) -> None:
    featured = sorted((p for p in places if p.kind in FEATURED), key=lambda p: p.name)
    pairs = [(a, b) for a, b, _ in story_pairs for _ in range(7)]
    attempts = 0
    while len(pairs) < 30 and len(featured) >= 2 and attempts < 200:
        attempts += 1
        i, j = rng.choice(len(featured), size=2, replace=False)
        if 1200 <= haversine_m(featured[i].lat, featured[i].lng, featured[j].lat, featured[j].lng) <= 4000:
            pairs.append((featured[i], featured[j]))
    for a, b in pairs:
        try:
            result = state.route_engine.recommend(
                db, (a.lat, a.lng), (b.lat, b.lng), origin_name=a.name, destination_name=b.name, persist=True, source="seed",
            )
        except Exception:  # a failed sample query must never block start-up
            db.rollback()
            continue
        q = db.get(RouteQuery, result["query_id"])
        q.created_at = now - timedelta(days=float(rng.uniform(0, 30)))
    db.commit()
