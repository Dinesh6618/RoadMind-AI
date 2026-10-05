"""Request bodies (responses are plain JSON documented in docs/API.md and /docs)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator

from .security import valid_email

USERNAME_PATTERN = r"^[A-Za-z0-9._-]{3,32}$"


def _clean_email(value: str) -> str:
    value = value.strip().lower()
    if not valid_email(value):
        raise ValueError("Enter a valid email address.")
    return value


class LoginRequest(BaseModel):
    """Log in with a username or an email address."""

    identifier: str = Field(min_length=1, max_length=254, validation_alias=AliasChoices("identifier", "username", "email"))
    password: str = Field(min_length=1, max_length=256)


class NewAccount(BaseModel):
    """Shared by the first-run administrator setup and by normal-user registration. The username is optional:
    people sign in with their email address, and a unique username is derived from it when none is given."""

    full_name: str = Field(min_length=2, max_length=120)
    username: str | None = Field(default=None, pattern=USERNAME_PATTERN, description="3-32 letters, digits, dot, underscore or hyphen")
    email: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)

    @field_validator("full_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("Enter your full name.")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _clean_email(v)

    @model_validator(mode="after")
    def _match(self):
        if self.password != self.confirm_password:
            raise ValueError("Password and Confirm Password do not match.")
        return self


class ProfileUpdate(BaseModel):
    """Update profile details. Changing the username or email needs the current password."""

    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    username: str | None = Field(default=None, pattern=USERNAME_PATTERN)
    email: str | None = Field(default=None, max_length=254)
    current_password: str | None = Field(default=None, max_length=256)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str | None) -> str | None:
        return None if v is None else _clean_email(v)

    @field_validator("full_name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return None if v is None else " ".join(v.split())


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def _match(self):
        if self.new_password != self.confirm_password:
            raise ValueError("New Password and Confirm New Password do not match.")
        return self


class ForgotPassword(BaseModel):
    identifier: str = Field(min_length=1, max_length=254)


class PasswordReset(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    new_password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def _match(self):
        if self.new_password != self.confirm_password:
            raise ValueError("Password and Confirm Password do not match.")
        return self


class VerifyEmail(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class AcceptInvite(BaseModel):
    """The invitee chooses their own password; the administrator never sees it."""

    token: str = Field(min_length=20, max_length=200)
    new_password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def _match(self):
        if self.new_password != self.confirm_password:
            raise ValueError("Password and Confirm Password do not match.")
        return self


class ResendVerification(BaseModel):
    email: str = Field(max_length=254)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _clean_email(v)


class StaffInvite(BaseModel):
    """An administrator creates an authorised account; the person then verifies the address and sets a password."""

    full_name: str = Field(min_length=2, max_length=120)
    email: str = Field(max_length=254)
    role: Literal["admin", "maintenance"]

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _clean_email(v)

    @field_validator("full_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("Enter the person's full name.")
        return v


class StaffRegistration(BaseModel):
    """Public request for an administrator / maintenance account. It creates nothing privileged: an existing
    administrator must approve it after the email address has been verified."""

    full_name: str = Field(min_length=2, max_length=120)
    email: str = Field(max_length=254)
    account_type: Literal["admin", "maintenance"]
    password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _clean_email(v)

    @field_validator("full_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("Enter your full name.")
        return v

    @model_validator(mode="after")
    def _match(self):
        if self.password != self.confirm_password:
            raise ValueError("Password and Confirm Password do not match.")
        return self


class ApproveAccount(BaseModel):
    """Approve a pending request. `role` lets the administrator grant less (or the other staff role) than was asked for."""

    role: Literal["admin", "maintenance"] | None = None


class RejectAccount(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


class UserAdminUpdate(BaseModel):
    role: Literal["admin", "maintenance", "user"] | None = None
    is_active: bool | None = None


class AssignRoad(BaseModel):
    """Assign a road to a maintenance employee (user_id null removes the assignment)."""

    user_id: int | None = None


class StaffNote(BaseModel):
    note: str = Field(min_length=1, max_length=1000)


class Point(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    name: str = Field(default="", max_length=160)


class RouteWeights(BaseModel):
    """Relative importance of each factor (normalised to sum to 1). Omitted values use the configured defaults."""

    distance: float | None = Field(default=None, ge=0, le=1)
    time: float | None = Field(default=None, ge=0, le=1)
    damage_risk: float | None = Field(default=None, ge=0, le=1)


class RouteRequest(BaseModel):
    origin: Point
    destination: Point
    weights: RouteWeights | None = None


class RouteCalcRequest(BaseModel):
    """`POST /api/routes/calculate`: traffic-aware routes scored against RoadMind road condition and road events."""

    origin: Point
    destination: Point
    departure_time: datetime | None = Field(default=None, description="Optional future departure (ISO 8601); omitted = now")


class CurrentRoute(BaseModel):
    """The route the person is on now (when re-planning): the alternative's extra km / minutes are measured against it."""

    distance_km: float = Field(ge=0, le=5000)
    duration_min: float = Field(ge=0, le=100000)
    label: str = Field(default="", max_length=32)


class EmergencyRouteRequest(BaseModel):
    """`POST /api/emergency/route`: the origin is where the person is (GPS, only after they allow it) or typed in."""

    origin: Point
    destination: Point
    destination_kind: Literal["hospital", "fire_station", "police", "custom"] | None = None
    current: CurrentRoute | None = None


class RouteStatusRequest(BaseModel):
    """`POST /api/emergency/route-status`: the active route's geometry (thinned out is fine) and the events that were on it when planned."""

    geometry: list[list[float]] = Field(min_length=2, max_length=6000)
    known_event_ids: list[int] = Field(default_factory=list, max_length=200)

    @field_validator("geometry")
    @classmethod
    def _points(cls, v: list[list[float]]) -> list[list[float]]:
        for p in v:
            if len(p) != 2 or not (-90 <= p[0] <= 90 and -180 <= p[1] <= 180):
                raise ValueError("geometry must be [[lat, lng], ...] with valid coordinates")
        return v


EventType = Literal["ROAD_BLOCKED", "ROAD_CLOSED", "TEMPORARY_CLOSURE", "CONSTRUCTION", "ACCIDENT", "FLOODED", "SEVERE_DAMAGE", "ROAD_REOPENED"]


class RoadEventCreate(BaseModel):
    """Authorised staff record an event directly (it is verified at once). Communities use POST /api/road-reports."""

    event_type: EventType
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    road_name: str = Field(default="", max_length=160)
    description: str = Field(default="", max_length=1000)
    hours: float | None = Field(default=None, gt=0, le=24 * 30, description="How long it lasts (default depends on the type)")
    expires_at: datetime | None = None
    radius_m: float | None = Field(default=None, ge=10, le=500)
    geometry: list[list[float]] | None = Field(default=None, description="Optional [[lat, lng], ...] of the affected stretch", max_length=500)


class EventVerify(BaseModel):
    approved: bool = True
    note: str = Field(default="", max_length=300)
    hours: float | None = Field(default=None, gt=0, le=24 * 30)


class EventResolve(BaseModel):
    note: str = Field(default="", max_length=300)


class EventUpdate(BaseModel):
    """Staff change an event: wording, how long it lasts (construction progress), where it applies."""

    description: str | None = Field(default=None, max_length=1000)
    road_name: str | None = Field(default=None, max_length=160)
    hours: float | None = Field(default=None, gt=0, le=24 * 30)
    expires_at: datetime | None = None
    radius_m: float | None = Field(default=None, ge=10, le=500)
    event_type: EventType | None = None


class MaintenanceUpdate(BaseModel):
    status: Literal["pending", "inspected", "repair_planned", "repair_completed"]
    notes: str | None = Field(default=None, max_length=1000)
    planned_date: date | None = None
