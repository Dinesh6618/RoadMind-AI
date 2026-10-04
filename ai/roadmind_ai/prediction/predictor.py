"""Load the trained model and score roads."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import joblib
import numpy as np

from ..config import RiskModelConfig
from .features import FEATURES, LABELS, UNITS, to_matrix


@dataclass
class RiskPrediction:
    risk: float  # probability 0..1 that the road deteriorates within the horizon
    level: str  # LOW | MEDIUM | HIGH
    factors: list[dict] = field(default_factory=list)
    model_name: str = ""
    model_version: str = ""


class RiskPredictor:
    def __init__(self, bundle: dict, config: RiskModelConfig | None = None):
        self.cfg = config or RiskModelConfig()
        self.model = bundle["model"]
        self.name: str = bundle["name"]
        self.version: str = bundle["version"]
        self.medians = np.asarray(bundle["medians"], dtype=np.float64)
        if list(bundle["features"]) != FEATURES:
            raise ValueError("Saved model was trained with a different feature set; retrain it.")

    @classmethod
    def load(cls, path: Path, config: RiskModelConfig | None = None) -> "RiskPredictor":
        return cls(joblib.load(path), config)

    def level_for(self, risk: float) -> str:
        if risk >= self.cfg.high_threshold:
            return "HIGH"
        if risk >= self.cfg.medium_threshold:
            return "MEDIUM"
        return "LOW"

    def predict_many(self, rows: list[dict], explain: bool = True) -> list[RiskPrediction]:
        if not rows:
            return []
        X = to_matrix(rows)
        proba = self.model.predict_proba(X)[:, 1]
        # What-if explanation: how much does the probability fall if one feature is set to the
        # training median? Positive contribution = that feature pushes the risk up.
        contrib = np.zeros_like(X)
        if explain:
            for j in range(X.shape[1]):
                Xj = X.copy()
                Xj[:, j] = self.medians[j]
                contrib[:, j] = proba - self.model.predict_proba(Xj)[:, 1]
        out = []
        for i, p in enumerate(proba):
            factors = []
            for j in np.argsort(-np.abs(contrib[i]))[:4]:
                if abs(contrib[i, j]) < 0.01:
                    continue
                name = FEATURES[j]
                value = X[i, j]
                factors.append(
                    {
                        "feature": name,
                        "label": LABELS[name],
                        "value": round(float(value), 1),
                        "display": f"{value:.0f}{UNITS[name]}" if abs(value) >= 10 else f"{value:.1f}{UNITS[name]}",
                        "effect_points": round(float(contrib[i, j]) * 100, 1),
                    }
                )
            risk = float(p)
            out.append(RiskPrediction(round(risk, 4), self.level_for(risk), factors, self.name, self.version))
        return out

    def predict(self, row: dict) -> RiskPrediction:
        return self.predict_many([row])[0]
