import json

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from roadmind_ai.severity import DISCLAIMER as SEVERITY_DISCLAIMER

from ..security import get_db
from ..services.network import network_info
from ..services.routing.engine import DISCLAIMER as ROUTE_DISCLAIMER

router = APIRouter(tags=["System"])


def _load(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


@router.get("/health", summary="Liveness check")
def health():
    return {"status": "ok"}


@router.get("/system/info", summary="Which models are running, their evaluation metrics and the disclaimers")
def system_info(request: Request, db: Session = Depends(get_db)):
    state = request.app.state.app_state
    s = state.settings
    return {
        "detector": {
            "name": state.detector.name,
            "demo_mode": bool(getattr(state.detector, "is_demo", False)),
            "metrics": _load(s.resolve("ai/models/detection_metrics.json")),
        },
        "risk_model": {
            "name": state.predictor.name,
            "version": state.predictor.version,
            "metrics": _load(s.resolve(s.risk.metrics_path)),
        },
        "severity": {
            "scale": {"Low": "0-30", "Moderate": "31-60", "High": "61-80", "Critical": "81-100"},
            "max_points": {"size": s.severity.size_points, "type": s.severity.type_points, "count": s.severity.count_points, "history": s.severity.history_points},
        },
        "priority": {
            "formula": "priority = 100 x danger x (base + swing x exposure)",
            "danger_weights": s.priority.danger_weights,
            "exposure_weights": s.priority.exposure_weights,
            "base_multiplier": s.priority.base_multiplier,
            "exposure_swing": s.priority.exposure_swing,
            "categories": {"Immediate": f"{s.priority.immediate_min:.0f}-100", "High Priority": f"{s.priority.high_min:.0f}-{s.priority.immediate_min - 1:.0f}",
                           "Medium Priority": f"{s.priority.medium_min:.0f}-{s.priority.high_min - 1:.0f}", "Monitor": f"0-{s.priority.medium_min - 1:.0f}"},
        },
        "routing": {"provider": s.routing.provider, "weights": s.routing.weights},
        "network": network_info(db, state),
        "disclaimers": {
            "severity": SEVERITY_DISCLAIMER,
            "prediction": "Risk scores are probabilities estimated by a statistical model, not guaranteed future events.",
            "routes": ROUTE_DISCLAIMER,
            "data": "Roads and places come from OpenStreetMap. The report history, severity, repair, traffic and rainfall values in the demo are SIMULATED sample data.",
            "unknown": "A road with no RoadMind condition data is shown as UNKNOWN. That is not a judgement that it is good or damaged.",
        },
    }


@router.get("/samples", summary="Sample road images for trying the detector")
def samples(request: Request):
    folder = request.app.state.app_state.settings.sample_dir
    if not folder.exists():
        return []
    return [{"name": p.stem.replace("_", " "), "url": f"/samples/{p.name}"} for p in sorted(folder.glob("*.jpg"))]
