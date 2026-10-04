# Training and evaluating real models

The demo ships with a classical OpenCV fallback detector and a risk model trained on synthetic data so it runs anywhere. For real use, train both on real data. **The YOLO workflow below is written but was not executed during development** (it needs the multi-GB RDD2022 dataset and ideally a GPU), so expect to adjust paths or versions.

## 1. Damage detection with YOLO + RDD2022

```powershell
pip install -r requirements-yolo.txt          # PyTorch + Ultralytics (large download)
```

1. Download **RDD2022** (Road Damage Detection 2022, public; see the [RoadDamageDetector](https://github.com/sekilab/RoadDamageDetector) project for links). Annotations are Pascal-VOC XML; classes `D00` longitudinal crack, `D10` transverse crack, `D20` alligator crack, `D40` pothole.
2. Convert to YOLO format (RoadMind's five classes; anything else becomes `surface_damage`):
   ```powershell
   cd ai
   python -m roadmind_ai.detection.convert_rdd2022 --rdd-root D:\data\RDD2022 --out ..\datasets\rdd2022_yolo
   ```
   The official test splits have no labels, so 15 % of the labelled training images are held out for validation.
3. Train and register:
   ```powershell
   python -m roadmind_ai.detection.train_yolo --data ..\datasets\rdd2022_yolo\dataset.yaml --epochs 50 --device 0
   ```
   This fine-tunes `yolov8n.pt`, copies the best weights to `ai/models/road_damage_yolo.pt` and writes validation **precision, recall, F1 and mAP@0.5 / mAP@0.5:0.95** (overall and per class) to `ai/models/detection_metrics.json`.
4. Restart the server. With `detection.backend: auto` RoadMind now uses YOLO; the dashboard's *Models & metrics* page switches from "Demo mode" to "Trained model" and shows your metrics.

Notes: use `detection.confidence_threshold` in `config/roadmind.yaml` to trade precision against recall. Validation metrics describe imagery like the training set (dash-cam photos from several countries); evaluate on photos from your own region before relying on the results, and never describe the model as perfectly accurate.

## 2. Evaluating any detector on your own labelled photos

```powershell
cd ai
python -m roadmind_ai.detection.evaluate --images D:\my_photos        # needs D:\my_photos\labels.json
```

`labels.json` format: `{"photo1.jpg": {"width": 1280, "height": 720, "boxes": [{"label": "pothole", "bbox": [x1, y1, x2, y2]}]}}`. Reports precision, recall, F1 and mAP@0.5 per class. (Without `--images` it evaluates the fallback detector on 80 generated images - that number is only a smoke test.)

## 3. Risk model

```powershell
cd ai
python -m roadmind_ai.prediction.train        # trains LR baseline, Random Forest, Gradient Boosting, XGBoost
```

Writes `ai/models/risk_model.joblib` (best ROC-AUC on a held-out 25 %) and `risk_metrics.json` (accuracy, precision, recall, F1, ROC-AUC, Brier score, cross-validation, permutation importance). The server trains it automatically if the file is missing.

**It is trained on synthetic data** drawn from an assumed deterioration process ([`prediction/synthetic.py`](../ai/roadmind_ai/prediction/synthetic.py)). To use real history:

1. Build one row per (road, snapshot date) with the ten columns in [`prediction/features.py`](../ai/roadmind_ai/prediction/features.py) - RoadMind already computes them in `services/condition.build_features`, and `road_condition_history` stores the snapshots.
2. Label each row `1` if the road's severity rose by ≥ 10 points (or reached Critical) within the next 90 days, else `0`.
3. Replace `synthetic.generate()` in `prediction/train.py` with your table (keep a time-based train/test split so the model is never tested on the past), retrain, and re-check the metrics.
4. Restart the server and call `POST /api/maintenance/refresh` (admin token, or the *Authorize* button at `/api/docs`) to re-score every road with the new model.

Until then, treat risk percentages as a demonstration of the pipeline, not a forecast.
