"""Account lookups, email-verification / invitation tokens and housekeeping."""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..database import utcnow
from ..models import EmailToken, RoadAssignment, User
from ..security import STAFF_ROLES, hash_password
from .mailer import send_email

log = logging.getLogger("roadmind.accounts")

ROLE_LABELS = {"admin": "Administrator", "maintenance": "Road maintenance staff", "user": "Normal user"}


def needs_email_verification(user: User) -> bool:
    """Staff accounts (and pending staff requests) must prove they own their address before anything else."""
    return user.email_verified_at is None and (user.role in STAFF_ROLES or user.approval_status == "PENDING_EMAIL")


def status_of(user: User) -> str:
    """The account state shown to administrators:
    PENDING_EMAIL_VERIFICATION | PENDING_ADMIN_APPROVAL | ACTIVE | REJECTED | SUSPENDED"""
    if user.approval_status == "REJECTED":
        return "REJECTED"
    if not user.is_active:
        return "SUSPENDED"
    if needs_email_verification(user) or user.must_set_password:
        return "PENDING_EMAIL_VERIFICATION"
    if user.approval_status == "PENDING_APPROVAL":
        return "PENDING_ADMIN_APPROVAL"
    return "ACTIVE"


# What a person who is refused at login is told (after the correct password only, so this reveals nothing to strangers).
STATUS_MESSAGES = {
    "PENDING_EMAIL_VERIFICATION": ("email_not_verified", "Please verify your email before logging in. Open the verification link we emailed you, or request a new one."),
    "PENDING_ADMIN_APPROVAL": ("pending_admin_approval", "Your account is waiting for administrator approval. You can sign in as soon as an administrator approves it."),
    "REJECTED": ("rejected", "Your account request was not approved. Please contact an administrator."),
    "SUSPENDED": ("suspended", "This account has been suspended. Please contact an administrator."),
}


def profile(user: User) -> dict:
    """What the client may know about an account. Never includes the password hash."""
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "email": user.email,
        "role": user.role,
        "is_active": user.is_active,
        "email_verified": user.email_verified_at is not None,
    }


def mask_email(email: str | None) -> str:
    """`dinesh@gmail.com` -> `d*****@gmail.com`: enough for the owner to recognise it, not for anyone else to use."""
    if not email or "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    return f"{local[:1]}{'*' * max(3, min(len(local) - 1, 8))}@{domain}"


def find_by_identifier(db: Session, identifier: str) -> User | None:
    """Look an account up by email address (or username), case-insensitively."""
    ident = identifier.strip().lower()
    if not ident:
        return None
    col = User.email if "@" in ident else User.username
    return db.scalar(select(User).where(func.lower(col) == ident))


def username_taken(db: Session, username: str, *, except_id: int | None = None) -> bool:
    q = select(User.id).where(func.lower(User.username) == username.strip().lower())
    if except_id is not None:
        q = q.where(User.id != except_id)
    return db.scalar(q) is not None


def email_taken(db: Session, email: str, *, except_id: int | None = None) -> bool:
    q = select(User.id).where(func.lower(User.email) == email.strip().lower())
    if except_id is not None:
        q = q.where(User.id != except_id)
    return db.scalar(q) is not None


def derive_username(db: Session, email: str) -> str:
    """People sign in with their email address, so a username is only a handle. Build a unique one from the address."""
    base = re.sub(r"[^A-Za-z0-9._-]", "", email.split("@", 1)[0])[:24].lower()
    if len(base) < 3:
        base = (base + "user")[:8]
    candidate, n = base, 1
    while username_taken(db, candidate):
        n += 1
        candidate = f"{base}{n}"
    return candidate


def admin_exists(db: Session) -> bool:
    """True when a usable administrator exists: active, with a VERIFIED email address."""
    return (
        db.scalar(select(func.count(User.id)).where(User.role == "admin", User.is_active.is_(True), User.email_verified_at.is_not(None))) or 0
    ) > 0


def pending_admin(db: Session) -> User | None:
    """The initial administrator who has been created but has not verified their email yet (if no verified one exists)."""
    if admin_exists(db):
        return None
    return db.scalar(select(User).where(User.role == "admin", User.is_active.is_(True), User.email.is_not(None), User.email_verified_at.is_(None)).order_by(User.id))


def pending_requests(db: Session) -> int:
    """Staff registrations still waiting for email verification or for an administrator's decision."""
    return db.scalar(select(func.count(User.id)).where(User.approval_status.in_(("PENDING_EMAIL", "PENDING_APPROVAL")))) or 0


def count_active_admins(db: Session) -> int:
    return db.scalar(select(func.count(User.id)).where(User.role == "admin", User.is_active.is_(True), User.email_verified_at.is_not(None))) or 0


def assigned_counts(db: Session) -> dict[int, int]:
    return dict(db.execute(select(RoadAssignment.user_id, func.count()).group_by(RoadAssignment.user_id)).all())


# ------------------------------------------------------------------ email tokens
def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(db: Session, user: User, purpose: str, hours: float) -> str:
    """Create a single-use token (replacing any unused one of the same kind) and return the raw value to be emailed."""
    token = secrets.token_urlsafe(32)
    db.execute(delete(EmailToken).where(EmailToken.user_id == user.id, EmailToken.purpose == purpose, EmailToken.used_at.is_(None)))
    db.add(EmailToken(user_id=user.id, purpose=purpose, token_hash=_hash(token), expires_at=utcnow() + timedelta(hours=hours)))
    db.commit()
    return token


def find_token(db: Session, token: str, purposes: tuple[str, ...]) -> tuple[EmailToken, User] | None:
    """The live (unused, unexpired) token row and its account, or None. Callers answer with one generic error."""
    row = db.scalar(select(EmailToken).where(EmailToken.token_hash == _hash(token), EmailToken.purpose.in_(purposes)))
    if row is None or row.used_at is not None or row.expires_at < utcnow():
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    return row, user


def send_account_email(settings: Settings, user: User, purpose: str, token: str) -> str:
    """Email the verification / invitation link. Returns "smtp" or "outbox" (see services.mailer)."""
    base = settings.auth.public_url.rstrip("/")
    role = ROLE_LABELS.get(user.requested_role or user.role, user.role)
    name = user.full_name or user.username
    if purpose == "invite":
        link = f"{base}/accept-invite?token={token}"
        subject = "You have been invited to RoadMind AI"
        text = (
            f"Hello {name},\n\n"
            f"An administrator has created a RoadMind AI account for you ({role}).\n"
            f"Open this link within {settings.auth.invite_hours} hours to verify this email address and choose your password:\n\n{link}\n\n"
            "If you were not expecting this, ignore this email - nothing happens until the link is used.\n"
        )
    else:
        link = f"{base}/verify-email?token={token}"
        subject = "Verify your RoadMind AI email address"
        after = (
            "After that, an administrator has to approve the request before you can sign in."
            if user.approval_status == "PENDING_EMAIL" else "The account cannot be used until the address is verified."
        )
        text = (
            f"Hello {name},\n\n"
            f"Please verify this email address for your RoadMind AI {role.lower()} account.\n"
            f"Open this link within {settings.auth.verify_hours} hours:\n\n{link}\n\n"
            f"{after} If you did not ask for this, ignore this email.\n"
        )
    return send_email(settings, user.email, subject, text)


def send_decision_email(settings: Settings, user: User, approved: bool, reason: str | None = None) -> str:
    """Tell a registrant the outcome of the administrator's review."""
    base = settings.auth.public_url.rstrip("/")
    name = user.full_name or user.username
    if approved:
        role = ROLE_LABELS.get(user.role, user.role).lower()
        subject, text = "Your RoadMind AI account was approved", (
            f"Hello {name},\n\nAn administrator approved your RoadMind AI {role} account.\n"
            f"You can now sign in with this email address at {base}/admin/login\n"
        )
    else:
        subject, text = "Your RoadMind AI account request was not approved", (
            f"Hello {name},\n\nAn administrator did not approve your request for a RoadMind AI staff account.\n"
            + (f"Reason given: {reason}\n" if reason else "") + "If you think this is a mistake, please contact an administrator.\n"
        )
    return send_email(settings, user.email, subject, text)


def delivery_info(settings: Settings, delivery) -> dict:
    """How an emailed link was handled, for the operator: where it went and, if a configured mail server failed, why.
    Never contains the link itself."""
    out: dict = {"delivery": str(delivery)}
    if delivery == "outbox":
        out["outbox_dir"] = str(settings.data_dir / "outbox")  # no (working) mail server: the message waits in this folder
        if getattr(delivery, "error", None):
            out["delivery_error"] = delivery.error
    return out


def email_mode(settings: Settings) -> dict:
    """What the setup page tells the person at the server computer about outgoing mail."""
    if settings.email.smtp_host:
        return {"mode": "smtp", "host": settings.email.smtp_host, "from": settings.email.from_address}
    return {"mode": "outbox", "outbox_dir": str(settings.data_dir / "outbox")}


def create_staff(db: Session, *, full_name: str, email: str, role: str, created_by: User | None) -> User:
    """An invited staff account: no usable password until the invitee sets one through the emailed link."""
    user = User(
        username=derive_username(db, email), full_name=full_name, email=email, role=role,
        password_hash=hash_password(secrets.token_urlsafe(48)),  # random placeholder; nobody knows it
        must_set_password=True, created_by_id=created_by.id if created_by else None,
    )
    db.add(user)
    db.commit()
    return user


def purge_legacy_admins(db: Session) -> int:
    """Remove administrator accounts that have no email address.

    Earlier builds created a built-in `admin` account at start-up. Accounts made through the setup page always
    have an email, so any admin without one is a leftover built-in account: it is removed so that no predefined
    administrator can exist. The owner then creates their own through the first-run setup page.
    """
    legacy = list(db.scalars(select(User).where(User.role == "admin", User.email.is_(None))))
    if legacy:
        names = ", ".join(u.username for u in legacy)
        db.execute(delete(User).where(User.id.in_([u.id for u in legacy])))
        db.commit()
        log.warning("Removed %d legacy built-in administrator account(s) (%s). Create your own at /setup.", len(legacy), names)
    return len(legacy)
