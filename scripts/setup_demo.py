"""Prepare everything the demo needs that is not stored in git:

  * sample road images (data/sample_images)         - procedurally generated
  * detector evaluation metrics (ai/models/detection_metrics.json)
  * the deterioration-risk model + metrics (ai/models/risk_model.joblib, risk_metrics.json)

    python scripts/setup_demo.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai"))

import cv2  # noqa: E402

from roadmind_ai import MODELS_DIR  # noqa: E402
from roadmind_ai.detection import evaluate as detection_eval  # noqa: E402
from roadmind_ai.detection.synthetic import generate_image  # noqa: E402
from roadmind_ai.prediction import train as risk_train  # noqa: E402

SAMPLES = {
    "large_pothole": ({"pothole"}, 1),
    "pothole_and_crack": ({"pothole", "longitudinal_crack"}, 2),
    "longitudinal_crack": ({"longitudinal_crack"}, 1),
    "transverse_crack": ({"transverse_crack"}, 1),
    "alligator_cracking": ({"alligator_crack"}, 1),
    "multiple_damage": ({"pothole", "alligator_crack", "transverse_crack"}, 3),
    "two_potholes": ({"pothole"}, 2),
    "clean_road": (set(), 0),
}


def find_seed(labels: set[str], n: int, start: int = 9000) -> int:
    for seed in range(start, start + 5000):
        _, truth = generate_image(seed, n_elements=n)
        found = {g.label for g in truth}
        if len(truth) == n and (found == labels if labels else not found):
            return seed
    raise RuntimeError(f"no seed found for {labels}")


def make_samples() -> None:
    out = ROOT / "data" / "sample_images"
    out.mkdir(parents=True, exist_ok=True)
    for name, (labels, n) in SAMPLES.items():
        img, _ = generate_image(find_seed(labels, n), n_elements=n)
        cv2.imwrite(str(out / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"wrote {len(SAMPLES)} sample images to {out}")


def main() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    make_samples()
    sys.argv = [sys.argv[0]]  # the evaluate/train CLIs parse sys.argv
    detection_eval.main()
    risk_train.main()


if __name__ == "__main__":
    main()
