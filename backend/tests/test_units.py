"""Unit tests for the scoring logic and the AI modules (no server needed)."""

import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from app.config import REPO_ROOT, PriorityConfig, RoutingConfig
from app.geo import SegmentIndex, densify, haversine_m
from app.services.priority import category_for, compute_priority
from app.services.routing.engine import RouteEngine, damage_label, normalise_weights
from app.services.routing.graph import NetworkGraph

sys.path.insert(0, str(REPO_ROOT / "ai"))
from roadmind_ai import severity  # noqa: E402
from roadmind_ai.detection import HeuristicDetector  # noqa: E402
from roadmind_ai.detection.evaluate import _average_precision  # noqa: E402
from roadmind_ai.detection.synthetic import generate_image  # noqa: E402
from roadmind_ai.detection.types import Detection, iou, nms  # noqa: E402


# --------------------------------------------------------------- severity
def _det(label, conf, w, h, img=(1000, 800)):
    return Detection(label, conf, 0, 0, w, h)


def test_severity_no_damage_is_zero():
    r = severity.assess([], 640, 480)
    assert r.score == 0 and r.level == "Low"


def test_severity_grows_with_size_type_count_and_history():
    small = severity.assess([_det("pothole", 0.8, 40, 40)], 1000, 800).score
    big = severity.assess([_det("pothole", 0.8, 500, 400)], 1000, 800).score
    crack = severity.assess([_det("longitudinal_crack", 0.8, 500, 400)], 1000, 800).score
    many = severity.assess([_det("pothole", 0.8, 40, 40)] * 5, 1000, 800).score
    repeat = severity.assess([_det("pothole", 0.8, 40, 40)], 1000, 800, recent_reports=10).score
    assert big > small and big > crack and many > small and repeat > small
    assert 0 <= big <= 100


def test_severity_levels_follow_the_documented_bands():
    assert [severity.level_for(s) for s in (0, 30, 31, 60, 61, 80, 81, 100)] == ["Low", "Low", "Moderate", "Moderate", "High", "High", "Critical", "Critical"]


def test_severity_breakdown_sums_to_score():
    r = severity.assess([_det("pothole", 0.9, 600, 500)], 1000, 800, recent_reports=6)
    assert r.score == pytest.approx(sum(r.breakdown.values()), abs=0.2)


# --------------------------------------------------------------- priority
def test_priority_categories():
    cfg = PriorityConfig()
    assert [category_for(s, cfg) for s in (95, 90, 89.9, 70, 69.9, 40, 39.9, 0)] == ["Immediate", "Immediate", "High Priority", "High Priority", "Medium Priority", "Medium Priority", "Monitor", "Monitor"]


def test_priority_matches_the_spec_example():
    # Road A: severity 90, risk 92 %, high traffic -> should be at the top of the scale
    r = compute_priority(severity=90, risk=0.92, reports_recent=14, daily_traffic=28000, facilities=2, months_since_repair=14, cfg=PriorityConfig())
    assert r.category == "Immediate" and r.score >= 90


def test_priority_ordering_and_guard():
    cfg = PriorityConfig()
    kw = dict(reports_recent=5, daily_traffic=8000, facilities=1, months_since_repair=20, cfg=cfg)
    assert compute_priority(severity=80, risk=0.8, **kw).score > compute_priority(severity=50, risk=0.5, **kw).score > compute_priority(severity=20, risk=0.2, **kw).score
    busy_but_undamaged = compute_priority(severity=0, risk=0.9, reports_recent=20, daily_traffic=60000, facilities=3, months_since_repair=90, cfg=cfg)
    assert busy_but_undamaged.category == "Monitor"
    high_traffic = compute_priority(severity=60, risk=0.6, reports_recent=5, daily_traffic=40000, facilities=0, months_since_repair=20, cfg=cfg).score
    low_traffic = compute_priority(severity=60, risk=0.6, reports_recent=5, daily_traffic=500, facilities=0, months_since_repair=20, cfg=cfg).score
    assert high_traffic > low_traffic


# ------------------------------------------------------------------- geo
def test_haversine_and_densify():
    assert haversine_m(13.0, 80.0, 13.0, 80.0) == 0
    assert haversine_m(13.0, 80.0, 13.01, 80.0) == pytest.approx(1111, rel=0.01)
    pts = densify([[13.0, 80.0], [13.0, 80.01]], 25)
    assert len(pts) > 30 and pts[0] == (13.0, 80.0)


def test_segment_index_nearest_and_candidates():
    roads = [(1, [[13.0, 80.0], [13.0, 80.01]]), (2, [[13.0, 80.01], [13.01, 80.01]])]
    idx = SegmentIndex(roads)
    ids, d = idx.nearest([(13.0001, 80.005), (13.005, 80.0101)])
    assert list(ids) == [1, 2] and d[0] < 15 and d[1] < 15
    assert set(idx.candidates([(13.0, 80.01)], tol_m=8, max_dist_m=40)[0]) == {1, 2}
    assert idx.candidates([(14.0, 81.0)], 8, 40) == [[]]
    assert SegmentIndex([]).nearest([(1, 1)])[0][0] == -1


def test_junction_samples_keep_route_continuity():
    cands = [[7], [7, 9], [9]]  # junction sample shared by roads 7 and 9
    assert RouteEngine._match_samples(cands) == [7, 7, 9]
    assert RouteEngine._match_samples([[3, 4], [3], [3, 4]]) == [3, 3, 3]
    assert RouteEngine._match_samples([[], [5], []]) == [None, 5, None]


def test_route_weights_normalise():
    d = RoutingConfig().weights
    w = normalise_weights({"damage_risk": 1, "distance": 0, "time": 0}, d)
    assert w == {"distance": 0, "time": 0, "damage_risk": 1}
    assert sum(normalise_weights(None, d).values()) == pytest.approx(1)
    assert normalise_weights({"distance": 0, "time": 0, "damage_risk": 0}, d) == pytest.approx(normalise_weights(None, d))


def test_damage_labels_follow_spec_examples():
    cfg = RoutingConfig()
    assert (damage_label(0.88, cfg), damage_label(0.22, cfg), damage_label(0.47, cfg)) == ("Severe", "Low", "Moderate")


LADDER = {"a": (13.00, 80.00), "b": (13.00, 80.01), "c": (13.00, 80.02), "d": (13.01, 80.00), "e": (13.01, 80.01), "f": (13.01, 80.02)}
LADDER_LINKS = [("a", "b"), ("b", "c"), ("d", "e"), ("e", "f"), ("a", "d"), ("b", "e"), ("c", "f")]


def _ladder(oneway: dict | None = None, highway: dict | None = None):
    oneway, highway = oneway or {}, highway or {}
    ids = {k: i + 1 for i, k in enumerate(LADDER)}
    return [
        SimpleNamespace(
            id=i, geometry=[list(LADDER[x]), list(LADDER[y])], highway=highway.get((x, y), "residential"),
            oneway=oneway.get((x, y), 0), node_a=ids[x], node_b=ids[y],
        )
        for i, (x, y) in enumerate(LADDER_LINKS)
    ]


def test_network_graph_finds_distinct_routes():
    g = NetworkGraph(_ladder())
    routes = g.routes(LADDER["a"], LADDER["c"], 3)
    assert len(routes) >= 2
    assert routes[0].duration_s <= routes[1].duration_s
    assert len({tuple(map(tuple, r.geometry)) for r in routes}) == len(routes)
    assert all(r.segments and abs(sum(m for _, m in r.segments) - r.distance_m) < 1 for r in routes)  # exact road list per route
    assert g.snap((14.0, 81.0)) == [] and not g.covers((14.0, 81.0))


def test_network_graph_honours_one_way_streets():
    # the only direct a->b link is one-way b->a, so a->b must detour through d/e
    g = NetworkGraph(_ladder(oneway={("b", "c"): 1}))
    ids = g.route_road_ids(LADDER["c"], LADDER["a"], 1)[0]  # against the one-way direction c->b
    assert LADDER_LINKS.index(("b", "c")) not in ids
    forward = g.route_road_ids(LADDER["b"], LADDER["c"], 1)[0]  # with it
    assert forward == [LADDER_LINKS.index(("b", "c"))]


def test_network_graph_prefers_faster_road_classes():
    slow = NetworkGraph(_ladder(highway={("a", "d"): "service", ("d", "e"): "service", ("e", "f"): "service"}))
    fast = NetworkGraph(_ladder(highway={("a", "d"): "primary", ("d", "e"): "primary", ("e", "f"): "primary"}))
    assert fast.routes(LADDER["a"], LADDER["f"], 1)[0].duration_s < slow.routes(LADDER["a"], LADDER["f"], 1)[0].duration_s


# ---------------------------------------------------- unknown-road handling in the route engine
def _engine():
    from app.config import load_settings

    return RouteEngine(load_settings({"data_dir": __import__("tempfile").mkdtemp()}))


def _info(**risk_by_id):
    return {int(k[1:]): {"name": f"Road {k}", "severity": r * 100, "level": "High" if r > 0.6 else "Low", "risk": r} for k, r in risk_by_id.items()}


def test_unknown_stretches_are_not_scored_as_good_or_bad():
    from app.services.routing.types import Candidate

    engine = _engine()
    info = _info(r1=0.8)  # road 1 is damaged; road 2 has no data
    prior = 0.35
    half = engine._assess(Candidate([[0, 0], [0, 1]], 1000, 100, segments=[(1, 500), (2, 500)]), SegmentIndex([]), info, prior)
    assert half.coverage == pytest.approx(0.5)
    assert half.known_risk == pytest.approx(0.8)  # the unknown half does not dilute the known stretch ("good") ...
    assert prior < half.effective_risk < 0.8  # ... and is not read as damaged either: only the neutral prior fills it
    none = engine._assess(Candidate([[0, 0], [0, 1]], 1000, 100, segments=[(2, 500), (3, 500)]), SegmentIndex([]), info, prior)
    assert none.coverage == 0 and none.known_risk is None and none.effective_risk == pytest.approx(prior)
    full = engine._assess(Candidate([[0, 0], [0, 1]], 1000, 100, segments=[(1, 1000)]), SegmentIndex([]), info, prior)
    assert full.coverage == 1 and full.known_risk == pytest.approx(0.8)


def test_unknown_prior_defaults_to_the_average_of_known_roads(client, app):
    # with no explicit setting the neutral prior is data-driven, never a hard-coded "good" value
    assert app.state.app_state.route_engine.cfg.unknown_road_risk is None


# -------------------------------------------------------------- detection
def test_iou_and_nms():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0
    a, b = Detection("pothole", 0.9, 0, 0, 10, 10), Detection("pothole", 0.6, 1, 1, 11, 11)
    assert len(nms([a, b], 0.5)) == 1
    assert len(nms([a, Detection("longitudinal_crack", 0.6, 1, 1, 11, 11)], 0.5)) == 2


def test_average_precision():
    assert _average_precision([0.9, 0.8], [1, 1], 2) == pytest.approx(1.0)
    assert _average_precision([0.9, 0.8], [1, 0], 2) == pytest.approx(0.5)
    assert _average_precision([], [], 3) == 0


def test_heuristic_detector_on_synthetic_images():
    det = HeuristicDetector()
    for seed in range(200):
        img, truth = generate_image(seed, n_elements=1)
        if truth and truth[0].label == "pothole":
            break
    else:
        pytest.fail("no synthetic pothole image found")
    res = det.detect(img)
    assert any(d.label == "pothole" and iou(d.box(), truth[0].box) > 0.5 for d in res.detections)
    assert res.experimental and "demo" in res.detector.lower()
    clean, _ = generate_image(11, n_elements=0)
    assert det.detect(clean).count == 0


def test_heuristic_detector_handles_odd_images():
    det = HeuristicDetector()
    assert det.detect(np.zeros((100, 100, 3), np.uint8)).count == 0
    assert det.detect(np.full((300, 200, 3), 255, np.uint8)).count == 0
    big = cv2.resize(generate_image(3, n_elements=1)[0], (2400, 1800))
    assert det.detect(big).width == 2400  # boxes are mapped back to the original resolution


# ------------------------------------------------------ risk model + data
def test_risk_model_orders_roads_sensibly(risk_predictor):
    predictor = risk_predictor
    base = dict(current_severity=10, max_severity_90d=12, severity_trend=0, reports_90d=1, total_reports=2, road_age_years=5, months_since_repair=6, repair_count=1, rainfall_mm_30d=40, traffic_k_per_day=2)
    bad = dict(current_severity=85, max_severity_90d=92, severity_trend=18, reports_90d=12, total_reports=20, road_age_years=22, months_since_repair=40, repair_count=1, rainfall_mm_30d=160, traffic_k_per_day=25)
    low, high = predictor.predict(base), predictor.predict(bad)
    assert 0 <= low.risk < 0.3 < 0.7 < high.risk <= 1
    assert low.level == "LOW" and high.level == "HIGH"
    assert any(f["feature"] == "current_severity" for f in high.factors)
    wetter = predictor.predict({**base, "current_severity": 50, "rainfall_mm_30d": 200}).risk
    drier = predictor.predict({**base, "current_severity": 50, "rainfall_mm_30d": 20}).risk
    assert wetter > drier


def test_condition_features_respect_repairs():
    from app.config import ConditionConfig
    from app.services import condition

    now = datetime(2026, 6, 1, tzinfo=timezone.utc)
    mk = lambda days, sev: SimpleNamespace(reported_at=now - timedelta(days=days), severity_score=sev)  # noqa: E731
    reports = [mk(100, 70), mk(40, 75), mk(5, 80)]
    cfg = ConditionConfig()
    assert condition.current_severity(reports, now, None, cfg) > 60
    # a repair 20 days ago leaves only the 5-day-old report: 0.6 * worst(77.3) + 0.4 * mean(80)
    assert condition.current_severity(reports, now, now - timedelta(days=20), cfg) == pytest.approx(78.4, abs=1.5)
    assert condition.current_severity(reports, now, now - timedelta(days=1), cfg) == 0  # repaired after every report
    assert condition.severity_trend([mk(30, 40), mk(10, 70)]) == 30
    assert condition.severity_trend([mk(10, 70)]) == 0
