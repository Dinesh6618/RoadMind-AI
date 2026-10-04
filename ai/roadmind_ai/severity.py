"""Damage-severity assessment (experimental 0-100 score).

The score is built from four transparent components that sum to at most 100:

    size     - how much of the image the damage covers (cracks are down-weighted
               because their bounding box is mostly empty road)
    type     - the worst damage type present, scaled by detector confidence
    count    - how many separate damaged areas were found
    history  - how many recent reports exist for the same road (repeat damage)

This is an AI-generated estimate for triage. It is NOT an engineering assessment.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import SeverityConfig
from .detection.types import DISPLAY_NAMES, Detection

LEVELS = ["Low", "Moderate", "High", "Critical"]

# Share of a bounding box that is typically damaged surface.
FILL_FACTOR = {
    "pothole": 0.9,
    "alligator_crack": 0.8,
    "surface_damage": 0.7,
    "transverse_crack": 0.25,
    "longitudinal_crack": 0.25,
}

DISCLAIMER = (
    "Experimental AI estimate based on a single image and the report history in RoadMind. "
    "It is not an official engineering safety assessment; roads should be inspected by qualified staff."
)


@dataclass
class SeverityResult:
    score: float
    level: str
    summary: str
    breakdown: dict[str, float] = field(default_factory=dict)
    effective_area_ratio: float = 0.0
    disclaimer: str = DISCLAIMER


def level_for(score: float, thresholds: list[float] | None = None) -> str:
    low, moderate, high = thresholds or [30, 60, 80]
    if score <= low:
        return LEVELS[0]
    if score <= moderate:
        return LEVELS[1]
    if score <= high:
        return LEVELS[2]
    return LEVELS[3]


def _size_word(ratio: float) -> str:
    if ratio >= 0.08:
        return "Large"
    if ratio >= 0.02:
        return "Medium"
    return "Small"


def detection_severity(det: Detection, image_w: int, image_h: int, config: SeverityConfig | None = None) -> tuple[float, str]:
    """Severity (0-100, level) of ONE detected damage, for the per-damage list on the result screen.

    It reuses the same ingredients as the overall score - how large the damage is, how serious its type is and how
    confident the detector is - so a small crack scores low even when a pothole in the same photo is critical.
    """
    cfg = config or SeverityConfig()
    effective = min(1.0, det.area_ratio(image_w, image_h) * FILL_FACTOR.get(det.label, 0.7))
    size = min(1.0, (effective / cfg.size_reference_ratio) ** 0.5)
    score = round(min(100.0, 100.0 * cfg.type_weights.get(det.label, 0.4) * det.confidence * (0.35 + 0.65 * size)), 1)
    return score, level_for(score, cfg.level_thresholds)


def assess(
    detections: list[Detection],
    image_w: int,
    image_h: int,
    recent_reports: int = 0,
    config: SeverityConfig | None = None,
) -> SeverityResult:
    cfg = config or SeverityConfig()
    if not detections:
        return SeverityResult(0.0, LEVELS[0], "No road damage detected", {"size": 0, "type": 0, "count": 0, "history": 0})

    effective = [d.area_ratio(image_w, image_h) * FILL_FACTOR.get(d.label, 0.7) for d in detections]
    total = min(1.0, sum(effective))
    size_pts = cfg.size_points * min(1.0, (total / cfg.size_reference_ratio) ** 0.5)
    type_pts = cfg.type_points * max(cfg.type_weights.get(d.label, 0.4) * d.confidence for d in detections)
    count_pts = cfg.count_points * min(1.0, len(detections) / cfg.count_reference)
    history_pts = cfg.history_points * min(1.0, max(0, recent_reports) / cfg.history_reference)

    score = round(min(100.0, size_pts + type_pts + count_pts + history_pts), 1)
    worst = max(range(len(detections)), key=lambda i: cfg.type_weights.get(detections[i].label, 0.4) * detections[i].confidence * (0.5 + effective[i]))
    main = detections[worst]
    summary = f"{_size_word(effective[worst])} {DISPLAY_NAMES.get(main.label, main.label).lower()}".capitalize()
    if len(detections) > 1:
        summary += f" (+{len(detections) - 1} more area{'s' if len(detections) > 2 else ''})"
    return SeverityResult(
        score=score,
        level=level_for(score, cfg.level_thresholds),
        summary=summary,
        breakdown={
            "size": round(size_pts, 1),
            "type": round(type_pts, 1),
            "count": round(count_pts, 1),
            "history": round(history_pts, 1),
        },
        effective_area_ratio=round(total, 4),
    )
