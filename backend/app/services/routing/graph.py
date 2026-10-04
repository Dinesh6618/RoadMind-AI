"""Routing over the complete stored road network (every OpenStreetMap segment, damaged or not).

Edges are road segments between junctions; one-way streets are honoured. Several distinct routes
are found with the *penalty method*: after each shortest path, its edges become more expensive so
the next search is pushed elsewhere. The router knows nothing about road damage - RoadMind's
condition scoring is applied afterwards by the engine, exactly as for OSRM routes.
"""

from __future__ import annotations

import heapq
import math
from collections import defaultdict

import numpy as np

from ...geo import M_PER_DEG_LAT, polyline_length_m
from .. import road_classes
from .types import Candidate, RoutingUnavailable

CONNECTOR_SPEED_MS = 20 / 3.6  # from/to the nearest junction


class NetworkGraph:
    name = "network"

    def __init__(self, roads, penalty_factor: float = 1.7, snap_radius_m: float = 400.0):
        """`roads`: objects with id, geometry, highway, oneway, node_a, node_b (stubs without nodes are ignored)."""
        self.penalty_factor = penalty_factor
        self.snap_radius_m = snap_radius_m
        self.node_index: dict[int, int] = {}
        self.node_pos: list[tuple[float, float]] = []
        self.adj: dict[int, list[tuple[int, int]]] = defaultdict(list)  # directed: node -> [(neighbour, edge id)]
        self._undirected: dict[int, list[int]] = defaultdict(list)
        self.edges: list[dict] = []
        for road in roads:
            geom = road.geometry
            if road.node_a is None or road.node_b is None or len(geom) < 2:
                continue
            a, b = self._node(road.node_a, geom[0]), self._node(road.node_b, geom[-1])
            if a == b:
                continue
            length = polyline_length_m(geom)
            speed = road_classes.speed_kmh(road.highway) / 3.6
            eid = len(self.edges)
            self.edges.append({"road_id": road.id, "a": a, "b": b, "geom": geom, "length": length, "time": length / speed})
            self.adj[a].append((b, eid))
            if road.oneway != 1:
                self.adj[b].append((a, eid))
            self._undirected[a].append(b)
            self._undirected[b].append(a)
        main = sorted(self._largest_component())
        self._main = np.array(main, dtype=np.int64)
        if len(main):
            pos = np.array([self.node_pos[n] for n in main])
            self._lat0, self._lng0 = float(pos[:, 0].mean()), float(pos[:, 1].mean())
            self._xy = self._project(pos)

    # ------------------------------------------------------------------ build helpers
    def _node(self, osm_id: int, point) -> int:
        if osm_id not in self.node_index:
            self.node_index[osm_id] = len(self.node_pos)
            self.node_pos.append((float(point[0]), float(point[1])))
        return self.node_index[osm_id]

    def _largest_component(self) -> set[int]:
        """Isolated pieces (disconnected stubs, clipped edges of the map) must not capture snapping."""
        seen: set[int] = set()
        best: set[int] = set()
        for start in self._undirected:
            if start in seen:
                continue
            comp, stack = {start}, [start]
            while stack:
                u = stack.pop()
                for v in self._undirected[u]:
                    if v not in comp:
                        comp.add(v)
                        stack.append(v)
            seen |= comp
            if len(comp) > len(best):
                best = comp
        return best

    def _project(self, pos: np.ndarray) -> np.ndarray:
        x = (pos[:, 1] - self._lng0) * M_PER_DEG_LAT * math.cos(math.radians(self._lat0))
        y = (pos[:, 0] - self._lat0) * M_PER_DEG_LAT
        return np.stack([x, y], axis=1)

    # --------------------------------------------------------------------- snapping
    def snap(self, point: tuple[float, float], k: int = 3) -> list[tuple[int, float]]:
        """Up to k nearest junctions of the connected network within the snap radius: [(node, metres)]."""
        if not len(self._main):
            return []
        d = np.linalg.norm(self._xy - self._project(np.array([point]))[0], axis=1)
        order = np.argsort(d)[:k]
        return [(int(self._main[i]), float(d[i])) for i in order if d[i] <= self.snap_radius_m]

    def covers(self, *points: tuple[float, float]) -> bool:
        return all(self.snap(p, 1) for p in points)

    # ----------------------------------------------------------------------- search
    def _dijkstra(self, src: int, dst: int, penalty: dict[int, float]) -> list[tuple[int, int]] | None:
        dist = {src: 0.0}
        prev: dict[int, tuple[int, int]] = {}
        heap = [(0.0, src)]
        while heap:
            d, u = heapq.heappop(heap)
            if u == dst:
                break
            if d > dist.get(u, float("inf")):
                continue
            for v, eid in self.adj[u]:
                nd = d + self.edges[eid]["time"] * penalty.get(eid, 1.0)
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    prev[v] = (u, eid)
                    heapq.heappush(heap, (nd, v))
        if dst not in dist:
            return None
        path, node = [], dst
        while node != src:
            u, eid = prev[node]
            path.append((u, eid))
            node = u
        path.reverse()
        return path  # [(from_node, edge_id), ...]

    def routes(self, origin, destination, max_routes):
        return [c for _, c in self._search(origin, destination, max_routes)]

    def route_road_ids(self, origin, destination, max_routes) -> list[list[int]]:
        """Road ids used by each candidate route (fastest first) - used when seeding demo data."""
        return [[self.edges[e]["road_id"] for e in eids] for eids, _ in self._search(origin, destination, max_routes)]

    def _search(self, origin, destination, max_routes) -> list[tuple[list[int], Candidate]]:
        starts, ends = self.snap(origin), self.snap(destination)
        if not starts or not ends:
            raise RoutingUnavailable("Start or destination is outside the loaded road network. Load the roads for that area first.")
        for (src, d_src) in starts:  # the nearest junction can be a one-way dead end: try the next ones
            for (dst, d_dst) in ends:
                if src == dst:
                    geom = [list(origin), list(self.node_pos[src]), list(destination)]
                    length = polyline_length_m(geom)
                    return [([], Candidate(geom, length, length / CONNECTOR_SPEED_MS, "Direct", segments=[]))]
                found = self._k_routes(src, dst, d_src, d_dst, origin, destination, max_routes)
                if found:
                    return found
        raise RoutingUnavailable("No connected route was found between these points on the loaded road network.")

    def _k_routes(self, src, dst, d_src, d_dst, origin, destination, max_routes):
        penalty: dict[int, float] = {}
        found: list[tuple[list[int], Candidate]] = []
        for _ in range(max_routes * 4):
            path = self._dijkstra(src, dst, penalty)
            if path is None:
                break
            eids = [e for _, e in path]
            for e in eids:
                penalty[e] = penalty.get(e, 1.0) * self.penalty_factor
            total = sum(self.edges[e]["length"] for e in eids)
            if any(self._shared_length(eids, other) / max(1.0, min(total, sum(self.edges[e]["length"] for e in other))) > 0.8 for other, _ in found):
                continue  # too similar to a route we already have
            found.append((eids, self._to_candidate(path, origin, destination, d_src, d_dst)))
            if len(found) >= max_routes:
                break
        found.sort(key=lambda item: item[1].duration_s)
        return found

    def _shared_length(self, a: list[int], b: list[int]) -> float:
        return sum(self.edges[e]["length"] for e in set(a) & set(b))

    def _to_candidate(self, path, origin, destination, d_src, d_dst) -> Candidate:
        geom: list[list[float]] = [list(origin)]
        length = d_src + d_dst
        seconds = (d_src + d_dst) / CONNECTOR_SPEED_MS
        segments: list[tuple[int, float]] = []
        for frm, eid in path:
            e = self.edges[eid]
            pts = e["geom"] if e["a"] == frm else list(reversed(e["geom"]))
            geom.extend([list(p) for p in pts])
            length += e["length"]
            seconds += e["time"]
            segments.append((e["road_id"], e["length"]))
        geom.append(list(destination))
        return Candidate(geom, length, seconds, "RoadMind network", segments=segments)
