"""Synthetic road-surface images with ground-truth boxes.

Used for (a) demo sample images that need no external dataset, (b) unit tests and
(c) a labelled evaluation set for the OpenCV fallback detector. These images are
procedurally drawn - metrics measured on them say nothing about real-world accuracy.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .types import DAMAGE_CLASSES, iou


@dataclass
class GroundTruth:
    label: str
    box: tuple[float, float, float, float]


def _asphalt(rng: np.random.Generator, w: int, h: int) -> np.ndarray:
    base = rng.uniform(92, 125)
    img = base + rng.normal(0, 6, (h, w))
    low = cv2.resize(rng.normal(0, 1, (4, 5)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    img += low * 7
    coarse = cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), 1.3) * 9
    img += coarse
    bgr = np.stack([img * 0.95, img * 0.98, img], axis=-1).astype(np.float32)
    return bgr


def _add_distractors(img: np.ndarray, rng: np.random.Generator) -> None:
    h, w = img.shape[:2]
    if rng.random() < 0.5:  # dashed lane marking - bright, must not be reported as damage
        x = int(rng.uniform(0.3, 0.7) * w)
        for y in range(0, h, 70):
            cv2.line(img, (x, y), (x + int(rng.integers(-3, 4)), y + 38), (205, 205, 205), 5, cv2.LINE_AA)
    if rng.random() < 0.5:  # soft shadow band
        mask = np.zeros((h, w), np.float32)
        x0 = int(rng.uniform(0, w))
        cv2.line(mask, (x0, 0), (x0 + int(rng.integers(-150, 150)), h), 1.0, int(rng.uniform(40, 110)))
        mask = cv2.GaussianBlur(mask, (0, 0), 25)
        img *= (1.0 - 0.22 * mask)[..., None]


def _blend(img: np.ndarray, mask: np.ndarray, color: float | np.ndarray, strength: float = 1.0) -> None:
    m = (mask.astype(np.float32) / 255.0 * strength)[..., None]
    if np.isscalar(color):
        color = np.full(3, float(color), np.float32) * np.array([0.95, 0.98, 1.0], np.float32)
    img[:] = img * (1.0 - m) + np.asarray(color, np.float32) * m


def _mask_box(mask: np.ndarray, pad: int = 2) -> tuple[float, float, float, float] | None:
    ys, xs = np.nonzero(mask > 40)
    if len(xs) == 0:
        return None
    h, w = mask.shape
    return (
        float(max(0, xs.min() - pad)),
        float(max(0, ys.min() - pad)),
        float(min(w - 1, xs.max() + pad)),
        float(min(h - 1, ys.max() + pad)),
    )


def _pothole(img, rng, w, h):
    rx = rng.uniform(0.05, 0.17) * w
    ry = rx * rng.uniform(0.55, 0.95)
    cx = rng.uniform(rx + 10, w - rx - 10)
    cy = rng.uniform(ry + 10, h - ry - 10)
    n = 28
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
    rad = 1 + rng.normal(0, 0.14, n)
    rad = np.convolve(np.r_[rad, rad[:2]], [0.25, 0.5, 0.25], mode="valid")[:n]
    pts = np.stack([cx + rx * rad * np.cos(ang), cy + ry * rad * np.sin(ang)], axis=1).astype(np.int32)
    mask = np.zeros((h, w), np.uint8)
    cv2.fillPoly(mask, [pts], 255)
    soft = cv2.GaussianBlur(mask, (0, 0), 2.0)
    dark = rng.uniform(22, 52)
    interior = dark + cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), 3) * 10
    for c in range(3):
        m = soft.astype(np.float32) / 255.0
        img[..., c] = img[..., c] * (1 - m) + interior * (0.95, 0.98, 1.0)[c] * m
    rim = cv2.GaussianBlur(cv2.dilate(mask, np.ones((9, 9), np.uint8)) - mask, (0, 0), 2.5).astype(np.float32) / 255.0
    img += rim[..., None] * 22
    return _mask_box(mask, pad=3)


def _walk(rng, start, direction_deg, steps, step_len, jitter_deg):
    pts = [np.array(start, np.float32)]
    ang = np.deg2rad(direction_deg)
    for _ in range(steps):
        ang += np.deg2rad(rng.normal(0, jitter_deg))
        pts.append(pts[-1] + step_len * np.array([np.cos(ang), np.sin(ang)], np.float32))
    return np.array(pts)


def _crack(img, rng, w, h, kind):
    steps = int(rng.integers(26, 44))
    step_len = rng.uniform(6, 10)
    if kind == "longitudinal_crack":
        start = (rng.uniform(0.15, 0.85) * w, rng.uniform(0.0, 0.25) * h)
        direction = 90 + rng.normal(0, 6)
    else:
        start = (rng.uniform(0.0, 0.25) * w, rng.uniform(0.2, 0.85) * h)
        direction = 0 + rng.normal(0, 6)
    mask = np.zeros((h, w), np.uint8)
    thick = int(rng.integers(1, 4))
    main = _walk(rng, start, direction, steps, step_len, 7)
    cv2.polylines(mask, [main.astype(np.int32)], False, 255, thick, cv2.LINE_AA)
    for _ in range(int(rng.integers(0, 3))):  # small side branches
        i = int(rng.integers(5, len(main) - 5))
        br = _walk(rng, main[i], direction + rng.choice([-1, 1]) * rng.uniform(25, 55), int(rng.integers(4, 9)), step_len, 9)
        cv2.polylines(mask, [br.astype(np.int32)], False, 255, max(1, thick - 1), cv2.LINE_AA)
    mask = cv2.GaussianBlur(mask, (0, 0), 0.7)
    _blend(img, mask, rng.uniform(25, 55), 0.95)
    box = _mask_box(mask)
    if box is None:
        return None
    # Keep the crack long enough to be a meaningful ground-truth object.
    if max(box[2] - box[0], box[3] - box[1]) < 60:
        return None
    return box


def _alligator(img, rng, w, h):
    rx = rng.uniform(0.09, 0.17) * w
    ry = rx * rng.uniform(0.6, 1.0)
    cx = rng.uniform(rx + 10, w - rx - 10)
    cy = rng.uniform(ry + 10, h - ry - 10)
    region = np.zeros((h, w), np.uint8)
    cv2.ellipse(region, (int(cx), int(cy)), (int(rx), int(ry)), 0, 0, 360, 255, -1)
    pts = []
    for _ in range(int(rng.integers(26, 40))):
        a, r = rng.uniform(0, 2 * np.pi), np.sqrt(rng.uniform(0, 1))
        pts.append((float(cx + rx * r * np.cos(a)), float(cy + ry * r * np.sin(a))))
    rect = (0, 0, w, h)
    sub = cv2.Subdiv2D(rect)
    for p in pts:
        sub.insert(p)
    mesh = np.zeros((h, w), np.uint8)
    for t in sub.getTriangleList():
        tri = t.reshape(3, 2).astype(np.int32)
        if tri.min() < 0 or tri[:, 0].max() >= w or tri[:, 1].max() >= h:
            continue
        cv2.polylines(mesh, [tri], True, 255, 1, cv2.LINE_AA)
    mask = cv2.bitwise_and(mesh, region)
    mask = cv2.GaussianBlur(mask, (0, 0), 0.6)
    _blend(img, mask, rng.uniform(25, 50), 0.95)
    return _mask_box(mask, pad=4)


def generate_image(seed: int, width: int = 640, height: int = 480, n_elements: int | None = None):
    """Return (BGR uint8 image, [GroundTruth])."""
    rng = np.random.default_rng(seed)
    img = _asphalt(rng, width, height)
    _add_distractors(img, rng)
    if n_elements is None:
        n_elements = int(rng.choice([0, 1, 1, 1, 2, 2, 3]))
    truth: list[GroundTruth] = []
    attempts = 0
    while len(truth) < n_elements and attempts < 40:
        attempts += 1
        label = DAMAGE_CLASSES[int(rng.integers(0, 4))]  # synthetic set covers the 4 specific classes
        trial = img.copy()
        if label == "pothole":
            box = _pothole(trial, rng, width, height)
        elif label == "alligator_crack":
            box = _alligator(trial, rng, width, height)
        else:
            box = _crack(trial, rng, width, height, label)
        if box is None:
            continue
        if any(iou(box, g.box) > 0.0 for g in truth):
            continue
        img[:] = trial
        truth.append(GroundTruth(label, box))
    out = np.clip(img, 0, 255).astype(np.uint8)
    out = cv2.GaussianBlur(out, (0, 0), 0.5)
    return out, truth


def generate_dataset(out_dir: Path, n: int, seed: int = 0, prefix: str = "synthetic") -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    labels: dict[str, dict] = {}
    for i in range(n):
        img, truth = generate_image(seed * 100_000 + i)
        name = f"{prefix}_{i:03d}.jpg"
        cv2.imwrite(str(out_dir / name), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        labels[name] = {
            "width": img.shape[1],
            "height": img.shape[0],
            "boxes": [{"label": g.label, "bbox": [round(v, 1) for v in g.box]} for g in truth],
        }
    (out_dir / "labels.json").write_text(json.dumps(labels, indent=1), encoding="utf-8")
    return labels
