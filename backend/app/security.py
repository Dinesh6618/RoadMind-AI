"""Password hashing (Argon2id), JWT sessions, password rules, rate limits and role-checking dependencies.

There are no built-in credentials anywhere in this module: every account is created by a person
choosing a password (first-run setup, registration, or a password reset).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .models import RevokedToken, User

bearer = HTTPBearer(auto_error=False)
STAFF_ROLES = ("admin", "maintenance")  # accounts that need a verified email address and sign in through a staff portal
_hasher = PasswordHasher()  # Argon2id with the library's current recommended parameters


# ------------------------------------------------------------------ hashing
def hash_password(password: str) -> str:
    """Argon2id hash with a random salt. The password itself is never stored or logged."""
    return _hasher.hash(password)


def _verify_legacy_scrypt(password: str, stored: str) -> bool:
    """Hashes written by RoadMind builds before Argon2 was adopted ("scrypt$salt$digest")."""
    try:
        scheme, salt_b64, digest_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(digest_b64)
        actual = hashlib.scrypt(password.encode(), salt=salt, dklen=len(expected), n=2**14, r=8, p=1)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def verify_password(password: str, stored: str) -> bool:
    if stored.startswith("$argon2"):
        try:
            return _hasher.verify(stored, password)
        except (VerificationError, InvalidHashError):
            return False
    return _verify_legacy_scrypt(password, stored)


def needs_rehash(stored: str) -> bool:
    """True for legacy hashes or Argon2 hashes with outdated parameters - upgraded transparently at login."""
    return (not stored.startswith("$argon2")) or _hasher.check_needs_rehash(stored)


# Verifying against this when the account does not exist keeps login time uniform (no account enumeration).
DUMMY_HASH = hash_password("roadmind-dummy-password-for-timing")


# ----------------------------------------------------------------- password rules
_COMMON_PASSWORDS = {
    "password", "password1", "password12", "password123", "passw0rd", "12345678", "123456789", "1234567890", "qwertyuiop",
    "qwerty123", "iloveyou", "letmein123", "welcome123", "administrator", "abcd1234", "abcdefghij", "roadmind", "roadmind123",
}


# Words that stay easy to guess even when digits or symbols are tacked on ("Password@123456", "welcome2026!").
_COMMON_CORES = {
    "password", "qwerty", "qwertyuiop", "asdfghjkl", "welcome", "letmein", "iloveyou", "admin", "administrator", "roadmind",
    "abcdefgh", "monkey", "dragon", "football", "baseball", "master", "changeme", "secret", "trustno",
}


def _built_on_common_word(core: str) -> bool:
    """The letters of the password are a common word, optionally with up to two extra letters at either end."""
    return any(core == w or (len(core) - len(w) in (1, 2) and (core.startswith(w) or core.endswith(w))) for w in _COMMON_CORES)


def password_problem(password: str, *personal: str, min_length: int = 10) -> str | None:
    """Why a new password is unacceptable, or None if it is fine. `personal` = values it must not contain
    (username, the part of the email before the @, ...)."""
    if len(password) < min_length:
        return f"The password must be at least {min_length} characters long."
    if len(password) > 128:
        return "The password is too long (maximum 128 characters)."
    low = password.lower()
    core = re.sub(r"[^a-z]+", "", low)  # letters only: "Password@123456" -> "password"
    if low in _COMMON_PASSWORDS or _built_on_common_word(core) or any(len(p) >= 3 and p.lower() in low for p in personal if p):
        return "That password is too easy to guess. Do not use a common password or your own name, username or email."
    if password.isdigit() or len(set(password)) < 5:
        return "Use a mix of letters, digits or symbols - not just digits or a few repeated characters."
    return None


EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")


def valid_email(value: str) -> bool:
    return len(value) <= 254 and bool(EMAIL_RE.match(value))


# -------------------------------------------------------------------- sessions
def create_token(user: User, secret: str, hours: float) -> str:
    """Signed, expiring session token. It names the user by id (so renaming does not log anyone out) and carries
    the user's token_version: bumping that column (password change, deactivation...) revokes every old token."""
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user.id), "role": user.role, "tv": user.token_version, "jti": secrets.token_hex(12), "iat": now, "exp": now + timedelta(hours=hours)}
    return jwt.encode(payload, secret, algorithm="HS256")


class LoginThrottle:
    """Tiny in-memory brute-force guard: `limit` events per key per `window_s`."""

    def __init__(self, limit: int = 8, window_s: int = 300):
        self.limit, self.window_s = limit, window_s
        self.failures: dict[str, list[float]] = {}

    def _recent(self, key: str) -> list[float]:
        cutoff = time.time() - self.window_s
        self.failures[key] = [t for t in self.failures.get(key, []) if t > cutoff]
        return self.failures[key]

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.limit

    def record_failure(self, key: str) -> None:
        self._recent(key).append(time.time())

    def reset(self, key: str) -> None:
        self.failures.pop(key, None)


class RateLimit:
    """Per-client sliding-window limiter, used as a dependency on public endpoints that do heavy work."""

    def __init__(self, limit: int, window_s: int = 60):
        self.limit, self.window_s = limit, window_s
        self.hits: dict[str, list[float]] = {}

    def __call__(self, request: Request) -> None:
        # keyed per app instance too, so several apps in one process (tests) never share a budget
        key = f"{getattr(request.app.state, 'instance_id', '')}:{request.client.host if request.client else 'unknown'}"
        now = time.time()
        recent = [t for t in self.hits.get(key, []) if t > now - self.window_s]
        if len(recent) >= self.limit:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests - please wait a moment and try again.")
        recent.append(now)
        self.hits[key] = recent


def get_db(request: Request):
    session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


# --------------------------------------------------------------- role dependencies
def _user_from_token(request: Request, creds: HTTPAuthorizationCredentials | None, db: Session) -> User | None:
    """The active user a valid, un-revoked token belongs to (any role), else None."""
    if creds is None:
        return None
    try:
        payload = jwt.decode(creds.credentials, request.app.state.settings.secret_key, algorithms=["HS256"])
        user = db.get(User, int(payload["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None
    if payload.get("jti") and db.get(RevokedToken, payload["jti"]) is not None:
        return None  # this very token was logged out
    if user is None or not user.is_active or payload.get("tv") != user.token_version:
        return None
    if user.approval_status != "ACTIVE":
        return None  # a registration that is still waiting for verification / approval (or was rejected) holds no session
    if user.role in STAFF_ROLES and user.email_verified_at is None:
        return None  # defence in depth: an unverified staff address never holds a working session
    return user


def current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    """Any signed-in, active user (administrator or normal user)."""
    user = _user_from_token(request, creds, db)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please log in.", headers={"WWW-Authenticate": "Bearer"})
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    """Administrators only: 401 when not signed in, 403 for everybody else (the message depends on who is asking)."""
    if user.role != "admin":
        if user.role == "maintenance":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Access Denied — Administrator privileges are required.")
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Access Denied — Administrator privileges are required to access this page.")
    return user


def require_staff(user: User = Depends(current_user)) -> User:
    """Administrators and maintenance staff (road work); normal users get 403."""
    if user.role not in STAFF_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Access Denied — Maintenance staff privileges are required.")
    return user


def optional_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User | None:
    return _user_from_token(request, creds, db)


def optional_admin(user: User | None = Depends(optional_user)) -> User | None:
    """Public endpoints use this to reveal extra (admin-only) fields when a valid administrator token is sent."""
    return user if user is not None and user.role == "admin" else None
