"""Emergency Route Mode, part 2: choose the best AVAILABLE route to an emergency destination.

    1. candidates  traffic-aware routes from Google (alternatives included), else RoadMind's own routing - never invented traffic
    2. hard rule   a route with a VERIFIED, live closure / blockage is UNAVAILABLE: it is not scored and never recommended.
                   If every route has one, nothing is recommended (the answer says so) - it is not "recommended with a warning".
    3. the rest    ranked by the Emergency Route Score (0-100, lower is better), configurable under `emergency:` in config/roadmind.yaml:

                       score = travel_time*0.45 + traffic*0.20 + road_damage*0.15 + flood*0.10 + other*0.10

                   travel_time   how much slower than the fastest route (100 = 50 % slower or more) - the shortest route does not
                                 automatically win because the other parts count 55 %
                   traffic       Google's speed readings and delay (left out without live traffic)
                   road_damage   current damage of the roads RoadMind has data for (left out without road-condition data)
                   flood         reported flooding on the route (verified events count fully, an unverified report only nudges)
                   other         construction, accidents, severe damage reports and the predicted deterioration risk of the roads
                   A part that is unavailable is dropped and the remaining weights re-normalised - never replaced by a made-up number.
    4. RoadMind risk (0-100) shown to the user is the same blend WITHOUT travel time.

RoadMind recommends a route from the information available right now. It does not guarantee the fastest response or a safe route.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from .engine import RouteEngine, damage_label
from .intelligence import Gathered, combine, gather, traffic_level

DISCLAIMER = (
    "RoadMind recommends this route based on currently available traffic, road-condition and verified road-event data. "
    "It does not guarantee the fastest emergency response or a safe route. In an emergency, follow the instructions of the emergency services."
)
FLOOD_TYPES = ("FLOODED",)
OTHER_TYPES = ("CONSTRUCTION", "ACCIDENT", "SEVERE_DAMAGE")


def _event_risk(blockage: dict, types: tuple[str, ...], rcfg) -> float:
    """Risk (0-100) of the events of these types on a route: verified ones at their configured level, unverified reports only nudge."""
    risk = 0.0
    for b in blockage["soft"]:
        if b["event_type"] in types:
            risk = max(risk, rcfg.event_risk.get(b["event_type"], 50.0))
    for b in blockage["unverified"]:
        if b["event_type"] in types:
            risk = max(risk, min(rcfg.unverified_blockage_risk, rcfg.event_risk.get(b["event_type"], 50.0)))
    return risk


def _flags(r: dict, high_risk: float) -> list[str]:
    flags = []
    if r["blocked"]:
        flags.append("VERIFIED_CLOSURE")
    if r["traffic_level"] in ("Heavy", "Traffic jam"):
        flags.append("HEAVY_TRAFFIC")
    if r["risk"] is not None and r["risk"] >= high_risk:
        flags.append("HIGH_ROAD_RISK")
    if r["damage_level"] in ("High", "Severe"):
        flags.append("ROAD_DAMAGE")
    if r["flood_risk"] > 0:
        flags.append("FLOODING_REPORTED")
    if r["events"]:
        flags.append("VERIFIED_EVENT")
    if r["unverified_events"]:
        flags.append("UNVERIFIED_REPORT")
    return flags


def calculate_emergency(
    engine: RouteEngine,
    db: Session,
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    origin_name: str = "",
    destination_name: str = "",
    destination_kind: str | None = None,
    current: dict | None = None,
    persist: bool = True,
) -> dict:
    """`current` = {distance_km, duration_min, label} of the route the person is on now (when re-planning): the alternative's
    "+1.4 km / +3 min" is measured against it; otherwise against the fastest route."""
    settings = engine.settings
    ecfg, rcfg = settings.emergency, settings.route_risk
    g: Gathered = gather(engine, db, origin, destination, with_steps=True)  # turn-by-turn for the live navigation screen (Google only)
    ref = max(ecfg.detour_reference, 1e-6)
    non_time_weights = {k: v for k, v in ecfg.weights.items() if k != "travel_time"}

    routes: list[dict] = []
    for i, (c, a, t, b) in enumerate(zip(g.candidates, g.assessments, g.traffic, g.blockage)):
        parts = {
            "travel_time": 100.0 * min(1.0, max(0.0, c.duration_s / g.min_t - 1.0) / ref),
            "traffic": None if t is None else t["risk"],
            "road_damage": 100.0 * a.effective_damage if g.have_condition else None,
            "flood": _event_risk(b, FLOOD_TYPES, rcfg),
            "other": max(_event_risk(b, OTHER_TYPES, rcfg), 100.0 * a.effective_pred if g.have_condition else 0.0),
        }
        blocked = b["blocked"]
        score, used = (None, {}) if blocked else combine(parts, ecfg.weights)
        risk, _ = combine({k: v for k, v in parts.items() if k != "travel_time"}, non_time_weights)
        enough = a.known_risk is not None and a.coverage >= engine.cfg.min_data_coverage
        routes.append(
            {
                "label": f"Route {chr(65 + i)}",
                "distance_km": round(c.distance_m / 1000, 2),
                "duration_min": round(c.duration_s / 60, 1),  # with live traffic when Google provided it
                "static_duration_min": None if c.static_duration_s is None else round(c.static_duration_s / 60, 1),
                "delay_min": None if t is None else t["delay_min"],
                "traffic_available": t is not None,
                "traffic_level": traffic_level(None if t is None else t["risk"]),
                "traffic_risk": None if t is None else round(t["risk"]),
                "traffic_segments": [] if t is None else t["segments"],
                "travel_time_score": round(parts["travel_time"]),
                "road_damage_risk": None if parts["road_damage"] is None else round(parts["road_damage"]),
                "flood_risk": round(parts["flood"]),
                "other_risk": round(parts["other"]),
                "emergency_score": None if score is None else round(score, 1),
                "score_weights": {k: round(v, 3) for k, v in used.items()},
                "risk": round(risk),  # RoadMind risk (without travel time)
                "damage_level": damage_label(a.known_risk, engine.cfg) if enough else "Unknown",
                "blocked": blocked,
                "available": not blocked,
                "blocked_by": b["blocking"],
                "events": b["soft"],
                "unverified_events": b["unverified"],
                "is_fastest": i == g.fastest,
                "data_coverage": round(a.coverage, 2),
                "geometry": [[round(p[0], 6), round(p[1], 6)] for p in c.geometry],
                "steps_available": bool(c.steps),
                "steps": (c.steps or [])[:300],  # only Google provides them; [] otherwise (the page then shows progress without turn cards)
                "roads": [x.__dict__ for x in a.roads],
                "severe_roads": [x.__dict__ for x in a.roads if x.severity_level in ("High", "Critical")],
                "status": "UNAVAILABLE" if blocked else "ALTERNATIVE",
                "flags": [],
                "reason": "",
            }
        )

    available = [i for i, r in enumerate(routes) if r["available"]]
    best = min(available, key=lambda i: (routes[i]["emergency_score"], routes[i]["duration_min"])) if available else None
    if best is not None:
        routes[best]["status"] = "RECOMMENDED"
    for r in routes:
        r["flags"] = _flags(r, ecfg.high_risk_threshold)

    selected = routes[g.fastest]  # the route a driver would take without RoadMind
    recommended = routes[best] if best is not None else None
    alert = _alert(selected, recommended, current)
    _explain(routes, recommended, selected)
    live_data = {"traffic": g.traffic_info["available"], "road_condition": g.have_condition, "road_events": True}
    messages = _messages(routes, recommended, selected, alert, g, live_data)

    rec_label = recommended["label"] if recommended else ""
    query_id = None
    if persist:
        store = [
            {**r, "effective_risk": round(r["risk"] / 100.0, 4), "score": round((r["emergency_score"] if r["emergency_score"] is not None else 100.0) / 100.0, 4),
             "recommendation": {"RECOMMENDED": "Recommended", "UNAVAILABLE": "Avoid"}.get(r["status"], "Alternative")}
            for r in routes
        ]
        query_id = engine._store(db, origin, destination, origin_name, destination_name, g.provider_name, {k: round(v, 3) for k, v in ecfg.weights.items()}, store, rec_label, "user")

    return {
        "query_id": query_id,
        "mode": "emergency",
        "provider": g.provider_name,
        "generated_at": g.now.isoformat(),
        "traffic": g.traffic_info,
        "live_data": live_data,
        "origin": {"lat": origin[0], "lng": origin[1], "name": origin_name},
        "destination": {"lat": destination[0], "lng": destination[1], "name": destination_name, "kind": destination_kind},
        "weights": {k: round(v, 3) for k, v in ecfg.weights.items()},
        "selected": selected["label"],
        "recommended": rec_label or None,
        "summary": _summary(recommended, selected),
        "alert": alert,
        "messages": messages,
        "routes": routes,
        "recheck": {"status_interval_s": ecfg.status_interval_s, "reroute_interval_s": ecfg.reroute_interval_s},
        "disclaimer": DISCLAIMER,
    }


# ----------------------------------------------------------------------------- wording
def _delta(a: dict, b: dict) -> tuple[float, int]:
    return round(a["distance_km"] - b["distance_km"], 1) + 0.0, int(round(a["duration_min"] - b["duration_min"]))


def _fmt_delta(km: float, minutes: int) -> str:
    return f"{km:+.1f} km, {minutes:+d} min"


def _alert(selected: dict, recommended: dict | None, current: dict | None) -> dict | None:
    """The 🚧 notice when the route the driver would take (or is on) has a verified closure."""
    if not selected["blocked"]:
        return None
    base = {
        "type": "ROAD_BLOCKED", "title": "🚧 ROAD BLOCKED", "message": "A verified road closure was detected on your current route.",
        "blocked_route": selected["label"], "blocked_by": selected["blocked_by"],
    }
    if recommended is None:
        return {**base, "headline": "No unblocked route available", "alternative": None,
                "detail": "Every route RoadMind found has a verified road closure, so none is recommended. Follow the instructions of the emergency services."}
    ref = current or selected
    km, minutes = _delta(recommended, {"distance_km": ref["distance_km"], "duration_min": ref["duration_min"]})
    lower = recommended["risk"] < selected["risk"]
    return {
        **base,
        "headline": "Alternative route found",
        "alternative": {
            "label": recommended["label"], "distance_km": recommended["distance_km"], "duration_min": recommended["duration_min"],
            "extra_km": km, "extra_min": minutes, "delta_text": _fmt_delta(km, minutes), "risk": recommended["risk"],
            "reason": "This route avoids a verified road closure and has lower available road-condition risk." if lower else "This route avoids a verified road closure.",
        },
    }


def _explain(routes: list[dict], recommended: dict | None, selected: dict) -> None:
    for r in routes:
        parts: list[str] = []
        if r["blocked"]:
            names = ", ".join(dict.fromkeys(b["road_name"] or "a reported road" for b in r["blocked_by"]))
            parts.append(f"Verified road closure on this route ({names}). Not recommended.")
        elif r is recommended:
            if selected["blocked"]:
                parts.append("This route avoids a verified road closure" + (" and has lower available road-condition risk." if r["risk"] < selected["risk"] else "."))
            else:
                parts.append("Best balance of travel time, traffic and road-condition risk from the information currently available.")
        elif recommended is not None:
            km, minutes = _delta(r, recommended)
            parts.append(f"{_fmt_delta(km, minutes)} compared with the recommended route; RoadMind risk {r['risk']}/100.")
        if r["traffic_level"] in ("Heavy", "Traffic jam"):
            parts.append(f"{r['traffic_level']} traffic" + (f" (about {round(r['delay_min'])} min delay)." if r["delay_min"] else "."))
        if "HIGH_ROAD_RISK" in r["flags"]:
            parts.append("High road risk on this route.")
        if r["flood_risk"] > 0:
            parts.append("Flooding has been reported on this route.")
        if r["events"]:
            parts.append("Also reported (verified): " + ", ".join(dict.fromkeys(e["headline"].split(" ", 1)[-1].lower() for e in r["events"])) + ".")
        if r["unverified_events"]:
            parts.append("An unverified community report is near this route; staff have not confirmed it.")
        r["reason"] = " ".join(parts)


def _messages(routes: list[dict], recommended: dict | None, selected: dict, alert: dict | None, g: Gathered, live: dict) -> list[dict]:
    out: list[dict] = []
    if alert:
        out.append({"kind": "error", "text": "🚧 Road blocked ahead"})
        out.append({"kind": "ok", "text": "🔵 Alternative route found"} if alert["alternative"] else {"kind": "error", "text": "No unblocked route is available right now."})
    elif recommended is None:
        out.append({"kind": "error", "text": "No unblocked route is available right now."})
    elif any(r["blocked"] for r in routes):
        out.append({"kind": "warn", "text": "🚧 A verified road closure is on one of the other routes - it is marked unavailable."})
    if recommended is not None:
        if recommended["traffic_level"] in ("Heavy", "Traffic jam"):
            out.append({"kind": "warn", "text": "⚠️ Heavy traffic detected"})
        if "HIGH_ROAD_RISK" in recommended["flags"] or recommended["damage_level"] in ("High", "Severe"):
            out.append({"kind": "warn", "text": "⚠️ High road-damage risk detected"})
        if recommended["flood_risk"] > 0:
            out.append({"kind": "warn", "text": "⚠️ Flooding reported on this route"})
        if recommended["unverified_events"]:
            out.append({"kind": "info", "text": "ℹ️ An unverified community report is near this route"})
    missing = [] if live["traffic"] else ["traffic"]
    if not live["road_condition"]:
        missing.append("road condition")
    if missing or g.notes:
        out.append({"kind": "info", "text": "ℹ️ Some live road information is unavailable (" + ", ".join(missing or ["traffic"]) + ")."})
    for note in g.notes:
        out.append({"kind": "warn", "text": note})
    return out


def _summary(recommended: dict | None, selected: dict) -> str:
    if recommended is None:
        return "No unblocked route is available right now, so RoadMind does not recommend one."
    base = f"RoadMind recommends {recommended['label']} based on currently available traffic, road-condition and verified road-event data."
    if selected["blocked"]:
        return f"{recommended['label']} avoids the verified road closure on {selected['label']}. " + base
    return base
