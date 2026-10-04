"""RoadMind AI - FastAPI application factory.

    uvicorn app.main:app --reload --port 8000      (run from the backend/ folder)
"""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from roadmind_ai.detection import load_detector
from roadmind_ai.prediction import RiskPredictor
from roadmind_ai.prediction.train import train as train_risk_model

from .config import REPO_ROOT, Settings, load_settings
from .database import Base, ensure_schema, make_engine, make_session_factory
from .routers import analytics, auth, maintenance, network, reports, roads, routes, staff, system, users
from .services.osm import ensure_network
from .services.routing.engine import RouteEngine
from .services.accounts import purge_legacy_admins
from .services.seed import seed_demo
from .services.state import AppState

log = logging.getLogger("roadmind")

DESCRIPTION = """
**RoadMind AI** detects road damage in photos, scores its severity, predicts which roads are likely to
deteriorate, ranks roads for maintenance and recommends lower-risk routes.

> All scores are **AI-generated estimates**, not official engineering assessments or guaranteed predictions.

Two separate sign-in doors: normal users (`POST /api/auth/login`) and Admin & Road Maintenance staff
(`POST /api/auth/staff/login`; the account's role decides which dashboard it opens). Protected endpoints need the
returned bearer token (use the **Authorize** button); the role is always read from the database, never from the client.
"""


def _load_risk_model(settings: Settings) -> RiskPredictor:
    model_path = settings.resolve(settings.risk.model_path)
    if not model_path.exists():
        log.info("No risk model at %s - training one on synthetic data (takes a few seconds)...", model_path)
        model_path.parent.mkdir(parents=True, exist_ok=True)
        train_risk_model(model_path, settings.resolve(settings.risk.metrics_path))
    try:
        return RiskPredictor.load(model_path, settings.risk)
    except Exception as exc:  # stale file from an older feature set
        log.warning("Risk model could not be loaded (%s) - retraining.", exc)
        train_risk_model(model_path, settings.resolve(settings.risk.metrics_path))
        return RiskPredictor.load(model_path, settings.risk)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = make_engine(settings.database_url)
        Base.metadata.create_all(engine)
        for column in ensure_schema(engine):  # databases from older builds gain any new columns (additive only)
            log.info("Database upgraded: added column %s", column)
        state = AppState(
            settings=settings,
            session_factory=make_session_factory(engine),
            detector=load_detector(settings.detection, REPO_ROOT),
            predictor=_load_risk_model(settings),
        )
        state.route_engine = RouteEngine(settings)
        app.state.app_state = state
        app.state.instance_id = uuid.uuid4().hex  # rate-limit budgets belong to one running app
        app.state.settings = settings
        app.state.session_factory = state.session_factory
        with state.session_factory() as db:
            purge_legacy_admins(db)  # no built-in administrator may exist: the owner creates theirs at /setup
            ensure_network(db, settings)  # base layer: the complete OpenStreetMap road network
            seed_demo(db, state)  # optional simulated condition data on top of it
        log.info("RoadMind ready - detector: %s", state.detector.name)
        yield
        engine.dispose()

    app = FastAPI(title="RoadMind AI", version="1.0.0", description=DESCRIPTION, lifespan=lifespan, docs_url="/api/docs", redoc_url="/api/redoc", openapi_url="/api/openapi.json")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],  # Vite dev server
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        # Send only the site's origin (never page paths) to other sites. Map tile servers such as
        # tile.openstreetmap.org REQUIRE a Referer and serve an "Access blocked" tile without one, so
        # "same-origin" / "no-referrer" would break the map.
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")  # the app is never meant to be framed (clickjacking)
        if request.url.path.startswith("/api/auth") or request.url.path.startswith("/api/admin") or request.url.path.startswith("/api/staff"):
            response.headers.setdefault("Cache-Control", "no-store")  # account data must not linger in shared caches
        return response

    app.add_middleware(GZipMiddleware, minimum_size=1000)  # the network payload is large and compresses well
    for r in (auth, users, reports, roads, network, maintenance, staff, routes, analytics, system):
        app.include_router(r.router, prefix="/api")

    app.mount("/media", StaticFiles(directory=settings.media_dir), name="media")
    if settings.sample_dir.exists():
        app.mount("/samples", StaticFiles(directory=settings.sample_dir), name="samples")

    dist: Path = settings.frontend_dist
    if dist.exists():
        if (dist / "assets").exists():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404, "Not found")
            candidate = (dist / path).resolve()
            if path and dist.resolve() in candidate.parents and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")
    else:
        @app.get("/", include_in_schema=False)
        def root():
            return {"app": "RoadMind AI", "docs": "/api/docs", "frontend": "not built yet - run `npm run build` in frontend/ or `npm run dev`"}

    return app


app = create_app()
