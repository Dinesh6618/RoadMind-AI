"""Train and compare deterioration-risk models.

    cd ai
    python -m roadmind_ai.prediction.train

Trains Logistic Regression (baseline), Random Forest, Gradient Boosting and - if the
package is installed - XGBoost, evaluates all of them on a held-out split and saves the
model with the best ROC-AUC together with the full metrics table.
"""

from __future__ import annotations

import argparse
import json
import warnings
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .. import MODELS_DIR
from . import synthetic
from .features import FEATURES, LABELS

MODEL_VERSION = "1.0"


def candidate_models(seed: int) -> dict:
    models = {
        "Logistic Regression (baseline)": make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000)),
        "Random Forest": RandomForestClassifier(n_estimators=300, max_depth=9, min_samples_leaf=8, n_jobs=-1, random_state=seed),
        "Gradient Boosting": GradientBoostingClassifier(n_estimators=200, max_depth=3, learning_rate=0.06, subsample=0.8, random_state=seed),
    }
    try:
        from xgboost import XGBClassifier

        models["XGBoost"] = XGBClassifier(
            n_estimators=250, max_depth=3, learning_rate=0.06, subsample=0.8, colsample_bytree=0.9,
            eval_metric="logloss", random_state=seed, n_jobs=2,
        )
    except Exception:  # xgboost is optional
        pass
    return models


def train(model_path: Path, metrics_path: Path, n_samples: int = 8000, seed: int = 7) -> dict:
    X, y = synthetic.generate(n_samples, seed=seed)
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, stratify=y, random_state=seed)

    results: dict[str, dict] = {}
    fitted = {}
    for name, model in candidate_models(seed).items():
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model.fit(X_tr, y_tr)
            proba = model.predict_proba(X_te)[:, 1]
        pred = (proba >= 0.5).astype(int)
        results[name] = {
            "accuracy": round(float(accuracy_score(y_te, pred)), 3),
            "precision": round(float(precision_score(y_te, pred, zero_division=0)), 3),
            "recall": round(float(recall_score(y_te, pred, zero_division=0)), 3),
            "f1": round(float(f1_score(y_te, pred, zero_division=0)), 3),
            "roc_auc": round(float(roc_auc_score(y_te, proba)), 3),
            "brier": round(float(brier_score_loss(y_te, proba)), 3),
        }
        fitted[name] = model

    best_name = max(results, key=lambda k: (results[k]["roc_auc"], results[k]["f1"]))
    best = fitted[best_name]
    cv = cross_val_score(
        candidate_models(seed)[best_name], X, y, cv=StratifiedKFold(5, shuffle=True, random_state=seed), scoring="roc_auc"
    )
    imp = permutation_importance(best, X_te, y_te, scoring="roc_auc", n_repeats=5, random_state=seed)
    importances = sorted(
        ({"feature": f, "label": LABELS[f], "importance": round(float(v), 4)} for f, v in zip(FEATURES, imp.importances_mean)),
        key=lambda r: r["importance"],
        reverse=True,
    )

    joblib.dump(
        {
            "model": best,
            "name": best_name,
            "version": MODEL_VERSION,
            "features": FEATURES,
            "medians": np.median(X_tr, axis=0).tolist(),
        },
        model_path,
    )
    report = {
        "selected_model": best_name,
        "version": MODEL_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target": "Road severity rises by >= 10 points (or becomes Critical) within the next 90 days",
        "dataset": {"synthetic": True, "samples": int(n_samples), "train": int(len(y_tr)), "test": int(len(y_te)), "positive_rate": round(float(y.mean()), 3)},
        "holdout_metrics": results,
        "selected_metrics": results[best_name],
        "cross_validation_roc_auc": {"mean": round(float(cv.mean()), 3), "std": round(float(cv.std()), 3)},
        "feature_importance": importances,
        "caveat": (
            "Trained on synthetic data generated from an assumed deterioration process. "
            "Metrics show that the model learned that assumption; they do not measure real-world "
            "forecasting skill. Predictions are probabilities, never guaranteed outcomes."
        ),
    }
    metrics_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--samples", type=int, default=8000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--model-out", type=Path, default=MODELS_DIR / "risk_model.joblib")
    ap.add_argument("--metrics-out", type=Path, default=MODELS_DIR / "risk_metrics.json")
    args = ap.parse_args()
    report = train(args.model_out, args.metrics_out, args.samples, args.seed)
    print(f"Selected: {report['selected_model']}  (positive rate {report['dataset']['positive_rate']})")
    for name, m in report["holdout_metrics"].items():
        print(f"  {name:32s} acc={m['accuracy']:.3f} P={m['precision']:.3f} R={m['recall']:.3f} F1={m['f1']:.3f} AUC={m['roc_auc']:.3f}")
    print(f"wrote {args.model_out} and {args.metrics_out}")


if __name__ == "__main__":
    main()
