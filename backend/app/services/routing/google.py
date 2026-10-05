"""Google Routes API provider: real roads, real traffic.

    POST https://routes.googleapis.com/directions/v2:computeRoutes      (the server key goes in a header, never to a browser)

Asks for traffic-aware routes (`TRAFFIC_AWARE_OPTIMAL` by default), the alternatives Google offers and the traffic along the
polyline (`TRAFFIC_ON_POLYLINE` -> speed readings NORMAL / SLOW / TRAFFIC_JAM). Nothing is invented: a route comes back with
`traffic=None` / `static_duration_s=None` when Google did not provide them, and any API problem is raised as
`GoogleRoutesError` so the caller can say "live traffic unavailable" instead of showing made-up numbers.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone

import httpx

from ...config import GoogleConfig
from .types import Candidate, RoutingUnavailable

log = logging.getLogger("roadmind.google")

FIELD_MASK = ",".join(
    [
        "routes.distanceMeters",
        "routes.duration",
        "routes.staticDuration",
        "routes.polyline.encodedPolyline",
        "routes.travelAdvisory.speedReadingIntervals",
        "routes.description",
        "routes.routeLabels",
    ]
)
STEPS_MASK = ",".join(
    [
        "routes.legs.steps.navigationInstruction",
        "routes.legs.steps.distanceMeters",
        "routes.legs.steps.staticDuration",
        "routes.legs.steps.startLocation",
        "routes.legs.steps.endLocation",
    ]
)
SPEEDS = {"NORMAL", "SLOW", "TRAFFIC_JAM"}


class GoogleRoutesError(RoutingUnavailable):
    """Google could not give routes. `reason`: not_configured | auth | quota | network | no_route | bad_response."""

    def __init__(self, message: str, reason: str, retryable: bool = True):
        super().__init__(message, retryable=retryable)
        self.reason = reason


_budget_lock = threading.Lock()
_calls: deque[float] = deque()


def reset_budget() -> None:
    with _budget_lock:
        _calls.clear()


def _spend(limit: int) -> None:
    """Count one Google call against the hourly budget (`google.max_requests_per_hour`); refuse it when the budget is used up."""
    if limit <= 0:
        return
    now = time.monotonic()
    with _budget_lock:
        while _calls and now - _calls[0] > 3600:
            _calls.popleft()
        if len(_calls) >= limit:
            log.warning("Google request budget used up (%s calls in the last hour); not calling Google", len(_calls))
            raise GoogleRoutesError("RoadMind's hourly Google request budget is used up.", "quota")
        _calls.append(now)


def decode_polyline(encoded: str) -> list[list[float]]:
    """Google's encoded polyline algorithm (1e-5 degrees) -> [[lat, lng], ...]."""
    coords: list[list[float]] = []
    index = lat = lng = 0
    n = len(encoded)
    while index < n:
        for axis in (0, 1):
            shift = result = 0
            while True:
                if index >= n:
                    raise ValueError("truncated polyline")
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if axis == 0:
                lat += delta
            else:
                lng += delta
        coords.append([lat / 1e5, lng / 1e5])
    return coords


def _seconds(value: str | None) -> float | None:
    """Google durations are strings like "1234s" (or "1234.5s")."""
    if not value or not isinstance(value, str) or not value.endswith("s"):
        return None
    try:
        return float(value[:-1])
    except ValueError:
        return None


def parse_steps(route: dict) -> list[dict] | None:
    """`routes[].legs[].steps[]` -> [{index, instruction, maneuver, distance_m, duration_s, start, end}] (None when Google sent none)."""
    out: list[dict] = []
    latlng = lambda p: {"lat": p["latLng"]["latitude"], "lng": p["latLng"]["longitude"]} if p and p.get("latLng") else None  # noqa: E731
    for leg in route.get("legs") or []:
        for st in leg.get("steps") or []:
            nav = st.get("navigationInstruction") or {}
            start, end = latlng(st.get("startLocation")), latlng(st.get("endLocation"))
            if start is None or end is None:
                continue
            out.append({
                "index": len(out), "instruction": (nav.get("instructions") or "").strip(), "maneuver": nav.get("maneuver") or None,
                "distance_m": float(st.get("distanceMeters", 0) or 0), "duration_s": _seconds(st.get("staticDuration")), "start": start, "end": end,
            })
    return out or None


def parse_route(route: dict, rank: int) -> Candidate:
    """One element of `routes[]` -> Candidate. Proto3 JSON leaves out zero values, so a missing start index means 0."""
    poly = (route.get("polyline") or {}).get("encodedPolyline")
    if not poly:
        raise GoogleRoutesError("Google returned a route without a geometry.", "bad_response")
    geometry = decode_polyline(poly)
    duration = _seconds(route.get("duration"))
    distance = route.get("distanceMeters")
    if duration is None or distance is None or len(geometry) < 2:
        raise GoogleRoutesError("Google returned an incomplete route.", "bad_response")
    traffic = None
    intervals = (route.get("travelAdvisory") or {}).get("speedReadingIntervals")
    if intervals:
        traffic = []
        last = len(geometry) - 1
        for it in intervals:
            start = int(it.get("startPolylinePointIndex", 0) or 0)
            end = int(it.get("endPolylinePointIndex", last) or 0)
            speed = it.get("speed") if it.get("speed") in SPEEDS else "NORMAL"
            if 0 <= start < end <= last:
                traffic.append((start, end, speed))
        traffic = traffic or None
    return Candidate(
        geometry=geometry,
        distance_m=float(distance),
        duration_s=duration,  # with traffic when the routing preference is traffic-aware
        name=str(route.get("description") or f"Google route {rank + 1}"),
        static_duration_s=_seconds(route.get("staticDuration")),
        traffic=traffic,
        source="google",
        steps=parse_steps(route),
    )


class GoogleRoutesProvider:
    name = "google"

    def __init__(self, api_key: str, cfg: GoogleConfig, client: httpx.Client | None = None):
        self.api_key = api_key
        self.cfg = cfg
        self._client = client  # tests pass an httpx.Client with a mock transport

    def _request_body(self, origin, destination, max_routes: int, departure: datetime | None) -> dict:
        body = {
            "origin": {"location": {"latLng": {"latitude": origin[0], "longitude": origin[1]}}},
            "destination": {"location": {"latLng": {"latitude": destination[0], "longitude": destination[1]}}},
            "travelMode": "DRIVE",
            "routingPreference": self.cfg.routing_preference,
            "computeAlternativeRoutes": max_routes > 1,
            "extraComputations": ["TRAFFIC_ON_POLYLINE"],
            "polylineQuality": "HIGH_QUALITY",
            "polylineEncoding": "ENCODED_POLYLINE",
            "units": "METRIC",
        }
        if departure is not None:  # must be in the future for Google; omitted = now
            body["departureTime"] = departure.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if self.cfg.region_code:
            body["regionCode"] = self.cfg.region_code
        return body

    def _post(self, url: str, body: dict, field_mask: str, what: str = "Routes"):
        """One Google request: the key and field mask go in headers, every failure becomes a GoogleRoutesError with a reason."""
        if not self.api_key:
            raise GoogleRoutesError("Google Maps is not configured (no GOOGLE_MAPS_API_KEY).", "not_configured", retryable=False)
        headers = {"Content-Type": "application/json", "X-Goog-Api-Key": self.api_key, "X-Goog-FieldMask": field_mask}
        _spend(self.cfg.max_requests_per_hour)
        try:
            client = self._client or httpx.Client(timeout=self.cfg.timeout_s)
            try:
                resp = client.post(url, json=body, headers=headers)
            finally:
                if self._client is None:
                    client.close()
        except httpx.HTTPError as exc:
            log.error("Google %s API unreachable: %s: %s", what, type(exc).__name__, exc)
            raise GoogleRoutesError(f"The Google {what} service could not be reached.", "network") from exc

        if resp.status_code != 200:
            detail = _error_text(resp)
            # never log the key; Google's message says what is wrong (API not enabled, key restricted, billing off...)
            log.error("Google %s API returned HTTP %s: %s", what, resp.status_code, detail)
            if resp.status_code in (400, 404) and "no route" in detail.lower():
                raise GoogleRoutesError("Google found no drivable route between these points.", "no_route", retryable=False)
            if resp.status_code in (401, 403):
                raise GoogleRoutesError(f"Google rejected the request (check the API key, that the {what} API is enabled and billing is on).", "auth")
            if resp.status_code == 429:
                raise GoogleRoutesError(f"The Google {what} quota is used up for now.", "quota")
            raise GoogleRoutesError(f"Google {what} answered with an error (HTTP {resp.status_code}).", "bad_response")
        try:
            return resp.json()
        except ValueError as exc:
            raise GoogleRoutesError("Google returned an unreadable answer.", "bad_response") from exc

    def matrix(self, origin: tuple[float, float], destinations: list[tuple[float, float]]) -> list[dict | None]:
        """Traffic-aware travel time and road distance from one origin to several places in ONE request (Route Matrix API).
        Returns a list aligned with `destinations`: {"duration_s", "distance_m"}, or None where Google found no route."""
        if not destinations:
            return []
        waypoint = lambda p: {"waypoint": {"location": {"latLng": {"latitude": p[0], "longitude": p[1]}}}}  # noqa: E731
        body = {"origins": [waypoint(origin)], "destinations": [waypoint(d) for d in destinations], "travelMode": "DRIVE", "routingPreference": "TRAFFIC_AWARE"}
        payload = self._post(self.cfg.matrix_url, body, "originIndex,destinationIndex,duration,distanceMeters,condition,status", "Route Matrix")
        out: list[dict | None] = [None] * len(destinations)
        for el in payload if isinstance(payload, list) else []:
            i = el.get("destinationIndex", 0)
            seconds = _seconds(el.get("duration"))
            if 0 <= i < len(out) and el.get("condition", "ROUTE_EXISTS") == "ROUTE_EXISTS" and seconds is not None and el.get("distanceMeters") is not None:
                out[i] = {"duration_s": seconds, "distance_m": float(el["distanceMeters"])}
        return out

    def routes(self, origin, destination, max_routes, departure: datetime | None = None, *, with_steps: bool = False) -> list[Candidate]:
        """`with_steps` also asks for the turn-by-turn steps (a bigger, slightly dearer response: only Emergency Route's live navigation uses it)."""
        mask = f"{FIELD_MASK},{STEPS_MASK}" if with_steps else FIELD_MASK
        payload = self._post(self.cfg.routes_url, self._request_body(origin, destination, max_routes, departure), mask, "Routes")
        raw = payload.get("routes") or []
        if not raw:
            raise GoogleRoutesError("Google found no drivable route between these points.", "no_route", retryable=False)
        out = [parse_route(r, i) for i, r in enumerate(raw[: max(1, max_routes)])]
        out.sort(key=lambda c: c.duration_s)
        return out


def _error_text(resp: httpx.Response) -> str:
    try:
        err = resp.json().get("error") or {}
        return f"{err.get('status', '')}: {err.get('message', '')}".strip(": ")
    except (ValueError, AttributeError):
        return resp.text[:200]
