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


class RoutingProvider(Protocol):
    name: str

    def routes(self, origin: tuple[float, float], destination: tuple[float, float], max_routes: int) -> list[Candidate]:
        """Return up to `max_routes` distinct candidate routes, fastest first."""
        ...
