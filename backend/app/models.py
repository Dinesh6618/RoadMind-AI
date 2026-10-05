"""Database schema.

    users ──────────────────────────────┐ (reporter is optional/anonymous)
    network_areas, places                  base-map bookkeeping (OpenStreetMap import)
    roads ─┬─< road_reports ─< damage_detections
           ├─< road_condition_history
           ├─< repairs
           ├─< predictions
           ├── 1:1 maintenance_priorities
           └─ referenced by route_options.road_ids
    route_queries ─< route_options

Geometry is stored as a GeoJSON-style list of [lat, lng] pairs so the same code runs on
SQLite and PostgreSQL. db/postgis_extras.sql shows how to add a PostGIS geometry column with a GIST index.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, BigInteger, Boolean, Date, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base, UTCDateTime, utcnow


class User(Base):
    """An account. Roles: "admin" (everything), "maintenance" (works on the roads assigned to them) and "user"
    (report damage, view roads, plan routes, see own reports). Passwords are stored only as Argon2id hashes;
    nothing here is a default or built-in account. Administrator and maintenance accounts cannot be used until
    their email address is verified (`email_verified_at`)."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120), default="")
    email: Mapped[str | None] = mapped_column(String(254), unique=True, index=True, nullable=True)  # stored lower-case
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="user")  # admin | maintenance | user
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)  # bumping it signs out every existing session
    email_verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # True for an account an administrator invited: its password hash is a random placeholder until the invitee
    # opens the emailed link and chooses a password (which also verifies the address).
    must_set_password: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # the administrator who invited this account
    # Self-service staff registration only ever creates a REQUEST. While it is pending, `role` stays "user" (no privileges at
    # all) and the wished-for role waits in `requested_role` until an administrator approves it.
    # approval_status: ACTIVE | PENDING_EMAIL | PENDING_APPROVAL | REJECTED  (is_active = False means SUSPENDED)
    approval_status: Mapped[str] = mapped_column(String(20), default="ACTIVE")
    requested_role: Mapped[str | None] = mapped_column(String(16), nullable=True)  # admin | maintenance
    reviewed_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class EmailToken(Base):
    """A single-use link emailed to verify an address ("verify") or to accept an invitation and choose a password
    ("invite"). Only a SHA-256 hash of the token is stored, never the token itself."""

    __tablename__ = "email_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String(12))  # verify | invite
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class RevokedToken(Base):
    """A session token that was explicitly logged out. Rows can be deleted once `expires_at` has passed."""

    __tablename__ = "revoked_tokens"

    jti: Mapped[str] = mapped_column(String(32), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)


class RoadAssignment(Base):
    """Which maintenance employee is responsible for a road. Maintenance staff see and update only these roads."""

    __tablename__ = "road_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    assigned_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    assigned_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class RepairEvidence(Base):
    """A photo a maintenance employee attached to a road as proof of an inspection or a finished repair."""

    __tablename__ = "repair_evidence"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    kind: Mapped[str] = mapped_column(String(12), default="repair")  # inspection | repair
    image_path: Mapped[str] = mapped_column(String(256))
    caption: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class PasswordReset(Base):
    """A single-use password-reset token. Only a SHA-256 hash of the token is stored, never the token itself."""

    __tablename__ = "password_resets"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Road(Base):
    """One road segment of the base network (between two junctions) - the unit RoadMind attaches
    condition data to. Segments come from OpenStreetMap (source "osm") or are a short stub created
    when a report lands where no network is loaded (source "user"). A segment WITHOUT RoadMind
    data (`has_data` false) is UNKNOWN - never "good" and never "damaged"."""

    __tablename__ = "roads"
    __table_args__ = (UniqueConstraint("osm_way_id", "osm_seq", name="uq_roads_osm_way_seq"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    zone: Mapped[str] = mapped_column(String(64), default="Other")
    highway: Mapped[str] = mapped_column(String(24), default="residential")  # OSM highway class
    oneway: Mapped[int] = mapped_column(Integer, default=0)  # 0 two-way, 1 only in geometry order
    geometry: Mapped[list] = mapped_column(JSON)  # [[lat, lng], ...]
    length_m: Mapped[float] = mapped_column(Float, default=0.0)
    # OpenStreetMap identity: segments are split at junctions so node_a / node_b are intersections
    osm_way_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    osm_seq: Mapped[int] = mapped_column(Integer, default=0)
    node_a: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    node_b: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # bounding box (indexed) so the map can ask for just the roads in view
    min_lat: Mapped[float] = mapped_column(Float, index=True, default=0.0)
    max_lat: Mapped[float] = mapped_column(Float, index=True, default=0.0)
    min_lng: Mapped[float] = mapped_column(Float, index=True, default=0.0)
    max_lng: Mapped[float] = mapped_column(Float, index=True, default=0.0)
    # attributes the risk model needs. For imported roads these are ESTIMATES from the road class.
    age_years: Mapped[float] = mapped_column(Float, default=10.0)
    daily_traffic: Mapped[int] = mapped_column(Integer, default=3000)  # vehicles per day (estimate)
    facilities_nearby: Mapped[int] = mapped_column(Integer, default=0)  # schools/hospitals within ~260 m
    rainfall_mm_30d: Mapped[float] = mapped_column(Float, default=60.0)
    last_repair_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    repair_count: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(16), default="osm")  # osm | user
    # cached condition, refreshed by services.pipeline.refresh_roads
    has_data: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    current_severity: Mapped[float] = mapped_column(Float, default=0.0)
    last_report_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    reports: Mapped[list["RoadReport"]] = relationship(back_populates="road", cascade="all, delete-orphan")
    history: Mapped[list["RoadConditionHistory"]] = relationship(back_populates="road", cascade="all, delete-orphan")
    repairs: Mapped[list["Repair"]] = relationship(back_populates="road", cascade="all, delete-orphan")
    predictions: Mapped[list["Prediction"]] = relationship(back_populates="road", cascade="all, delete-orphan")
    priority: Mapped["MaintenancePriority | None"] = relationship(back_populates="road", uselist=False, cascade="all, delete-orphan")


class Place(Base):
    """A named place from OpenStreetMap (hospital, school, station...). Used for route search and to
    count schools/hospitals near each road."""

    __tablename__ = "places"

    id: Mapped[int] = mapped_column(primary_key=True)
    osm_id: Mapped[str] = mapped_column(String(32), unique=True)  # e.g. "node/12345"
    name: Mapped[str] = mapped_column(String(160), index=True)
    kind: Mapped[str] = mapped_column(String(24))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)


class NetworkArea(Base):
    """A bounding box whose OpenStreetMap road network has been imported (avoids re-fetching)."""

    __tablename__ = "network_areas"

    id: Mapped[int] = mapped_column(primary_key=True)
    south: Mapped[float] = mapped_column(Float)
    west: Mapped[float] = mapped_column(Float)
    north: Mapped[float] = mapped_column(Float)
    east: Mapped[float] = mapped_column(Float)
    segments: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(32), default="overpass")
    imported_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class RoadReport(Base):
    __tablename__ = "road_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"), index=True)
    reporter_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    description: Mapped[str] = mapped_column(Text, default="")
    reported_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    image_path: Mapped[str | None] = mapped_column(String(256), nullable=True)
    annotated_path: Mapped[str | None] = mapped_column(String(256), nullable=True)
    detector: Mapped[str] = mapped_column(String(96), default="")
    damage_count: Mapped[int] = mapped_column(Integer, default=0)
    damage_summary: Mapped[str] = mapped_column(String(160), default="")
    severity_score: Mapped[float] = mapped_column(Float, default=0.0)
    severity_level: Mapped[str] = mapped_column(String(16), default="Low")
    severity_breakdown: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    user_severity: Mapped[str | None] = mapped_column(String(16), nullable=True)  # optional reporter confirmation
    source: Mapped[str] = mapped_column(String(16), default="user")  # user | seed

    road: Mapped[Road] = relationship(back_populates="reports")
    detections: Mapped[list["DamageDetection"]] = relationship(back_populates="report", cascade="all, delete-orphan")


class DamageDetection(Base):
    __tablename__ = "damage_detections"

    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("road_reports.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(32), index=True)
    confidence: Mapped[float] = mapped_column(Float)
    x1: Mapped[float] = mapped_column(Float)
    y1: Mapped[float] = mapped_column(Float)
    x2: Mapped[float] = mapped_column(Float)
    y2: Mapped[float] = mapped_column(Float)
    area_ratio: Mapped[float] = mapped_column(Float, default=0.0)

    report: Mapped[RoadReport] = relationship(back_populates="detections")


class RoadConditionHistory(Base):
    __tablename__ = "road_condition_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"), index=True)
    recorded_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    severity: Mapped[float] = mapped_column(Float)
    report_count: Mapped[int] = mapped_column(Integer, default=0)
    event: Mapped[str] = mapped_column(String(24), default="report")  # report | repair | seed

    road: Mapped[Road] = relationship(back_populates="history")


class Repair(Base):
    __tablename__ = "repairs"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="completed")  # planned | completed
    planned_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    completed_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    road: Mapped[Road] = relationship(back_populates="repairs")


class Prediction(Base):
    __tablename__ = "predictions"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    risk: Mapped[float] = mapped_column(Float)  # probability 0..1
    risk_level: Mapped[str] = mapped_column(String(8))  # LOW | MEDIUM | HIGH
    model_name: Mapped[str] = mapped_column(String(64))
    model_version: Mapped[str] = mapped_column(String(16))
    features: Mapped[dict] = mapped_column(JSON)
    factors: Mapped[list] = mapped_column(JSON, default=list)

    road: Mapped[Road] = relationship(back_populates="predictions")


class MaintenancePriority(Base):
    __tablename__ = "maintenance_priorities"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"), unique=True, index=True)
    priority_score: Mapped[float] = mapped_column(Float)
    category: Mapped[str] = mapped_column(String(16))  # Immediate | High Priority | Medium Priority | Monitor
    recommended_action: Mapped[str] = mapped_column(String(200))
    components: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | inspected | repair_planned | repair_completed
    notes: Mapped[str] = mapped_column(Text, default="")
    inspected_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    road: Mapped[Road] = relationship(back_populates="priority")


class RoadEvent(Base):
    """Something happening on a road right now: a blockage, closure, construction, accident, flooding, severe damage
    - or the road reopening. Events come from community reports (PENDING until staff verify them) or are entered by
    authorised staff (VERIFIED at once). Nothing is blocked for ever: every event has `expires_at`, and staff can
    resolve it earlier. The location is a point (+ radius) and optionally the blocked stretch; `road_id` is only a
    convenience link to a RoadMind road, because the real road network comes from Google Maps, not from our database.

    verification_status: PENDING | VERIFIED | REJECTED          status: ACTIVE | RESOLVED | EXPIRED
    Only VERIFIED + ACTIVE + not-yet-expired events strongly affect route recommendations."""

    __tablename__ = "road_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    road_id: Mapped[int | None] = mapped_column(ForeignKey("roads.id", ondelete="SET NULL"), nullable=True, index=True)
    road_name: Mapped[str] = mapped_column(String(160), default="")
    lat: Mapped[float] = mapped_column(Float, index=True)
    lng: Mapped[float] = mapped_column(Float, index=True)
    radius_m: Mapped[float] = mapped_column(Float, default=50.0)  # how close a route must pass for the event to count
    geometry: Mapped[list | None] = mapped_column(JSON, nullable=True)  # optional [[lat, lng], ...] of the affected stretch
    event_type: Mapped[str] = mapped_column(String(24), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    reported_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    source: Mapped[str] = mapped_column(String(8), default="user")  # user (community report) | staff
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    verification_status: Mapped[str] = mapped_column(String(10), default="PENDING", index=True)
    status: Mapped[str] = mapped_column(String(10), default="ACTIVE", index=True)
    verified_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    resolved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    review_note: Mapped[str] = mapped_column(String(300), default="")
    evidence_path: Mapped[str | None] = mapped_column(String(256), nullable=True)  # photo, stored under media/events/


class RouteQuery(Base):
    __tablename__ = "route_queries"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    origin_name: Mapped[str] = mapped_column(String(160), default="")
    origin_lat: Mapped[float] = mapped_column(Float)
    origin_lng: Mapped[float] = mapped_column(Float)
    dest_name: Mapped[str] = mapped_column(String(160), default="")
    dest_lat: Mapped[float] = mapped_column(Float)
    dest_lng: Mapped[float] = mapped_column(Float)
    provider: Mapped[str] = mapped_column(String(16), default="demo")
    weights: Mapped[dict] = mapped_column(JSON, default=dict)
    recommended_label: Mapped[str] = mapped_column(String(16), default="")
    source: Mapped[str] = mapped_column(String(16), default="user")  # user | seed

    options: Mapped[list["RouteOption"]] = relationship(back_populates="query", cascade="all, delete-orphan", order_by="RouteOption.id")


class RouteOption(Base):
    __tablename__ = "route_options"

    id: Mapped[int] = mapped_column(primary_key=True)
    query_id: Mapped[int] = mapped_column(ForeignKey("route_queries.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(16))  # Route A, B, ...
    distance_km: Mapped[float] = mapped_column(Float)
    duration_min: Mapped[float] = mapped_column(Float)
    risk: Mapped[float] = mapped_column(Float)  # 0..1 effective risk used for ranking (unknown stretches at the neutral prior)
    data_coverage: Mapped[float] = mapped_column(Float, default=1.0)  # share of the route with RoadMind data
    score: Mapped[float] = mapped_column(Float)  # lower is better
    recommendation: Mapped[str] = mapped_column(String(16))  # Recommended | Alternative | Avoid
    is_fastest: Mapped[bool] = mapped_column(Boolean, default=False)
    geometry: Mapped[list] = mapped_column(JSON)
    road_ids: Mapped[list] = mapped_column(JSON, default=list)
    damaged_road_ids: Mapped[list] = mapped_column(JSON, default=list)  # roads with severity >= High on this route

    query: Mapped[RouteQuery] = relationship(back_populates="options")
