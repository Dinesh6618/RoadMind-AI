"""Detector evaluation: precision, recall, F1 and mAP@0.5 on a labelled image set.

    cd ai
    python -m roadmind_ai.detection.evaluate                       # synthetic set, fallback detector
    python -m roadmind_ai.detection.evaluate --images DIR          # DIR/labels.json in the format
                                                                   # written by synthetic.generate_dataset
"""

from __future__ import annotations

import argparse
import json
import tempfile
from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from .. import AI_DIR, MODELS_DIR
from ..config import DetectionConfig
from .heuristic import HeuristicDetector
from .synthetic import generate_dataset
from .types import DAMAGE_CLASSES, iou

IOU_MATCH = 0.5


def _average_precision(scores: list[float], tps: list[int], n_gt: int) -> float:
    """All-point interpolated AP (PASCAL VOC 2010+ style)."""
    if n_gt == 0 or not scores:
        return 0.0
    order = np.argsort(-np.asarray(scores))
    tp = np.asarray(tps)[order]
    fp = 1 - tp
    tp_c, fp_c = np.cumsum(tp), np.cumsum(fp)
    recall = tp_c / n_gt
    precision = tp_c / np.maximum(tp_c + fp_c, 1e-9)
    mrec = np.concatenate([[0.0], recall, [1.0]])
    mpre = np.concatenate([[1.0], precision, [0.0]])
    for i in range(len(mpre) - 2, -1, -1):
        mpre[i] = max(mpre[i], mpre[i + 1])
    idx = np.where(mrec[1:] != mrec[:-1])[0]
    return float(np.sum((mrec[idx + 1] - mrec[idx]) * mpre[idx + 1]))


def evaluate(detector, images_dir: Path, labels: dict, operating_conf: float) -> dict:
    # (confidence, is_true_positive) per class, over every prediction made at low confidence
    scored: dict[str, list[tuple[float, int]]] = defaultdict(list)
    n_gt: dict[str, int] = defaultdict(int)

    for name, meta in labels.items():
        img = cv2.imread(str(images_dir / name))
        if img is None:
            continue
        result = detector.detect(img)
        gts = [(b["label"], tuple(b["bbox"])) for b in meta["boxes"]]
        for label, _ in gts:
            n_gt[label] += 1
        matched: set[int] = set()
        for det in sorted(result.detections, key=lambda d: d.confidence, reverse=True):
            best, best_iou = -1, IOU_MATCH
            for j, (label, box) in enumerate(gts):
                if j in matched or label != det.label:
                    continue
                v = iou(det.box(), box)
                if v >= best_iou:
                    best, best_iou = j, v
            if best >= 0:
                matched.add(best)
            scored[det.label].append((det.confidence, 1 if best >= 0 else 0))

    classes = [c for c in DAMAGE_CLASSES if n_gt[c] > 0]
    per_class, tot_tp, tot_fp, tot_gt = {}, 0, 0, 0
    for c in classes:
        at_op = [(s, t) for s, t in scored[c] if s >= operating_conf]
        tp = sum(t for _, t in at_op)
        fp = len(at_op) - tp
        fn = n_gt[c] - tp
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / n_gt[c]
        f1 = 2 * p * r / (p + r) if p + r else 0.0
        ap = _average_precision([s for s, _ in scored[c]], [t for _, t in scored[c]], n_gt[c])
        per_class[c] = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f1, 3), "ap50": round(ap, 3), "support": n_gt[c], "tp": tp, "fp": fp, "fn": fn}
        tot_tp, tot_fp, tot_gt = tot_tp + tp, tot_fp + fp, tot_gt + n_gt[c]
    # false positives for classes with no ground truth still count against precision
    for c in DAMAGE_CLASSES:
        if c not in classes:
            tot_fp += sum(1 for s, _ in scored[c] if s >= operating_conf)

    p = tot_tp / (tot_tp + tot_fp) if tot_tp + tot_fp else 0.0
    r = tot_tp / tot_gt if tot_gt else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return {
        "overall": {
            "precision": round(p, 3),
            "recall": round(r, 3),
            "f1": round(f1, 3),
            "map50": round(float(np.mean([per_class[c]["ap50"] for c in classes])) if classes else 0.0, 3),
            "objects": tot_gt,
            "images": len(labels),
        },
        "per_class": per_class,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", type=Path, help="directory with images and labels.json (default: generate a synthetic set)")
    ap.add_argument("--count", type=int, default=80, help="synthetic images to generate")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--conf", type=float, default=DetectionConfig().confidence_threshold, help="operating confidence threshold")
    ap.add_argument("--out", type=Path, default=MODELS_DIR / "detection_metrics.json")
    args = ap.parse_args()

    synthetic = args.images is None
    with tempfile.TemporaryDirectory() as tmp:
        if synthetic:
            images_dir = Path(tmp)
            labels = generate_dataset(images_dir, args.count, seed=args.seed, prefix="eval")
        else:
            images_dir = args.images
            labels = json.loads((images_dir / "labels.json").read_text(encoding="utf-8"))
        cfg = replace(DetectionConfig(), confidence_threshold=0.05)  # low threshold so AP sees the full ranking
        detector = HeuristicDetector(cfg)
        metrics = evaluate(detector, images_dir, labels, args.conf)

    report = {
        "detector": detector.name,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": {
            "name": f"RoadMind synthetic road images (seed {args.seed})" if synthetic else str(args.images),
            "synthetic": synthetic,
            "images": metrics["overall"]["images"],
            "objects": metrics["overall"]["objects"],
        },
        "iou_threshold": IOU_MATCH,
        "confidence_threshold": args.conf,
        **metrics,
        "caveat": (
            "Measured on procedurally generated images with a classical-vision fallback detector. "
            "These numbers do NOT describe accuracy on real road photographs. "
            "Train YOLO on RDD2022 (see docs/MODEL_TRAINING.md) and re-run evaluation for real metrics."
            if synthetic
            else "Metrics measured on the supplied labelled image set."
        ),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    o = report["overall"]
    print(f"{report['detector']}\n  images={o['images']} objects={o['objects']}")
    print(f"  precision={o['precision']}  recall={o['recall']}  F1={o['f1']}  mAP@0.5={o['map50']}")
    for c, v in report["per_class"].items():
        print(f"  {c:20s} P={v['precision']:.2f} R={v['recall']:.2f} F1={v['f1']:.2f} AP50={v['ap50']:.2f} (n={v['support']})")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
