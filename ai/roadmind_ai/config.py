"""Typed configuration for the AI modules (defaults mirror config/roadmind.yaml)."""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from typing import Any, TypeVar

T = TypeVar("T")


def from_dict(cls: type[T], data: dict[str, Any] | None) -> T:
    """Build a dataclass from a dict, ignoring unknown keys so old configs keep working."""
    data = data or {}
    names = {f.name for f in fields(cls)}  # type: ignore[arg-type]
    return cls(**{k: v for k, v in data.items() if k in names})  # type: ignore[call-arg]


@dataclass
class DetectionConfig:
    backend: str = "auto"  # auto | yolo | heuristic
    weights_path: str = "ai/models/road_damage_yolo.pt"
    confidence_threshold: float = 0.30
    iou_threshold: float = 0.45
    image_size: int = 640
    max_detections: int = 25


@dataclass
class SeverityConfig:
    size_points: float = 50
    type_points: float = 25
    count_points: float = 15
    history_points: float = 15
    size_reference_ratio: float = 0.15
    count_reference: int = 6
    history_reference: int = 10
    history_window_days: int = 90
    type_weights: dict[str, float] = field(
        default_factory=lambda: {
            "pothole": 1.0,
            "alligator_crack": 0.85,
            "transverse_crack": 0.55,
            "longitudinal_crack": 0.5,
            "surface_damage": 0.4,
        }
    )
    level_thresholds: list[float] = field(default_factory=lambda: [30, 60, 80])


@dataclass
class RiskModelConfig:
    model_path: str = "ai/models/risk_model.joblib"
    metrics_path: str = "ai/models/risk_metrics.json"
    high_threshold: float = 0.70
    medium_threshold: float = 0.40
    deterioration_flag_threshold: float = 0.50
    horizon_days: int = 90
