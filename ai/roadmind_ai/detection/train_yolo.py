"""Train a YOLO road-damage detector and register it with RoadMind.

    pip install -r requirements-yolo.txt
    cd ai
    python -m roadmind_ai.detection.convert_rdd2022 --rdd-root <RDD2022 folder> --out ../datasets/rdd2022_yolo
    python -m roadmind_ai.detection.train_yolo --data ../datasets/rdd2022_yolo/dataset.yaml --epochs 50

On success the best weights are copied to ai/models/road_damage_yolo.pt (picked up
automatically by `detection.backend: auto`) and precision / recall / F1 / mAP measured on
the validation split are written to ai/models/detection_metrics.json for the dashboard.

NOTE: not executed in the development environment (needs the multi-GB RDD2022 dataset and
ideally a GPU). The metrics it writes come from your own training run.
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .. import MODELS_DIR
from .types import DAMAGE_CLASSES


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True, help="dataset.yaml in YOLO format")
    ap.add_argument("--model", default="yolov8n.pt", help="starting checkpoint (downloaded by Ultralytics)")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default=None, help="e.g. 0 for the first GPU, or cpu")
    ap.add_argument("--project", type=Path, default=MODELS_DIR.parent / "runs")
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.model)
    model.train(
        data=str(args.data), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch,
        device=args.device, project=str(args.project), name="road_damage", exist_ok=True,
    )
    best = Path(model.trainer.best)
    target = MODELS_DIR / "road_damage_yolo.pt"
    shutil.copy2(best, target)

    metrics = YOLO(str(target)).val(data=str(args.data), imgsz=args.imgsz, device=args.device)
    box = metrics.box
    per_class = {}
    for pos, cls_idx in enumerate(getattr(box, "ap_class_index", [])):
        name = DAMAGE_CLASSES[int(cls_idx)] if int(cls_idx) < len(DAMAGE_CLASSES) else str(cls_idx)
        p, r = float(box.p[pos]), float(box.r[pos])
        per_class[name] = {
            "precision": round(p, 3),
            "recall": round(r, 3),
            "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0,
            "ap50": round(float(box.ap50[pos]), 3),
        }
    p, r = float(box.mp), float(box.mr)
    report = {
        "detector": f"YOLO ({args.model} fine-tuned)",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": {"name": str(args.data), "synthetic": False},
        "iou_threshold": 0.5,
        "overall": {
            "precision": round(p, 3),
            "recall": round(r, 3),
            "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0,
            "map50": round(float(box.map50), 3),
            "map50_95": round(float(box.map), 3),
        },
        "per_class": per_class,
        "caveat": "Validation-split metrics from this training run. They estimate performance on similar imagery and are not a guarantee.",
    }
    (MODELS_DIR / "detection_metrics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Saved weights to {target}\nP={p:.3f} R={r:.3f} mAP50={float(box.map50):.3f}")


if __name__ == "__main__":
    main()
