"""Maintenance-priority score (0-100) and recommended action.

    danger   = w_sev * severity + w_risk * predicted_risk                 (both 0..1)
    exposure = weighted mean of: recent reports, traffic, nearby schools/hospitals,
               people potentially affected, time since last repair        (each 0..1)
    priority = 100 * danger * (base + swing * exposure)                   (clipped to 0..100)

Damage that is both severe and likely to get worse sets the base score; how many people it
affects and how neglected the road is can raise it by up to +15 % or lower it by 15 %.
All weights and reference values live in config/roadmind.yaml.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..config import PriorityConfig

FACILITY_PEOPLE = 800  # assumed extra daily pedestrians/visitors per nearby school, hospital or college

ACTIONS = {
    "Immediate": "Dispatch an inspection within 24-48 hours and schedule urgent repair.",
    "High Priority": "Schedule inspection this week and plan repair within two weeks.",
    "Medium Priority": "Add to the next maintenance cycle and re-inspect within 30 days.",
    "Monitor": "No action needed now - keep monitoring incoming reports.",
}


@dataclass
class PriorityResult:
    score: float
    category: str
    action: str
    components: dict[str, float] = field(default_factory=dict)


def category_for(score: float, cfg: PriorityConfig) -> str:
    if score >= cfg.immediate_min:
        return "Immediate"
    if score >= cfg.high_min:
        return "High Priority"
    if score >= cfg.medium_min:
        return "Medium Priority"
    return "Monitor"


def _wmean(values: dict[str, float], weights: dict[str, float]) -> float:
    total = sum(weights.get(k, 0.0) for k in values) or 1.0
    return sum(weights.get(k, 0.0) * v for k, v in values.items()) / total


def compute_priority(
    *,
    severity: float,
    risk: float,
    reports_recent: int,
    daily_traffic: float,
    facilities: int,
    months_since_repair: float,
    cfg: PriorityConfig,
) -> PriorityResult:
    people = daily_traffic * cfg.people_per_vehicle + facilities * FACILITY_PEOPLE
    sev_f = min(1.0, max(0.0, severity / 100.0))
    risk_f = min(1.0, max(0.0, risk))
    exposure_factors = {
        "reports": min(1.0, reports_recent / cfg.reports_reference),
        "traffic": min(1.0, daily_traffic / cfg.traffic_reference),
        "facilities": min(1.0, facilities / cfg.facilities_reference),
        "people_affected": min(1.0, people / cfg.people_reference),
        "time_since_repair": min(1.0, months_since_repair / cfg.repair_reference_months),
    }
    danger = _wmean({"severity": sev_f, "risk": risk_f}, cfg.danger_weights)
    exposure = _wmean(exposure_factors, cfg.exposure_weights)
    multiplier = cfg.base_multiplier + cfg.exposure_swing * exposure
    score = 100.0 * danger * multiplier
    # An undamaged road never needs urgent work, whatever its traffic or age.
    if severity < 10:
        score = min(score, cfg.medium_min - 1)
    score = round(min(100.0, max(0.0, score)), 1)
    category = category_for(score, cfg)
    return PriorityResult(
        score=score,
        category=category,
        action=ACTIONS[category],
        components={
            "severity": round(sev_f * 100, 1),
            "risk": round(risk_f * 100, 1),
            "danger": round(danger * 100, 1),
            **{k: round(v * 100, 1) for k, v in exposure_factors.items()},
            "exposure": round(exposure * 100, 1),
            "multiplier": round(multiplier, 3),
        },
    )
