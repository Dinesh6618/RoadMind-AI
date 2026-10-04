"""Synthetic training data for the deterioration-risk model.

No public dataset links road-condition history to later deterioration for an arbitrary
city, so the demo model is trained on data drawn from an explicit, documented process.
Label = "road's severity rises materially (>= 10 points, or reaches Critical) within the
next 90 days". The relationship between features and label is an *assumption* encoded
below (damaged, wet, busy, old, un-repaired roads with an upward trend are more likely to
get worse) plus noise - so the model learns that assumption, not real-world physics.
Replace this with real inspection history when it exists (see docs/MODEL_TRAINING.md).
"""

from __future__ import annotations

import numpy as np

from .features import FEATURES


def sample_features(rng: np.random.Generator, n: int) -> np.ndarray:
    severity = np.clip(rng.beta(1.6, 2.4, n) * 100, 0, 100)
    reports_90d = rng.poisson(0.5 + severity / 100 * 9)
    total_reports = reports_90d + rng.poisson(rng.uniform(0, 12, n))
    age = rng.uniform(0.5, 30, n)
    months_since_repair = np.minimum(rng.uniform(0, 72, n), age * 12)
    repair_count = rng.poisson(age / 9)
    rainfall = rng.gamma(2.0, 45, n)
    traffic = np.clip(rng.lognormal(np.log(9), 0.8, n), 0.3, 60)
    trend = rng.normal(1 + severity * 0.05, 8)
    max_sev = np.clip(severity + np.abs(rng.normal(0, 9, n)), 0, 100)
    columns = {
        "current_severity": severity,
        "max_severity_90d": max_sev,
        "severity_trend": trend,
        "reports_90d": reports_90d,
        "total_reports": total_reports,
        "road_age_years": age,
        "months_since_repair": months_since_repair,
        "repair_count": repair_count,
        "rainfall_mm_30d": rainfall,
        "traffic_k_per_day": traffic,
    }
    return np.column_stack([columns[name] for name in FEATURES])


def deterioration_logit(X: np.ndarray) -> np.ndarray:
    c = {name: X[:, i] for i, name in enumerate(FEATURES)}
    return (
        -5.1
        + 0.034 * c["current_severity"]
        + 0.012 * c["max_severity_90d"]
        + 0.050 * c["severity_trend"]
        + 0.060 * c["reports_90d"]
        + 0.004 * c["rainfall_mm_30d"]
        + 0.011 * c["months_since_repair"]
        + 0.014 * c["road_age_years"]
        + 0.012 * c["traffic_k_per_day"]
        - 0.04 * c["repair_count"]
        # Assumed non-linear effects: water gets into already-cracked pavement (rain x severity),
        # and badly damaged roads in heavy traffic fail faster than the linear terms suggest.
        + 0.00018 * c["rainfall_mm_30d"] * c["current_severity"]
        + 0.0009 * c["traffic_k_per_day"] * np.maximum(c["current_severity"] - 55, 0)
    )


def generate(n: int = 8000, seed: int = 7, noise: float = 0.9) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    X = sample_features(rng, n)
    logit = deterioration_logit(X) + rng.normal(0, noise, n)
    y = (rng.random(n) < 1.0 / (1.0 + np.exp(-logit))).astype(int)
    return X, y
