"""Road events, community road reports, the RoadMind overlay endpoints and the smart (Google-aware) route engine.

Google is never called: the Routes API is replaced by an httpx MockTransport that returns responses in the documented shape
(`routes[].polyline.encodedPolyline`, `duration` / `staticDuration` as "123s", `travelAdvisory.speedReadingIntervals` with the
zero start index left out as proto3 JSON does). These are test FIXTURES - they say nothing about real traffic.
"""

import json
import logging
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.database import utcnow
from app.main import create_app
from app.models import Road, RoadEvent
from app.services import events as ev_service
from app.services.routing import intelligence
from app.services.routing.google import decode_polyline
from app.services.routing.types import Candidate
from conftest import ADMIN, STAFF, STAFF_PASSWORD, USER, email_token, verify_admin
from osm_fixture import make_extract

KEY = "test-server-key-123"
JS_KEY = "test-browser-key-456"


def encode_polyline(coords):
    """Google's polyline encoding (the inverse of decode_polyline) so the mocks look like the real API."""
    out, plat, plng = [], 0, 0
    for lat, lng in coords:
        ilat, ilng = round(lat * 1e5), round(lng * 1e5)
        for d in (ilat - plat, ilng - plng):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return "".join(out)


def line(a, b, n=20):
    return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]


START, END = (13.0600, 80.2548), (13.0780, 80.2740)
ROUTE_A = line(START, END)  # the direct (fastest) route
ROUTE_B = line(START, (13.0600, 80.2740)) + line((13.0600, 80.2740), END)[1:]  # east, then north
ROUTE_C = line(START, (13.0780, 80.2548)) + line((13.0780, 80.2548), END)[1:]  # north, then east
MID_A = ROUTE_A[10]


def g_route(coords, duration_s, static_s, distance_m, speeds=()):
    """One element of Google's `routes[]`. `speeds` = [(start, end, "SLOW"), ...]; a 0 start index is left out like proto3 JSON does."""
    route = {"distanceMeters": distance_m, "duration": f"{duration_s}s", "staticDuration": f"{static_s}s", "polyline": {"encodedPolyline": encode_polyline(coords)}}
    if speeds:
        route["travelAdvisory"] = {"speedReadingIntervals": [({"startPolylinePointIndex": s} if s else {}) | {"endPolylinePointIndex": e, "speed": sp} for s, e, sp in speeds]}
    return route


class FakeGoogle:
    """What the mocked Routes API answers; tests change `.routes` / `.status` and read `.requests`."""

    def __init__(self):
        self.routes, self.status, self.requests = [], 200, []
        self.places, self.matrix, self.places_status, self.matrix_status = [], [], 200, 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        status = self.places_status if "searchNearby" in path else self.matrix_status if "computeRouteMatrix" in path else self.status
        if status != 200:
            return httpx.Response(status, json={"error": {"code": status, "status": "PERMISSION_DENIED", "message": "Routes API has not been used in project 1 before or it is disabled."}})
        if "searchNearby" in path:
            return httpx.Response(200, json={"places": self.places} if self.places else {})
        if "computeRouteMatrix" in path:
            return httpx.Response(200, json=self.matrix)
        return httpx.Response(200, json={"routes": self.routes} if self.routes else {})


def default_routes():
    """Google orders routes by travel time WITH traffic: A is still the fastest (20 min) although it is slow and jammed; B and C
    are a little longer but flow freely - and C runs along a badly damaged road."""
    n = len(ROUTE_A) - 1
    return [
        g_route(ROUTE_A, 1200, 900, 5200, [(0, 10, "SLOW"), (10, n, "TRAFFIC_JAM")]),
        g_route(ROUTE_B, 1300, 1280, 6100, [(0, len(ROUTE_B) - 1, "NORMAL")]),
        g_route(ROUTE_C, 1400, 1380, 5800, [(0, len(ROUTE_C) - 1, "NORMAL")]),
    ]


@pytest.fixture(scope="module")
def g(client, app, tmp_path_factory):  # (`client` starts the shared app, whose pre-trained risk model is reused)
    """An isolated app with the fixture street grid, a (fake) Google server key and a Google mock - plus a verified administrator."""
    tmp = tmp_path_factory.mktemp("events")
    (tmp / "grid.json").write_text(json.dumps(make_extract()), encoding="utf-8")
    settings = load_settings({
        "data_dir": tmp, "seed_demo_data": False, "google_api_key": KEY, "google_js_api_key": JS_KEY,
        "network": {"source_file": str(tmp / "grid.json"), "remote_enabled": False}, "auth": {"setup_local_only": False, "require_login_to_report": True},
    })
    settings.risk.model_path, settings.risk.metrics_path = app.state.settings.risk.model_path, app.state.settings.risk.metrics_path
    settings.geocoding.nominatim_enabled = False
    with TestClient(create_app(settings)) as c:
        verify_admin(c)
        fake = FakeGoogle()
        c.fake = fake
        c.app.state.app_state.route_engine.google_client = httpx.Client(transport=httpx.MockTransport(fake.handler))
        yield c


def default_places():
    """Places API (New) `places[]`: three hospitals; proto3 JSON leaves out what is not known (no opening hours for the second)."""
    return [
        {"id": "p1", "displayName": {"text": "City Hospital", "languageCode": "en"}, "location": {"latitude": 13.0650, "longitude": 80.2600}, "formattedAddress": "1 Test Road", "currentOpeningHours": {"openNow": True}, "nationalPhoneNumber": "044 1111 1111"},
        {"id": "p2", "displayName": {"text": "Lakeside Clinic and Hospital"}, "location": {"latitude": 13.0700, "longitude": 80.2700}, "formattedAddress": "2 Test Road"},
        {"id": "p3", "displayName": {"text": "Far Away Hospital"}, "location": {"latitude": 13.0900, "longitude": 80.2900}},
    ]


def default_matrix():
    """Route Matrix elements for the 3 hospitals: destinationIndex 0 is left out (zero value), the nearest on the map is NOT the quickest."""
    return [
        {"distanceMeters": 3900, "duration": "1020s", "condition": "ROUTE_EXISTS", "status": {}},
        {"destinationIndex": 1, "distanceMeters": 5200, "duration": "660s", "condition": "ROUTE_EXISTS", "status": {}},
        {"destinationIndex": 2, "distanceMeters": 9800, "duration": "1500s", "condition": "ROUTE_EXISTS"},
    ]


@pytest.fixture()
def fake(g):
    f = g.fake
    f.routes, f.status, f.requests = default_routes(), 200, []
    f.places, f.matrix, f.places_status, f.matrix_status = default_places(), default_matrix(), 200, 200
    from app.services import emergency  # (a cached lookup from an earlier test must not answer for this one)
    from app.services.routing import google as google_mod

    emergency.clear_cache()
    google_mod.reset_budget()
    return f


def login(c, ident, password):
    r = c.post("/api/auth/staff/login" if ident != USER["email"] else "/api/auth/login", json={"identifier": ident, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def admin(g):
    return login(g, ADMIN["email"], ADMIN["password"])


@pytest.fixture(scope="module")
def crew(g, admin):
    """A road-maintenance employee, invited and accepted like the real thing."""
    assert g.post("/api/admin/users", json=STAFF, headers=admin).status_code == 201
    ok = g.post("/api/auth/accept-invite", json={"token": email_token(g, "accept-invite"), "new_password": STAFF_PASSWORD, "confirm_password": STAFF_PASSWORD})
    assert ok.status_code == 200, ok.text
    return login(g, STAFF["email"], STAFF_PASSWORD)


@pytest.fixture(scope="module")
def citizen(g):
    assert g.post("/api/auth/register", json=USER).status_code == 201
    return login(g, USER["email"], USER["password"])


@pytest.fixture(scope="module", autouse=True)
def condition_data(g):
    """RoadMind has data for two roads: a severely damaged one along route C and a good one far away (so the neutral
    prior for roads without data is the middle, as in real use)."""
    def road(name, coords, severity):
        lats, lngs = [p[0] for p in coords], [p[1] for p in coords]
        return Road(name=name, geometry=[list(p) for p in coords], length_m=3000, min_lat=min(lats), max_lat=max(lats), min_lng=min(lngs), max_lng=max(lngs),
                    source="osm", has_data=True, current_severity=severity)
    with g.app.state.session_factory() as db:
        db.add_all([road("Damaged Test Road", ROUTE_C, 95.0), road("Good Test Road", line((13.30, 80.40), (13.31, 80.41)), 5.0)])
        db.commit()


def calc(g, origin=START, dest=END, **extra):
    r = g.post("/api/routes/calculate", json={"origin": {"lat": origin[0], "lng": origin[1], "name": "Start"}, "destination": {"lat": dest[0], "lng": dest[1], "name": "End"}, **extra})
    return r


def staff_event(g, headers, **body):
    r = g.post("/api/road-events", json={"event_type": "ROAD_BLOCKED", "lat": MID_A[0], "lng": MID_A[1], "road_name": "Test Avenue", "description": "Tree across the road", "hours": 6, **body}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture(autouse=True)
def clean_events(g):
    yield
    with g.app.state.session_factory() as db:
        db.query(RoadEvent).delete()
        db.commit()


# =============================================================== pieces
def test_decode_polyline_matches_googles_documented_example():
    pts = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    assert pts == [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]
    back = decode_polyline(encode_polyline(ROUTE_B))
    assert len(back) == len(ROUTE_B) and all(abs(a - c) < 1e-5 and abs(b - d) < 1e-5 for (a, b), (c, d) in zip(back, ROUTE_B))


def test_the_google_request_is_traffic_aware_and_the_key_stays_in_a_header(g, fake):
    assert calc(g).status_code == 200
    req = fake.requests[0]
    body = json.loads(req.content)
    assert str(req.url) == "https://routes.googleapis.com/directions/v2:computeRoutes"
    assert req.headers["x-goog-api-key"] == KEY and KEY not in str(req.url) and KEY not in req.content.decode()
    assert "routes.travelAdvisory.speedReadingIntervals" in req.headers["x-goog-fieldmask"]
    assert body["routingPreference"] == "TRAFFIC_AWARE_OPTIMAL" and body["travelMode"] == "DRIVE"
    assert body["computeAlternativeRoutes"] is True and body["extraComputations"] == ["TRAFFIC_ON_POLYLINE"]
    assert body["origin"]["location"]["latLng"] == {"latitude": START[0], "longitude": START[1]}


def test_traffic_is_read_from_googles_speed_intervals_and_the_delay():
    from app.config import RouteRiskConfig

    cfg = RouteRiskConfig()
    n = 10
    geometry = [[13.0 + i * 0.001, 80.0] for i in range(n + 1)]
    jam = Candidate(geometry, 1100, 1500, static_duration_s=900, traffic=[(0, 5, "SLOW"), (5, n, "TRAFFIC_JAM")], source="google")
    t = intelligence.assess_traffic(jam, cfg)
    assert t["level"] == "Traffic jam" and t["delay_min"] == 10.0 and t["jam_km"] > 0 and {s["speed"] for s in t["segments"]} == {"SLOW", "TRAFFIC_JAM"}
    free = Candidate(geometry, 1100, 905, static_duration_s=900, traffic=[(0, n, "NORMAL")], source="google")
    assert intelligence.assess_traffic(free, cfg)["level"] == "Normal"
    assert intelligence.assess_traffic(Candidate(geometry, 1100, 900, source="osrm"), cfg) is None  # no provider traffic -> unknown, never zero
    assert intelligence.assess_traffic(Candidate(geometry, 1100, 900, source="google"), cfg) is None


def test_missing_components_are_left_out_and_the_weights_renormalised():
    w = {"traffic": 0.30, "road_damage": 0.25, "predicted_damage": 0.15, "blockage": 0.30}
    risk, used = intelligence.combine({"traffic": 100, "road_damage": 50, "predicted_damage": 0, "blockage": 0}, w)
    assert risk == pytest.approx(42.5) and sum(used.values()) == pytest.approx(1)
    risk, used = intelligence.combine({"traffic": None, "road_damage": 50, "predicted_damage": 0, "blockage": 0}, w)  # no traffic information
    assert "traffic" not in used and risk == pytest.approx(0.25 / 0.70 * 50) and sum(used.values()) == pytest.approx(1)


# ================================================================ smart routing
def test_routes_are_scored_with_traffic_damage_and_blockage_and_the_blocked_one_is_avoided(g, admin, fake):
    staff_event(g, admin)  # a verified blockage on route A
    out = calc(g).json()
    by = {r["label"]: r for r in out["routes"]}
    a, b, c = by["Route A"], by["Route B"], by["Route C"]

    assert out["provider"] == "google" and out["traffic"] == {"available": True, "source": "google", "message": "Live traffic from Google Maps."}
    assert a["blocked"] and a["status"] == "AVOID" and a["blocked_by"][0]["event_type"] == "ROAD_BLOCKED" and a["blockage_risk"] == 100
    assert a["traffic_level"] == "Traffic jam" and a["is_fastest"] and not b["blocked"] and not c["blocked"]
    assert c["road_damage_risk"] > b["road_damage_risk"] and c["traffic_level"] == "Normal" and c["damage_level"] in ("Moderate", "High", "Severe")  # (label = severity + predicted risk; this road has no prediction yet)
    assert (b["status"], c["status"]) == ("RECOMMENDED", "ALTERNATIVE") and out["recommended"] == "Route B"

    w = out["weights"]  # the documented formula, with every component present
    assert w == {"traffic": 0.3, "road_damage": 0.25, "predicted_damage": 0.15, "blockage": 0.3}
    for r in (a, b, c):
        expect = w["traffic"] * r["traffic_risk"] + w["road_damage"] * r["road_damage_risk"] + w["predicted_damage"] * r["predicted_damage_risk"] + w["blockage"] * r["blockage_risk"]
        assert abs(r["risk"] - expect) <= 1.0, r["label"]
    assert a["risk"] > c["risk"] > b["risk"]

    assert out["selected"] == "Route A"  # what a driver would take without RoadMind
    alert = out["alert"]
    assert alert["type"] == "ROAD_BLOCKED" and alert["title"] == "🚧 ROAD BLOCKED" and alert["headline"] == "Alternative route recommended"
    assert alert["message"] == "RoadMind detected a verified road blockage on your selected route."
    assert alert["alternative"]["label"] == "Route B" and alert["alternative"]["risk"] == b["risk"] and alert["alternative"]["distance_km"] == 6.1
    assert "avoids the blocked road and has lower current road-condition risk" in alert["alternative"]["reason"]
    texts = [m["text"] for m in out["messages"]]
    assert "🚧 Road blocked ahead" in texts and "✅ Lower-risk alternative found" in texts and "✅ Route selected because it avoids the reported blockage." in texts
    assert "guarantee" in out["disclaimer"]
    assert out["query_id"]  # the comparison was stored with the others


def test_without_a_blockage_the_fastest_route_is_not_blindly_recommended(g, fake):
    out = calc(g).json()
    by = {r["label"]: r for r in out["routes"]}
    assert out["alert"] is None and not any(r["blocked"] for r in out["routes"])
    assert by["Route A"]["is_fastest"] and out["recommended"] == "Route B"  # the fastest route is jammed: a freer one has the lower risk
    assert by["Route A"]["traffic_level"] == "Traffic jam" and by["Route A"]["risk"] > by["Route B"]["risk"] and by["Route A"]["status"] == "ALTERNATIVE"
    assert "⚠️ Heavy traffic detected" not in [m["text"] for m in out["messages"]]  # the recommended route's traffic is normal


def test_an_unverified_report_only_nudges_a_route_until_staff_verify_it(g, admin, citizen, fake):
    r = g.post("/api/road-reports", data={"report_type": "BLOCKED_ROAD", "lat": MID_A[0], "lng": MID_A[1], "road_name": "Test Avenue", "description": "Looks blocked"}, headers=citizen)
    assert r.status_code == 201 and r.json()["kind"] == "event" and r.json()["event"]["verification_status"] == "PENDING"
    eid = r.json()["event"]["id"]
    a = next(x for x in calc(g).json()["routes"] if x["label"] == "Route A")
    assert not a["blocked"] and a["unverified_events"] and a["blockage_risk"] == 35  # a nudge, not a verdict
    assert g.patch(f"/api/road-events/{eid}/verify", json={"approved": True, "hours": 4}, headers=admin).json()["is_blocking"] is True
    out = calc(g).json()
    assert next(x for x in out["routes"] if x["label"] == "Route A")["blocked"] and out["alert"]["blocked_route"] == "Route A"


def test_a_resolved_expired_or_rejected_event_stops_blocking(g, admin, fake):
    ev = staff_event(g, admin)
    assert next(x for x in calc(g).json()["routes"] if x["label"] == "Route A")["blocked"]
    assert g.patch(f"/api/road-events/{ev['id']}/resolve", json={"note": "Cleared"}, headers=admin).json()["display_status"] == "RESOLVED"
    assert not any(r["blocked"] for r in calc(g).json()["routes"])

    ev = staff_event(g, admin)  # expiry: nothing is blocked for ever
    with g.app.state.session_factory() as db:
        db.get(RoadEvent, ev["id"]).expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
    assert not any(r["blocked"] for r in calc(g).json()["routes"])
    assert g.get("/api/road-events/active").json()["count"] == 0
    with g.app.state.session_factory() as db:
        assert db.get(RoadEvent, ev["id"]).status == "EXPIRED"  # persisted by the housekeeping on the call above

    pending = g.post("/api/road-events", json={"event_type": "ACCIDENT", "lat": MID_A[0], "lng": MID_A[1], "hours": 3}, headers=admin).json()
    assert g.patch(f"/api/road-events/{pending['id']}/verify", json={"approved": False, "note": "False report"}, headers=admin).json()["display_status"] == "REJECTED"
    assert g.get("/api/road-events/active").json()["count"] == 0


def test_when_every_route_is_blocked_the_least_risky_is_still_recommended_with_a_warning(g, admin, fake):
    for pt in (ROUTE_A[10], ROUTE_B[8], ROUTE_C[8]):
        staff_event(g, admin, lat=pt[0], lng=pt[1])
    out = calc(g).json()
    assert all(r["blocked"] for r in out["routes"])
    rec = next(r for r in out["routes"] if r["status"] == "RECOMMENDED")
    assert rec["risk"] == min(r["risk"] for r in out["routes"]) and out["alert"]["headline"] == "No unblocked route available" and out["alert"]["alternative"] is None
    assert "Every route has a verified blockage" in out["summary"]


def test_other_verified_events_raise_the_risk_without_forbidding_the_route(g, admin, fake):
    staff_event(g, admin, event_type="CONSTRUCTION", road_name="Works Road")
    a = next(x for x in calc(g).json()["routes"] if x["label"] == "Route A")
    assert not a["blocked"] and a["blockage_risk"] == 60 and a["events"][0]["event_type"] == "CONSTRUCTION"


def test_no_google_key_means_no_traffic_and_the_answer_says_so(g, admin, fake, monkeypatch):
    monkeypatch.setattr(g.app.state.settings, "google_api_key", "")
    out = calc(g, origin=(13.0600, 80.2548), dest=(13.0780, 80.2740)).json()  # RoadMind's own OpenStreetMap routing on the grid
    assert out["provider"] in ("network", "osrm") and out["traffic"]["available"] is False and "unavailable" in out["traffic"]["message"]
    assert fake.requests == [] and all(r["traffic_risk"] is None and r["traffic_level"] == "Unknown" and not r["traffic_segments"] for r in out["routes"])
    assert "traffic" not in out["routes"][0]["risk_weights"]  # left out of the score, not invented
    assert any("traffic" in m["text"].lower() for m in out["messages"])


def test_a_failing_google_falls_back_with_a_clear_message_and_never_fake_traffic(g, fake, caplog):
    fake.status = 403
    with caplog.at_level(logging.WARNING, logger="roadmind"):
        out = calc(g).json()
    assert out["traffic"]["available"] is False and out["traffic"]["message"] == "Live traffic temporarily unavailable."
    assert all(r["traffic_risk"] is None for r in out["routes"]) and any("temporarily unavailable" in m["text"] for m in out["messages"])
    assert "Routes API has not been used" in caplog.text and KEY not in caplog.text  # the real reason is logged - without the key


def test_when_no_route_can_be_calculated_the_user_gets_the_plain_message(g, fake, monkeypatch):
    fake.status = 403
    monkeypatch.setattr(g.app.state.settings.routing, "provider", "network")
    r = calc(g, origin=(40.0, -100.0), dest=(40.01, -100.01))  # nowhere near the street grid, and Google is down
    assert r.status_code in (422, 503)
    if r.status_code == 503:
        assert r.json()["detail"].startswith("Unable to calculate routes right now.")


def test_the_hourly_google_budget_stops_the_calls_and_the_app_falls_back(g, fake, monkeypatch, caplog):
    """Public endpoints + a billed API: past `google.max_requests_per_hour` RoadMind stops calling Google instead of running up a bill."""
    monkeypatch.setattr(g.app.state.settings.google, "max_requests_per_hour", 2)
    first = calc(g, origin=START, dest=END).json()
    second = calc(g, origin=START, dest=END).json()
    assert first["provider"] == "google" and second["provider"] == "google"
    with caplog.at_level(logging.WARNING, logger="roadmind"):
        third = calc(g, origin=START, dest=END).json()  # the budget (2 calls) is used up
    assert third["provider"] != "google" and third["traffic"]["message"] == "Live traffic temporarily unavailable." and len(fake.requests) == 2
    assert "budget used up" in caplog.text
    from app.services.routing import google as google_mod

    google_mod.reset_budget()  # the window clearing restores Google
    assert calc(g, origin=START, dest=END).json()["provider"] == "google"


def test_google_without_any_route_is_a_422_not_a_made_up_answer(g, fake):
    fake.routes = []
    r = calc(g)
    assert r.status_code == 422 and "no drivable route" in r.json()["detail"].lower()


# ===================================================================== events
def test_staff_events_are_verified_and_community_reports_are_pending(g, admin, crew, citizen):
    s = staff_event(g, admin, event_type="ROAD_CLOSED", hours=3)
    assert s["verification_status"] == "VERIFIED" and s["is_blocking"] and s["headline"] == "⛔ ROAD CLOSED" and s["reported_by"]["kind"] == "staff"
    assert s["reported_by"]["name"] == ADMIN["full_name"]  # staff see who

    c = g.post("/api/road-reports", data={"report_type": "FLOODING", "lat": 13.07, "lng": 80.265, "description": "Knee-deep water"}, headers=citizen).json()["event"]
    assert c["verification_status"] == "PENDING" and c["event_type"] == "FLOODED" and not c["is_blocking"] and c["reported_by"] == {"kind": "community"}
    public = g.get("/api/road-events/active").json()
    assert {i["id"] for i in public["items"]} == {s["id"], c["id"]} and public["blocked_count"] == 1
    assert all("name" not in i["reported_by"] and "review_note" not in i for i in public["items"])  # no personal data in the public list
    assert g.get("/api/road-events/active", params={"verified_only": True}).json()["count"] == 1
    box = g.get("/api/road-events/active", params={"south": 13.0, "west": 80.0, "north": 13.1, "east": 80.3}).json()
    far = g.get("/api/road-events/active", params={"south": 20.0, "west": 20.0, "north": 21.0, "east": 21.0}).json()
    assert box["count"] == 2 and far["count"] == 0

    assert g.patch(f"/api/road-events/{c['id']}/verify", json={"approved": True}, headers=crew).json()["verified"] is True  # maintenance staff may verify too
    mine = g.get("/api/road-reports/mine", headers=citizen).json()["items"]
    assert [m["id"] for m in mine] == [c["id"]] and mine[0]["display_status"] == "ACTIVE"


def test_a_long_blocked_stretch_is_returned_while_any_part_of_it_is_in_view(g, admin):
    """The map asks for a box; an event is in it when its stretch (not only its middle point) overlaps - or its radius reaches in."""
    stretch = [[13.060, 80.250], [13.070, 80.250], [13.080, 80.250]]  # 2.2 km north-south; the stored point is the middle one
    ev = g.post("/api/road-events", json={"event_type": "ROAD_CLOSED", "lat": 13.070, "lng": 80.250, "geometry": stretch, "hours": 3}, headers=admin).json()
    near_the_north_end = {"south": 13.077, "west": 80.24, "north": 13.09, "east": 80.26}  # the middle (13.070) is outside this box
    assert [e["id"] for e in g.get("/api/road-events/active", params=near_the_north_end).json()["items"]] == [ev["id"]]
    elsewhere = {"south": 13.09, "west": 80.24, "north": 13.1, "east": 80.26}
    assert g.get("/api/road-events/active", params=elsewhere).json()["count"] == 0
    point = staff_event(g, admin, lat=13.2, lng=80.3, radius_m=200)  # a point event: its 200 m radius reaches a box that ends 100 m away
    beside = {"south": 13.1, "west": 80.3014, "north": 13.3, "east": 80.31}
    assert [e["id"] for e in g.get("/api/road-events/active", params=beside).json()["items"]] == [point["id"]]


def test_an_event_does_not_take_the_name_of_an_unnamed_road(g, admin, citizen):
    geometry = [[13.50, 80.50], [13.50, 80.5005]]
    with g.app.state.session_factory() as db:
        road = Road(name="Unnamed residential road", geometry=geometry, length_m=55, min_lat=13.50, max_lat=13.50, min_lng=80.50, max_lng=80.5005, source="osm")
        db.add(road)
        db.commit()
        road_id = road.id
    ev = g.post("/api/road-reports", data={"report_type": "BLOCKED_ROAD", "lat": 13.50, "lng": 80.50025}, headers=citizen).json()["event"]
    assert ev["road_name"] == "" and ev["road_id"] == road_id  # linked to the road, but no meaningless name
    named = g.post("/api/road-reports", data={"report_type": "BLOCKED_ROAD", "lat": 13.50, "lng": 80.50025, "road_name": "Mill Lane"}, headers=citizen).json()["event"]
    assert named["road_name"] == "Mill Lane"


def test_only_staff_can_manage_events(g, citizen, admin):
    ev = staff_event(g, admin)
    body = {"event_type": "ROAD_BLOCKED", "lat": 13.07, "lng": 80.26}
    for call in (
        lambda h: g.post("/api/road-events", json=body, headers=h), lambda h: g.get("/api/road-events", headers=h),
        lambda h: g.patch(f"/api/road-events/{ev['id']}/verify", json={"approved": True}, headers=h), lambda h: g.patch(f"/api/road-events/{ev['id']}/resolve", json={}, headers=h),
        lambda h: g.patch(f"/api/road-events/{ev['id']}", json={"description": "x"}, headers=h), lambda h: g.get("/api/road-reports", headers=h),
    ):
        assert call({}).status_code == 401
        assert call(citizen).status_code == 403
    assert g.get("/api/road-events", headers=admin).status_code == 200


def test_reopening_resolves_the_blockages_around_it(g, admin):
    blocked = staff_event(g, admin)
    far = staff_event(g, admin, lat=13.09, lng=80.29)
    r = g.post("/api/road-events", json={"event_type": "ROAD_REOPENED", "lat": MID_A[0], "lng": MID_A[1], "description": "Road reopened"}, headers=admin)
    assert r.status_code == 201 and r.json()["display_status"] == "RESOLVED" and r.json()["is_blocking"] is False
    listed = {e["id"]: e for e in g.get("/api/road-events", headers=admin).json()["items"]}
    assert listed[blocked["id"]]["display_status"] == "RESOLVED" and listed[far["id"]]["display_status"] == "ACTIVE"


def test_events_can_be_updated_and_extended_and_always_expire(g, admin):
    ev = staff_event(g, admin, event_type="CONSTRUCTION", hours=2)
    up = g.patch(f"/api/road-events/{ev['id']}", json={"description": "Resurfacing until evening", "hours": 10, "radius_m": 120}, headers=admin).json()
    assert up["description"] == "Resurfacing until evening" and up["radius_m"] == 120
    assert (utcnow() + timedelta(hours=9)).isoformat() < up["expires_at"] < (utcnow() + timedelta(hours=11)).isoformat()
    forever = g.post("/api/road-events", json={"event_type": "ROAD_BLOCKED", "lat": 13.07, "lng": 80.26, "hours": 24 * 30}, headers=admin).json()
    assert forever["expires_at"] < (utcnow() + timedelta(days=31)).isoformat()  # the maximum is bounded: nothing is blocked for ever
    assert g.post("/api/road-events", json={"event_type": "ROAD_BLOCKED", "lat": 13.07, "lng": 80.26, "hours": 24 * 400}, headers=admin).status_code == 422


def test_unverified_reports_stop_counting_after_the_pending_window(g, citizen):
    ev = g.post("/api/road-reports", data={"report_type": "ACCIDENT", "lat": 13.07, "lng": 80.26}, headers=citizen).json()["event"]
    assert g.get("/api/road-events/active").json()["count"] == 1
    with g.app.state.session_factory() as db:
        db.get(RoadEvent, ev["id"]).created_at = utcnow() - timedelta(hours=g.app.state.settings.events.pending_hours + 1)
        db.commit()
    assert g.get("/api/road-events/active").json()["count"] == 0  # still PENDING and unverified for too long
    with g.app.state.session_factory() as db:
        assert db.get(RoadEvent, ev["id"]).status == "EXPIRED"  # and the review queue no longer carries it as a live report
    # staff can still confirm a late report: it becomes current again
    admin = login(g, ADMIN["email"], ADMIN["password"])
    revived = g.patch(f"/api/road-events/{ev['id']}/verify", json={"approved": True, "hours": 2}, headers=admin).json()
    assert revived["display_status"] == "ACTIVE" and revived["verified"] and g.get("/api/road-events/active").json()["count"] == 1


def test_event_evidence_photos_are_validated_and_stored(g, admin, sample_image):
    ev = staff_event(g, admin)
    ok = g.post(f"/api/road-events/{ev['id']}/evidence", files={"image": ("tree.jpg", sample_image, "image/jpeg")}, headers=admin)
    assert ok.status_code == 200 and ok.json()["evidence_url"].startswith("/media/events/")
    assert g.get(ok.json()["evidence_url"]).status_code == 200
    assert g.post(f"/api/road-events/{ev['id']}/evidence", files={"image": ("x.jpg", b"not an image", "image/jpeg")}, headers=admin).status_code == 415


# =========================================================== community road reports
def test_road_reports_cover_every_kind_of_problem(g, citizen, sample_image):
    def post(kind, **kw):
        return g.post("/api/road-reports", data={"report_type": kind, "lat": 13.07, "lng": 80.265, "road_name": "Cross Street 1", **kw.pop("data", {})}, headers=citizen, **kw)

    pothole = post("POTHOLE", files={"image": ("p.jpg", sample_image, "image/jpeg")})
    assert pothole.status_code == 201 and pothole.json()["kind"] == "damage"  # through the AI damage detector -> condition, risk, priority
    assert pothole.json()["damage"]["detection"]["count"] >= 1 and pothole.json()["damage"]["road"]["has_data"]
    assert post("POTHOLE").status_code == 422 and post("CRACK").status_code == 422  # these need a photo for the AI

    expected = {"BLOCKED_ROAD": "ROAD_BLOCKED", "FLOODING": "FLOODED", "ACCIDENT": "ACCIDENT", "CONSTRUCTION": "CONSTRUCTION", "DANGEROUS_CONDITION": "SEVERE_DAMAGE"}
    for kind, event_type in expected.items():
        r = post(kind, data={"description": f"{kind} here"})
        assert r.status_code == 201, (kind, r.text)
        ev = r.json()["event"]
        assert ev["event_type"] == event_type and ev["verification_status"] == "PENDING" and ev["description"] == f"{kind} here" and (ev["lat"], ev["lng"]) == (13.07, 80.265)
        assert ev["created_at"] and ev["road_name"]
    with_photo = post("BLOCKED_ROAD", files={"image": ("b.jpg", sample_image, "image/jpeg")}).json()["event"]
    assert with_photo["evidence_url"]  # a photo of a blockage is kept as evidence, not run through the pothole detector
    danger = post("DANGEROUS_CONDITION", files={"image": ("d.jpg", sample_image, "image/jpeg")}).json()
    assert danger["kind"] == "damage" and danger["event"]["event_type"] == "SEVERE_DAMAGE"  # analysed AND flagged for staff
    assert g.post("/api/road-reports", data={"report_type": "NONSENSE", "lat": 1, "lng": 1}, headers=citizen).status_code == 422


def test_guests_cannot_store_road_reports_while_login_is_required(g):
    r = g.post("/api/road-reports", data={"report_type": "BLOCKED_ROAD", "lat": 13.07, "lng": 80.265})
    assert r.status_code == 401


# ================================================================ overlay endpoints
def test_road_conditions_are_an_overlay_and_an_empty_answer_is_normal(g, app, tmp_path):
    faraway = g.get("/api/road-conditions", params={"south": 50, "west": 50, "north": 51, "east": 51}).json()
    assert faraway["items"] == [] and faraway["count"] == 0 and faraway["message"] == "No RoadMind condition data available in this area."
    box = {"south": 13.04, "west": 80.24, "north": 13.09, "east": 80.29}
    data = g.get("/api/road-conditions", params=box).json()
    names = [i["road_name"] for i in data["items"]]
    assert data["count"] >= 1 and data["message"] is None and "Damaged Test Road" in names and "Good Test Road" not in names  # only what is in view
    assert data["total_with_data"] >= 2 and all(i["state"] != "UNKNOWN" for i in data["items"])  # only roads that HAVE data - never the whole network
    with g.app.state.session_factory() as db:
        assert data["total_with_data"] < db.query(Road).count()  # the street grid's other roads are NOT in the overlay
    item = next(i for i in data["items"] if i["road_name"] == "Damaged Test Road")
    assert item["state"] in ("HIGH_RISK", "CRITICAL") and item["severity"] == 95 and len(item["geometry"]) > 2
    for key in ("pothole_count", "crack_count", "report_count", "last_report_at", "ai_confidence", "risk_percent", "maintenance_status", "lat", "lng"):
        assert key in item
    assert "Good Test Road" in [i["road_name"] for i in g.get("/api/road-conditions").json()["items"]]  # no box: everything RoadMind knows
    assert g.get("/api/road-conditions", params={"south": 95, "west": 0, "north": 96, "east": 1}).status_code == 422


def test_an_empty_database_still_gives_a_complete_answer(app, tmp_path):
    """Zero RoadMind roads must never be an error or a reason to hide the map."""
    settings = load_settings({"data_dir": tmp_path, "seed_demo_data": False, "network": {"source_file": str(tmp_path / "none.json"), "remote_enabled": False}})
    settings.risk.model_path, settings.risk.metrics_path = app.state.settings.risk.model_path, app.state.settings.risk.metrics_path
    with TestClient(create_app(settings)) as c:
        r = c.get("/api/road-conditions", params={"south": 13, "west": 80, "north": 14, "east": 81})
        assert r.status_code == 200 and r.json()["items"] == [] and r.json()["message"]
        assert c.get("/api/road-events/active").json()["count"] == 0
        cfg = c.get("/api/map/config").json()
        assert cfg["default_center"] and cfg["tiles"]["url"] and cfg["google"] == {"js_api_key": None, "routes_enabled": False}
        assert c.get("/api/traffic").json()["message"] == "Live traffic unavailable: Google Maps is not set up."


def test_the_default_view_is_the_main_area_not_the_midpoint_of_every_import(g):
    """Someone loads a second area far away: the map must still open on the main one (the midpoint of both would be empty ground)."""
    from app.models import NetworkArea

    main = g.get("/api/map/config").json()["default_center"]
    assert 13.0 < main["lat"] < 13.1 and 80.2 < main["lng"] < 80.3
    with g.app.state.session_factory() as db:
        db.add(NetworkArea(south=54.646, west=-2.778, north=54.650, east=-2.762, segments=1, source="overpass"))
        db.commit()
    try:
        assert g.get("/api/map/config").json()["default_center"] == main
        info = g.get("/api/network/info").json()
        assert info["bounds"][0] < 14 and info["all_bounds"][2] > 54  # the main area for the first view, every area in all_bounds
    finally:
        with g.app.state.session_factory() as db:
            db.query(NetworkArea).filter(NetworkArea.source == "overpass").delete()
            db.commit()


def test_the_map_config_hands_out_only_the_browser_key(g):
    cfg = g.get("/api/map/config").json()
    assert cfg["google"] == {"js_api_key": JS_KEY, "routes_enabled": True}
    assert KEY not in json.dumps(cfg) and KEY not in g.get("/api/traffic").text  # the server key never leaves the server
    assert cfg["traffic"]["layer_available"] is True and cfg["traffic"]["routing_available"] is True and cfg["refresh_seconds"] == 60


def test_google_keys_come_from_the_environment_and_the_dotenv_file(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("GOOGLE_MAPS_API_KEY=from-dotenv-server\nGOOGLE_MAPS_MAPS_JS_API_KEY=from-dotenv-browser\n", encoding="utf-8")
    monkeypatch.setenv("ROADMIND_ENV_FILE", str(env))
    s = load_settings({"data_dir": tmp_path / "d1"})
    assert (s.google_api_key, s.google_js_api_key) == ("from-dotenv-server", "from-dotenv-browser")
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "from-env")
    monkeypatch.setenv("GOOGLE_MAPS_JS_API_KEY", "js-from-env")
    s = load_settings({"data_dir": tmp_path / "d2"})
    assert (s.google_api_key, s.google_js_api_key) == ("from-env", "js-from-env")  # real environment beats the file
    assert not hasattr(s.google, "api_key") and "from-env" not in json.dumps(s.google.__dict__)  # never part of the plain config


def test_events_module_helpers():
    from app.config import EventsConfig, RouteRiskConfig

    assert set(EventsConfig().default_hours) >= {"ROAD_BLOCKED", "CONSTRUCTION", "FLOODED"} and RouteRiskConfig().hard_block_types == ["ROAD_BLOCKED", "ROAD_CLOSED", "TEMPORARY_CLOSURE"]
    assert ev_service.REPORT_TO_EVENT["BLOCKED_ROAD"] == "ROAD_BLOCKED" and "POTHOLE" not in ev_service.REPORT_TO_EVENT


# =============================================================== Emergency Route Mode
PART = {"travel_time": "travel_time_score", "traffic": "traffic_risk", "road_damage": "road_damage_risk", "flood": "flood_risk", "other": "other_risk"}


def emergency(g, origin=START, dest=END, **extra):
    return g.post("/api/emergency/route", json={"origin": {"lat": origin[0], "lng": origin[1], "name": "My location"}, "destination": {"lat": dest[0], "lng": dest[1], "name": "City Hospital"}, "destination_kind": "hospital", **extra})


def nearby(g, kind="hospital", lat=START[0], lng=START[1], **params):
    return g.get("/api/emergency/nearby", params={"kind": kind, "lat": lat, "lng": lng, **params})


def test_nearby_hospitals_come_from_google_places_with_real_travel_times(g, fake):
    r = nearby(g)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["source"] == "google" and out["kind"] == "hospital" and out["eta_traffic_aware"] is True
    request = next(q for q in fake.requests if "searchNearby" in q.url.path)
    body = json.loads(request.content)
    assert body["includedTypes"] == ["hospital"] and body["rankPreference"] == "DISTANCE" and body["locationRestriction"]["circle"]["radius"] == 15000.0
    assert request.headers["x-goog-api-key"] == KEY and "places.currentOpeningHours.openNow" in request.headers["x-goog-fieldmask"] and KEY not in request.content.decode()

    # ordered by real travel time with traffic (11 < 17 < 25 min), although City Hospital is the nearest on the map
    assert [i["name"] for i in out["items"]] == ["Lakeside Clinic and Hospital", "City Hospital", "Far Away Hospital"]
    lake, city, far = out["items"]
    assert (lake["eta_min"], city["eta_min"], far["eta_min"]) == (11, 17, 25) and city["route_distance_km"] == 3.9 and all(i["eta_traffic_aware"] for i in out["items"])
    assert city["open_now"] is True and city["phone"] and city["address"] and city["distance_km"] > 0
    assert lake["open_now"] is None and lake["opening_hours"] is None and lake["has_emergency"] is None  # availability is only passed on when stated
    matrix = json.loads(next(q for q in fake.requests if "computeRouteMatrix" in q.url.path).content)
    assert matrix["routingPreference"] == "TRAFFIC_AWARE" and len(matrix["destinations"]) == 3 and len(matrix["origins"]) == 1  # ONE request for all of them

    seen = len(fake.requests)
    assert nearby(g).json()["items"] == out["items"] and len(fake.requests) == seen  # cached: Google is not asked again


def test_a_failing_google_falls_back_to_openstreetmap_places_and_roadmind_travel_times(g, fake):
    fake.places_status = fake.matrix_status = 403
    out = nearby(g, lat=13.0735, lng=80.2645).json()  # inside the street grid, which has two stored hospitals
    assert out["source"] == "openstreetmap" and any("temporarily unavailable" in n for n in out["notes"])
    assert {"Test General Hospital", "West Clinic Hospital"} <= {i["name"] for i in out["items"]}
    assert all(i["eta_traffic_aware"] is False for i in out["items"]) and any(i["eta_min"] for i in out["items"])  # RoadMind's own routing: no live traffic, and labelled so
    assert out["eta_traffic_aware"] is False


def test_without_google_only_real_openstreetmap_places_are_listed_and_nothing_is_invented(g, fake, monkeypatch):
    monkeypatch.setattr(g.app.state.settings, "google_api_key", "")
    ok = nearby(g, lat=13.0735, lng=80.2645)
    assert ok.status_code == 200 and ok.json()["source"] == "openstreetmap" and fake.requests == []
    far = nearby(g, lat=13.0735, lng=80.2645, radius_km=0.1).json()  # nothing within 100 m
    assert far["items"] == [] and "No hospitals were found" in far["message"]
    r = nearby(g, kind="fire_station", lat=13.0735, lng=80.2645)  # no stored fire stations and no remote lookup: honest 503, not a made-up list
    assert r.status_code == 503 and r.json()["detail"] == "Unable to find nearby fire stations right now."


def test_nearby_validates_its_input(g, fake):
    assert nearby(g, kind="pharmacy").status_code == 422
    assert nearby(g, lat=95).status_code == 422 and nearby(g, limit=0).status_code == 422
    assert g.get("/api/emergency/nearby", params={"kind": "police"}).status_code == 422  # a position is required: it is never assumed


def test_a_verified_closure_makes_a_route_unavailable_and_an_alternative_is_found(g, admin, fake):
    staff_event(g, admin)  # a verified ROAD_BLOCKED on route A, the fastest
    out = emergency(g).json()
    by = {r["label"]: r for r in out["routes"]}
    a, b, c = by["Route A"], by["Route B"], by["Route C"]

    assert out["mode"] == "emergency" and out["provider"] == "google" and out["selected"] == "Route A" and out["recommended"] == "Route B"
    assert (a["status"], b["status"], c["status"]) == ("UNAVAILABLE", "RECOMMENDED", "ALTERNATIVE")
    assert a["blocked"] and a["available"] is False and a["emergency_score"] is None and "VERIFIED_CLOSURE" in a["flags"]  # a hard rule: not scored, never recommended
    assert b["available"] and b["emergency_score"] is not None and b["traffic_level"] == "Normal" and "HIGH_ROAD_RISK" not in b["flags"]

    w = out["weights"]  # the configurable Emergency Route Score; every part is present here
    assert w == {"travel_time": 0.45, "traffic": 0.2, "road_damage": 0.15, "flood": 0.1, "other": 0.1}
    for r in (b, c):
        expect = sum(r["score_weights"][k] * r[PART[k]] for k in w)
        assert abs(r["emergency_score"] - expect) <= 1.0 and abs(sum(r["score_weights"].values()) - 1) < 0.01, r["label"]
    assert b["emergency_score"] < c["emergency_score"] and b["risk"] < c["risk"]  # RoadMind risk (without travel time) is shown to the user too

    alert = out["alert"]
    assert alert["title"] == "🚧 ROAD BLOCKED" and alert["message"] == "A verified road closure was detected on your current route." and alert["headline"] == "Alternative route found"
    alt = alert["alternative"]
    assert alt["label"] == "Route B" and alt["extra_km"] == 0.9 and alt["extra_min"] == 2 and alt["delta_text"] == "+0.9 km, +2 min"
    assert alt["reason"] == "This route avoids a verified road closure and has lower available road-condition risk."
    texts = [m["text"] for m in out["messages"]]
    assert "🚧 Road blocked ahead" in texts and "🔵 Alternative route found" in texts
    assert "does not guarantee" in out["disclaimer"] and "based on currently available traffic, road-condition and verified road-event data" in out["disclaimer"]
    assert out["recheck"] == {"status_interval_s": 60, "reroute_interval_s": 180} and out["query_id"]


def test_turn_by_turn_steps_are_requested_only_for_emergency_routes_and_only_google_provides_them(g, fake, monkeypatch):
    ll = lambda p: {"latLng": {"latitude": p[0], "longitude": p[1]}}  # noqa: E731
    steps = [  # proto3 JSON: a zero distance is left out, the first start has no extra fields
        {"navigationInstruction": {"maneuver": "DEPART", "instructions": "Head north on Row Lane"}, "distanceMeters": 800, "staticDuration": "90s", "startLocation": ll(ROUTE_A[0]), "endLocation": ll(ROUTE_A[8])},
        {"navigationInstruction": {"maneuver": "TURN_LEFT", "instructions": "Turn left onto Central Avenue"}, "distanceMeters": 1500, "staticDuration": "180s", "startLocation": ll(ROUTE_A[8]), "endLocation": ll(ROUTE_A[20])},
        {"navigationInstruction": {"instructions": "Destination will be on the right"}, "startLocation": ll(ROUTE_A[20]), "endLocation": ll(ROUTE_A[20])},
    ]
    fake.routes[0]["legs"] = [{"steps": steps}]

    out = emergency(g).json()
    mask = fake.requests[-1].headers["x-goog-fieldmask"]
    assert "routes.legs.steps.navigationInstruction" in mask and "routes.legs.steps.startLocation" in mask
    first = next(r for r in out["routes"] if r["label"] == "Route A")
    assert first["steps_available"] is True and [s["index"] for s in first["steps"]] == [0, 1, 2]
    assert first["steps"][0] == {"index": 0, "instruction": "Head north on Row Lane", "maneuver": "DEPART", "distance_m": 800.0, "duration_s": 90.0, "start": {"lat": ROUTE_A[0][0], "lng": ROUTE_A[0][1]}, "end": {"lat": ROUTE_A[8][0], "lng": ROUTE_A[8][1]}}
    assert first["steps"][1]["maneuver"] == "TURN_LEFT" and first["steps"][2]["maneuver"] is None and first["steps"][2]["distance_m"] == 0.0
    other = next(r for r in out["routes"] if r["label"] == "Route B")
    assert other["steps_available"] is False and other["steps"] == []  # Google sent no steps for it: nothing is made up

    calc(g)  # the normal route planner never asks for steps (smaller, cheaper response)
    assert "legs.steps" not in fake.requests[-1].headers["x-goog-fieldmask"]

    monkeypatch.setattr(g.app.state.settings, "google_api_key", "")
    offline = emergency(g).json()
    assert all(r["steps_available"] is False and r["steps"] == [] for r in offline["routes"])


def test_the_shortest_route_does_not_automatically_win(g, fake):
    out = emergency(g).json()  # nothing is closed: A is the fastest (20 min) but jammed; B costs 2 minutes more and flows freely
    by = {r["label"]: r for r in out["routes"]}
    assert by["Route A"]["is_fastest"] and by["Route A"]["traffic_level"] == "Traffic jam" and out["alert"] is None
    assert out["recommended"] == "Route B" and by["Route A"]["status"] == "ALTERNATIVE" and by["Route A"]["emergency_score"] > by["Route B"]["emergency_score"]
    assert "Best balance of travel time" in by["Route B"]["reason"]


def test_the_weights_are_configurable(g, fake, monkeypatch):
    monkeypatch.setattr(g.app.state.settings.emergency, "weights", {"travel_time": 1.0, "traffic": 0, "road_damage": 0, "flood": 0, "other": 0})
    out = emergency(g).json()
    assert out["recommended"] == "Route A" and out["weights"]["travel_time"] == 1.0  # only speed counts: the fastest route wins


def test_when_every_route_is_closed_nothing_is_recommended(g, admin, fake):
    for pt in (ROUTE_A[10], ROUTE_B[8], ROUTE_C[8]):
        staff_event(g, admin, lat=pt[0], lng=pt[1])
    out = emergency(g).json()
    assert out["recommended"] is None and all(r["status"] == "UNAVAILABLE" and r["emergency_score"] is None for r in out["routes"])
    assert out["alert"]["headline"] == "No unblocked route available" and out["alert"]["alternative"] is None
    assert "No unblocked route is available right now." in [m["text"] for m in out["messages"]] and "does not recommend" in out["summary"]


def test_only_verified_closures_exclude_a_route(g, admin, citizen, fake):
    assert g.post("/api/road-reports", data={"report_type": "BLOCKED_ROAD", "lat": MID_A[0], "lng": MID_A[1]}, headers=citizen).status_code == 201  # unverified
    a = next(r for r in emergency(g).json()["routes"] if r["label"] == "Route A")
    assert a["available"] and not a["blocked"] and "UNVERIFIED_REPORT" in a["flags"] and a["unverified_events"]  # noted, not excluded
    ev = g.get("/api/road-reports", headers=admin).json()["items"][0]
    assert g.patch(f"/api/road-events/{ev['id']}/verify", json={"approved": True}, headers=admin).status_code == 200
    assert next(r for r in emergency(g).json()["routes"] if r["label"] == "Route A")["status"] == "UNAVAILABLE"  # once staff verify it, it is a hard exclusion


def test_flooding_and_other_events_raise_the_matching_score_parts(g, admin, citizen, fake):
    staff_event(g, admin, event_type="FLOODED", road_name="Low Road")
    staff_event(g, admin, event_type="CONSTRUCTION", lat=ROUTE_B[8][0], lng=ROUTE_B[8][1])
    by = {r["label"]: r for r in emergency(g).json()["routes"]}
    assert by["Route A"]["flood_risk"] == 85 and "FLOODING_REPORTED" in by["Route A"]["flags"] and by["Route A"]["available"]
    assert by["Route B"]["other_risk"] == 60 and "VERIFIED_EVENT" in by["Route B"]["flags"] and by["Route B"]["flood_risk"] == 0
    assert "Flooding has been reported" in by["Route A"]["reason"]


def test_the_alternative_is_measured_against_the_route_the_person_is_on(g, admin, fake):
    staff_event(g, admin)
    alt = emergency(g, current={"distance_km": 5.0, "duration_min": 18.0, "label": "Route A"}).json()["alert"]["alternative"]
    assert alt["extra_km"] == 1.1 and alt["extra_min"] == 4 and alt["delta_text"] == "+1.1 km, +4 min"


def test_without_google_the_answer_says_which_live_information_is_missing(g, fake, monkeypatch):
    monkeypatch.setattr(g.app.state.settings, "google_api_key", "")
    out = emergency(g).json()  # RoadMind's own routing on the street grid: no live traffic
    assert out["traffic"]["available"] is False and out["live_data"]["traffic"] is False and fake.requests == []
    assert all(r["traffic_risk"] is None and "traffic" not in r["score_weights"] for r in out["routes"])  # left out of the score - not invented
    assert any("Some live road information is unavailable" in m["text"] and "traffic" in m["text"] for m in out["messages"])


def test_route_failures_have_plain_messages(g, fake, monkeypatch):
    fake.routes = []
    r = emergency(g)
    assert r.status_code == 422 and "no drivable route" in r.json()["detail"].lower()
    fake.status = 403
    monkeypatch.setattr(g.app.state.settings.routing, "provider", "network")
    r = emergency(g, origin=(40.0, -100.0), dest=(40.01, -100.01))  # Google is down AND the point is outside RoadMind's network
    assert r.status_code in (422, 503)
    if r.status_code == 503:
        assert r.json()["detail"].startswith("Unable to calculate the route right now.")


def test_an_active_route_is_checked_against_road_events_without_google(g, admin, fake):
    geometry = [list(p) for p in ROUTE_A]
    status = lambda **kw: g.post("/api/emergency/route-status", json={"geometry": geometry, **kw})  # noqa: E731
    clear = status().json()
    assert clear["status"] == "OK" and clear["event_ids"] == [] and clear["next_check_s"] == 60

    built = len(fake.requests)
    ev = staff_event(g, admin)  # a closure appears on the route
    blocked = status(known_event_ids=[]).json()
    assert blocked["status"] == "BLOCKED" and blocked["message"] == "A verified road closure was detected on your current route."
    assert [e["id"] for e in blocked["blocking_events"]] == [ev["id"]] and blocked["blocking_events"][0]["headline"] == "🚧 BLOCKED"
    assert len(fake.requests) == built  # database only: no Google call

    g.patch(f"/api/road-events/{ev['id']}/resolve", json={}, headers=admin)  # it reopens
    ended = status(known_event_ids=[ev["id"]]).json()
    assert ended["status"] == "CHANGED" and ended["ended_event_ids"] == [ev["id"]] and ended["blocking_events"] == []
    works = staff_event(g, admin, event_type="CONSTRUCTION")  # something new, but not a closure
    changed = status(known_event_ids=[]).json()
    assert changed["status"] == "CHANGED" and [e["id"] for e in changed["new_events"]] == [works["id"]] and changed["message"] == "A road condition changed on your route."
    assert status(known_event_ids=[works["id"]]).json()["status"] == "OK"  # already known: nothing changed


def test_route_status_validates_its_input(g):
    post = lambda body: g.post("/api/emergency/route-status", json=body)  # noqa: E731
    assert post({"geometry": [[13.0, 80.0]]}).status_code == 422 and post({"geometry": [[13.0, 80.0], [95.0, 80.0]]}).status_code == 422
    assert post({"geometry": [[13.0, 80.0], [13.1]]}).status_code == 422 and post({}).status_code == 422


def test_emergency_events_list_closures_first(g, admin, citizen):
    staff_event(g, admin, event_type="CONSTRUCTION", lat=13.07, lng=80.26)
    staff_event(g, admin, event_type="ROAD_CLOSED", lat=13.07, lng=80.27)
    out = g.get("/api/emergency/events").json()
    assert [i["event_type"] for i in out["items"]] == ["ROAD_CLOSED", "CONSTRUCTION"] and out["blocking_count"] == 1 and out["refresh_seconds"] == 60
    assert g.get("/api/emergency/events", params={"south": 13.0}).status_code == 422
    assert g.get("/api/emergency/events", params={"south": 20, "west": 20, "north": 21, "east": 21}).json()["count"] == 0
    assert all("name" not in i["reported_by"] for i in out["items"])
