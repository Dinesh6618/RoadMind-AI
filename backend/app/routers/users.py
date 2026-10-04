"""User management (administrators only): review staff requests, invite staff, change roles, suspend accounts."""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..database import utcnow
from ..models import RoadAssignment, RoadReport, User
from ..schemas import ApproveAccount, RejectAccount, StaffInvite, UserAdminUpdate
from ..security import STAFF_ROLES, get_db, require_admin
from ..services import accounts
from ..services.queries import iso

router = APIRouter(prefix="/admin/users", tags=["Users (admin)"])


def _row(user: User, reports: int, assigned: int) -> dict:
    return {
        **accounts.profile(user),
        "status": accounts.status_of(user),  # PENDING_EMAIL_VERIFICATION | PENDING_ADMIN_APPROVAL | ACTIVE | REJECTED | SUSPENDED
        "requested_role": user.requested_role,
        "invited": user.must_set_password,
        "created_at": iso(user.created_at),
        "last_login_at": iso(user.last_login_at),
        "reviewed_at": iso(user.reviewed_at),
        "reports": reports,
        "assigned_roads": assigned,
    }


def _one(db: Session, user: User) -> dict:
    reports = db.scalar(select(func.count(RoadReport.id)).where(RoadReport.reporter_id == user.id)) or 0
    assigned = db.scalar(select(func.count(RoadAssignment.id)).where(RoadAssignment.user_id == user.id)) or 0
    return _row(user, reports, assigned)


def _delivery(settings, delivery) -> dict:
    return accounts.delivery_info(settings, delivery)


@router.get("", summary="All accounts")
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    reports = dict(db.execute(select(RoadReport.reporter_id, func.count()).where(RoadReport.reporter_id.is_not(None)).group_by(RoadReport.reporter_id)).all())
    assigned = accounts.assigned_counts(db)
    order = {"admin": 0, "maintenance": 1, "user": 2}
    users = sorted(db.scalars(select(User)), key=lambda u: (u.approval_status != "PENDING_APPROVAL", order.get(u.role, 9), u.created_at))  # requests to review first
    return [_row(u, reports.get(u.id, 0), assigned.get(u.id, 0)) for u in users]


@router.post("", status_code=201, summary="Create an authorised staff account (sends an invitation)")
def invite_staff(body: StaffInvite, request: Request, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Only an existing administrator can create administrator or maintenance accounts directly. The new person receives an
    email, verifies the address and chooses their own password - the administrator never sees or sets it."""
    settings = request.app.state.app_state.settings
    if accounts.email_taken(db, body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email address already exists.")
    user = accounts.create_staff(db, full_name=body.full_name, email=body.email, role=body.role, created_by=admin)
    token = accounts.issue_token(db, user, "invite", settings.auth.invite_hours)
    delivery = accounts.send_account_email(settings, user, "invite", token)
    return {**_one(db, user), **_delivery(settings, delivery)}


@router.post("/{user_id}/approve", summary="Approve a staff registration request")
def approve(user_id: int, body: ApproveAccount, request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Turns a verified request into a working account with the requested role (or the role chosen here). Only requests whose
    email address has been verified can be approved; a rejected request can be reconsidered."""
    settings = request.app.state.app_state.settings
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if user.approval_status not in ("PENDING_APPROVAL", "REJECTED") or user.email_verified_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a request whose email address has been verified can be approved.")
    role = body.role or user.requested_role
    if role not in STAFF_ROLES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose the role to grant: administrator or maintenance staff.")
    user.role, user.approval_status, user.is_active = role, "ACTIVE", True
    user.reviewed_by_id, user.reviewed_at = admin.id, utcnow()
    user.token_version += 1
    db.commit()
    tasks.add_task(accounts.send_decision_email, settings, user, True)
    return _one(db, user)


@router.post("/{user_id}/reject", summary="Reject a staff registration request")
def reject(user_id: int, body: RejectAccount, request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    settings = request.app.state.app_state.settings
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if user.approval_status not in ("PENDING_EMAIL", "PENDING_APPROVAL"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a pending request can be rejected. Suspend an active account instead.")
    user.approval_status = "REJECTED"
    user.reviewed_by_id, user.reviewed_at = admin.id, utcnow()
    user.token_version += 1
    db.commit()
    tasks.add_task(accounts.send_decision_email, settings, user, False, body.reason)
    return _one(db, user)


@router.post("/{user_id}/resend", summary="Send a new invitation / verification link")
def resend(user_id: int, request: Request, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    settings = request.app.state.app_state.settings
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if not accounts.needs_email_verification(user) or not user.is_active or not user.email:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only an active account with an unverified email address needs a link.")
    purpose = "invite" if user.must_set_password else "verify"
    hours = settings.auth.invite_hours if purpose == "invite" else settings.auth.verify_hours
    token = accounts.issue_token(db, user, purpose, hours)
    return {**_one(db, user), **_delivery(settings, accounts.send_account_email(settings, user, purpose, token))}


@router.patch("/{user_id}", summary="Change a user's role or suspend / reactivate the account")
def update_user(user_id: int, body: UserAdminUpdate, request: Request, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Role changes and suspension sign the user out everywhere. You cannot change your own role or status, and the
    last active administrator cannot be removed. Promoting an account to administrator or maintenance staff requires an
    email address; if it is not verified yet a verification link is sent and the account works once it is opened.
    Pending registration requests are decided with /approve or /reject, not here."""
    settings = request.app.state.app_state.settings
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if user.id == admin.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "You cannot change your own role or status. Ask another administrator.")
    if user.approval_status != "ACTIVE" and body.role is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This account is a registration request: approve or reject it instead of changing its role.")
    if user.approval_status == "REJECTED" and body.is_active:
        raise HTTPException(status.HTTP_409_CONFLICT, "A rejected request has to be approved before the account can be used.")
    new_role = body.role if body.role is not None else user.role
    new_active = body.is_active if body.is_active is not None else user.is_active
    removing_admin = user.role == "admin" and user.is_active and user.email_verified_at is not None and (new_role != "admin" or not new_active)
    if removing_admin and accounts.count_active_admins(db) <= 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "This is the last active administrator and cannot be removed.")
    if new_role in STAFF_ROLES and not user.email:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Administrator and maintenance accounts need an email address.")
    extra: dict = {}
    if (new_role, new_active) != (user.role, user.is_active):
        became_staff = new_role in STAFF_ROLES and user.role not in STAFF_ROLES
        if user.role == "maintenance" and new_role != "maintenance":
            db.execute(delete(RoadAssignment).where(RoadAssignment.user_id == user.id))  # their roads go back to unassigned
        user.role, user.is_active = new_role, new_active
        user.token_version += 1
        db.commit()
        if became_staff and user.email_verified_at is None and user.is_active:
            token = accounts.issue_token(db, user, "verify", settings.auth.verify_hours)
            extra = _delivery(settings, accounts.send_account_email(settings, user, "verify", token))
    return {**_one(db, user), **extra}
