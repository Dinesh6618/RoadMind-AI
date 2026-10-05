"""Route recommendation: candidate routes on the complete network + RoadMind condition overlay.

Candidate routes come from a provider (RoadMind's own graph of the whole OpenStreetMap network, or
OSRM). Each route is then read against RoadMind's condition data. Stretches with NO data are UNKNOWN:
they are reported as such, never shown as good or as damaged, and are counted only through a neutral
prior (the average risk of roads that do have data) when ranking, so missing data neither rewards
nor penalises a route.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from roadmind_ai.severity import level_for

from ...config import RoutingConfig, Settings
from ...database import utcnow
from ...geo import SegmentIndex, densify
from ...models import Road, RouteOption, RouteQuery
from ..pipeline import latest_predictions
from .graph import NetworkGraph
from .osrm import OSRMProvider
from .types import Candidate, RoutingProvider, RoutingUnavailable

JUNCTION_TOLERANCE_M = 8.0  # roads this close to the nearest one count as "equally close"
FALLBACK_PRIOR = 0.30  # used only when no road at all has data

DISCLAIMER = (
    "Route suggestions use the road-condition data currently held by RoadMind, which is an AI-generated estimate "
    "built from user reports. Roads without data are shown as unknown, not as good or damaged. This is not an "
    "official safety assessment and does not mean a road is unsafe or open/closed."
)


@dataclass
class RoadOnRoute:
    road_id: int
    name: str
    severity: float
    severity_level: str
    risk: float
    length_m: float


@dataclass
class RouteAssessment:
    known_risk: float | None  # risk of the stretches that have data (None if none do)
    effective_risk: float  # known stretches + neutral prior for the rest; used only for ranking
    coverage: float  # share of the route (by length) that has RoadMind data
    roads: list[RoadOnRoute] = field(default_factory=list)
    # the same, split into its two ingredients (0..1): current road damage (severity) and predicted deterioration
    known_damage: float | None = None
    known_pred: float | None = None
    effective_damage: float = 0.0
    effective_pred: float = 0.0


def damage_label(risk: float, cfg: RoutingConfig) -> str:
    lb = cfg.damage_labels
    if risk < lb["low"]:
        return "Low"
    if risk < lb["moderate"]:
        return "Moderate"
    if risk < lb["high"]:
        return "High"
    return "Severe"


def normalise_weights(weights: dict[str, float] | None, defaults: dict[str, float]) -> dict[str, float]:
    merged = {k: max(0.0, float((weights or {}).get(k, defaults[k]))) for k in ("distance", "time", "damage_risk")}
    total = sum(merged.values())
    if total <= 0:
        merged = dict(defaults)
        total = sum(merged.values())
    return {k: v / total for k, v in merged.items()}


def _blend(risks: np.ndarray) -> float:
    """Average pulled toward the worst stretches: one terrible road must not be diluted away."""
    return float(0.65 * risks.mean() + 0.35 * np.quantile(risks, 0.9))


def _delta(a: dict, b: dict, sep: str = " and ") -> str:
    """How route `a` differs from route `b`, e.g. "+1.0 km and +1 min" (never "-0.0 km")."""
    km = round(a["distance_km"] - b["distance_km"], 1) + 0.0  # + 0.0 turns -0.0 into 0.0
    minutes = int(round(a["duration_min"] - b["duration_min"]))
    return f"{km:+.1f} km{sep}{minutes:+d} min"


class RouteEngine:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.cfg = settings.routing
        self._graph: NetworkGraph | None = None
        self._graph_signature: tuple | None = None

    # --------------------------------------------------------------- providers
    def graph(self, db: Session) -> NetworkGraph:
        """Graph of the whole stored network, rebuilt only when the network changes."""
        sig = tuple(db.execute(select(func.count(Road.id), func.max(Road.id))).one())
        if self._graph is None or sig != self._graph_signature:
            roads = db.scalars(select(Road).where(Road.node_a.is_not(None), Road.node_b.is_not(None)))
            self._graph = NetworkGraph(roads, self.cfg.penalty_factor, self.cfg.demo_snap_radius_m)
            self._graph_signature = sig
        return self._graph

    def _provider(self, db: Session, origin, destination) -> RoutingProvider:
        mode = self.cfg.provider
        osrm = OSRMProvider(self.cfg.osrm_base_url, self.cfg.osrm_timeout_s)
        if mode == "osrm":
            return osrm
        graph = self.graph(db)
        if mode in ("network", "demo"):
            return graph
        return graph if graph.covers(origin, destination) else osrm  # auto

    # ------------------------------------------------------------- risk reading
    @staticmethod
    def _match_samples(cands: list[list[int]]) -> list[int | None]:
        """Pick one road per sample. Where several roads are equally close (junctions, parallel
        carriageways) keep the road the route was already on, else the one it moves onto next."""
        chosen: list[int | None] = [c[0] if len(c) == 1 else None for c in cands]
        prev = None
        for i, c in enumerate(cands):
            if chosen[i] is not None:
                prev = chosen[i]
            elif c and prev in c:
                chosen[i] = prev
        nxt = None
        for i in range(len(cands) - 1, -1, -1):
            if chosen[i] is not None:
                nxt = chosen[i]
            elif cands[i]:
                chosen[i] = nxt if nxt in cands[i] else cands[i][0]
        return chosen

    def _road_samples(self, candidate: Candidate, index: SegmentIndex, info: dict[int, dict]) -> list[int | None]:
        """One entry per sample along the route: the id of the known (has-data) road it is on, else None."""
        step = self.cfg.sample_step_m
        if candidate.segments is not None:  # routed on RoadMind's own network: exact, no matching needed
            out: list[int | None] = []
            for rid, length in candidate.segments:
                out.extend([rid if rid in info else None] * max(1, round(length / step)))
            return out
        samples = densify(candidate.geometry, step)
        return self._match_samples(index.candidates(samples, JUNCTION_TOLERANCE_M, self.cfg.match_radius_m))

    def _condition_context(self, db: Session) -> tuple[dict[int, dict], SegmentIndex, float, dict[str, float]]:
        """What RoadMind knows about road condition: per-road facts (only roads that HAVE data), a spatial index over them and
        the neutral prior used for stretches without data (the average of the roads that do have data - neither good nor bad)."""
        known_roads = list(db.scalars(select(Road).where(Road.has_data.is_(True))))
        preds = latest_predictions(db, [r.id for r in known_roads]) if known_roads else {}
        share = self.cfg.severity_share
        info = {}
        for r in known_roads:
            pred = preds[r.id].risk if r.id in preds else 0.0
            sev = r.current_severity / 100.0
            info[r.id] = {
                "name": r.name,
                "severity": r.current_severity,
                "level": level_for(r.current_severity, self.settings.severity.level_thresholds),
                "risk": share * sev + (1 - share) * pred,
                "sev": sev,
                "pred": pred,
            }
        index = SegmentIndex([(r.id, r.geometry) for r in known_roads])
        if self.cfg.unknown_road_risk is not None:
            prior = float(self.cfg.unknown_road_risk)
            priors = {"sev": prior, "pred": prior}
        elif info:
            prior = float(np.mean([v["risk"] for v in info.values()]))
            priors = {"sev": float(np.mean([v["sev"] for v in info.values()])), "pred": float(np.mean([v["pred"] for v in info.values()]))}
        else:
            prior = FALLBACK_PRIOR
            priors = {"sev": FALLBACK_PRIOR, "pred": FALLBACK_PRIOR}
        return info, index, prior, priors

    def _assess(self, candidate: Candidate, index: SegmentIndex, info: dict[int, dict], prior: float, priors: dict[str, float] | None = None) -> RouteAssessment:
        chosen = self._road_samples(candidate, index, info)
        n = len(chosen)
        if n == 0:
            return RouteAssessment(None, prior, 0.0, effective_damage=prior, effective_pred=prior)
        known = [c for c in chosen if c is not None]
        coverage = len(known) / n
        known_risk = _blend(np.array([info[c]["risk"] for c in known])) if known else None
        effective = _blend(np.array([info[c]["risk"] if c is not None else prior for c in chosen]))
        priors = priors or {"sev": prior, "pred": prior}
        sev = lambda c: info[c].get("sev", info[c]["risk"])  # noqa: E731  (hand-made `info` dicts may carry only the combined risk)
        pred = lambda c: info[c].get("pred", info[c]["risk"])  # noqa: E731
        known_damage = _blend(np.array([sev(c) for c in known])) if known else None
        known_pred = _blend(np.array([pred(c) for c in known])) if known else None
        effective_damage = _blend(np.array([sev(c) if c is not None else priors["sev"] for c in chosen]))
        effective_pred = _blend(np.array([pred(c) if c is not None else priors["pred"] for c in chosen]))

        counts: dict[int, int] = {}
        order: list[int] = []
        for c in known:
            counts[c] = counts.get(c, 0) + 1
            if c not in order:
                order.append(c)
        roads = [
            RoadOnRoute(rid, info[rid]["name"], info[rid]["severity"], info[rid]["level"], round(info[rid]["risk"], 3), counts[rid] * self.cfg.sample_step_m)
            for rid in order
            if counts[rid] >= 2  # a single stray sample at a junction is not "on" the road
        ]
        return RouteAssessment(
            None if known_risk is None else round(known_risk, 4), round(effective, 4), coverage, roads,
            known_damage=None if known_damage is None else round(known_damage, 4), known_pred=None if known_pred is None else round(known_pred, 4),
            effective_damage=round(effective_damage, 4), effective_pred=round(effective_pred, 4),
        )

    # ------------------------------------------------------------------ public
    def recommend(
        self,
        db: Session,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        origin_name: str = "",
        destination_name: str = "",
        weights: dict[str, float] | None = None,
        persist: bool = True,
        source: str = "user",
    ) -> dict:
        info, index, prior, priors = self._condition_context(db)

        provider = self._provider(db, origin, destination)
        candidates = provider.routes(origin, destination, self.cfg.max_alternatives)
        if not candidates:
            raise RoutingUnavailable("No route could be found between these points.")

        w = normalise_weights(weights, self.cfg.weights)
        assessments = [self._assess(c, index, info, prior, priors) for c in candidates]
        min_d = min(c.distance_m for c in candidates) or 1.0
        min_t = min(c.duration_s for c in candidates) or 1.0
        ref = max(self.cfg.detour_reference, 1e-6)
        scores = []
        for c, a in zip(candidates, assessments):
            extra_d = min(1.0, max(0.0, c.distance_m / min_d - 1.0) / ref)
            extra_t = min(1.0, max(0.0, c.duration_s / min_t - 1.0) / ref)
            scores.append(w["distance"] * extra_d + w["time"] * extra_t + w["damage_risk"] * a.effective_risk)

        min_cov = self.cfg.min_data_coverage
        best = int(np.argmin(scores))
        fastest = int(np.argmin([c.duration_s for c in candidates]))
        out_routes = []
        for i, (c, a, s) in enumerate(zip(candidates, assessments, scores)):
            enough = a.known_risk is not None and a.coverage >= min_cov
            if i == best:
                rec = "Recommended"
            elif enough and a.known_risk >= self.cfg.avoid_risk_threshold and a.effective_risk > assessments[best].effective_risk + 0.05:
                rec = "Avoid"
            else:
                rec = "Alternative"
            severe = [r for r in a.roads if r.severity_level in ("High", "Critical")]
            total_m = c.distance_m
            out_routes.append(
                {
                    "label": f"Route {chr(65 + i)}",
                    "distance_km": round(c.distance_m / 1000, 2),
                    "duration_min": round(c.duration_s / 60, 1),
                    # condition of the stretches RoadMind has data for; null = no usable data
                    "risk": a.known_risk if enough else None,
                    "risk_percent": round(a.known_risk * 100) if enough else None,
                    "damage_level": damage_label(a.known_risk, self.cfg) if enough else "Unknown",
                    "effective_risk": a.effective_risk,  # used for ranking only
                    "score": round(s, 4),
                    "suitability": round(100 * (1 - min(1.0, s))),
                    "recommendation": rec,
                    "is_fastest": i == fastest,
                    "data_coverage": round(a.coverage, 2),
                    "unknown_km": round(total_m * (1 - a.coverage) / 1000, 2),
                    "geometry": c.geometry,
                    "roads": [r.__dict__ for r in a.roads],
                    "severe_roads": [r.__dict__ for r in severe],
                    "reason": "",
                }
            )
        self._explain(out_routes, best, fastest)

        warnings = []
        mean_cov = float(np.mean([a.coverage for a in assessments]))
        best_route = out_routes[best]
        if best_route["risk"] is not None and best_route["risk"] >= self.cfg.avoid_risk_threshold and best_route["data_coverage"] >= 0.5:
            warnings.append("Every available route passes through damaged roads; the recommended one has the lowest estimated risk.")
        if mean_cov < 0.5:
            warnings.append(
                f"RoadMind has condition data for only {round(mean_cov * 100)}% of these routes. Stretches without data are shown as unknown - "
                "they are not counted as good or as damaged."
            )

        rec_label = best_route["label"]
        if mean_cov < min_cov:
            summary = (
                f"RoadMind has little or no road-condition data for these routes, so it cannot rank them by damage risk. "
                f"{rec_label} is suggested on distance and travel time alone."
            )
        elif best != fastest:
            summary = f"RoadMind recommends {rec_label} because the available road-condition data indicates lower damage risk."
        elif best_route["effective_risk"] <= min(r["effective_risk"] for r in out_routes) + 1e-9:
            summary = f"RoadMind recommends {rec_label}: it is the fastest option and the available road-condition data indicates the lowest damage risk."
        else:
            summary = (
                f"RoadMind recommends {rec_label}: it is the fastest option, and the routes with lower estimated damage risk "
                "add more distance or time than the current weights justify."
            )

        query_id = None
        if persist:
            query_id = self._store(db, origin, destination, origin_name, destination_name, provider.name, w, out_routes, rec_label, source)
        return {
            "query_id": query_id,
            "provider": provider.name,
            "origin": {"lat": origin[0], "lng": origin[1], "name": origin_name},
            "destination": {"lat": destination[0], "lng": destination[1], "name": destination_name},
            "weights": {k: round(v, 3) for k, v in w.items()},
            "recommended": rec_label,
            "summary": summary,
            "warnings": warnings,
            "routes": out_routes,
            "disclaimer": DISCLAIMER,
        }

    # ------------------------------------------------------------------ helpers
    def _explain(self, routes: list[dict], best: int, fastest: int) -> None:
        ref, rec = routes[fastest], routes[best]
        min_cov = self.cfg.min_data_coverage

        def risk(r: dict) -> str:
            return f"{r['risk_percent']}%" if r["risk_percent"] is not None else "unknown"

        for i, r in enumerate(routes):
            parts = []
            if r["recommendation"] == "Recommended":
                if r["risk_percent"] is None:
                    parts.append(f"{r['distance_km']} km, about {round(r['duration_min'])} min. RoadMind has no usable condition data along this route.")
                elif i == fastest:
                    parts.append(f"Fastest option, with {r['damage_level'].lower()} estimated road-damage risk ({risk(r)}) on the stretches RoadMind has data for.")
                    lower = [x for x in routes if x["risk_percent"] is not None and x["risk"] < (r["risk"] or 0) - 0.02]
                    if lower:
                        alt = min(lower, key=lambda x: x["risk"])
                        parts.append(
                            f"{alt['label']} has lower estimated risk ({risk(alt)}) but is {_delta(alt, r)} different; "
                            "adjust the weights to favour road condition."
                        )
                else:
                    parts.append("RoadMind recommends this route because the available road-condition data indicates lower damage risk.")
                    parts.append(
                        f"Estimated road-condition risk {risk(r)} versus {risk(ref)} on the fastest route "
                        f"({_delta(r, ref, sep=', ')})."
                    )
                    avoided = [x["name"] for x in ref["severe_roads"] if x["road_id"] not in {y["road_id"] for y in r["roads"]}]
                    if avoided:
                        parts.append("Avoids: " + ", ".join(dict.fromkeys(avoided).keys()) + ".")
            elif r["recommendation"] == "Avoid":
                names = list(dict.fromkeys(x["name"] for x in r["severe_roads"]))[:3]
                parts.append(f"Estimated road-condition risk is high ({risk(r)}).")
                if names:
                    parts.append("Includes roads with high-severity damage reports: " + ", ".join(names) + ".")
                parts.append("This is a data-based caution, not a finding that the road is unsafe.")
            else:
                if r["risk_percent"] is None:
                    parts.append(f"Condition unknown for this route; {_delta(r, rec)} versus the recommended route.")
                else:
                    parts.append(
                        f"{r['damage_level']} estimated risk ({risk(r)}); "
                        f"{_delta(r, rec)} versus the recommended route."
                    )
            if r["risk_percent"] is not None and r["data_coverage"] < 0.5:
                parts.append(f"Condition data covers only {round(r['data_coverage'] * 100)}% of this route; the rest is unknown (not counted as good or damaged).")
            elif r["risk_percent"] is None and r["data_coverage"] < min_cov and r["recommendation"] != "Recommended":
                parts.append("No usable RoadMind condition data on this route.")
            r["reason"] = " ".join(parts)

    def _store(self, db, origin, destination, oname, dname, provider, weights, routes, rec_label, source) -> int:
        q = RouteQuery(
            created_at=utcnow(),
            origin_name=oname, origin_lat=origin[0], origin_lng=origin[1],
            dest_name=dname, dest_lat=destination[0], dest_lng=destination[1],
            provider=provider, weights=weights, recommended_label=rec_label, source=source,
        )
        for r in routes:
            q.options.append(
                RouteOption(
                    label=r["label"], distance_km=r["distance_km"], duration_min=r["duration_min"], risk=r["effective_risk"],
                    data_coverage=r["data_coverage"], score=r["score"], recommendation=r["recommendation"], is_fastest=r["is_fastest"],
                    geometry=r["geometry"],
                    road_ids=[x["road_id"] for x in r["roads"]], damaged_road_ids=[x["road_id"] for x in r["severe_roads"]],
                )
            )
        db.add(q)
        db.commit()
        return q.id
