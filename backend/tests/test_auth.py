"""Accounts for three separate portals: user, administrator and maintenance staff.

Covers first-run setup with email verification (no built-in admin), Argon2 hashing, portal separation, roles,
staff invitations, profile / password changes, sessions and logout, password reset and legacy upgrades.
Each test gets its own throw-away app so one test's accounts cannot affect another's."""

import smtplib
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text

from app.config import load_settings
from app.database import utcnow
from app.main import create_app
from app.models import EmailToken, PasswordReset, User
from app.security import hash_password, password_problem, valid_email, verify_password
from conftest import ADMIN, STAFF, STAFF_PASSWORD, USER, email_token, verify_admin

NOT_ADMIN = "Access Denied — Administrator privileges are required to access this page."
STAFF_NOT_ADMIN = "Access Denied — Administrator privileges are required."


def _settings(app, tmp_path, **auth):
    s = load_settings({"data_dir": tmp_path, "seed_demo_data": False,
                       "network": {"source_file": str(tmp_path / "none.json"), "remote_enabled": False}, "auth": {"setup_local_only": False, **auth}})
    s.risk.model_path, s.risk.metrics_path = app.state.settings.risk.model_path, app.state.settings.risk.metrics_path
    return s


@pytest.fixture()
def fresh(client, app, tmp_path):  # `client` starts the shared app, whose pre-trained risk model is reused
    """An empty app: no accounts exist until a test creates them."""
    with TestClient(create_app(_settings(app, tmp_path))) as c:
        yield c


@pytest.fixture()
def ready(fresh):
    """Fresh app with the initial administrator created AND verified, as on a real install."""
    verify_admin(fresh)
    return fresh


def _login(portal, c, ident, password):
    return c.post(f"/api/auth/{portal}" if portal else "/api/auth/login", json={"identifier": ident, "password": password})


def admin_login(c, ident=ADMIN["email"], password=ADMIN["password"]):
    return _login("staff/login", c, ident, password)


def user_login(c, ident=USER["email"], password=USER["password"]):
    return _login(None, c, ident, password)


def staff_login(c, ident=STAFF["email"], password=STAFF_PASSWORD):
    return _login("staff/login", c, ident, password)


def bearer(r):
    assert r.status_code in (200, 201), r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def users(c):
    with c.app.state.session_factory() as db:
        return list(db.scalars(select(User)))


def mails(c, needle):
    box = c.app.state.settings.data_dir / "outbox"
    return [f.read_text(encoding="utf-8") for f in sorted(box.glob("*.txt")) if needle in f.read_text(encoding="utf-8")] if box.exists() else []


def make_staff(c, headers, body=STAFF, password=STAFF_PASSWORD):
    """Invite a staff member and accept the invitation, like the real thing."""
    r = c.post("/api/admin/users", json=body, headers=headers)
    assert r.status_code == 201, r.text
    ok = c.post("/api/auth/accept-invite", json={"token": email_token(c, "accept-invite"), "new_password": password, "confirm_password": password})
    assert ok.status_code == 200, ok.text
    return r.json()


# ============================================================== first-run setup
def test_a_fresh_install_has_no_accounts_at_all(fresh):
    assert users(fresh) == []  # nothing hidden, predefined or backdoor
    for name, pw in (("admin", "admin123"), ("administrator@gmail.com", "password")):  # (a few: repeated failures from one address are throttled)
        for portal in (admin_login, user_login, staff_login):
            assert portal(fresh, name, pw).status_code == 401
    assert fresh.get("/api/auth/setup-status").json() == {"setup_required": True, "setup_allowed_here": True, "verification_pending": False, "pending_email": None, "email": None}


def test_setup_creates_an_unverified_administrator_who_must_open_the_emailed_link(fresh):
    r = fresh.post("/api/auth/setup", json=ADMIN)
    body = r.json()
    assert r.status_code == 201 and body["created"] and body["verification_required"] and body["delivery"] == "outbox"
    assert "access_token" not in body and ADMIN["password"] not in r.text  # setup never signs anybody in
    [admin] = users(fresh)
    assert admin.role == "admin" and admin.email == ADMIN["email"] and admin.email_verified_at is None

    status = fresh.get("/api/auth/setup-status").json()
    assert status["setup_required"] and status["verification_pending"] and status["pending_email"].endswith("@example.org") and status["pending_email"] != ADMIN["email"]

    blocked = admin_login(fresh)  # right password, but the address is not verified
    assert blocked.status_code == 403 and blocked.json()["detail"]["code"] == "email_not_verified"

    token = email_token(fresh, "verify-email")
    assert token not in r.text  # the link is only in the email
    ok = fresh.post("/api/auth/verify-email", json={"token": token})
    assert ok.status_code == 200 and ok.json()["portal"] == "staff" and ok.json()["login_path"] == "/admin/login" and "administrator email has been verified" in ok.json()["message"]
    assert admin_login(fresh).status_code == 200
    assert fresh.get("/api/auth/setup-status").json()["setup_required"] is False
    assert fresh.post("/api/auth/setup", json={**ADMIN, "email": "second@example.org"}).status_code == 409  # setup can never add a second admin


@pytest.mark.parametrize(
    "change",
    [
        {"full_name": ""}, {"full_name": "x"}, {"username": "ab"}, {"username": "has space"}, {"username": "a@b.org"},
        {"email": ""}, {"email": "not-an-email"}, {"email": "a@b"}, {"email": "a b@example.org"},
        {"password": "", "confirm_password": ""},
    ],
)
def test_setup_rejects_empty_and_invalid_input(fresh, change):
    assert fresh.post("/api/auth/setup", json={**ADMIN, **change}).status_code == 422
    assert users(fresh) == []


def test_setup_requires_matching_and_strong_passwords(fresh):
    mismatch = fresh.post("/api/auth/setup", json={**ADMIN, "confirm_password": "Different-Pass-1"})
    assert mismatch.status_code == 422 and "do not match" in mismatch.text
    for weak in ("short1!", "password123", "1234567890", "aaaaaaaaaaaa", "test.admin-2026", "admin@example-pass", "Test Administrator"):
        r = fresh.post("/api/auth/setup", json={**ADMIN, "password": weak, "confirm_password": weak})
        assert r.status_code == 422, weak
    assert users(fresh) == []


def test_setup_is_only_allowed_on_the_server_computer_by_default(app, tmp_path):
    with TestClient(create_app(_settings(app, tmp_path, setup_local_only=True))) as c:  # test client address is not loopback
        assert c.get("/api/auth/setup-status").json()["setup_allowed_here"] is False
        r = c.post("/api/auth/setup", json=ADMIN)
        assert r.status_code == 403 and "computer that runs RoadMind" in r.json()["detail"]
        assert users(c) == []


def test_running_setup_again_before_verification_replaces_the_unverified_account(fresh):
    fresh.post("/api/auth/setup", json=ADMIN)  # typo'd address: nobody can ever open that link
    old = email_token(fresh, "verify-email")
    again = fresh.post("/api/auth/setup", json={**ADMIN, "email": "right@example.org"})
    assert again.status_code == 201
    [admin] = users(fresh)
    assert admin.email == "right@example.org" and admin.email_verified_at is None
    assert fresh.post("/api/auth/verify-email", json={"token": old}).status_code == 400  # the old link died with the old account
    assert fresh.post("/api/auth/verify-email", json={"token": email_token(fresh, "verify-email")}).status_code == 200
    assert fresh.post("/api/auth/setup", json={**ADMIN, "email": "third@example.org"}).status_code == 409  # now it is closed


def test_a_weak_password_does_not_replace_the_pending_account(fresh):
    fresh.post("/api/auth/setup", json=ADMIN)
    r = fresh.post("/api/auth/setup", json={**ADMIN, "email": "other@example.org", "password": "short", "confirm_password": "short"})
    assert r.status_code == 422
    assert [u.email for u in users(fresh)] == [ADMIN["email"]]


def test_two_setups_cannot_both_win(ready):
    assert ready.post("/api/auth/setup", json={**ADMIN, "email": "rival@example.org"}).status_code == 409
    assert [u.email for u in users(ready)] == [ADMIN["email"]]


# ================================================================ verification
def test_verification_links_are_single_use_expire_and_garbage_is_rejected(fresh):
    fresh.post("/api/auth/setup", json=ADMIN)
    token = email_token(fresh, "verify-email")
    with fresh.app.state.session_factory() as db:  # only a hash of the token is stored
        stored = db.scalars(select(EmailToken)).one()
        assert token not in stored.token_hash and len(stored.token_hash) == 64 and stored.purpose == "verify"
        stored.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    assert fresh.post("/api/auth/verify-email", json={"token": token}).status_code == 400  # expired
    assert fresh.post("/api/auth/verify-email", json={"token": "x" * 43}).status_code == 400
    assert admin_login(fresh).status_code == 403  # still unverified

    again = fresh.post("/api/auth/resend-verification", json={"email": ADMIN["email"]})
    assert again.status_code == 200
    fresh_token = email_token(fresh, "verify-email")
    assert fresh_token != token
    assert fresh.post("/api/auth/verify-email", json={"token": fresh_token}).status_code == 200
    assert fresh.post("/api/auth/verify-email", json={"token": fresh_token}).status_code == 400  # single use
    assert admin_login(fresh).status_code == 200


def test_resending_a_verification_link_never_reveals_which_addresses_exist(fresh):
    fresh.post("/api/auth/setup", json=ADMIN)
    known = fresh.post("/api/auth/resend-verification", json={"email": ADMIN["email"]})
    unknown = fresh.post("/api/auth/resend-verification", json={"email": "ghost@example.org"})
    assert known.status_code == unknown.status_code == 200 and known.json() == unknown.json()
    assert len(mails(fresh, "verify-email")) == 2 and all(ADMIN["email"] in m for m in mails(fresh, "verify-email"))  # setup + resend, nothing for the ghost


def test_normal_users_and_verified_accounts_get_no_verification_mail(ready):
    ready.post("/api/auth/register", json=USER)
    before = len(mails(ready, "verify-email"))
    for email in (USER["email"], ADMIN["email"]):
        assert ready.post("/api/auth/resend-verification", json={"email": email}).status_code == 200
    assert len(mails(ready, "verify-email")) == before


def test_an_unverified_staff_account_never_holds_a_working_session(ready):
    h = bearer(admin_login(ready))
    assert ready.get("/api/auth/me", headers=h).status_code == 200
    with ready.app.state.session_factory() as db:  # e.g. verification withdrawn after the token was issued
        admin = db.scalar(select(User))
        admin.email_verified_at = None
        db.commit()
    assert ready.get("/api/auth/me", headers=h).status_code == 401
    assert ready.get("/api/admin/users", headers=h).status_code == 401


# =========================================================== storing passwords
def test_passwords_are_stored_only_as_argon2id_hashes(ready):
    [admin] = users(ready)
    assert admin.password_hash.startswith("$argon2id$") and ADMIN["password"] not in admin.password_hash
    assert verify_password(ADMIN["password"], admin.password_hash) and not verify_password("wrong", admin.password_hash)
    assert hash_password("same") != hash_password("same")  # random salt
    r = admin_login(ready)
    for body in (r.text, ready.get("/api/auth/me", headers=bearer(r)).text, ready.get("/api/admin/users", headers=bearer(r)).text):
        assert ADMIN["password"] not in body and "argon2" not in body and "password_hash" not in body
    raw = (ready.app.state.settings.data_dir / "roadmind.db").read_bytes()  # the plaintext is nowhere in the database file
    assert ADMIN["password"].encode() not in raw


def test_old_scrypt_hashes_still_work_and_are_upgraded_at_login(ready):
    import base64, hashlib, os

    salt = os.urandom(16)
    legacy = "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(hashlib.scrypt(b"Legacy-Pass-1234", salt=salt, dklen=32, n=2**14, r=8, p=1)).decode()
    with ready.app.state.session_factory() as db:
        db.add(User(username="olduser", email="old@example.org", full_name="Old User", password_hash=legacy, role="user"))
        db.commit()
    assert user_login(ready, "old@example.org", "Legacy-Pass-1234").status_code == 200
    assert next(u for u in users(ready) if u.username == "olduser").password_hash.startswith("$argon2id$")
    assert user_login(ready, "old@example.org", "Legacy-Pass-1234").status_code == 200  # and still works after the upgrade


# ============================================================ portal separation
def test_each_door_only_accepts_its_own_accounts(ready):
    h = bearer(admin_login(ready))
    ready.post("/api/auth/register", json=USER)
    make_staff(ready, h)

    assert user_login(ready).status_code == 200 and admin_login(ready).status_code == 200 and staff_login(ready).status_code == 200

    wrong = {
        "user": [(admin_login, USER["email"], USER["password"])],  # a normal user at the Admin & Road Maintenance door
        "staff": [(user_login, ADMIN["email"], ADMIN["password"]), (user_login, STAFF["email"], STAFF_PASSWORD)],  # staff at the user door
    }
    paths = {"user": "/user/login", "staff": "/admin/login"}
    for owner, attempts in wrong.items():
        for door, ident, pw in attempts:
            r = door(ready, ident, pw)
            detail = r.json()["detail"]
            assert r.status_code == 403 and detail["code"] == "wrong_portal" and detail["portal"] == owner and detail["login_path"] == paths[owner]
            assert "access_token" not in r.text  # no session is handed out by the wrong door


def test_the_server_decides_where_each_role_lands_after_signing_in(ready):
    h = bearer(admin_login(ready))
    ready.post("/api/auth/register", json=USER)
    make_staff(ready, h)
    assert admin_login(ready).json()["home"] == "/admin/dashboard"  # one staff door for both roles...
    assert staff_login(ready).json()["home"] == "/maintenance/dashboard"  # ...the account's role picks the dashboard
    assert user_login(ready).json()["home"] == "/user/home"


def test_login_failures_do_not_reveal_whether_the_account_exists(ready):
    for login in (user_login, admin_login, staff_login):
        wrong_pw, no_user = login(ready, ADMIN["email"], "Wrong-Password-1"), login(ready, "nobody@example.org", "Wrong-Password-1")
        assert wrong_pw.status_code == no_user.status_code == 401
        assert wrong_pw.json() == no_user.json()
    assert ready.post("/api/auth/staff/login", json={"identifier": ADMIN["email"]}).status_code == 422


def test_login_by_email_is_case_insensitive_and_returns_the_profile(ready):
    for ident in (ADMIN["email"], ADMIN["email"].upper()):
        r = admin_login(ready, ident)
        assert r.status_code == 200, ident
        assert r.json()["user"] == {"id": 1, "username": "admin", "full_name": ADMIN["full_name"], "email": ADMIN["email"], "role": "admin", "is_active": True, "email_verified": True}


def test_repeated_failures_lock_the_account_for_a_while(ready):
    for _ in range(8):
        assert admin_login(ready, password="nope-nope-nope").status_code == 401
    assert admin_login(ready, password="nope-nope-nope").status_code == 429
    assert admin_login(ready).status_code == 429  # even the right password waits out the lock


def test_staff_sessions_expire_sooner_than_user_sessions(ready):
    ready.post("/api/auth/register", json=USER)
    assert admin_login(ready).json()["expires_in"] == int(ready.app.state.settings.auth.staff_token_hours * 3600)
    assert user_login(ready).json()["expires_in"] == int(ready.app.state.settings.auth.token_hours * 3600)


# ================================================================== roles
def test_registered_users_are_normal_users_and_cannot_become_admins(ready):
    r = ready.post("/api/auth/register", json={**USER, "role": "admin"})  # an attempt to smuggle in a role
    assert r.status_code == 201 and r.json()["user"]["role"] == "user" and r.json()["user"]["email_verified"] is False
    h = bearer(r)
    for path in ("/api/admin/users", "/api/maintenance/priorities", "/api/analytics/overview", "/api/reports"):
        denied = ready.get(path, headers=h)
        assert denied.status_code == 403 and denied.json()["detail"] == NOT_ADMIN, path
    assert ready.patch("/api/admin/users/1", json={"role": "user"}, headers=h).status_code == 403
    assert ready.post("/api/admin/users", json=STAFF, headers=h).status_code == 403  # nobody but an administrator creates accounts
    assert ready.get("/api/staff/roads", headers=h).status_code == 403
    assert ready.get("/api/auth/me", headers=h).json()["role"] == "user"


def test_no_public_endpoint_can_create_an_administrator_or_staff_account(ready):
    for body in ({**USER, "role": "admin"}, {**USER, "role": "maintenance"}, {**USER, "is_admin": True}):
        r = ready.post("/api/auth/register", json={**body, "email": f"x{abs(hash(str(body)))}@example.org"})
        assert r.status_code == 201 and r.json()["user"]["role"] == "user"
    assert ready.post("/api/admin/users", json=STAFF).status_code == 401  # not even reachable without an administrator's token


def test_maintenance_staff_are_refused_with_their_own_message(ready):
    h = bearer(admin_login(ready))
    make_staff(ready, h)
    s = bearer(staff_login(ready))
    for path in ("/api/admin/users", "/api/maintenance/priorities", "/api/analytics/overview", "/api/reports"):
        denied = ready.get(path, headers=s)
        assert denied.status_code == 403 and denied.json()["detail"] == STAFF_NOT_ADMIN, path
    assert ready.post("/api/admin/users", json=STAFF, headers=s).status_code == 403
    assert ready.patch("/api/admin/users/1", json={"is_active": False}, headers=s).status_code == 403  # cannot touch administrator credentials
    assert ready.post("/api/maintenance/refresh", headers=s).status_code == 403


def test_registration_validates_and_rejects_duplicates(ready):
    assert ready.post("/api/auth/register", json={**USER, "email": ADMIN["email"].upper()}).status_code == 409
    assert ready.post("/api/auth/register", json={**USER, "email": "nope"}).status_code == 422
    assert ready.post("/api/auth/register", json={**USER, "confirm_password": "x"}).status_code == 422
    assert ready.post("/api/auth/register", json={**USER, "password": "citizen123", "confirm_password": "citizen123"}).status_code == 422
    assert ready.post("/api/auth/register", json={**USER, "full_name": ""}).status_code == 422


def test_registration_needs_only_name_email_and_password(ready):
    a = ready.post("/api/auth/register", json=USER)
    b = ready.post("/api/auth/register", json={**USER, "email": "citizen@other.org"})
    assert a.status_code == b.status_code == 201
    assert {a.json()["user"]["username"], b.json()["user"]["username"]} == {"citizen", "citizen2"}  # a handle is derived and kept unique
    assert user_login(ready).status_code == 200


# ============================================================= guest access
def test_guests_can_try_the_detector_but_need_an_account_to_store_a_report(fresh, sample_image):
    files = lambda: {"image": ("r.jpg", sample_image, "image/jpeg")}  # noqa: E731
    assert fresh.post("/api/detect", files=files()).status_code == 200  # the AI preview is open to everybody
    blocked = fresh.post("/api/reports", files=files(), data={"lat": 28.6139, "lng": 77.2090})
    assert blocked.status_code == 401 and "log in or create a free account" in blocked.json()["detail"].lower()
    h = bearer(fresh.post("/api/auth/register", json=USER))
    assert fresh.post("/api/reports", files=files(), data={"lat": 28.6139, "lng": 77.2090}, headers=h).status_code == 201


def test_guest_reporting_can_be_switched_on(app, tmp_path, sample_image):
    with TestClient(create_app(_settings(app, tmp_path, require_login_to_report=False))) as c:
        assert c.post("/api/reports", files={"image": ("r.jpg", sample_image, "image/jpeg")}, data={"lat": 28.6139, "lng": 77.2090}).status_code == 201


def test_users_see_only_their_own_reports(ready, sample_image):
    a = bearer(ready.post("/api/auth/register", json=USER))
    b = bearer(ready.post("/api/auth/register", json={**USER, "email": "zed@example.org"}))
    files = {"image": ("r.jpg", sample_image, "image/jpeg")}
    assert ready.get("/api/reports/mine").status_code == 401
    assert ready.post("/api/reports", files=files, data={"lat": 28.6139, "lng": 77.2090}, headers=a).status_code == 201
    mine = ready.get("/api/reports/mine", headers=a).json()
    assert mine["total"] == 1 and mine["items"][0]["image_url"] and "reporter" not in str(mine["items"][0])
    assert ready.get("/api/reports/mine", headers=b).json()["total"] == 0


# ======================================================== account management
def test_profile_updates_and_sensitive_changes_need_the_password(ready):
    h = bearer(admin_login(ready))
    ok = ready.patch("/api/auth/profile", json={"full_name": "Dr. Ada Lovelace"}, headers=h)
    assert ok.status_code == 200 and ok.json()["full_name"] == "Dr. Ada Lovelace"
    assert ready.patch("/api/auth/profile", json={"username": "new.name"}, headers=h).status_code == 401
    assert ready.patch("/api/auth/profile", json={"username": "new.name", "current_password": "Wrong-Password-1"}, headers=h).status_code == 401
    r = ready.patch("/api/auth/profile", json={"username": "new.name", "current_password": ADMIN["password"]}, headers=h)
    assert r.status_code == 200 and r.json()["username"] == "new.name"
    assert ready.get("/api/auth/me", headers=h).json()["username"] == "new.name"  # the session survives a rename
    assert admin_login(ready).status_code == 200  # people sign in with their email, which did not change


def test_staff_cannot_change_their_verified_email_but_normal_users_can(ready):
    h = bearer(admin_login(ready))
    denied = ready.patch("/api/auth/profile", json={"email": "other@example.org", "current_password": ADMIN["password"]}, headers=h)
    assert denied.status_code == 403 and "cannot be changed" in denied.json()["detail"]
    assert admin_login(ready).status_code == 200

    u = bearer(ready.post("/api/auth/register", json=USER))
    ok = ready.patch("/api/auth/profile", json={"email": "New@Example.org", "current_password": USER["password"]}, headers=u)
    assert ok.status_code == 200 and ok.json()["email"] == "new@example.org"
    assert user_login(ready, "new@example.org").status_code == 200 and user_login(ready).status_code == 401


def test_profile_changes_cannot_take_another_users_name_or_email(ready):
    ready.post("/api/auth/register", json=USER)
    h = bearer(admin_login(ready))
    assert ready.patch("/api/auth/profile", json={"username": "citizen", "current_password": ADMIN["password"]}, headers=h).status_code == 409
    assert ready.patch("/api/auth/profile", json={"username": "bad name!", "current_password": ADMIN["password"]}, headers=h).status_code == 422
    u = bearer(user_login(ready))
    assert ready.patch("/api/auth/profile", json={"email": ADMIN["email"], "current_password": USER["password"]}, headers=u).status_code == 409


def test_change_password_requires_the_current_one_and_a_matching_strong_new_one(ready):
    h = bearer(admin_login(ready))
    new = "Brand-New-Pass-42"
    base = {"current_password": ADMIN["password"], "new_password": new, "confirm_password": new}
    assert ready.post("/api/auth/change-password", json={**base, "current_password": "Wrong-Password-1"}, headers=h).status_code == 401
    assert ready.post("/api/auth/change-password", json={**base, "confirm_password": "Mismatch-Pass-42"}, headers=h).status_code == 422
    assert ready.post("/api/auth/change-password", json={**base, "new_password": "short", "confirm_password": "short"}, headers=h).status_code == 422
    same = ready.post("/api/auth/change-password", json={**base, "new_password": ADMIN["password"], "confirm_password": ADMIN["password"]}, headers=h)
    assert same.status_code == 422
    assert admin_login(ready).status_code == 200  # nothing changed so far
    assert ready.post("/api/auth/change-password", json=base, headers=h).status_code == 200
    assert admin_login(ready).status_code == 401 and admin_login(ready, password=new).status_code == 200


def test_changing_the_password_signs_out_other_sessions(ready):
    old_session, other_device = bearer(admin_login(ready)), bearer(admin_login(ready))
    new = "Brand-New-Pass-42"
    r = ready.post("/api/auth/change-password", json={"current_password": ADMIN["password"], "new_password": new, "confirm_password": new}, headers=old_session)
    assert ready.get("/api/auth/me", headers=other_device).status_code == 401  # revoked
    assert ready.get("/api/auth/me", headers=old_session).status_code == 401
    assert ready.get("/api/auth/me", headers=bearer(r)).status_code == 200  # the fresh token keeps this browser signed in


def test_wrong_current_passwords_are_throttled(ready):
    h = bearer(admin_login(ready))
    body = {"current_password": "Wrong-Password-1", "new_password": "Brand-New-Pass-42", "confirm_password": "Brand-New-Pass-42"}
    for _ in range(8):
        ready.post("/api/auth/change-password", json=body, headers=h)
    assert ready.post("/api/auth/change-password", json={**body, "current_password": ADMIN["password"]}, headers=h).status_code == 429


def test_logout_ends_this_session_only_and_sign_out_everywhere_ends_all(ready):
    a, b = bearer(admin_login(ready)), bearer(admin_login(ready))
    assert ready.post("/api/auth/logout", headers=a).status_code == 200
    assert ready.get("/api/auth/me", headers=a).status_code == 401  # this token is dead...
    assert ready.get("/api/auth/me", headers=b).status_code == 200  # ...the other device is untouched
    assert ready.post("/api/auth/logout-all", headers=b).status_code == 200
    assert ready.get("/api/auth/me", headers=b).status_code == 401
    assert admin_login(ready).status_code == 200
    assert ready.post("/api/auth/logout").status_code == 401  # needs a session to end


def test_responses_with_account_data_are_not_cacheable_and_pages_cannot_be_framed(ready):
    r = ready.get("/api/auth/me", headers=bearer(admin_login(ready)))
    assert r.headers["cache-control"] == "no-store" and r.headers["x-frame-options"] == "DENY"


# ============================================================ forgot password
def test_forgot_password_never_reveals_whether_an_account_exists(ready):
    known = ready.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]})
    unknown = ready.post("/api/auth/forgot-password", json={"identifier": "ghost@example.org"})
    assert known.status_code == unknown.status_code == 200 and known.json() == unknown.json()
    resets = mails(ready, "reset-password")
    assert len(resets) == 1 and ADMIN["email"] in resets[0]  # only the real account got a message


def test_reset_link_flow_end_to_end(ready):
    session = bearer(admin_login(ready))
    r = ready.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]})
    token = email_token(ready, "reset-password")
    assert token not in r.text and "reset-password?token=" not in r.text  # the link is never in the web response
    with ready.app.state.session_factory() as db:  # only a hash of the token is stored
        stored = db.scalars(select(PasswordReset)).one()
        assert token not in stored.token_hash and len(stored.token_hash) == 64 and stored.used_at is None
    new = "Reset-Pass-2026-x"
    assert ready.post("/api/auth/reset-password", json={"token": token, "new_password": "short", "confirm_password": "short"}).status_code == 422
    assert ready.post("/api/auth/reset-password", json={"token": token, "new_password": new, "confirm_password": "Other-Pass-2026-x"}).status_code == 422
    ok = ready.post("/api/auth/reset-password", json={"token": token, "new_password": new, "confirm_password": new})
    assert ok.status_code == 200 and ok.json()["portal"] == "staff" and ok.json()["login_path"] == "/admin/login" and ok.json()["home"] == "/admin/dashboard"
    assert admin_login(ready).status_code == 401 and admin_login(ready, password=new).status_code == 200
    assert ready.get("/api/auth/me", headers=session).status_code == 401  # old sessions ended
    again = ready.post("/api/auth/reset-password", json={"token": token, "new_password": "Another-One-2026", "confirm_password": "Another-One-2026"})
    assert again.status_code == 400  # single use


def test_reset_tokens_expire_and_garbage_is_rejected(ready):
    ready.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]})
    token = email_token(ready, "reset-password")
    with ready.app.state.session_factory() as db:
        row = db.scalars(select(PasswordReset)).one()
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    body = {"new_password": "Reset-Pass-2026-x", "confirm_password": "Reset-Pass-2026-x"}
    expired = ready.post("/api/auth/reset-password", json={"token": token, **body})
    assert expired.status_code == 400 and "invalid or has expired" in expired.json()["detail"]
    assert ready.post("/api/auth/reset-password", json={"token": "x" * 43, **body}).status_code == 400
    assert admin_login(ready).status_code == 200  # the password is unchanged


def test_a_new_request_replaces_the_previous_link(ready):
    ready.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]})
    first = email_token(ready, "reset-password")
    import time; time.sleep(0.01)
    ready.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]})
    second = email_token(ready, "reset-password")
    body = {"new_password": "Reset-Pass-2026-x", "confirm_password": "Reset-Pass-2026-x"}
    assert first != second
    assert ready.post("/api/auth/reset-password", json={"token": first, **body}).status_code == 400
    assert ready.post("/api/auth/reset-password", json={"token": second, **body}).status_code == 200


def test_reset_requests_for_one_account_are_rate_limited(ready):
    for _ in range(5):  # the per-address limit is 5 requests a minute; the per-account limit is 3 messages per 15 minutes
        assert ready.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]}).status_code == 200
    assert len(mails(ready, "reset-password")) == 3  # the rest were silently dropped


def test_staff_without_a_verified_email_cannot_reset_a_password(fresh):
    fresh.post("/api/auth/setup", json=ADMIN)  # created, not verified
    assert fresh.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]}).status_code == 200
    assert mails(fresh, "reset-password") == []


def test_email_goes_through_smtp_when_configured(app, tmp_path, monkeypatch):
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None): sent.append(("connect", host, port))
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def starttls(self): sent.append(("starttls",))
        def login(self, user, password): sent.append(("login", user, password))
        def send_message(self, msg): sent.append(("send", msg["To"], msg["Subject"], msg.get_content()))

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    settings = _settings(app, tmp_path)
    settings.email.smtp_host, settings.email.smtp_user, settings.smtp_password = "smtp.example.org", "mailer", "s3cret"
    settings.auth.public_url = "https://roads.example.org"
    with TestClient(create_app(settings)) as c:
        r = c.post("/api/auth/setup", json=ADMIN)
        assert r.json()["delivery"] == "smtp" and "outbox_dir" not in r.json()
        assert [s[0] for s in sent] == ["connect", "starttls", "login", "send"] and sent[2][1:] == ("mailer", "s3cret")
        to, subject, body = sent[3][1:]
        assert to == ADMIN["email"] and "Verify" in subject and ADMIN["password"] not in body
        prefix = "https://roads.example.org/verify-email?token="
        assert prefix in body
        token = body.split(prefix)[1].split()[0]
        assert c.post("/api/auth/verify-email", json={"token": token}).status_code == 200

        sent.clear()
        assert c.post("/api/auth/forgot-password", json={"identifier": ADMIN["email"]}).status_code == 200
        assert [s[0] for s in sent] == ["connect", "starttls", "login", "send"]
        to, subject, body = sent[3][1:]
        assert to == ADMIN["email"] and "RoadMind" in subject
        assert "https://roads.example.org/reset-password?token=" in body and ADMIN["password"] not in body
    assert not (tmp_path / "outbox").exists()


def test_smtp_failure_never_breaks_the_request(app, tmp_path, monkeypatch):
    def boom(*a, **k): raise OSError("mail server down")

    monkeypatch.setattr(smtplib, "SMTP", boom)
    settings = _settings(app, tmp_path)
    settings.email.smtp_host = "smtp.example.org"
    with TestClient(create_app(settings)) as c:
        r = c.post("/api/auth/setup", json=ADMIN)
        assert r.status_code == 201 and r.json()["delivery"] == "outbox"
        assert "mail server down" in r.json()["delivery_error"] and "smtp.example.org" in r.json()["delivery_error"]  # the operator is told WHY
        assert "token" not in r.text and "verify-email" not in r.text
    assert list((tmp_path / "outbox").glob("*.txt"))  # falls back to the outbox so the operator can still help


def test_gmail_style_app_password_errors_are_explained_and_spaces_are_ignored(app, tmp_path, monkeypatch):
    logins = []

    class GmailSMTP:
        def __init__(self, host, port, timeout=None): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def starttls(self): pass
        def login(self, user, password):
            logins.append(password)
            if password != "abcdefghijklmnop":
                raise smtplib.SMTPAuthenticationError(535, b"5.7.8 Username and Password not accepted")
        def send_message(self, msg): logins.append("sent")

    monkeypatch.setattr(smtplib, "SMTP", GmailSMTP)
    good = _settings(app, tmp_path / "good")
    good.email.smtp_host, good.email.smtp_user, good.smtp_password = "smtp.gmail.com", "me@gmail.com", "abcd efgh ijkl mnop"  # as Google displays it
    with TestClient(create_app(good)) as c:
        assert c.post("/api/auth/setup", json=ADMIN).json()["delivery"] == "smtp"
    assert logins == ["abcdefghijklmnop", "sent"]

    bad = _settings(app, tmp_path / "bad")
    bad.email.smtp_host, bad.email.smtp_user, bad.smtp_password = "smtp.gmail.com", "me@gmail.com", "my-normal-password"
    with TestClient(create_app(bad)) as c:
        r = c.post("/api/auth/setup", json=ADMIN).json()
        assert r["delivery"] == "outbox" and "App Password" in r["delivery_error"] and "my-normal-password" not in str(r)


def test_setup_status_and_resend_work_for_the_pending_administrator_without_retyping_the_address(fresh):
    assert fresh.post("/api/auth/setup/resend").status_code == 409  # nobody is waiting yet
    fresh.post("/api/auth/setup", json=ADMIN)
    status = fresh.get("/api/auth/setup-status").json()
    assert status["verification_pending"] and status["email"] == {"mode": "outbox", "outbox_dir": str(fresh.app.state.settings.data_dir / "outbox")}
    old = email_token(fresh, "verify-email")
    again = fresh.post("/api/auth/setup/resend")
    assert again.status_code == 200 and again.json()["delivery"] == "outbox" and ADMIN["email"] not in again.text  # only the masked address comes back
    assert "token" not in again.text and "verify-email" not in again.text
    new = email_token(fresh, "verify-email")
    assert new != old
    assert fresh.post("/api/auth/verify-email", json={"token": old}).status_code == 400  # the earlier link was replaced
    assert fresh.post("/api/auth/verify-email", json={"token": new}).status_code == 200
    assert fresh.post("/api/auth/setup/resend").status_code == 409  # verified: nothing left to send
    assert fresh.get("/api/auth/setup-status").json()["email"] is None


def test_setup_resend_is_only_for_the_server_computer(app, tmp_path):
    with TestClient(create_app(_settings(app, tmp_path, setup_local_only=True))) as c:
        assert c.post("/api/auth/setup/resend").status_code == 403


def test_settings_read_the_env_file_and_environment_with_the_right_precedence(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# comment\nROADMIND_SMTP_HOST=smtp.gmail.com\nROADMIND_SMTP_PORT=465\nROADMIND_SMTP_USER='me@gmail.com'\n"
        'ROADMIND_SMTP_PASSWORD="abcd efgh ijkl mnop"\nOTHER=ignored\n', encoding="utf-8")
    monkeypatch.setenv("ROADMIND_ENV_FILE", str(env_file))
    s = load_settings({"data_dir": tmp_path / "d1"})
    assert (s.email.smtp_host, s.email.smtp_port, s.email.smtp_user) == ("smtp.gmail.com", 465, "me@gmail.com")
    assert s.smtp_password == "abcd efgh ijkl mnop" and s.email.from_address == "RoadMind AI <me@gmail.com>"  # sends as the account itself
    monkeypatch.setenv("ROADMIND_SMTP_HOST", "smtp.other.org")  # a real environment variable beats the file
    assert load_settings({"data_dir": tmp_path / "d2"}).email.smtp_host == "smtp.other.org"
    assert load_settings({"data_dir": tmp_path / "d3", "email": {"smtp_host": ""}}).email.smtp_host == ""  # and explicit overrides beat both
    monkeypatch.setenv("ROADMIND_ENV_FILE", "")  # "no .env file": how the tests stay hermetic
    monkeypatch.delenv("ROADMIND_SMTP_HOST")
    assert load_settings({"data_dir": tmp_path / "d4"}).email.smtp_host == ""


# ============================================================ staff invitations
def test_an_administrator_invites_staff_who_verify_and_choose_their_own_password(ready):
    h = bearer(admin_login(ready))
    r = ready.post("/api/admin/users", json=STAFF, headers=h)
    row = r.json()
    assert r.status_code == 201 and row["role"] == "maintenance" and row["status"] == "PENDING_EMAIL_VERIFICATION" and row["invited"] is True and row["email_verified"] is False and row["delivery"] == "outbox"
    token = email_token(ready, "accept-invite")
    assert token not in r.text and not any("password" in k for k in row)  # nobody is told, or sets, a password for them

    # until the invitation is accepted the account cannot be used
    assert staff_login(ready, STAFF["email"], "anything-at-all-1").status_code == 401
    assert ready.post("/api/auth/verify-email", json={"token": token}).status_code == 400  # an invitation is not a plain verification link
    weak = ready.post("/api/auth/accept-invite", json={"token": token, "new_password": "short", "confirm_password": "short"})
    assert weak.status_code == 422
    assert ready.post("/api/auth/accept-invite", json={"token": token, "new_password": STAFF_PASSWORD, "confirm_password": "Different-One-1"}).status_code == 422

    ok = ready.post("/api/auth/accept-invite", json={"token": token, "new_password": STAFF_PASSWORD, "confirm_password": STAFF_PASSWORD})
    assert ok.status_code == 200 and ok.json()["portal"] == "staff" and ok.json()["login_path"] == "/admin/login" and ok.json()["home"] == "/maintenance/dashboard"
    assert ready.post("/api/auth/accept-invite", json={"token": token, "new_password": STAFF_PASSWORD, "confirm_password": STAFF_PASSWORD}).status_code == 400  # single use

    login = staff_login(ready)
    assert login.status_code == 200 and login.json()["user"]["role"] == "maintenance" and login.json()["user"]["email_verified"] is True
    listed = {u["email"]: u for u in ready.get("/api/admin/users", headers=h).json()}
    assert listed[STAFF["email"]]["status"] == "ACTIVE" and listed[STAFF["email"]]["assigned_roads"] == 0
    stored = next(u for u in users(ready) if u.email == STAFF["email"])
    assert stored.password_hash.startswith("$argon2id$") and STAFF_PASSWORD not in stored.password_hash and stored.created_by_id == 1


def test_invitations_are_validated_and_cannot_duplicate_accounts(ready):
    h = bearer(admin_login(ready))
    assert ready.post("/api/admin/users", json={**STAFF, "email": ADMIN["email"].upper()}, headers=h).status_code == 409
    assert ready.post("/api/admin/users", json={**STAFF, "email": "not-an-email"}, headers=h).status_code == 422
    assert ready.post("/api/admin/users", json={**STAFF, "role": "user"}, headers=h).status_code == 422
    assert ready.post("/api/admin/users", json={**STAFF, "role": "superuser"}, headers=h).status_code == 422
    assert ready.post("/api/admin/users", json={**STAFF, "full_name": " "}, headers=h).status_code == 422
    assert ready.post("/api/admin/users", json=STAFF).status_code == 401


def test_invitations_expire_and_can_be_sent_again(ready):
    h = bearer(admin_login(ready))
    uid = ready.post("/api/admin/users", json=STAFF, headers=h).json()["id"]
    old = email_token(ready, "accept-invite")
    with ready.app.state.session_factory() as db:
        db.scalars(select(EmailToken).where(EmailToken.purpose == "invite")).one().expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    body = {"new_password": STAFF_PASSWORD, "confirm_password": STAFF_PASSWORD}
    assert ready.post("/api/auth/accept-invite", json={"token": old, **body}).status_code == 400
    again = ready.post(f"/api/admin/users/{uid}/resend", headers=h)
    assert again.status_code == 200 and again.json()["delivery"] == "outbox"
    new = email_token(ready, "accept-invite")
    assert new != old and ready.post("/api/auth/accept-invite", json={"token": new, **body}).status_code == 200
    assert ready.post(f"/api/admin/users/{uid}/resend", headers=h).status_code == 409  # nothing left to send
    assert ready.post("/api/admin/users/999/resend", headers=h).status_code == 404


def test_an_invited_administrator_gets_the_same_checks(ready):
    h = bearer(admin_login(ready))
    row = make_staff(ready, h, {"full_name": "Second Admin", "email": "second@example.org", "role": "admin"}, "Maple-Orchard-Bridge-8")
    assert row["role"] == "admin"
    second = admin_login(ready, "second@example.org", "Maple-Orchard-Bridge-8")
    assert second.status_code == 200 and second.json()["home"] == "/admin/dashboard" and second.json()["user"]["role"] == "admin"
    assert user_login(ready, "second@example.org", "Maple-Orchard-Bridge-8").status_code == 403  # and not through the user door


# ========================================================= user management
def test_admin_can_list_and_manage_users(ready):
    ready.post("/api/auth/register", json=USER)
    h = bearer(admin_login(ready))
    rows = ready.get("/api/admin/users", headers=h).json()
    assert [r["role"] for r in rows] == ["admin", "user"] and {r["email"] for r in rows} == {ADMIN["email"], USER["email"]}
    assert {r["status"] for r in rows} == {"ACTIVE"}
    uid = next(r["id"] for r in rows if r["role"] == "user")
    assert ready.patch(f"/api/admin/users/{uid}", json={"is_active": False}, headers=h).json()["status"] == "SUSPENDED"
    assert ready.patch("/api/admin/users/999", json={"is_active": False}, headers=h).status_code == 404
    assert ready.patch(f"/api/admin/users/{uid}", json={"role": "boss"}, headers=h).status_code == 422


def test_admin_cannot_change_their_own_role_or_status(ready):
    h = bearer(admin_login(ready))
    me = ready.get("/api/auth/me", headers=h).json()["id"]
    assert ready.patch(f"/api/admin/users/{me}", json={"is_active": False}, headers=h).status_code == 409
    assert ready.patch(f"/api/admin/users/{me}", json={"role": "user"}, headers=h).status_code == 409


def test_promoting_a_user_to_staff_requires_them_to_verify_their_email_first(ready):
    reg = ready.post("/api/auth/register", json=USER)
    h = bearer(admin_login(ready))
    uid = reg.json()["user"]["id"]
    promoted = ready.patch(f"/api/admin/users/{uid}", json={"role": "maintenance"}, headers=h).json()
    assert promoted["role"] == "maintenance" and promoted["status"] == "PENDING_EMAIL_VERIFICATION" and promoted["delivery"] == "outbox"
    assert ready.get("/api/auth/me", headers=bearer(reg)).status_code == 401  # the old session ended with the role change
    blocked = staff_login(ready, USER["email"], USER["password"])
    assert blocked.status_code == 403 and blocked.json()["detail"]["code"] == "email_not_verified"
    assert ready.post("/api/auth/verify-email", json={"token": email_token(ready, "verify-email")}).status_code == 200
    assert staff_login(ready, USER["email"], USER["password"]).status_code == 200


def test_demoting_staff_ends_their_staff_session(ready):
    h = bearer(admin_login(ready))
    row = make_staff(ready, h)
    s = bearer(staff_login(ready))
    assert ready.get("/api/staff/roads", headers=s).status_code == 200
    assert ready.patch(f"/api/admin/users/{row['id']}", json={"role": "user"}, headers=h).json()["role"] == "user"
    assert ready.get("/api/staff/roads", headers=s).status_code == 401  # token no longer valid
    assert user_login(ready, STAFF["email"], STAFF_PASSWORD).status_code == 200
    assert ready.get("/api/staff/roads", headers=bearer(user_login(ready, STAFF["email"], STAFF_PASSWORD))).status_code == 403


def test_deactivated_users_are_locked_out_immediately(ready):
    user_session = bearer(ready.post("/api/auth/register", json=USER))
    h = bearer(admin_login(ready))
    uid = ready.get("/api/auth/me", headers=user_session).json()["id"]
    assert ready.patch(f"/api/admin/users/{uid}", json={"is_active": False}, headers=h).status_code == 200
    assert ready.get("/api/auth/me", headers=user_session).status_code == 401  # existing session revoked
    refused = user_login(ready)  # right password, suspended account: a clear message (never shown to people who do not know the password)
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "suspended" and refused.json()["detail"]["status"] == "SUSPENDED"
    assert user_login(ready, password="Wrong-Password-1").status_code == 401
    assert ready.post("/api/auth/forgot-password", json={"identifier": USER["email"]}).status_code == 200
    assert mails(ready, "reset-password") == []  # no reset mail for a disabled account
    ready.patch(f"/api/admin/users/{uid}", json={"is_active": True}, headers=h)
    assert user_login(ready).status_code == 200


# ============================================ staff registration: request -> verify -> approve
REQUEST = {"full_name": "Priya Engineer", "email": "priya.eng@gmail.com", "account_type": "maintenance", "password": "Teal-Meadow-Bridge-4", "confirm_password": "Teal-Meadow-Bridge-4"}


def register_staff(c, **change):
    return c.post("/api/auth/staff/register", json={**REQUEST, **change})


def requester(c, email=REQUEST["email"]):
    return next(u for u in users(c) if u.email == email)


def verified_request(c, **change):
    """Register a staff request and open its verification link: it is now waiting for an administrator."""
    assert register_staff(c, **change).status_code == 201
    assert c.post("/api/auth/verify-email", json={"token": email_token(c, "verify-email")}).status_code == 200


def test_a_staff_registration_is_only_a_request_until_verified_and_approved(ready):
    r = register_staff(ready)
    assert r.status_code == 201 and "access_token" not in r.text and r.json()["delivery"] == "outbox"
    assert r.json()["status"] == "PENDING_EMAIL_VERIFICATION" and r.json()["requested_role"] == "maintenance"
    u = requester(ready)
    assert u.role == "user" and u.requested_role == "maintenance" and u.approval_status == "PENDING_EMAIL"  # no privilege, just a wish
    assert u.password_hash.startswith("$argon2id$") and REQUEST["password"] not in u.password_hash

    for door in (staff_login, user_login):  # step 1: nobody gets in before the address is verified
        refused = door(ready, REQUEST["email"], REQUEST["password"])
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "email_not_verified"

    verified = ready.post("/api/auth/verify-email", json={"token": email_token(ready, "verify-email")})
    assert verified.status_code == 200 and verified.json()["status"] == "PENDING_ADMIN_APPROVAL" and "waiting for administrator approval" in verified.json()["message"]
    assert requester(ready).approval_status == "PENDING_APPROVAL" and requester(ready).email_verified_at is not None
    for door in (staff_login, user_login):  # step 2: a verified address is still not an approved account
        refused = door(ready, REQUEST["email"], REQUEST["password"])
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "pending_admin_approval"
        assert "access_token" not in refused.text

    h = bearer(admin_login(ready))
    listed = {x["email"]: x for x in ready.get("/api/admin/users", headers=h).json()}
    assert listed[REQUEST["email"]]["status"] == "PENDING_ADMIN_APPROVAL" and listed[REQUEST["email"]]["requested_role"] == "maintenance"
    assert ready.get("/api/admin/users", headers=h).json()[0]["email"] == REQUEST["email"]  # requests to review are listed first

    approved = ready.post(f"/api/admin/users/{listed[REQUEST['email']]['id']}/approve", json={}, headers=h)
    assert approved.status_code == 200 and approved.json()["status"] == "ACTIVE" and approved.json()["role"] == "maintenance"
    assert "approved" in mails(ready, "/admin/login")[-1] and REQUEST["email"] in mails(ready, "/admin/login")[-1]  # the requester is told
    ok = staff_login(ready, REQUEST["email"], REQUEST["password"])
    assert ok.status_code == 200 and ok.json()["home"] == "/maintenance/dashboard" and ok.json()["user"]["role"] == "maintenance"
    assert user_login(ready, REQUEST["email"], REQUEST["password"]).status_code == 403  # staff do not use the user door
    assert requester(ready).reviewed_by_id == 1 and requester(ready).reviewed_at is not None


def test_asking_for_the_administrator_role_grants_nothing_by_itself(ready):
    verified_request(ready, account_type="admin", email="wannabe@gmail.com")
    u = requester(ready, "wannabe@gmail.com")
    assert u.role == "user" and u.requested_role == "admin"  # still a plain user
    assert staff_login(ready, "wannabe@gmail.com", REQUEST["password"]).status_code == 403
    h = bearer(admin_login(ready))
    uid = next(x["id"] for x in ready.get("/api/admin/users", headers=h).json() if x["email"] == "wannabe@gmail.com")
    assert ready.patch(f"/api/admin/users/{uid}", json={"role": "admin"}, headers=h).status_code == 409  # role changes do not bypass the review
    granted = ready.post(f"/api/admin/users/{uid}/approve", json={"role": "maintenance"}, headers=h)  # the administrator decides what is granted
    assert granted.status_code == 200 and granted.json()["role"] == "maintenance"
    assert staff_login(ready, "wannabe@gmail.com", REQUEST["password"]).json()["home"] == "/maintenance/dashboard"
    assert ready.get("/api/admin/users", headers=bearer(staff_login(ready, "wannabe@gmail.com", REQUEST["password"]))).status_code == 403


def test_an_approved_requester_can_become_an_administrator(ready):
    verified_request(ready, account_type="admin", email="second.admin@gmail.com")
    h = bearer(admin_login(ready))
    uid = next(x["id"] for x in ready.get("/api/admin/users", headers=h).json() if x["email"] == "second.admin@gmail.com")
    assert ready.post(f"/api/admin/users/{uid}/approve", json={}, headers=h).json()["role"] == "admin"
    login = staff_login(ready, "second.admin@gmail.com", REQUEST["password"])
    assert login.status_code == 200 and login.json()["home"] == "/admin/dashboard"
    assert ready.get("/api/admin/users", headers=bearer(login)).status_code == 200


def test_registration_input_is_validated_and_emails_cannot_be_reused(ready):
    assert register_staff(ready, email=ADMIN["email"].upper()).status_code == 409  # already an account
    assert register_staff(ready, email="not-an-email").status_code == 422
    assert register_staff(ready, account_type="superuser").status_code == 422
    assert register_staff(ready, account_type="user").status_code == 422
    assert register_staff(ready, full_name=" ").status_code == 422


def test_registration_passwords_must_match_and_be_strong(ready):  # (registration is rate-limited to 5 requests a minute, hence the split)
    assert register_staff(ready, confirm_password="Different-One-1").status_code == 422
    for weak in ("short", "password123456", "priya.eng-secret-1"):
        assert register_staff(ready, password=weak, confirm_password=weak).status_code == 422, weak
    assert not any(u.email == REQUEST["email"] for u in users(ready))


def test_the_same_email_cannot_register_twice(ready):
    assert register_staff(ready).status_code == 201
    assert register_staff(ready).status_code == 409
    assert sum(1 for u in users(ready) if u.email == REQUEST["email"]) == 1


def test_registration_is_closed_until_an_administrator_exists(fresh):
    r = register_staff(fresh)
    assert r.status_code == 409 and "no administrator" in r.json()["detail"].lower()
    assert users(fresh) == []


def test_requests_cannot_flood_the_database(app, tmp_path):
    with TestClient(create_app(_settings(app, tmp_path, max_pending_requests=2))) as c:
        verify_admin(c)
        assert register_staff(c, email="a1@gmail.com").status_code == 201 and register_staff(c, email="a2@gmail.com").status_code == 201
        assert register_staff(c, email="a3@gmail.com").status_code == 429


def test_only_administrators_review_requests(ready):
    verified_request(ready)
    uid = requester(ready).id
    make_staff(ready, bearer(admin_login(ready)))
    ready.post("/api/auth/register", json=USER)
    for headers, expected in ((None, 401), (bearer(user_login(ready)), 403), (bearer(staff_login(ready)), 403)):
        for action in ("approve", "reject"):
            r = ready.post(f"/api/admin/users/{uid}/{action}", json={}, headers=headers) if headers else ready.post(f"/api/admin/users/{uid}/{action}", json={})
            assert r.status_code == expected, (action, expected)
    assert requester(ready).approval_status == "PENDING_APPROVAL"  # nothing changed


def test_a_request_cannot_be_approved_before_its_email_is_verified(ready):
    assert register_staff(ready).status_code == 201
    h = bearer(admin_login(ready))
    uid = requester(ready).id
    assert ready.post(f"/api/admin/users/{uid}/approve", json={}, headers=h).status_code == 409
    assert ready.post("/api/admin/users/99999/approve", json={}, headers=h).status_code == 404
    assert staff_login(ready, REQUEST["email"], REQUEST["password"]).status_code == 403


def test_rejecting_a_request_keeps_the_person_out_and_can_be_reconsidered(ready):
    verified_request(ready)
    h = bearer(admin_login(ready))
    uid = requester(ready).id
    rejected = ready.post(f"/api/admin/users/{uid}/reject", json={"reason": "Not a member of the maintenance crew"}, headers=h)
    assert rejected.status_code == 200 and rejected.json()["status"] == "REJECTED"
    note = mails(ready, "not approve")[-1]
    assert REQUEST["email"] in note and "Not a member of the maintenance crew" in note
    refused = staff_login(ready, REQUEST["email"], REQUEST["password"])
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "rejected"
    assert ready.patch(f"/api/admin/users/{uid}", json={"is_active": True}, headers=h).status_code == 409  # not reactivated by a toggle
    assert ready.post(f"/api/admin/users/{uid}/reject", json={}, headers=h).status_code == 409  # already decided
    assert ready.post(f"/api/admin/users/{uid}/approve", json={}, headers=h).json()["status"] == "ACTIVE"  # the administrator changed their mind
    assert staff_login(ready, REQUEST["email"], REQUEST["password"]).status_code == 200


def test_suspending_and_reactivating_an_approved_account(ready):
    verified_request(ready)
    h = bearer(admin_login(ready))
    uid = requester(ready).id
    ready.post(f"/api/admin/users/{uid}/approve", json={}, headers=h)
    session = bearer(staff_login(ready, REQUEST["email"], REQUEST["password"]))
    assert ready.patch(f"/api/admin/users/{uid}", json={"is_active": False}, headers=h).json()["status"] == "SUSPENDED"
    assert ready.get("/api/auth/me", headers=session).status_code == 401  # signed out at once
    refused = staff_login(ready, REQUEST["email"], REQUEST["password"])
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "suspended"
    assert ready.patch(f"/api/admin/users/{uid}", json={"is_active": True}, headers=h).json()["status"] == "ACTIVE"
    assert staff_login(ready, REQUEST["email"], REQUEST["password"]).status_code == 200


def test_a_pending_request_can_ask_for_a_new_verification_link(ready):
    assert register_staff(ready).status_code == 201
    first = email_token(ready, "verify-email")
    assert ready.post("/api/auth/resend-verification", json={"email": REQUEST["email"]}).status_code == 200
    second = email_token(ready, "verify-email")
    assert first != second
    assert ready.post("/api/auth/verify-email", json={"token": first}).status_code == 400
    assert ready.post("/api/auth/verify-email", json={"token": second}).json()["status"] == "PENDING_ADMIN_APPROVAL"


# ======================================================= legacy / upgrades
def test_built_in_accounts_from_older_builds_are_removed_on_start(app, tmp_path):
    settings = _settings(app, tmp_path)
    with TestClient(create_app(settings)) as c:
        with c.app.state.session_factory() as db:  # what an old build created at start-up: an admin without an email
            db.add(User(username="admin", password_hash=hash_password("whatever-it-was"), role="admin"))
            db.commit()
    with TestClient(create_app(settings)) as c:  # server restarted
        assert users(c) == []
        assert c.get("/api/auth/setup-status").json()["setup_required"] is True
        assert admin_login(c, "admin", "whatever-it-was").status_code == 401


def test_administrators_from_the_previous_build_must_verify_their_email(app, tmp_path):
    settings = _settings(app, tmp_path)
    with TestClient(create_app(settings)) as c:
        with c.app.state.session_factory() as db:  # an admin made before email verification existed
            db.add(User(username="olduser", email="old@example.org", password_hash=hash_password("Legacy-Admin-Pass-1"), role="admin"))
            db.commit()
        blocked = admin_login(c, "old@example.org", "Legacy-Admin-Pass-1")
        assert blocked.status_code == 403 and blocked.json()["detail"]["code"] == "email_not_verified"
        assert c.get("/api/auth/setup-status").json()["verification_pending"] is True


def test_old_databases_gain_the_new_columns(tmp_path):
    from app.database import Base, ensure_schema

    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:  # the users table as an older build made it
        conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(64) UNIQUE, password_hash VARCHAR(256), role VARCHAR(16), created_at DATETIME)"))
        conn.execute(text("INSERT INTO users (username, password_hash, role) VALUES ('old', 'x', 'user')"))
    Base.metadata.create_all(engine)
    added = ensure_schema(engine)
    assert {"users.email", "users.full_name", "users.is_active", "users.token_version", "users.last_login_at", "users.email_verified_at", "users.must_set_password"} <= set(added)
    with engine.connect() as conn:
        row = conn.execute(text("SELECT is_active, token_version, full_name, email, must_set_password FROM users")).one()
    assert tuple(row) == (1, 0, "", None, 0)  # existing rows get sensible defaults
    assert ensure_schema(engine) == []  # idempotent


# ============================================================ unit checks
def test_password_policy():
    assert password_problem("Correct-Horse-9", "alice", "alice.smith") is None
    assert password_problem("short", "alice")
    assert password_problem("x" * 129, "alice")
    assert password_problem("password123", "alice") and password_problem("1234567890", "alice") and password_problem("aaaaaaaaaaaa", "alice")
    for padded in ("password123456", "Password@123456", "Welcome2026!!", "QWERTY-12345-x", "ADMIN_2026_2026"):  # a common word with digits/symbols added
        assert password_problem(padded, "alice"), padded
    assert password_problem("Correct-Horse-Battery-9", "alice") is None and password_problem("Another-Strong-7", "alice") is None
    assert password_problem("my-alice-secret", "alice")  # contains the username
    assert password_problem("alice.smith2026!", "bob", "alice.smith")  # contains the email name
    assert password_problem("Longer-Than-Ten", "al") is None  # tiny personal values (under 3 characters) are not matched: too many false hits
    assert password_problem("Nine-char9", "bob", min_length=10) is None and password_problem("Nine-ch9", "bob", min_length=10)


@pytest.mark.parametrize("email,ok", [("a@b.co", True), ("first.last+tag@sub.example.org", True), ("a@b", False), ("@b.co", False), ("a b@c.co", False), ("a@b..co", False), ("a@-b.co", False), ("x" * 250 + "@b.co", False)])
def test_email_validation(email, ok):
    assert valid_email(email) is ok
