"""Pick the best available detector."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

import numpy as np

from ..config import DetectionConfig
from .heuristic import HeuristicDetector
from .types import DetectionResult

log = logging.getLogger("roadmind.detection")


class Detector(Protocol):
    name: str
    is_demo: bool

    def detect(self, image_bgr: np.ndarray) -> DetectionResult: ...


def load_detector(config: DetectionConfig, repo_root: Path) -> Detector:
    """`auto` uses YOLO when weights and ultralytics are present, else the OpenCV fallback."""
    backend = config.backend.lower()
    if backend == "heuristic":
        return HeuristicDetector(config)

    weights = Path(config.weights_path)
    if not weights.is_absolute():
        weights = repo_root / weights
    if weights.exists():
        try:
            from .yolo import YoloDetector

            return YoloDetector(weights, config)
        except Exception as exc:  # ultralytics missing, corrupt weights, ...
            if backend == "yolo":
                raise
            log.warning("YOLO weights found at %s but could not be loaded (%s); using fallback.", weights, exc)
    elif backend == "yolo":
        raise FileNotFoundError(f"detection.backend is 'yolo' but no weights exist at {weights}")
    else:
        log.info("No YOLO weights at %s - using the OpenCV heuristic fallback detector.", weights)
    return HeuristicDetector(config)
