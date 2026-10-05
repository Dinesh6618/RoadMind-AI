"""Controlled server errors: the person gets a short request id and a plain message, the full detail (exception type,
message, traceback, the step that failed) goes only to the server log - never the password, never to the browser."""

from __future__ import annotations

import secrets

AUTH_UNAVAILABLE = "Unable to connect to the authentication service. Please try again."
SERVER_ERROR = "Something went wrong on the server. Please try again."


def request_id(prefix: str = "ERR") -> str:
    """`AUTH-3FA91C`: quote it when reporting a problem; the matching log line carries the real error."""
    return f"{prefix}-{secrets.token_hex(3).upper()}"


def error_detail(message: str, code: str, rid: str) -> dict:
    return {"message": message, "code": code, "request_id": rid}
