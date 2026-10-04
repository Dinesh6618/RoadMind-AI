"""Per-class defaults for OpenStreetMap `highway` values.

OpenStreetMap has no traffic counts, pavement age or travel speeds, so these are rough ESTIMATES
by road class, used for the risk model's inputs, the traffic factor of the priority score and the
travel-time estimate of the offline router. They are shown as estimates in the UI.
"""

from __future__ import annotations

# class: (typical speed km/h, vehicles per day, pavement age in years)
CLASS_DEFAULTS: dict[str, tuple[float, int, float]] = {
    "motorway": (70, 45000, 12),
    "trunk": (60, 35000, 14),
    "primary": (45, 24000, 15),
    "secondary": (36, 12000, 15),
    "tertiary": (30, 6000, 14),
    "unclassified": (26, 2500, 12),
    "residential": (22, 1500, 12),
    "living_street": (15, 600, 12),
    "service": (15, 400, 10),
    "road": (22, 1500, 12),
}

# Lowest map zoom at which a class is drawn when it has no RoadMind data (generalisation: the same
# rule for every road, data or not). Roads WITH RoadMind data are always drawn.
MIN_ZOOM: dict[str, int] = {
    "motorway": 0, "trunk": 0, "primary": 0, "secondary": 11, "tertiary": 13,
    "unclassified": 14, "residential": 14, "road": 14, "living_street": 15, "service": 15,
}

MAJOR = {"motorway", "trunk", "primary", "secondary"}


def base_class(highway: str) -> str:
    """`primary_link` -> `primary`."""
    return highway.removesuffix("_link")


def defaults_for(highway: str) -> tuple[float, int, float]:
    return CLASS_DEFAULTS.get(base_class(highway), CLASS_DEFAULTS["residential"])


def speed_kmh(highway: str) -> float:
    speed = defaults_for(highway)[0]
    return speed * (0.7 if highway.endswith("_link") else 1.0)


def min_zoom(highway: str) -> int:
    return MIN_ZOOM.get(base_class(highway), 14)


def display_name(name: str | None, highway: str) -> str:
    if name:
        return name
    return f"Unnamed {base_class(highway).replace('_', ' ')}{'' if base_class(highway) == 'living_street' else ' road'}"
