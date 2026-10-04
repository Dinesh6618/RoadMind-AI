"""Outgoing email: address verification, staff invitations and password resets.

With an SMTP server configured (config `email.smtp_host`, or ROADMIND_SMTP_* in the environment / the git-ignored `.env`
file; the password is only ever read from ROADMIND_SMTP_PASSWORD) the message is sent. Without one - or when sending
fails - the message is written to `<data dir>/outbox/` and the link is logged, so a person with access to the server
(the operator) can complete the step. Links are never returned by the API or shown in the web page.
"""

from __future__ import annotations

import logging
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage

from ..config import Settings

log = logging.getLogger("roadmind.mail")


class Delivery(str):
    """"smtp" (handed to the mail server) or "outbox" (saved as a file). `error` says why a configured server was not
    used, so the operator can fix it (wrong app password, blocked port...). It never contains the password."""

    error: str | None = None

    def __new__(cls, mode: str, error: str | None = None):
        obj = super().__new__(cls, mode)
        obj.error = error
        return obj


def _explain(exc: Exception, host: str) -> str:
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        hint = " Gmail needs an App Password (Google Account > Security > 2-Step Verification > App passwords), not your normal password." if "gmail" in host or "google" in host else ""
        return f"the mail server rejected the user name or password.{hint}"
    if isinstance(exc, (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused)):
        return "the mail server refused the sender or recipient address."
    if isinstance(exc, (TimeoutError, ConnectionError, OSError, smtplib.SMTPConnectError)):
        return f"could not connect to {host} ({type(exc).__name__}: {exc}). Check the host, port and your internet connection."
    return f"{type(exc).__name__}: {exc}"


def send_email(settings: Settings, to: str, subject: str, body: str) -> Delivery:
    """Send (or write out) one plain-text message. Never raises: a mail failure must not break the request (and must
    not reveal whether an account exists)."""
    cfg = settings.email
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = cfg.from_address, to, subject
    msg.set_content(body)
    error: str | None = None
    if cfg.smtp_host:
        password = settings.smtp_password
        if cfg.smtp_host.lower().endswith(("gmail.com", "googlemail.com")):
            password = password.replace(" ", "")  # Google shows app passwords in four groups; they work without the spaces
        try:
            with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=10) as smtp:
                if cfg.starttls:
                    smtp.starttls()
                if cfg.smtp_user:
                    smtp.login(cfg.smtp_user, password)
                smtp.send_message(msg)
            log.info("Email %r sent to %s", subject, to)
            return Delivery("smtp")
        except Exception as exc:  # network down, bad credentials, refused recipient...
            error = _explain(exc, cfg.smtp_host.lower())
            log.error("Could not send email to %s via %s: %s", to, cfg.smtp_host, error)
    outbox = settings.data_dir / "outbox"
    try:
        outbox.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        (outbox / f"{stamp}.txt").write_text(f"To: {to}\nSubject: {subject}\n\n{body}\n", encoding="utf-8")
    except OSError as exc:
        log.error("Could not write the email outbox: %s", exc)
    log.warning("No email was sent to %s - the message was written to %s", to, outbox)
    return Delivery("outbox", error)
