"""Application settings: defaults in code, overridden by config/roadmind.yaml and env vars."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from roadmind_ai.config import DetectionConfig, RiskModelConfig, SeverityConfig, from_dict

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class ConditionConfig:
    history_window_days: int = 180  # older reports no longer count; a road with none left is UNKNOWN again
    recency_half_life_days: float = 60
    max_weight: float = 0.6
    match_radius_m: float = 60  # a report is attached to the road segment whose centre line is this close


@dataclass
class NetworkConfig:
    source_file: str = "data/osm/demo_area.json"  # pre-fetched OpenStreetMap extract loaded on first start
    remote_enabled: bool = True  # allow fetching more road network from the Overpass API
    default_bbox: list[float] = field(default_factory=lambda: [13.0600, 80.2500, 13.0870, 80.2790])  # S, W, N, E
    overpass_urls: list[str] = field(
        default_factory=lambda: ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
    )
    overpass_timeout_s: float = 60
    auto_import_timeout_s: float = 20  # shorter budget when a report triggers an import
    max_import_span_deg: float = 0.06  # largest area (degrees per side) that may be imported at once
    auto_import_radius_m: float = 900  # network fetched around a report that lands outside any loaded area
    default_rainfall_mm: float = 85.0  # 30-day rainfall assumed for imported roads (no live feed)
    max_segments_per_view: int = 6000


@dataclass
class PriorityConfig:
    danger_weights: dict[str, float] = field(default_factory=lambda: {"severity": 0.55, "risk": 0.45})
    exposure_weights: dict[str, float] = field(
        default_factory=lambda: {"reports": 0.25, "traffic": 0.25, "facilities": 0.15, "people_affected": 0.15, "time_since_repair": 0.20}
    )
    base_multiplier: float = 0.85
    exposure_swing: float = 0.30
    reports_reference: int = 15
    traffic_reference: float = 30000
    facilities_reference: int = 3
    people_per_vehicle: float = 1.6
    people_reference: float = 45000
    repair_reference_months: float = 36
    immediate_min: float = 90
    high_min: float = 70
    medium_min: float = 40


@dataclass
class RoutingConfig:
    provider: str = "auto"  # auto | demo | osrm
    osrm_base_url: str = "https://router.project-osrm.org"
    osrm_timeout_s: float = 6
    demo_snap_radius_m: float = 400
    max_alternatives: int = 3
    penalty_factor: float = 1.7
    sample_step_m: float = 25
    match_radius_m: float = 25  # OSRM routes: how close to a RoadMind road a route must run to count as on it
    # Risk assumed for stretches with no RoadMind data when scoring. None = the average risk of the roads
    # that do have data, i.e. neither "good" nor "bad": missing data must not look like either.
    unknown_road_risk: float | None = None
    min_data_coverage: float = 0.15  # below this share of known road, a route's condition is reported as unknown
    severity_share: float = 0.5
    weights: dict[str, float] = field(default_factory=lambda: {"distance": 0.20, "time": 0.20, "damage_risk": 0.60})
    detour_reference: float = 0.5
    avoid_risk_threshold: float = 0.60
    damage_labels: dict[str, float] = field(default_factory=lambda: {"low": 0.25, "moderate": 0.50, "high": 0.70})


@dataclass
class MapConfig:
    """Base-map pictures (raster tiles) under the road network. The roads themselves are drawn by RoadMind
    and never depend on this. tile.openstreetmap.org is a shared volunteer service with a usage policy
    (https://operations.osmfoundation.org/policies/tiles/): for heavy use point this at your own or a
    commercial tile provider (MapTiler, Stadia Maps, Thunderforest...) with its key in the URL."""

    tile_url: str = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    attribution: str = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    max_zoom: int = 19


@dataclass
class GeocodingConfig:
    nominatim_enabled: bool = True
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    timeout_s: float = 5


@dataclass
class UploadConfig:
    max_bytes: int = 8 * 1024 * 1024
    min_side_px: int = 64
    max_pixels: int = 50_000_000
    stored_max_side_px: int = 1600
    allowed_formats: list[str] = field(default_factory=lambda: ["JPEG", "PNG", "WEBP"])


@dataclass
class AuthConfig:
    token_hours: float = 8  # normal users
    staff_token_hours: float = 4  # administrators and maintenance staff sign in again sooner
    # The one-time "Create Initial Administrator" page may only be used from the computer that runs the
    # server, so nobody who can merely reach a freshly started server can claim it. Set false to allow remote setup.
    setup_local_only: bool = True
    public_url: str = "http://127.0.0.1:8000"  # base of the links in emails (never taken from request headers)
    reset_minutes: int = 30  # password-reset link lifetime
    verify_hours: int = 48  # email-verification link lifetime (initial administrator, promoted accounts)
    invite_hours: int = 72  # invitation link lifetime (staff accounts created by an administrator)
    min_password_length: int = 10
    # Guests may browse, search, plan routes and try the AI detector; storing a report needs an account.
    require_login_to_report: bool = True
    max_pending_requests: int = 50  # staff registrations waiting for verification / approval; more are refused (spam guard)


@dataclass
class EmailConfig:
    """Outgoing mail (verification, invitations, password resets). With no smtp_host the message is written to
    data/outbox/ and the server log instead of being sent (links are never shown in the web page). The SMTP password
    is read from the ROADMIND_SMTP_PASSWORD environment variable, not from this file."""

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    starttls: bool = True
    from_address: str = "RoadMind AI <no-reply@localhost>"


@dataclass
class Settings:
    detection: DetectionConfig
    severity: SeverityConfig
    risk: RiskModelConfig
    condition: ConditionConfig
    priority: PriorityConfig
    routing: RoutingConfig
    network: NetworkConfig
    map: MapConfig
    geocoding: GeocodingConfig
    uploads: UploadConfig
    auth: AuthConfig
    email: EmailConfig
    data_dir: Path
    media_dir: Path
    database_url: str
    secret_key: str
    smtp_password: str
    frontend_dist: Path
    sample_dir: Path
    seed_demo_data: bool = True

    def resolve(self, path: str) -> Path:
        p = Path(path)
        return p if p.is_absolute() else REPO_ROOT / p


def read_dotenv(path: Path) -> dict[str, str]:
    """Minimal `.env` reader: `ROADMIND_*=value` lines (optionally quoted), `#` comments. Secrets such as the SMTP
    password live there instead of in config/roadmind.yaml, and the file is git-ignored."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key.startswith("ROADMIND_"):
            values[key] = value
    return values


def load_settings(overrides: dict[str, Any] | None = None) -> Settings:
    """Build settings. `overrides` (used by tests) may set data_dir, database_url, seed_demo_data, ...

    Precedence, lowest to highest: config/roadmind.yaml, the `.env` file in the project folder, real environment
    variables, `overrides`."""
    overrides = overrides or {}
    # (ROADMIND_ENV_FILE points at another file; an empty value means "no .env file" - the tests use that)
    env_file = os.environ.get("ROADMIND_ENV_FILE")
    dotenv_path = REPO_ROOT / ".env" if env_file is None else (Path(env_file) if env_file else None)
    env: dict[str, str] = {**(read_dotenv(dotenv_path) if dotenv_path else {}), **os.environ}
    cfg_path = Path(env.get("ROADMIND_CONFIG", REPO_ROOT / "config" / "roadmind.yaml"))
    raw: dict[str, Any] = {}
    if cfg_path.exists():
        raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}

    data_dir = Path(overrides.get("data_dir") or env.get("ROADMIND_DATA_DIR") or REPO_ROOT / "backend" / "data")
    data_dir.mkdir(parents=True, exist_ok=True)
    media_dir = data_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    email_raw: dict[str, Any] = dict(raw.get("email") or {})
    for key, name in (("smtp_host", "ROADMIND_SMTP_HOST"), ("smtp_user", "ROADMIND_SMTP_USER"), ("from_address", "ROADMIND_SMTP_FROM")):
        if env.get(name):
            email_raw[key] = env[name]
    if env.get("ROADMIND_SMTP_PORT", "").isdigit():
        email_raw["smtp_port"] = int(env["ROADMIND_SMTP_PORT"])
    if env.get("ROADMIND_SMTP_STARTTLS"):
        email_raw["starttls"] = env["ROADMIND_SMTP_STARTTLS"].strip().lower() not in ("0", "false", "no", "off")
    email_raw.update(overrides.get("email") or {})
    if email_raw.get("smtp_user") and email_raw.get("from_address", EmailConfig.from_address) == EmailConfig.from_address:
        email_raw["from_address"] = f"RoadMind AI <{email_raw['smtp_user']}>"  # providers such as Gmail only send as the account itself

    secret = env.get("ROADMIND_SECRET_KEY")
    if not secret:  # persist a random key so admin sessions survive restarts
        key_file = data_dir / "secret.key"
        if key_file.exists():
            secret = key_file.read_text().strip()
        else:
            secret = secrets.token_hex(32)
            key_file.write_text(secret)

    db_url = overrides.get("database_url") or env.get("ROADMIND_DATABASE_URL") or f"sqlite:///{(data_dir / 'roadmind.db').as_posix()}"

    return Settings(
        detection=from_dict(DetectionConfig, raw.get("detection")),
        severity=from_dict(SeverityConfig, raw.get("severity")),
        risk=from_dict(RiskModelConfig, raw.get("risk_model")),
        condition=from_dict(ConditionConfig, raw.get("road_condition")),
        priority=from_dict(PriorityConfig, raw.get("priority")),
        routing=from_dict(RoutingConfig, raw.get("routing")),
        network=from_dict(NetworkConfig, {**(raw.get("network") or {}), **(overrides.get("network") or {})}),
        map=from_dict(MapConfig, raw.get("map")),
        geocoding=from_dict(GeocodingConfig, raw.get("geocoding")),
        uploads=from_dict(UploadConfig, raw.get("uploads")),
        auth=from_dict(AuthConfig, {**(raw.get("auth") or {}), **(overrides.get("auth") or {})}),
        email=from_dict(EmailConfig, email_raw),
        data_dir=data_dir,
        media_dir=media_dir,
        database_url=db_url,
        secret_key=secret,
        smtp_password=env.get("ROADMIND_SMTP_PASSWORD", ""),
        frontend_dist=REPO_ROOT / "frontend" / "dist",
        sample_dir=REPO_ROOT / "data" / "sample_images",
        seed_demo_data=bool(overrides.get("seed_demo_data", env.get("ROADMIND_SEED_DEMO", "1") != "0")),
    )
