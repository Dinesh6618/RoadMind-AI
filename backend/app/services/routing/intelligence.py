"""Smart routing: real traffic-aware routes + RoadMind road condition + verified road events -> one recommendation.

    candidates   Google Routes API (traffic-aware, with alternatives) when GOOGLE_MAPS_API_KEY is set; otherwise RoadMind's own
                 OpenStreetMap routing - then there is NO traffic information and the answer says so, nothing is invented
    per route    RoadMind Route Risk Score (0-100, lower is better), configurable under `route_risk` in config/roadmind.yaml:

                     risk = traffic*0.30 + road_damage*0.25 + predicted_damage*0.15 + blockage*0.30

                 traffic            Google's speed readings along the route + the delay against free flow (None without Google)
                 road_damage        current damage (severity) of the roads RoadMind has data for
                 predicted_damage   predicted deterioration risk of those roads
                 blockage           100 for a VERIFIED, live blockage / closure on the route; less for other verified events;
                                    only a small nudge for an unverified community report
                 A component that is not available is left out and the remaining weights are re-normalised.
    status       AVOID if a verified blockage is on the route (unless every route has one), or the risk is high and clearly worse
                 than the best route; RECOMMENDED = lowest risk (a small travel-time term breaks ties - the shortest route is never
                 recommended blindly); everything else ALTERNATIVE

Roads without RoadMind data are neither good nor bad: they count through the neutral prior (see RouteEngine) and the answer
reports how much of each route has data. None of this guarantees physical safety.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

from ...database import utcnow
from ...geo import haversine_m
from .. import events as ev_service
from .engine import DISCLAIMER, RouteEngine, damage_label
from .google import GoogleRoutesError, GoogleRoutesProvider
from .types import Candidate, RoutingUnavailable

log = logging.getLogger("roadmind.routes")

TRAFFIC_LEVELS = ((15, "Normal"), (40, "Moderate"), (70, "Heavy"))  # upper bounds; above is "Traffic jam"
SAFETY_NOTE = " RoadMind estimates risk from reports, AI detections and live traffic; it cannot guarantee that a road is physically safe."


def traffic_level(risk: float | None) -> str:
    if risk is None:
        return "Unknown"
    for bound, label in TRAFFIC_LEVELS:
        if risk < bound:
            return label
    return "Traffic jam"


def _cumulative(geometry: list[list[float]]) -> list[float]:
    cum = [0.0]
    for a, b in zip(geometry, geometry[1:]):
        cum.append(cum[-1] + haversine_m(a[0], a[1], b[0], b[1]))
    return cum


def assess_traffic(c: Candidate, cfg) -> dict | None:
    """Traffic facts of a route, or None when the provider has none (no Google, or Google sent no traffic data)."""
    if c.source != "google" or (c.traffic is None and c.static_duration_s is None):
        return None
    cum = _cumulative(c.geometry)
    congestion = None
    jam_m = slow_m = 0.0
    segments = []
    if c.traffic:
        weighted = covered = 0.0
        for start, end, speed in c.traffic:
            length = cum[end] - cum[start]
            weighted += length * cfg.speed_risk.get(speed, 0.0)
            covered += length
            jam_m += length if speed == "TRAFFIC_JAM" else 0.0
            slow_m += length if speed == "SLOW" else 0.0
            segments.append({"speed": speed, "path": [[round(p[0], 6), round(p[1], 6)] for p in c.geometry[start : end + 1]]})
        congestion = weighted / covered if covered > 0 else None
    delay_s = delay_risk = None
    if c.static_duration_s:
        delay_s = max(0.0, c.duration_s - c.static_duration_s)
        delay_risk = 100.0 * min(1.0, (delay_s / c.static_duration_s) / max(cfg.delay_reference, 1e-6))
    if congestion is not None and delay_risk is not None:
        risk = (1 - cfg.delay_share) * congestion + cfg.delay_share * delay_risk
    else:
        risk = congestion if congestion is not None else delay_risk
    if risk is None:
        return None
    return {
        "risk": round(risk, 1),
        "level": traffic_level(risk),
        "delay_min": None if delay_s is None else round(delay_s / 60, 1),
        "jam_km": round(jam_m / 1000, 2),
        "slow_km": round(slow_m / 1000, 2),
        "segments": segments,
    }


def _event_brief(ev, settings, now) -> dict:
    meta = ev_service.EVENT_TYPES.get(ev.event_type, {})
    return {
        "id": ev.id, "event_type": ev.event_type, "headline": meta.get("headline", ev.event_type), "road_name": ev.road_name,
        "lat": ev.lat, "lng": ev.lng, "description": ev.description, "verified": ev.verification_status == "VERIFIED",
        "expected_reopening_at": ev.expires_at.isoformat(), "age_minutes": max(0, int((now - ev.created_at).total_seconds() // 60)),
    }


def assess_events(hits, settings, now) -> dict:
    """Blockage facts of a route from the events it runs through."""
    cfg = settings.route_risk
    risk = 0.0
    blocking, soft, unverified = [], [], []
    for ev, _dist in hits:
        brief = _event_brief(ev, settings, now)
        if ev.verification_status == "VERIFIED":
            risk = max(risk, cfg.event_risk.get(ev.event_type, 50.0))
            (blocking if ev.event_type in cfg.hard_block_types else soft).append(brief)
        else:  # nobody has confirmed it: it must not decide the route, only nudge it
            risk = max(risk, min(cfg.unverified_blockage_risk, cfg.event_risk.get(ev.event_type, 50.0)))
            unverified.append(brief)
    return {"risk": risk, "blocked": bool(blocking), "blocking": blocking, "soft": soft, "unverified": unverified}


def combine(components: dict[str, float | None], weights: dict[str, float]) -> tuple[float, dict[str, float]]:
    """Weighted mean of the components that exist; weights re-normalised over them."""
    present = {k: v for k, v in components.items() if v is not None and weights.get(k, 0) > 0}
    total = sum(weights[k] for k in present)
    if not present or total <= 0:
        return 0.0, {}
    used = {k: weights[k] / total for k in present}
    return float(sum(used[k] * present[k] for k in present)), used


def _departure(departure: datetime | None, now: datetime) -> datetime | None:
    """Google only accepts a departure time in the future; "now" is the default."""
    return departure if departure is not None and departure > now + timedelta(seconds=30) else None


@dataclass
class Gathered:
    """Everything known about the candidate routes before any scoring: shared by the normal and the emergency route engines."""

    now: datetime
    provider_name: str
    traffic_info: dict
    notes: list[str]
    candidates: list[Candidate]
    assessments: list  # RouteAssessment per candidate (RoadMind road condition along the route)
    traffic: list[dict | None]  # per candidate: traffic facts, None when the provider has none
    blockage: list[dict]  # per candidate: events on the route (see assess_events)
    have_condition: bool  # RoadMind has usable condition data for these routes
    fastest: int
    min_t: float


def gather(engine: RouteEngine, db, origin: tuple[float, float], destination: tuple[float, float], departure_time: datetime | None = None, *, with_steps: bool = False) -> Gathered:
    """Candidate routes (Google when configured, else RoadMind's own routing - never invented traffic) + the facts about each:
    road condition, live traffic, road events on it. Raises RoutingUnavailable when no route can be found."""
    settings = engine.settings
    cfg = settings.route_risk
    now = utcnow()
    ev_service.expire_due(db, now, settings)
    live = ev_service.live_events(db, settings, now=now)
    info, index, prior, priors = engine._condition_context(db)

    traffic_info = {"available": False, "source": None, "message": "Live traffic unavailable."}
    notes: list[str] = []
    candidates: list[Candidate] = []
    provider_name = ""
    if settings.google_api_key:
        google = GoogleRoutesProvider(settings.google_api_key, settings.google, getattr(engine, "google_client", None))
        try:
            candidates = google.routes(origin, destination, settings.google.max_routes, _departure(departure_time, now), with_steps=with_steps)
            provider_name = "google"
            traffic_info = {"available": True, "source": "google", "message": "Live traffic from Google Maps."}
        except GoogleRoutesError as exc:
            if exc.reason == "no_route":
                raise
            log.warning("Google Routes failed (%s); falling back to RoadMind routing without traffic", exc.reason)
            traffic_info["message"] = "Live traffic temporarily unavailable."
            notes.append("Live traffic temporarily unavailable. Routes were calculated without traffic.")
    else:
        traffic_info["message"] = "Live traffic unavailable (Google Maps is not set up)."
    if not candidates:
        provider = engine._provider(db, origin, destination)
        candidates = provider.routes(origin, destination, engine.cfg.max_alternatives)
        provider_name = provider.name
        for c in candidates:
            c.source = c.source or provider.name
    if not candidates:
        raise RoutingUnavailable("No route could be found between these points.")

    assessments = [engine._assess(c, index, info, prior, priors) for c in candidates]
    mean_cov = float(np.mean([a.coverage for a in assessments]))
    return Gathered(
        now=now, provider_name=provider_name, traffic_info=traffic_info, notes=notes, candidates=candidates, assessments=assessments,
        traffic=[assess_traffic(c, cfg) for c in candidates],
        blockage=[assess_events(ev_service.route_hits(live, c.geometry, settings), settings, now) for c in candidates],
        have_condition=mean_cov >= engine.cfg.min_data_coverage,  # otherwise road damage / prediction are "unavailable", not zero
        fastest=int(np.argmin([c.duration_s for c in candidates])),
        min_t=min(c.duration_s for c in candidates) or 1.0,
    )


def calculate(
    engine: RouteEngine,
    db,
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    origin_name: str = "",
    destination_name: str = "",
    departure_time: datetime | None = None,
    persist: bool = True,
    source: str = "user",
) -> dict:
    settings = engine.settings
    cfg = settings.route_risk
    g = gather(engine, db, origin, destination, departure_time)
    now, provider_name, traffic_info, notes = g.now, g.provider_name, g.traffic_info, g.notes
    candidates, assessments, have_condition, fastest, min_t = g.candidates, g.assessments, g.have_condition, g.fastest, g.min_t
    ref = max(engine.cfg.detour_reference, 1e-6)

    rows = []
    for c, a, traffic, blockage in zip(candidates, assessments, g.traffic, g.blockage):
        components = {
            "traffic": None if traffic is None else traffic["risk"],
            "road_damage": 100.0 * a.effective_damage if have_condition else None,
            "predicted_damage": 100.0 * a.effective_pred if have_condition else None,
            "blockage": blockage["risk"],
        }
        risk, used = combine(components, cfg.weights)
        extra_t = min(1.0, max(0.0, c.duration_s / min_t - 1.0) / ref)
        rows.append({"c": c, "a": a, "traffic": traffic, "blockage": blockage, "components": components, "used": used, "risk": risk, "rank": risk + cfg.time_weight * extra_t})

    # -------------------------------------------------------------------------- ranking
    ok = [i for i, r in enumerate(rows) if not r["blockage"]["blocked"]]
    all_blocked = not ok
    best = min(ok or range(len(rows)), key=lambda i: rows[i]["rank"])
    best_risk = rows[best]["risk"]
    out_routes = []
    for i, r in enumerate(rows):
        c, a, t, b = r["c"], r["a"], r["traffic"], r["blockage"]
        if i == best:
            rec = "Recommended"
        elif b["blocked"] or (r["risk"] >= cfg.avoid_threshold and r["risk"] >= best_risk + cfg.margin):
            rec = "Avoid"
        else:
            rec = "Alternative"
        enough = a.known_risk is not None and a.coverage >= engine.cfg.min_data_coverage
        severe = [x for x in a.roads if x.severity_level in ("High", "Critical")]
        out_routes.append(
            {
                "label": f"Route {chr(65 + i)}",
                "distance_km": round(c.distance_m / 1000, 2),
                "duration_min": round(c.duration_s / 60, 1),  # with live traffic when Google provided it
                "static_duration_min": None if c.static_duration_s is None else round(c.static_duration_s / 60, 1),
                "delay_min": None if t is None else t["delay_min"],
                "traffic_available": t is not None,
                "traffic_level": traffic_level(None if t is None else t["risk"]),
                "traffic_risk": None if t is None else t["risk"],
                "traffic_segments": [] if t is None else t["segments"],
                "road_damage_risk": None if r["components"]["road_damage"] is None else round(r["components"]["road_damage"]),
                "predicted_damage_risk": None if r["components"]["predicted_damage"] is None else round(r["components"]["predicted_damage"]),
                "blockage_risk": round(b["risk"]),
                "risk": round(r["risk"]),
                "risk_percent": round(r["risk"]),
                "risk_weights": {k: round(v, 3) for k, v in r["used"].items()},
                "damage_level": damage_label(a.known_risk, engine.cfg) if enough else "Unknown",
                "blocked": b["blocked"],
                "blocked_by": b["blocking"],
                "events": b["soft"],
                "unverified_events": b["unverified"],
                "recommendation": rec,
                "status": rec.upper(),
                "is_fastest": i == fastest,
                "data_coverage": round(a.coverage, 2),
                "unknown_km": round(c.distance_m * (1 - a.coverage) / 1000, 2),
                "geometry": [[round(p[0], 6), round(p[1], 6)] for p in c.geometry],
                "roads": [x.__dict__ for x in a.roads],
                "severe_roads": [x.__dict__ for x in severe],
                "reason": "",
                # kept for the stored history / the older planner
                "effective_risk": round(r["risk"] / 100.0, 4),
                "score": round(r["rank"] / 100.0, 4),
            }
        )
    _explain(out_routes, best, fastest, all_blocked, have_condition)

    selected = out_routes[fastest]  # the route a driver would take without RoadMind
    recommended = out_routes[best]
    alert = _alert(selected, recommended, all_blocked)
    messages = _messages(out_routes, best, alert, traffic_info, have_condition, notes)
    summary = _summary(selected, recommended, all_blocked, traffic_info["available"], have_condition)

    query_id = None
    if persist:
        query_id = engine._store(db, origin, destination, origin_name, destination_name, provider_name, {k: round(v, 3) for k, v in cfg.weights.items()}, out_routes, recommended["label"], source)
    return {
        "query_id": query_id,
        "provider": provider_name,
        "generated_at": now.isoformat(),
        "traffic": traffic_info,
        "origin": {"lat": origin[0], "lng": origin[1], "name": origin_name},
        "destination": {"lat": destination[0], "lng": destination[1], "name": destination_name},
        "weights": {k: round(v, 3) for k, v in cfg.weights.items()},
        "selected": selected["label"],
        "recommended": recommended["label"],
        "summary": summary,
        "alert": alert,
        "messages": messages,
        "warnings": [m["text"] for m in messages if m["kind"] in ("warn", "error")],
        "routes": out_routes,
        "disclaimer": DISCLAIMER + SAFETY_NOTE,
    }


# ----------------------------------------------------------------------------- wording
def _explain(routes: list[dict], best: int, fastest: int, all_blocked: bool, have_condition: bool) -> None:
    rec = routes[best]
    for i, r in enumerate(routes):
        parts: list[str] = []
        if r["blocked"]:
            names = ", ".join(dict.fromkeys(b["road_name"] or "a reported road" for b in r["blocked_by"]))
            parts.append(f"Verified road blockage on this route ({names}).")
            if all_blocked:
                parts.append("Every available route has a verified blockage; this one has the lowest overall risk.")
        elif r["recommendation"] == "Recommended":
            if i == fastest:
                parts.append("Fastest route and the lowest RoadMind risk.")
            else:
                parts.append(f"Lowest RoadMind risk ({r['risk']}/100), {_delta(r, routes[fastest])} compared with the fastest route.")
        elif r["recommendation"] == "Avoid":
            parts.append(f"High overall risk ({r['risk']}/100).")
        else:
            parts.append(f"Risk {r['risk']}/100; {_delta(r, rec)} compared with the recommended route.")
        if r["traffic_level"] in ("Heavy", "Traffic jam"):
            parts.append(f"{r['traffic_level']} traffic{'' if r['delay_min'] is None else f' (about {round(r['delay_min'])} min delay)'}.")
        if r["damage_level"] in ("High", "Severe"):
            parts.append(f"{r['damage_level']} road-damage risk on the stretches RoadMind has data for.")
        if r["events"]:
            parts.append("Also on this route: " + ", ".join(dict.fromkeys(e["headline"].split(" ", 1)[-1].lower() for e in r["events"])) + " (verified).")
        if r["unverified_events"]:
            parts.append("An unverified community report is near this route; staff have not confirmed it.")
        if have_condition and r["data_coverage"] < 0.5:
            parts.append(f"RoadMind has condition data for only {round(r['data_coverage'] * 100)}% of this route; the rest is unknown (not counted as good or damaged).")
        r["reason"] = " ".join(parts)


def _delta(a: dict, b: dict) -> str:
    km = round(a["distance_km"] - b["distance_km"], 1) + 0.0
    minutes = int(round(a["duration_min"] - b["duration_min"]))
    return f"{km:+.1f} km and {minutes:+d} min"


def _alert(selected: dict, recommended: dict, all_blocked: bool) -> dict | None:
    """The prominent notice when the route the driver would take has a verified blockage."""
    if not selected["blocked"]:
        return None
    base = {
        "type": "ROAD_BLOCKED",
        "title": "🚧 ROAD BLOCKED",
        "message": "RoadMind detected a verified road blockage on your selected route.",
        "blocked_route": selected["label"],
        "blocked_by": selected["blocked_by"],
    }
    if all_blocked or recommended["blocked"]:
        return {**base, "headline": "No unblocked route available", "alternative": None,
                "detail": "Every route RoadMind found passes a verified blockage. The least risky one is highlighted - check conditions before you go."}
    lower = recommended["risk"] < selected["risk"]
    return {
        **base,
        "headline": "Alternative route recommended",
        "alternative": {
            "label": recommended["label"],
            "distance_km": recommended["distance_km"],
            "duration_min": recommended["duration_min"],
            "risk": recommended["risk"],
            "reason": "Alternative route avoids the blocked road and has lower current road-condition risk." if lower else "Alternative route avoids the blocked road.",
        },
    }


def _messages(routes: list[dict], best: int, alert: dict | None, traffic: dict, have_condition: bool, notes: list[str]) -> list[dict]:
    rec = routes[best]
    out: list[dict] = []
    if alert:
        out.append({"kind": "error", "text": "🚧 Road blocked ahead"})
        alt = alert["alternative"]
        if alt:
            blocked_risk = next(r["risk"] for r in routes if r["label"] == alert["blocked_route"])
            if alt["risk"] < blocked_risk:
                out.append({"kind": "ok", "text": "✅ Lower-risk alternative found"})
            out.append({"kind": "ok", "text": "✅ Route selected because it avoids the reported blockage."})
    elif any(r["blocked"] for r in routes):
        out.append({"kind": "warn", "text": "🚧 A verified blockage is on one of the alternative routes - it is marked AVOID."})
    if rec["traffic_level"] in ("Heavy", "Traffic jam"):
        out.append({"kind": "warn", "text": "⚠️ Heavy traffic detected"})
    if rec["damage_level"] in ("High", "Severe"):
        out.append({"kind": "warn", "text": "⚠️ High road-damage risk detected"})
    if rec["events"]:
        out.append({"kind": "warn", "text": "⚠️ " + ", ".join(dict.fromkeys(e["headline"] for e in rec["events"])) + " reported on this route"})
    if rec["unverified_events"]:
        out.append({"kind": "info", "text": "ℹ️ An unverified community report is near this route"})
    if not have_condition:
        out.append({"kind": "info", "text": "ℹ️ Road condition data unavailable"})
    for note in notes:
        out.append({"kind": "warn", "text": note})
    if not traffic["available"] and not notes:
        out.append({"kind": "info", "text": "ℹ️ " + traffic["message"]})
    return out


def _summary(selected: dict, rec: dict, all_blocked: bool, traffic_ok: bool, have_condition: bool) -> str:
    if all_blocked:
        return f"Every route has a verified blockage. {rec['label']} has the lowest risk, but check conditions before you go."
    if selected["blocked"]:
        return f"{rec['label']} is recommended because it avoids the verified blockage on {selected['label']}."
    if rec["label"] == selected["label"]:
        return f"RoadMind recommends {rec['label']}: the fastest option, with the lowest estimated risk{' including live traffic' if traffic_ok else ''}."
    return f"RoadMind recommends {rec['label']}: lower estimated risk than the fastest route ({rec['risk']}/100 vs {selected['risk']}/100)."
