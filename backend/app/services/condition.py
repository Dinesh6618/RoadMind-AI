"""Turn a road's report history into a current severity and ML features."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, time, timedelta, timezone

from ..config import ConditionConfig
from ..models import Road, RoadReport


# The five states a road segment can be in. UNKNOWN means RoadMind has no recent data - it is NOT a
# judgement that the road is good or bad, and it is never counted as either.
STATE_BY_LEVEL = {"Low": "GOOD", "Moderate": "MODERATE", "High": "HIGH_RISK", "Critical": "CRITICAL"}
STATE_LABELS = {"GOOD": "GOOD", "MODERATE": "MODERATE", "HIGH_RISK": "HIGH RISK", "CRITICAL": "CRITICAL", "UNKNOWN": "UNKNOWN"}


def state_for(has_data: bool, severity_level: str | None) -> str:
    if not has_data or severity_level is None:
        return "UNKNOWN"
    return STATE_BY_LEVEL[severity_level]


def has_condition_data(road: Road, reports: Sequence[RoadReport], now: datetime, cfg: ConditionConfig) -> bool:
    """RoadMind has data for a road if it has a report inside the history window (after the last
    repair), or a repair completed inside that window. Otherwise the road is UNKNOWN."""
    if _window(reports, now, cfg.history_window_days, repair_cutoff(road)):
        return True
    return road.last_repair_date is not None and (now.date() - road.last_repair_date).days <= cfg.history_window_days


def repair_cutoff(road: Road) -> datetime | None:
    if road.last_repair_date is None:
        return None
    return datetime.combine(road.last_repair_date, time.min, tzinfo=timezone.utc)


def _window(reports: Sequence[RoadReport], now: datetime, days: int, cutoff: datetime | None) -> list[RoadReport]:
    start = now - timedelta(days=days)
    if cutoff is not None and cutoff > start:
        start = cutoff
    return sorted((r for r in reports if start <= r.reported_at <= now), key=lambda r: r.reported_at)


def current_severity(reports: Sequence[RoadReport], now: datetime, cutoff: datetime | None, cfg: ConditionConfig) -> float:
    """Blend of the worst recent report and the recency-weighted average severity (0-100).

    Reports older than the last completed repair, or than the history window, are ignored.
    """
    recent = _window(reports, now, cfg.history_window_days, cutoff)
    if not recent:
        return 0.0
    weights = [0.5 ** (max(0.0, (now - r.reported_at).total_seconds() / 86400) / cfg.recency_half_life_days) for r in recent]
    mean = sum(w * r.severity_score for w, r in zip(weights, recent)) / sum(weights)
    worst = max(r.severity_score * (0.4 + 0.6 * w) for w, r in zip(weights, recent))
    return round(cfg.max_weight * worst + (1 - cfg.max_weight) * mean, 1)


def severity_trend(reports_90d: Sequence[RoadReport]) -> float:
    """Later-half average minus earlier-half average severity within the window (points)."""
    n = len(reports_90d)
    if n < 2:
        return 0.0
    half = n // 2
    first = sum(r.severity_score for r in reports_90d[:half]) / half
    last = sum(r.severity_score for r in reports_90d[n - half :]) / half
    return round(last - first, 1)


def months_since_repair(road: Road, now: datetime) -> float:
    if road.last_repair_date is None:
        return min(road.age_years * 12, 96.0)
    return min(96.0, max(0.0, (now.date() - road.last_repair_date).days / 30.4))


def build_features(road: Road, reports: Sequence[RoadReport], now: datetime, cfg: ConditionConfig) -> dict:
    """Feature row for the deterioration-risk model (see roadmind_ai.prediction.features)."""
    cutoff = repair_cutoff(road)
    recent = _window(reports, now, 90, cutoff)
    return {
        "current_severity": current_severity(reports, now, cutoff, cfg),
        "max_severity_90d": max((r.severity_score for r in recent), default=0.0),
        "severity_trend": severity_trend(recent),
        "reports_90d": len(recent),
        "total_reports": len(reports),
        "road_age_years": road.age_years,
        "months_since_repair": round(months_since_repair(road, now), 1),
        "repair_count": road.repair_count,
        "rainfall_mm_30d": road.rainfall_mm_30d,
        "traffic_k_per_day": road.daily_traffic / 1000.0,
    }


def traffic_level(daily_traffic: int) -> str:
    if daily_traffic >= 15000:
        return "High"
    if daily_traffic >= 6000:
        return "Medium"
    return "Low"
