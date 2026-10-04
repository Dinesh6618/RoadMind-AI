"""Draw detections on an image."""

from __future__ import annotations

import cv2
import numpy as np

from .types import Detection

COLORS_BGR = {
    "pothole": (60, 60, 235),
    "longitudinal_crack": (40, 150, 245),
    "transverse_crack": (30, 215, 250),
    "alligator_crack": (200, 70, 220),
    "surface_damage": (235, 150, 50),
}


def annotate(image_bgr: np.ndarray, detections: list[Detection]) -> np.ndarray:
    out = image_bgr.copy()
    h, w = out.shape[:2]
    thickness = max(2, int(round(min(h, w) / 220)))
    font_scale = max(0.5, min(h, w) / 900)
    for d in detections:
        color = COLORS_BGR.get(d.label, (255, 255, 255))
        p1, p2 = (int(d.x1), int(d.y1)), (int(d.x2), int(d.y2))
        cv2.rectangle(out, p1, p2, color, thickness, cv2.LINE_AA)
        text = f"{d.display_name} {d.confidence * 100:.0f}%"
        (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 1)
        top = max(0, p1[1] - th - base - 4)
        cv2.rectangle(out, (p1[0], top), (p1[0] + tw + 8, top + th + base + 4), color, -1)
        cv2.putText(out, text, (p1[0] + 4, top + th + 1), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), 1, cv2.LINE_AA)
    return out
