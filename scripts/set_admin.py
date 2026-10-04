"""Recover access: set a new password for an administrator, or create the first one, from the command line.

    python scripts/set_admin.py                         # asks which administrator, then for the new password
    python scripts/set_admin.py --email me@gmail.com    # reset the password of the administrator with that email

Run it on the machine that hosts the database (it edits backend/data/roadmind.db directly, or the database named
by ROADMIND_DATABASE_URL). It is the offline equivalent of "Forgot password" for installations without an email
server, and it needs file access to the server - which is the point. Whoever runs it is physically in control of the
installation, so the address is marked verified. If no administrator exists it creates one (full name, email,
password) - the same as the first-run setup page, without the email step. Existing sessions of a reset account are
signed out. There is no need to stop the server.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import func, select  # noqa: E402

from app.config import load_settings  # noqa: E402
from app.database import Base, ensure_schema, make_engine, make_session_factory, utcnow  # noqa: E402
from app.models import User  # noqa: E402
from app.security import hash_password, password_problem, valid_email  # noqa: E402
from app.services.accounts import derive_username  # noqa: E402


def ask_password(username: str, email: str | None, min_length: int) -> str:
    password = getpass.getpass("New password: ")
    if password != getpass.getpass("Repeat the password: "):
        sys.exit("The passwords do not match.")
    problem = password_problem(password, username, (email or "").split("@")[0], min_length=min_length)
    if problem:
        sys.exit(problem)
    return password


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--email", help="the administrator to reset (or the email for a new administrator)")
    args = ap.parse_args()

    settings = load_settings()
    engine = make_engine(settings.database_url)
    Base.metadata.create_all(engine)
    ensure_schema(engine)
    with make_session_factory(engine)() as db:
        admins = list(db.scalars(select(User).where(User.role == "admin", User.email.is_not(None))))
        if admins:
            ident = (args.email or (admins[0].email if len(admins) == 1 else input("Administrator email: "))).strip().lower()
            user = next((u for u in admins if ident in (u.email.lower(), u.username.lower())), None)
            if user is None:
                sys.exit(f"No administrator matches '{ident}'. Existing: {', '.join(u.email for u in admins)}")
            user.password_hash = hash_password(ask_password(user.username, user.email, settings.auth.min_password_length))
            user.is_active = True
            user.must_set_password = False
            user.email_verified_at = user.email_verified_at or utcnow()
            user.token_version += 1  # signs the account out everywhere
            db.commit()
            print(f"Password reset for administrator '{user.email}'. Existing sessions were signed out.")
            return

        print("No administrator exists yet - creating one.")
        full_name = " ".join(input("Full name: ").split())
        email = (args.email or input("Authorised email address: ")).strip().lower()
        if len(full_name) < 2 or not valid_email(email):
            sys.exit("Please give a full name and a valid email address.")
        existing = db.scalar(select(User).where(func.lower(User.email) == email))
        if existing is not None:
            # e.g. the owner already registered as a normal user with this address: offer to make that account the administrator
            if existing.role == "admin" or input(f"{email} is already a {existing.role} account. Make it the administrator? [y/N] ").strip().lower() != "y":
                sys.exit("That email is already used by another account.")
            existing.role, existing.is_active, existing.must_set_password = "admin", True, False
            existing.full_name = full_name or existing.full_name
            existing.email_verified_at = existing.email_verified_at or utcnow()
            existing.password_hash = hash_password(ask_password(existing.username, email, settings.auth.min_password_length))
            existing.token_version += 1  # the account's old sessions end
            db.commit()
            print(f"'{email}' is now an administrator. Log in at /admin/login.")
            return
        username = derive_username(db, email)
        password = ask_password(username, email, settings.auth.min_password_length)
        db.add(User(username=username, full_name=full_name, email=email, password_hash=hash_password(password), role="admin", email_verified_at=utcnow()))
        db.commit()
        print(f"Created administrator '{email}'. Log in at /admin/login.")


if __name__ == "__main__":
    main()
