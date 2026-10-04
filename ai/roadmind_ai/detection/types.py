"""Shared types for road-damage detection."""

from __future__ import annotations

from dataclasses import dataclass, field

DAMAGE_CLASSES = [
    "pothole",
    "longitudinal_crack",
    "transverse_crack",
    "alligator_crack",
    "surface_damage",
]

DISPLAY_NAMES = {
    "pothole": "Pothole",
    "longitudinal_crack": "Longitudinal crack",
    "transverse_crack": "Transverse crack",
    "alligator_crack": "Alligator crack",
    "surface_damage": "General surface damage",
}

# RDD2022 / RDD2020 label codes -> RoadMind classes.
RDD_CLASS_MAP = {
    "D00": "longitudinal_crack",
    "D01": "longitudinal_crack",
    "D10": "transverse_crack",
    "D11": "transverse_crack",
    "D20": "alligator_crack",
    "D40": "pothole",
    "D43": "surface_damage",  # cross-walk / white-line blur
    "D44": "surface_damage",
    "D50": "surface_damage",
}


@dataclass
class Detection:
    label: str
    confidence: float  # 0..1
    x1: float  # pixel coordinates in the original image
    y1: float
    x2: float
    y2: float

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def area(self) -> float:
        return self.width * self.height

    def area_ratio(self, image_w: int, image_h: int) -> float:
        return self.area / float(max(1, image_w * image_h))

    @property
    def display_name(self) -> str:
        return DISPLAY_NAMES.get(self.label, self.label.replace("_", " ").title())

    def box(self) -> tuple[float, float, float, float]:
        return (self.x1, self.y1, self.x2, self.y2)


@dataclass
class DetectionResult:
    width: int
    height: int
    detections: list[Detection] = field(default_factory=list)
    detector: str = ""
    experimental: bool = True  # True for every AI estimate; kept explicit for the API
    note: str = ""

    @property
    def count(self) -> int:
        return len(self.detections)


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def nms(detections: list[Detection], iou_threshold: float) -> list[Detection]:
    """Class-aware non-maximum suppression."""
    kept: list[Detection] = []
    for det in sorted(detections, key=lambda d: d.confidence, reverse=True):
        if all(k.label != det.label or iou(k.box(), det.box()) < iou_threshold for k in kept):
            kept.append(det)
    return kept
