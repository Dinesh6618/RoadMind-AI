"""Check that RoadMind can send email (verification links, staff invitations, password resets).

    python scripts/test_email.py you@gmail.com

It uses exactly the settings the server uses (config/roadmind.yaml, the .env file, ROADMIND_SMTP_* variables), sends one
test message and says plainly whether it was handed to the mail server - and if not, why (for Gmail the usual reason is
that an *App Password* is required instead of the normal password). Nothing is stored; the password is never printed.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import load_settings  # noqa: E402
from app.services.mailer import send_email  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2 or "@" not in sys.argv[1]:
        sys.exit(__doc__)
    settings = load_settings()
    cfg = settings.email
    if not cfg.smtp_host:
        sys.exit(
            "No mail server is configured, so RoadMind can only save emails as files in backend/data/outbox/.\n"
            "To send real email, copy .env.example to .env, fill in ROADMIND_SMTP_USER and ROADMIND_SMTP_PASSWORD "
            "(see README: 'Real email with Gmail'), then run this again."
        )
    print(f"Sending a test message to {sys.argv[1]} through {cfg.smtp_host}:{cfg.smtp_port} as {cfg.smtp_user or '(no login)'} ...")
    result = send_email(settings, sys.argv[1], "RoadMind AI test email", "If you can read this, RoadMind can send email. You can delete it.")
    if result == "smtp":
        print("OK - the mail server accepted the message. Check the inbox (and the spam folder).")
        return
    print(f"FAILED - {result.error or 'unknown reason'}")
    print(f"(The message was saved in {settings.data_dir / 'outbox'} instead.)")
    sys.exit(1)


if __name__ == "__main__":
    main()
