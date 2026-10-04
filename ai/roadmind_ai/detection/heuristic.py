"""Classical-vision fallback detector (OpenCV only, no trained weights).

This is a *demo* detector so the whole platform runs end to end without a GPU or a
downloaded dataset. It looks for
  * potholes  - large compact regions darker than the surrounding surface,
  * cracks    - thin dark elongated structures (black-hat filter), classed as
                longitudinal / transverse from their direction (assumes the camera
                looks along the road, so travel direction is "up" in the image),
  * alligator - crack networks that enclose several cells,
  * general surface damage - large irregular dark patches.
Its "confidence" is a heuristic score built from contrast, shape and size, not a
calibrated probability. Real deployments should train YOLO (see train_yolo.py).
"""

from __future__ import annotations

import cv2
import numpy as np

from ..config import DetectionConfig
from .types import Detection, DetectionResult, nms

NAME = "OpenCV heuristic detector (demo mode)"


def _clip01(x: float) -> float:
    return float(min(1.0, max(0.0, x)))


class HeuristicDetector:
    name = NAME
    is_demo = True

    def __init__(self, config: DetectionConfig | None = None):
        self.cfg = config or DetectionConfig()

    # ------------------------------------------------------------------ public
    def detect(self, image_bgr: np.ndarray) -> DetectionResult:
        h0, w0 = image_bgr.shape[:2]
        scale = min(1.0, self.cfg.image_size / float(max(h0, w0)))
        img = cv2.resize(image_bgr, (int(w0 * scale), int(h0 * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else image_bgr
        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        dets: list[Detection] = []
        pothole_mask = np.zeros((h, w), np.uint8)
        dets += self._dark_regions(gray, pothole_mask)
        dets += self._cracks(gray, pothole_mask)

        dets = nms(dets, self.cfg.iou_threshold)
        dets = [d for d in dets if d.confidence >= self.cfg.confidence_threshold]
        dets.sort(key=lambda d: d.confidence, reverse=True)
        dets = dets[: self.cfg.max_detections]

        inv = 1.0 / scale
        for d in dets:
            d.x1, d.y1, d.x2, d.y2 = d.x1 * inv, d.y1 * inv, d.x2 * inv, d.y2 * inv
            d.confidence = round(d.confidence, 3)
        return DetectionResult(
            width=w0,
            height=h0,
            detections=dets,
            detector=self.name,
            experimental=True,
            note="Heuristic scores are not calibrated probabilities. Load trained YOLO weights for real use.",
        )

    # --------------------------------------------------------------- potholes
    def _dark_regions(self, gray: np.ndarray, out_mask: np.ndarray) -> list[Detection]:
        h, w = gray.shape
        smooth = cv2.GaussianBlur(gray.astype(np.float32), (0, 0), 2.0)
        med = float(np.median(smooth))
        # Estimate the illumination of the *intact* surface by ignoring dark outliers.
        ref = np.where(smooth < med - 15, med, smooth)
        bg = cv2.GaussianBlur(ref, (0, 0), 50)
        diff = bg - smooth
        mask = (diff > 30).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        dets: list[Detection] = []
        image_area = float(w * h)
        for i in range(1, n):
            x, y, bw, bh, area = stats[i]
            if area < 0.0015 * image_area or area > 0.6 * image_area:
                continue
            comp = (labels == i).astype(np.uint8)
            contours, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            cnt = max(contours, key=cv2.contourArea)
            hull_area = max(1.0, cv2.contourArea(cv2.convexHull(cnt)))
            solidity = cv2.contourArea(cnt) / hull_area
            aspect = max(bw, bh) / float(max(1, min(bw, bh)))
            contrast = _clip01(float(diff[comp > 0].mean()) / 70.0)
            size_term = _clip01(area / (0.03 * image_area))
            if aspect > 5.0:
                continue  # too stretched: handled by the crack branch
            if solidity >= 0.72:
                label = "pothole"
                conf = 0.30 + 0.30 * contrast + 0.28 * solidity + 0.10 * size_term
            elif area > 0.012 * image_area:
                label = "surface_damage"
                conf = 0.28 + 0.25 * contrast + 0.2 * solidity + 0.05 * size_term
            else:
                continue
            cv2.drawContours(out_mask, [cnt], -1, 255, -1)
            dets.append(Detection(label, min(conf, 0.97), float(x), float(y), float(x + bw), float(y + bh)))
        return dets

    # ------------------------------------------------------------------ cracks
    def _cracks(self, gray: np.ndarray, pothole_mask: np.ndarray) -> list[Detection]:
        h, w = gray.shape
        diag = float(np.hypot(w, h))
        blur = cv2.GaussianBlur(gray, (0, 0), 1.0)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17))
        bh = cv2.morphologyEx(blur, cv2.MORPH_BLACKHAT, kernel).astype(np.float32)
        binary = (bh > 20).astype(np.uint8) * 255
        guard = cv2.dilate(pothole_mask, np.ones((25, 25), np.uint8))
        binary[guard > 0] = 0
        # discard isolated speckle before linking
        n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
        keep = np.zeros(n, bool)
        keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= 10
        binary = (keep[labels] * 255).astype(np.uint8)
        linked = cv2.dilate(binary, np.ones((3, 3), np.uint8))

        dets: list[Detection] = []
        contours, hierarchy = cv2.findContours(linked, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            return dets
        hierarchy = hierarchy[0]
        for idx, cnt in enumerate(contours):
            if hierarchy[idx][3] != -1:  # inner contour (a hole)
                continue
            x, y, bw, bh_ = cv2.boundingRect(cnt)
            holes = 0
            child = hierarchy[idx][2]
            while child != -1:
                if cv2.contourArea(contours[child]) >= 30:
                    holes += 1
                child = hierarchy[child][0]
            comp_mask = np.zeros((h, w), np.uint8)
            cv2.drawContours(comp_mask, [cnt], -1, 255, -1)
            px = (comp_mask > 0) & (binary > 0)
            ys, xs = np.nonzero(px)
            if len(xs) < 12:
                continue
            strength = _clip01(float(bh[ys, xs].mean()) / 55.0)
            if holes >= 3 and max(bw, bh_) > 0.08 * diag:
                fill = _clip01(len(xs) / float(max(1, bw * bh_)) / 0.25)
                conf = 0.40 + 0.25 * strength + 0.2 * _clip01(holes / 8.0) + 0.1 * fill
                dets.append(Detection("alligator_crack", min(conf, 0.95), x, y, x + bw, y + bh_))
                continue
            pts = np.stack([xs, ys], axis=1).astype(np.float32)
            mean = pts.mean(axis=0)
            cov = np.cov((pts - mean).T)
            evals, evecs = np.linalg.eigh(cov)
            major = evecs[:, 1]
            along = (pts - mean) @ major
            length = float(along.max() - along.min())
            across = (pts - mean) @ evecs[:, 0]
            thickness = float(across.max() - across.min()) + 1.0
            if length < 0.10 * diag or length / thickness < 4.0:
                continue
            angle = abs(np.degrees(np.arctan2(major[1], major[0])))  # 0 = horizontal, 90 = vertical
            label = "longitudinal_crack" if 45.0 <= angle <= 135.0 else "transverse_crack"
            conf = 0.38 + 0.28 * strength + 0.30 * _clip01(length / (0.40 * diag))
            dets.append(Detection(label, min(conf, 0.95), x, y, x + bw, y + bh_))
        return dets
