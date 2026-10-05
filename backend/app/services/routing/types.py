"""Routing-provider interface. Swap map/routing backends by implementing `RoutingProvider`."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class RoutingUnavailable(RuntimeError):
    """The provider cannot produce routes. `retryable` is True for outages (offline server),
    False when the request itself cannot be served (outside coverage, no connected route)."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class Candidate:
    geometry: list[list[float]]  # [[lat, lng], ...]
    distance_m: float
    duration_s: float
    name: str = ""
    # (road id, metres) per road segment used - provided by providers that route on RoadMind's own
    # network, so condition can be read exactly. None for external routers (matched geometrically).
    segments: list[tuple[int, float]] | None = None
    # Live-traffic facts, ONLY from a provider that really has them (Google Routes with traffic awareness). None = unknown,
    # never a guess: `static_duration_s` is the travel time without traffic, `traffic` the speed readings along the geometry
    # as (start point index, end point index, "NORMAL" | "SLOW" | "TRAFFIC_JAM").
    static_duration_s: float | None = None
    traffic: list[tuple[int, int, str]] | None = None
    source: str = ""  # which provider produced the route: network | osrm | google
    # Turn-by-turn steps, only from a provider that has them (Google, when asked): [{index, instruction, maneuver, distance_m, duration_s, start, end}]
    steps: list[dict] | None = None


class RoutingProvider(Protocol):
    name: str

    def routes(self, origin: tuple[float, float], destination: tuple[float, float], max_routes: int) -> list[Candidate]:
        """Return up to `max_routes` distinct candidate routes, fastest first."""
        ...
