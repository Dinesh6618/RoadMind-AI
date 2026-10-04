"""OSRM routing provider (OpenStreetMap road network, works anywhere there is a server)."""

from __future__ import annotations

import httpx

from .types import Candidate, RoutingUnavailable


class OSRMProvider:
    name = "osrm"

    def __init__(self, base_url: str, timeout_s: float = 6.0):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def routes(self, origin, destination, max_routes):
        (olat, olng), (dlat, dlng) = origin, destination
        url = f"{self.base_url}/route/v1/driving/{olng:.6f},{olat:.6f};{dlng:.6f},{dlat:.6f}"
        params = {"alternatives": "true" if max_routes > 1 else "false", "overview": "full", "geometries": "geojson", "steps": "false"}
        try:
            resp = httpx.get(url, params=params, timeout=self.timeout_s, headers={"User-Agent": "RoadMind-AI/1.0"})
            resp.raise_for_status()
            payload = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RoutingUnavailable(
                "The online routing service could not be reached. Choose places inside the built-in demo area to route offline.", retryable=True
            ) from exc
        if payload.get("code") != "Ok" or not payload.get("routes"):
            raise RoutingUnavailable(f"No drivable route was found between these points ({payload.get('code')}).")
        out = []
        for r in payload["routes"][:max_routes]:
            coords = [[lat, lng] for lng, lat in r["geometry"]["coordinates"]]  # GeoJSON is [lng, lat]
            out.append(Candidate(coords, float(r["distance"]), float(r["duration"]), name="OSRM route"))
        out.sort(key=lambda c: c.duration_s)
        return out
