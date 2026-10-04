"""Objects shared across requests, stored on app.state."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from ..config import Settings
from ..security import LoginThrottle


@dataclass
class AppState:
    settings: Settings
    session_factory: sessionmaker[Session]
    detector: Any  # roadmind_ai.detection.Detector
    predictor: Any  # roadmind_ai.prediction.RiskPredictor
    route_engine: Any = None  # services.routing.engine.RouteEngine
    throttle: LoginThrottle = field(default_factory=LoginThrottle)  # failed logins (per client address and per account)
    forgot_throttle: LoginThrottle = field(default_factory=lambda: LoginThrottle(limit=3, window_s=900))  # reset requests per account
    setup_lock: threading.Lock = field(default_factory=threading.Lock)  # makes "is there an admin?" + "create one" atomic
