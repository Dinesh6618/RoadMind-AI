"""Small geometry helpers (no GIS dependency). Coordinates are (lat, lng) in degrees."""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

EARTH_RADIUS_M = 6_371_000.0
M_PER_DEG_LAT = 111_320.0


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def polyline_length_m(coords: Sequence[Sequence[float]]) -> float:
    return sum(haversine_m(a[0], a[1], b[0], b[1]) for a, b in zip(coords, coords[1:]))


def densify(coords: Sequence[Sequence[float]], step_m: float) -> list[tuple[float, float]]:
    """Points along the polyline roughly every `step_m` metres (always includes both ends)."""
    if not coords:
        return []
    out = [(coords[0][0], coords[0][1])]
    for a, b in zip(coords, coords[1:]):
        seg = haversine_m(a[0], a[1], b[0], b[1])
        n = max(1, int(round(seg / step_m)))
        for i in range(1, n + 1):
            t = i / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def project(points: np.ndarray, lat0: float, lng0: float) -> np.ndarray:
    """Equirectangular projection to local metres: (lat, lng) -> (x east, y north)."""
    x = (points[:, 1] - lng0) * M_PER_DEG_LAT * math.cos(math.radians(lat0))
    y = (points[:, 0] - lat0) * M_PER_DEG_LAT
    return np.stack([x, y], axis=1)


class SegmentIndex:
    """Nearest-road lookup over many polylines using vectorised point-to-segment distances."""

    def __init__(self, roads: Sequence[tuple[int, Sequence[Sequence[float]]]]):
        ids, a_pts, b_pts = [], [], []
        for road_id, coords in roads:
            for a, b in zip(coords, coords[1:]):
                ids.append(road_id)
                a_pts.append(a)
                b_pts.append(b)
            if len(coords) == 1:  # degenerate single point road
                ids.append(road_id)
                a_pts.append(coords[0])
                b_pts.append(coords[0])
        self.empty = not ids
        self.road_ids = np.asarray(ids, dtype=np.int64)
        if self.empty:
            return
        a, b = np.asarray(a_pts, float), np.asarray(b_pts, float)
        self.lat0 = float(np.concatenate([a[:, 0], b[:, 0]]).mean())
        self.lng0 = float(np.concatenate([a[:, 1], b[:, 1]]).mean())
        self.a = project(a, self.lat0, self.lng0)
        self.b = project(b, self.lat0, self.lng0)
        self.ab = self.b - self.a
        self.ab2 = np.maximum((self.ab**2).sum(axis=1), 1e-9)

    def distances(self, pts: np.ndarray) -> np.ndarray:
        """(N, M) matrix of distances in metres from each point to each segment."""
        p = project(pts, self.lat0, self.lng0)
        ap = p[:, None, :] - self.a[None, :, :]
        t = np.clip((ap * self.ab[None]).sum(axis=2) / self.ab2[None], 0.0, 1.0)
        closest = self.a[None] + t[..., None] * self.ab[None]
        return np.linalg.norm(p[:, None, :] - closest, axis=2)

    def nearest(self, points: Sequence[Sequence[float]]) -> tuple[np.ndarray, np.ndarray]:
        """For each (lat, lng) return (road_id, distance_m); road_id is -1 when there are no roads."""
        pts = np.asarray(points, float).reshape(-1, 2)
        if self.empty or len(pts) == 0:
            return np.full(len(pts), -1, dtype=np.int64), np.full(len(pts), np.inf)
        d = self.distances(pts)
        best = d.argmin(axis=1)
        return self.road_ids[best], d[np.arange(len(pts)), best]

    def candidates(self, points: Sequence[Sequence[float]], tol_m: float, max_dist_m: float) -> list[list[int]]:
        """Per point, the roads within `tol_m` of the closest one (nearest first); [] if none within `max_dist_m`.

        At a junction several roads are equally close, so callers resolve the ambiguity from context.
        """
        pts = np.asarray(points, float).reshape(-1, 2)
        if self.empty or len(pts) == 0:
            return [[] for _ in range(len(pts))]
        d = self.distances(pts)
        best = d.min(axis=1)
        out: list[list[int]] = []
        for i in range(len(pts)):
            if best[i] > max_dist_m:
                out.append([])
                continue
            per_road: dict[int, float] = {}
            for j in np.nonzero(d[i] <= best[i] + tol_m)[0]:
                rid = int(self.road_ids[j])
                per_road[rid] = min(per_road.get(rid, np.inf), float(d[i, j]))
            out.append([rid for rid, _ in sorted(per_road.items(), key=lambda kv: kv[1])])
        return out


def centroid(coords: Sequence[Sequence[float]]) -> tuple[float, float]:
    arr = np.asarray(coords, float)
    return float(arr[:, 0].mean()), float(arr[:, 1].mean())


def short_segment_around(lat: float, lng: float, length_m: float = 60.0) -> list[list[float]]:
    """A short east-west segment centred on a point - used when a report creates a new road."""
    d = (length_m / 2) / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    return [[lat, lng - d], [lat, lng + d]]
