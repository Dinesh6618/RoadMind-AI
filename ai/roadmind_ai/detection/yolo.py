"""YOLO (Ultralytics) detector wrapper.

Requires `pip install -r requirements-yolo.txt` and trained weights at
detection.weights_path. Train them with `python -m roadmind_ai.detection.train_yolo`.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..config import DetectionConfig
from .types import DAMAGE_CLASSES, RDD_CLASS_MAP, Detection, DetectionResult


def normalize_label(name: str) -> str:
    """Map whatever class name the weights were trained with onto RoadMind's classes."""
    key = name.strip()
    if key in DAMAGE_CLASSES:
        return key
    if key.upper() in RDD_CLASS_MAP:
        return RDD_CLASS_MAP[key.upper()]
    low = key.lower().replace("-", "_").replace(" ", "_")
    if "pothole" in low:
        return "pothole"
    if "alligator" in low or "fatigue" in low:
        return "alligator_crack"
    if "transverse" in low:
        return "transverse_crack"
    if "longitudinal" in low or low in {"crack", "cracks"}:
        return "longitudinal_crack"
    return "surface_damage"


class YoloDetector:
    is_demo = False

    def __init__(self, weights_path: Path, config: DetectionConfig | None = None):
        from ultralytics import YOLO  # imported lazily: torch is an optional dependency

        self.cfg = config or DetectionConfig()
        self.weights_path = Path(weights_path)
        self.model = YOLO(str(self.weights_path))
        self.names = self.model.names
        self.name = f"YOLO ({self.weights_path.name})"

    def detect(self, image_bgr: np.ndarray) -> DetectionResult:
        h, w = image_bgr.shape[:2]
        result = self.model.predict(
            image_bgr,
            imgsz=self.cfg.image_size,
            conf=self.cfg.confidence_threshold,
            iou=self.cfg.iou_threshold,
            max_det=self.cfg.max_detections,
            verbose=False,
        )[0]
        dets: list[Detection] = []
        for box in result.boxes:
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
            label = normalize_label(str(self.names[int(box.cls[0])]))
            dets.append(Detection(label, round(float(box.conf[0]), 3), x1, y1, x2, y2))
        dets.sort(key=lambda d: d.confidence, reverse=True)
        return DetectionResult(
            width=w,
            height=h,
            detections=dets,
            detector=self.name,
            experimental=True,
            note="Model output is an estimate; confidence is the model's score, not a guarantee.",
        )
