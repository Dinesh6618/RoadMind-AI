"""Feature definition shared by training and inference."""

from __future__ import annotations

import numpy as np

FEATURES = [
    "current_severity",
    "max_severity_90d",
    "severity_trend",
    "reports_90d",
    "total_reports",
    "road_age_years",
    "months_since_repair",
    "repair_count",
    "rainfall_mm_30d",
    "traffic_k_per_day",
]

LABELS = {
    "current_severity": "Current severity",
    "max_severity_90d": "Worst recent severity",
    "severity_trend": "Damage progression (90 d)",
    "reports_90d": "Recent reports (90 d)",
    "total_reports": "Total reports",
    "road_age_years": "Road age",
    "months_since_repair": "Months since last repair",
    "repair_count": "Past repairs",
    "rainfall_mm_30d": "Rainfall (last 30 d)",
    "traffic_k_per_day": "Traffic (1000 vehicles/day)",
}

UNITS = {
    "current_severity": "/100",
    "max_severity_90d": "/100",
    "severity_trend": " pts",
    "reports_90d": "",
    "total_reports": "",
    "road_age_years": " yr",
    "months_since_repair": " mo",
    "repair_count": "",
    "rainfall_mm_30d": " mm",
    "traffic_k_per_day": "k",
}


def to_vector(row: dict) -> np.ndarray:
    return np.array([float(row[name]) for name in FEATURES], dtype=np.float64)


def to_matrix(rows: list[dict]) -> np.ndarray:
    return np.vstack([to_vector(r) for r in rows]) if rows else np.zeros((0, len(FEATURES)))
