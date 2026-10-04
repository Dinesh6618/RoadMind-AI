"""Authentication for three separate portals: normal users (/login), administrators (/admin/login) and road
maintenance staff (/maintenance/login).

Design rules (see docs/ARCHITECTURE.md): no built-in accounts; passwords only as Argon2id hashes; generic
messages that never reveal whether an account exists; every sensitive change needs the current password;
password changes/resets sign out all existing sessions; administrator and maintenance accounts work only after
their email address has been verified; the role always comes from the database, never from the client.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..database import utcnow
from ..models import PasswordReset, RevokedToken, User
from ..schemas import (
    AcceptInvite, ForgotPassword, LoginRequest, NewAccount, PasswordChange, PasswordReset as PasswordResetBody,
    ProfileUpdate, ResendVerification, StaffRegistration, VerifyEmail,
)
from ..security import (
    DUMMY_HASH, STAFF_ROLES, RateLimit, bearer, create_token, current_user, get_db, hash_password, needs_rehash,
    password_problem, verify_password,
)
from ..services import accounts
from ..services.mailer import send_email

router = APIRouter(prefix="/auth", tags=["Authentication"])

_setup_limit = RateLimit(10, 60)
_register_limit = RateLimit(10, 60)
_forgot_limit = RateLimit(5, 60)
_reset_limit = RateLimit(10, 60)
_verify_limit = RateLimit(20, 60)
_resend_limit = RateLimit(5, 60)
_staff_register_limit = RateLimit(5, 60)
LOOPBACK = {"127.0.0.1", "::1", "localhost"}

LOGIN_FAILED = "Incorrect email or password."
GENERIC_SENT = "If an account matches, an email with a link has been sent to its address. The link works once and expires soon."
FORGOT_REPLY = {
    "message": GENERIC_SENT + " (On an installation without an email server the link is written to the server's console and outbox folder instead.)"
}
# Two doors: normal users, and "Admin & Road Maintenance" (one sign-in page; the role decides where the person lands).
PORTAL_PATH = {"user": "/user/login", "staff": "/admin/login"}
PORTAL_NAME = {"user": "the user portal", "staff": "the Admin & Road Maintenance portal"}
ROLE_HOME = {"admin": "/admin/dashboard", "maintenance": "/maintenance/dashboard", "user": "/user/home"}


def portal_of(role: str) -> str:
    return "staff" if role in STAFF_ROLES else "user"


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _session(user: User, state) -> dict:
    cfg = state.settings.auth
    hours = cfg.staff_token_hours if user.role in STAFF_ROLES else cfg.token_hours
    return {
        "access_token": create_token(user, state.settings.secret_key, hours),
        "token_type": "bearer",
        "expires_in": int(hours * 3600),
        "user": accounts.profile(user),
        "home": ROLE_HOME[user.role],  # where this role lands after signing in (decided here, never by the client)
    }


def _check_new_password(password: str, state, username: str, email: str | None) -> None:
    local = (email or "").split("@")[0]
    problem = password_problem(password, username, local, min_length=state.settings.auth.min_password_length)
    if problem:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, problem)


def _ensure_unique(db: Session, username: str | None, email: str | None, *, except_id: int | None = None) -> None:
    if username and accounts.username_taken(db, username, except_id=except_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "That username is already taken.")
    if email and accounts.email_taken(db, email, except_id=except_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email address already exists.")


# ----------------------------------------------------------------- first-run setup
@router.get("/setup-status", summary="Does an administrator exist yet?")
def setup_status(request: Request, db: Session = Depends(get_db)):
    """`setup_required` is true until an administrator with a VERIFIED email exists. The setup page can only be used
    from the computer running the server unless `auth.setup_local_only` is turned off."""
    state = request.app.state.app_state
    required = not accounts.admin_exists(db)
    allowed_here = required and ((_client(request) in LOOPBACK) or not state.settings.auth.setup_local_only)
    pending = accounts.pending_admin(db) if allowed_here else None
    return {
        "setup_required": required,
        "setup_allowed_here": allowed_here,
        "verification_pending": pending is not None,
        "pending_email": accounts.mask_email(pending.email) if pending else None,
        # where the verification email goes (only told to the server computer, only while it matters)
        "email": accounts.email_mode(state.settings) if pending is not None else None,
    }


@router.post("/setup", status_code=201, summary="Create the initial administrator (first run only)", dependencies=[Depends(_setup_limit)])
def setup(body: NewAccount, request: Request, db: Session = Depends(get_db)):
    """Works only while NO verified administrator exists. There is no built-in account: this is the only way the first
    administrator comes into being. The password is stored only as an Argon2id hash and the account cannot be used until
    the emailed verification link has been opened. Running setup again before that replaces the unverified account
    (for example after a mistyped address)."""
    state = request.app.state.app_state
    settings = state.settings
    if settings.auth.setup_local_only and _client(request) not in LOOPBACK:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Open this page on the computer that runs RoadMind to create the administrator account.")
    with state.setup_lock:  # two simultaneous requests must not both create an administrator
        if accounts.admin_exists(db):
            raise HTTPException(status.HTTP_409_CONFLICT, "An administrator account already exists. Please log in.")
        pending = accounts.pending_admin(db)
        _ensure_unique(db, body.username, body.email, except_id=pending.id if pending else None)
        # check the password against the details it will belong to BEFORE the old unverified account is replaced
        username = body.username or accounts.derive_username(db, body.email)
        _check_new_password(body.password, state, username, body.email)
        if pending is not None:
            db.delete(pending)
            db.commit()
            username = body.username or accounts.derive_username(db, body.email)
        user = User(username=username, full_name=body.full_name, email=body.email, password_hash=hash_password(body.password), role="admin")
        db.add(user)
        db.commit()
        token = accounts.issue_token(db, user, "verify", settings.auth.verify_hours)
    delivery = accounts.send_account_email(settings, user, "verify", token)
    return {
        "created": True,
        "email": user.email,
        "verification_required": True,
        "message": f"Administrator account created. We sent a verification link to {user.email}; open it to activate the account.",
        **accounts.delivery_info(settings, delivery),  # no (working) mail server: tells the person at this computer where the message is
    }


@router.post("/setup/resend", summary="Send the verification email again to the initial administrator", dependencies=[Depends(_resend_limit)])
def setup_resend(request: Request, db: Session = Depends(get_db)):
    """For the page shown after setup (also after a reload, when the full address is no longer on screen): sends a fresh
    verification link to the administrator who is still waiting. Same gate as setup itself - the server computer only."""
    state = request.app.state.app_state
    settings = state.settings
    if settings.auth.setup_local_only and _client(request) not in LOOPBACK:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Open this page on the computer that runs RoadMind.")
    pending = accounts.pending_admin(db)
    if pending is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No administrator is waiting for email verification.")
    token = accounts.issue_token(db, pending, "verify", settings.auth.verify_hours)
    delivery = accounts.send_account_email(settings, pending, "verify", token)
    return {"email": accounts.mask_email(pending.email), "message": f"A new verification link was prepared for {accounts.mask_email(pending.email)}.", **accounts.delivery_info(settings, delivery)}


# ----------------------------------------------------------------------- accounts
@router.post("/register", status_code=201, summary="Create a normal-user account", dependencies=[Depends(_register_limit)])
def register(body: NewAccount, request: Request, db: Session = Depends(get_db)):
    """Normal users can report damage, view roads, plan routes and see their own reports - never admin pages.
    The role is always "user": there is no way to ask for another one here."""
    state = request.app.state.app_state
    _ensure_unique(db, body.username, body.email)
    username = body.username or accounts.derive_username(db, body.email)
    _check_new_password(body.password, state, username, body.email)
    user = User(username=username, full_name=body.full_name, email=body.email, password_hash=hash_password(body.password), role="user")
    db.add(user)
    db.commit()
    return _session(user, state)


def _portal_login(portal: str, body: LoginRequest, request: Request, db: Session) -> dict:
    state = request.app.state.app_state
    ident = body.identifier.strip().lower()
    keys = (f"ip:{_client(request)}", f"id:{ident}")
    if any(state.throttle.blocked(k) for k in keys):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many failed login attempts. Try again in a few minutes.")
    user = accounts.find_by_identifier(db, body.identifier)
    ok = verify_password(body.password, user.password_hash if user else DUMMY_HASH)  # same work whether or not the account exists
    if not (user and ok):
        for k in keys:
            state.throttle.record_failure(k)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)

    # The credentials are correct from here on, so it is safe to say precisely why this door says no.
    # 1-4: account status (email verified? approved? not rejected / suspended?) - whatever door was used.
    account_state = accounts.status_of(user)
    if account_state != "ACTIVE":
        code, message = accounts.STATUS_MESSAGES[account_state]
        detail = {"message": message, "code": code, "status": account_state}
        if code == "email_not_verified":
            detail["message"] = f"Your email address ({accounts.mask_email(user.email)}) has not been verified yet. Open the verification link we emailed you, or request a new one."
            detail["email"] = user.email
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail)
    # 5: the role - a staff account does not use the user door and vice versa.
    actual = portal_of(user.role)
    if actual != portal:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            {"message": f"This account signs in through {PORTAL_NAME[actual]}.", "code": "wrong_portal", "portal": actual, "login_path": PORTAL_PATH[actual]},
        )
    state.throttle.reset(keys[1])
    if needs_rehash(user.password_hash):  # upgrade old hashes silently, now that we hold the plaintext
        user.password_hash = hash_password(body.password)
    user.last_login_at = utcnow()
    db.commit()
    return _session(user, state)


@router.post("/login", summary="User portal login (email + password)")
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """For normal users. Administrators and maintenance staff are pointed to their own portal."""
    return _portal_login("user", body, request, db)


@router.post("/staff/login", summary="Admin & Road Maintenance portal login (verified authorised email + password)")
def staff_login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """For administrators and road-maintenance staff. The password, the account status, the verified email and the role are
    all checked here; the reply says where this role goes next (`home`). Normal users are refused and pointed to /user/login."""
    return _portal_login("staff", body, request, db)


@router.post("/staff/register", status_code=201, summary="Request an administrator / maintenance account (needs verification + approval)", dependencies=[Depends(_staff_register_limit)])
def staff_register(body: StaffRegistration, request: Request, db: Session = Depends(get_db)):
    """Creates a REQUEST, never privileges. The account keeps the plain "user" role and cannot sign in anywhere until
    (1) the emailed link has verified the address and (2) an existing administrator has approved it - only then does it get
    the role it asked for (or the one the administrator chooses). Choosing "Administrator" here grants nothing by itself."""
    state = request.app.state.app_state
    settings = state.settings
    if not accounts.admin_exists(db):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "There is no administrator yet to approve requests. The initial administrator is created on the computer that runs RoadMind.",
        )
    if accounts.pending_requests(db) >= settings.auth.max_pending_requests:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many account requests are waiting for review right now. Please try again later.")
    _ensure_unique(db, None, body.email)
    username = accounts.derive_username(db, body.email)
    _check_new_password(body.password, state, username, body.email)
    user = User(
        username=username, full_name=body.full_name, email=body.email, password_hash=hash_password(body.password),
        role="user", approval_status="PENDING_EMAIL", requested_role=body.account_type,
    )
    db.add(user)
    db.commit()
    token = accounts.issue_token(db, user, "verify", settings.auth.verify_hours)
    delivery = accounts.send_account_email(settings, user, "verify", token)
    return {
        "created": True,
        "email": user.email,
        "status": accounts.status_of(user),
        "requested_role": user.requested_role,
        "message": "Your account has been created successfully. Verify your email with the link we sent, then wait for administrator approval.",
        **accounts.delivery_info(settings, delivery),
    }


@router.get("/me", summary="The signed-in account")
def me(user: User = Depends(current_user)):
    return accounts.profile(user)


@router.post("/logout", summary="End this session")
def logout(request: Request, creds=Depends(bearer), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Revokes the token used for this request (other devices stay signed in; use /logout-all for those)."""
    try:
        payload = jwt.decode(creds.credentials, request.app.state.settings.secret_key, algorithms=["HS256"])
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        db.execute(delete(RevokedToken).where(RevokedToken.expires_at < utcnow()))  # housekeeping: forget expired entries
        if payload.get("jti") and db.get(RevokedToken, payload["jti"]) is None:
            db.add(RevokedToken(jti=payload["jti"], expires_at=exp))
        db.commit()
    except (jwt.PyJWTError, KeyError):
        pass
    return {"message": "Signed out."}


@router.patch("/profile", summary="Update profile details (name, username, email)")
def update_profile(body: ProfileUpdate, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Changing the username or email needs the current password; the display name does not. The email address of an
    administrator or maintenance account is its verified identity and cannot be changed here."""
    state = request.app.state.app_state
    new_username = body.username if body.username and body.username != user.username else None
    new_email = body.email if body.email and body.email != user.email else None
    if new_email and user.role in STAFF_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "The authorised email address of an administrator or maintenance account cannot be changed here. Ask an administrator.")
    if new_username or new_email:
        key = f"change:{user.id}"
        if state.throttle.blocked(key):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many wrong passwords. Try again in a few minutes.")
        if not body.current_password or not verify_password(body.current_password, user.password_hash):
            state.throttle.record_failure(key)
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Enter your current password to change your username or email.")
        state.throttle.reset(key)
        _ensure_unique(db, new_username, new_email, except_id=user.id)
    if body.full_name:
        user.full_name = body.full_name
    if new_username:
        user.username = new_username
    if new_email:
        user.email = new_email
    db.commit()
    return accounts.profile(user)


@router.post("/change-password", summary="Change your password")
def change_password(body: PasswordChange, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Needs the current password. All other sessions are signed out; this one gets a fresh token."""
    state = request.app.state.app_state
    key = f"change:{user.id}"
    if state.throttle.blocked(key):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many wrong passwords. Try again in a few minutes.")
    if not verify_password(body.current_password, user.password_hash):
        state.throttle.record_failure(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "The current password is incorrect.")
    state.throttle.reset(key)
    if body.new_password == body.current_password:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The new password must be different from the current one.")
    _check_new_password(body.new_password, state, user.username, user.email)
    user.password_hash = hash_password(body.new_password)
    user.token_version += 1
    db.commit()
    return {**_session(user, state), "message": "Your password was changed. Other devices have been signed out."}


@router.post("/logout-all", summary="Sign out of every device")
def logout_all(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.token_version += 1
    db.commit()
    return {"message": "Signed out everywhere."}


# -------------------------------------------------- email verification and invitations
def _portal_info(user: User) -> dict:
    # a pending staff request still has the plain "user" role, but its sign-in door is the staff one
    portal = "staff" if (user.role in STAFF_ROLES or user.requested_role) else "user"
    return {"role": user.role, "portal": portal, "login_path": PORTAL_PATH[portal], "home": ROLE_HOME[user.role], "status": accounts.status_of(user)}


@router.post("/verify-email", summary="Verify an administrator / maintenance email address", dependencies=[Depends(_verify_limit)])
def verify_email(body: VerifyEmail, db: Session = Depends(get_db)):
    """Opens the emailed link and marks the address as verified. For the initial administrator and invited staff that
    activates the account; for a self-service staff registration it moves the request on to "pending administrator
    approval" - it still cannot sign in until an administrator approves it. Invitation links (which also set a password)
    go to /auth/accept-invite instead."""
    found = accounts.find_token(db, body.token, ("verify",))
    if found is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This verification link is invalid, already used or has expired. Request a new one from the login page.")
    row, user = found
    now = utcnow()
    row.used_at = now
    if user.email_verified_at is None:
        user.email_verified_at = now
    if user.approval_status == "PENDING_EMAIL":
        user.approval_status = "PENDING_APPROVAL"
    db.commit()
    if user.approval_status == "PENDING_APPROVAL":
        message = "Your email has been verified. Your account is now waiting for administrator approval; you will be able to sign in once it is approved."
    else:
        label = {"admin": "administrator", "maintenance": "maintenance staff"}.get(user.role, "")
        message = f"Your RoadMind AI {label + ' ' if label else ''}email has been verified."
    return {"verified": True, "message": message, **_portal_info(user)}


@router.post("/accept-invite", summary="Accept an invitation: verify the address and choose a password", dependencies=[Depends(_verify_limit)])
def accept_invite(body: AcceptInvite, request: Request, db: Session = Depends(get_db)):
    state = request.app.state.app_state
    found = accounts.find_token(db, body.token, ("invite",))
    if found is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This invitation link is invalid, already used or has expired. Ask an administrator to send a new one.")
    row, user = found
    _check_new_password(body.new_password, state, user.username, user.email)
    now = utcnow()
    user.password_hash = hash_password(body.new_password)
    user.must_set_password = False
    user.email_verified_at = now
    user.token_version += 1
    row.used_at = now
    db.commit()
    return {"verified": True, "message": "Your email is verified and your password is set. You can now log in.", **_portal_info(user)}


@router.post("/resend-verification", summary="Send a new verification / invitation link", dependencies=[Depends(_resend_limit)])
def resend_verification(body: ResendVerification, request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Always answers the same way. Only unverified administrator / maintenance accounts receive a message, and at most a
    few per address per 15 minutes."""
    state = request.app.state.app_state
    settings = state.settings
    key = f"verify:{body.email}"
    if state.forgot_throttle.blocked(key):
        return {"message": GENERIC_SENT}
    state.forgot_throttle.record_failure(key)
    user = accounts.find_by_identifier(db, body.email)
    if user and user.is_active and accounts.needs_email_verification(user) and user.email:
        purpose = "invite" if user.must_set_password else "verify"
        hours = settings.auth.invite_hours if purpose == "invite" else settings.auth.verify_hours
        token = accounts.issue_token(db, user, purpose, hours)
        tasks.add_task(accounts.send_account_email, settings, user, purpose, token)
    return {"message": GENERIC_SENT}


# ------------------------------------------------------------------ password reset
def _can_reset(user: User | None) -> bool:
    """Staff accounts must have a verified address (and a password of their own) before a reset makes sense."""
    if user is None or not user.is_active or not user.email:
        return False
    return user.role == "user" or (user.email_verified_at is not None and not user.must_set_password)


@router.post("/forgot-password", summary="Request a password-reset email", dependencies=[Depends(_forgot_limit)])
def forgot_password(body: ForgotPassword, request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Always answers the same way, whether or not an account matches. If one does, a single-use token (stored only
    as a hash, valid for `auth.reset_minutes`) is emailed as a link. The old password is never revealed."""
    state = request.app.state.app_state
    settings = state.settings
    ident = body.identifier.strip().lower()
    key = f"forgot:{ident}"
    if state.forgot_throttle.blocked(key):
        return FORGOT_REPLY
    state.forgot_throttle.record_failure(key)  # counts every request, so one account cannot be mail-bombed
    user = accounts.find_by_identifier(db, body.identifier)
    if _can_reset(user):
        token = secrets.token_urlsafe(32)
        db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None)))  # one live link at a time
        db.add(PasswordReset(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=utcnow() + timedelta(minutes=settings.auth.reset_minutes)))
        db.commit()
        link = f"{settings.auth.public_url.rstrip('/')}/reset-password?token={token}"
        text = (
            f"Hello {user.full_name or user.username},\n\n"
            f"We received a request to reset the password of your RoadMind AI account ({user.email}).\n"
            f"Open this link within {settings.auth.reset_minutes} minutes to choose a new password:\n\n{link}\n\n"
            "If you did not ask for this, ignore this email - your password has not been changed.\n"
        )
        tasks.add_task(send_email, settings, user.email, "Reset your RoadMind AI password", text)  # after the response: no timing difference
    return FORGOT_REPLY


@router.post("/reset-password", summary="Choose a new password with a reset link", dependencies=[Depends(_reset_limit)])
def reset_password(body: PasswordResetBody, request: Request, db: Session = Depends(get_db)):
    state = request.app.state.app_state
    invalid = HTTPException(status.HTTP_400_BAD_REQUEST, "This reset link is invalid or has expired. Please request a new one.")
    row = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == hashlib.sha256(body.token.encode()).hexdigest()))
    now = utcnow()
    if row is None or row.used_at is not None or row.expires_at < now:
        raise invalid
    user = db.get(User, row.user_id)
    if not _can_reset(user):
        raise invalid
    _check_new_password(body.new_password, state, user.username, user.email)
    user.password_hash = hash_password(body.new_password)
    user.token_version += 1  # every existing session ends
    row.used_at = now
    db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.id != row.id))
    db.commit()
    state.throttle.reset(f"id:{user.username.lower()}")
    state.throttle.reset(f"id:{(user.email or '').lower()}")
    return {"message": "Your password was changed. You can now log in with it.", **_portal_info(user)}
