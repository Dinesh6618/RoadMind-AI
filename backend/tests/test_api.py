"""End-to-end API tests against a freshly built database (fixture road network + simulated condition data)."""

import io

import pytest
from PIL import Image

from conftest import GRID, view
from osm_fixture import make_extract


def _segments(client, **kw):
    return view(client, **kw)["segments"]


def _midpoint(seg):
    g = seg["geometry"]
    a, b = g[len(g) // 2 - 1], g[len(g) // 2]
    return (a[0] + b[0]) / 2, (a[1] + b[1]) / 2


def _first(client, state=None, not_state=None, name=None):
    for s in _segments(client):
        if (state is None or s["state"] == state) and (not_state is None or s["state"] != not_state) and (name is None or name in s["name"]):
            return s
    raise AssertionError(f"no segment found for state={state} not_state={not_state} name={name}")


def _submit(client, image: bytes, lat: float, lng: float, **extra):
    return client.post(
        "/api/reports",
        files={"image": ("road.jpg", image, "image/jpeg")},
        data={"lat": lat, "lng": lng, **extra},
    )


# ------------------------------------------------------------------ basics
def test_health_and_system_info(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    info = client.get("/api/system/info").json()
    assert info["detector"]["name"]
    assert info["risk_model"]["metrics"]["selected_metrics"]["roc_auc"] > 0.5
    assert info["network"]["segments"] > 50 and "OpenStreetMap" in info["network"]["attribution"]
    assert "unknown" in info["disclaimers"]["unknown"].lower()


# --------------------------------------------- the complete base network
def test_pages_send_a_referer_origin_to_map_tile_servers(client):
    # tile.openstreetmap.org serves an "Access blocked" tile to requests without a Referer, so the app must
    # never send `same-origin` / `no-referrer`; `strict-origin-when-cross-origin` sends only the site origin.
    for path in ("/api/health", "/api/network/info", "/"):
        assert client.get(path).headers["referrer-policy"] == "strict-origin-when-cross-origin", path
    tiles = client.get("/api/network/info").json()["tiles"]
    assert "{z}" in tiles["url"] and "{x}" in tiles["url"] and "OpenStreetMap" in tiles["attribution"]


def test_network_shows_every_road_including_unknown(client):
    data = view(client)
    segs = data["segments"]
    info = client.get("/api/network/info").json()
    assert len(segs) == info["segments"] and not data["truncated"]  # nothing dropped at street zoom
    states = {s["state"] for s in segs}
    assert "UNKNOWN" in states and states <= {"GOOD", "MODERATE", "HIGH_RISK", "CRITICAL", "UNKNOWN"}
    unknown = [s for s in segs if s["state"] == "UNKNOWN"]
    known = [s for s in segs if s["state"] != "UNKNOWN"]
    assert len(unknown) > len(known) > 0  # RoadMind knows only a minority of the network
    assert all(s["geometry"] and len(s["geometry"]) >= 2 and s["name"] for s in segs)
    # excluded ways never become roads
    names = {s["name"] for s in segs}
    assert not names & {"Pedestrian Path", "Driveway X", "Private Yard"}
    assert "Unnamed residential road" in names  # unnamed roads are kept, honestly labelled
    assert data["intersections"], "junctions are reported"
    assert info["data_coverage"] == round(len(known) / len(segs), 4)


def test_unknown_roads_carry_no_condition_data_at_all(client):
    for s in _segments(client):
        if s["state"] == "UNKNOWN":
            assert s["state_label"] == "UNKNOWN"
            for key in ("severity", "severity_level", "risk_percent", "damage_type", "report_count", "priority_category"):
                assert key not in s, f"unknown road must not carry {key}"
        else:
            assert s["severity"] is not None and s["risk_percent"] is not None and s["report_count"] >= 1


def test_zoom_generalisation_hides_no_road_that_has_data(client):
    street, city = view(client, zoom=16), view(client, zoom=11)
    known = lambda d: {s["id"] for s in d["segments"] if s["state"] != "UNKNOWN"}  # noqa: E731
    assert known(city) == known(street)  # roads with RoadMind data are always drawn
    assert len(city["segments"]) < len(street["segments"])  # minor streets without data are generalised away on wide views
    kinds = {s["highway"] for s in city["segments"] if s["state"] == "UNKNOWN"}
    assert not kinds & {"service", "residential"}


def test_unknown_road_detail_has_no_prediction_or_priority(client, admin_headers):
    seg = _first(client, state="UNKNOWN")
    detail = client.get(f"/api/roads/{seg['id']}").json()
    assert detail["state"] == "UNKNOWN" and not detail["has_data"]
    assert detail["prediction"] is None and detail["priority"] is None and detail["recent_reports"] == []
    ranked = {r["id"] for r in client.get("/api/maintenance/priorities", headers=admin_headers).json()}
    assert seg["id"] not in ranked  # nothing can be prioritised without data
    assert seg["id"] not in {r["id"] for r in client.get("/api/roads").json()}  # /roads lists only roads with data


def test_known_road_popup_fields(client):
    seg = _first(client, not_state="UNKNOWN")
    for key in ("name", "state", "severity", "damage_type", "report_count", "last_report_at", "risk_percent", "priority_category"):
        assert key in seg
    assert seg["simulated"] is True  # seeded demo data is labelled as simulated


def test_network_match_previews_the_road_a_report_would_use(client):
    seg = _first(client, state="UNKNOWN")
    lat, lng = _midpoint(seg)
    m = client.get("/api/network/match", params={"lat": lat, "lng": lng}).json()
    assert m["matched"] and m["state"] == "UNKNOWN" and m["distance_m"] < 60
    assert client.get("/api/network/match", params={"lat": 0.0, "lng": 0.0}).json() == {"matched": False}


def test_match_can_search_wider_and_returns_a_point_on_the_road(client):
    seg = _first(client, name="Main Boulevard")
    lat, lng = _midpoint(seg)
    near = client.get("/api/network/match", params={"lat": lat + 0.0030, "lng": lng})  # ~330 m away: outside the report radius
    assert near.json() == {"matched": False}
    wide = client.get("/api/network/match", params={"lat": lat + 0.0030, "lng": lng, "radius": 500}).json()
    assert wide["matched"] and 60 < wide["distance_m"] < 500 and {"lat", "lng"} <= wide["midpoint"].keys()  # found by the wider search only


def test_places_suggest_the_designed_trip(client, places):
    data = client.get("/api/routes/places").json()
    trip = data["suggested_trips"][0]
    assert trip["origin"]["name"] in places and trip["destination"]["name"] in places
    assert data["center"] and data["bounds"] and data["default_weights"]


def test_network_view_validation(client):
    r = client.get("/api/network", params={"south": 1, "west": 1, "north": 0, "east": 2})
    assert r.status_code == 422
    r = client.get("/api/network", params={"south": 0, "west": 0, "north": 5, "east": 5, "zoom": 10})
    assert r.status_code == 422  # view too large


def test_network_import_limits_and_idempotence(client):
    s, w, n, e = make_extract()["bbox"]  # the area the fixture network was imported for (inset a little)
    again = client.post("/api/network/import", json={"south": s + 0.001, "west": w + 0.001, "north": n - 0.001, "east": e - 0.001})
    assert again.status_code == 200 and again.json()["already_loaded"] is True
    too_big = client.post("/api/network/import", json={"south": 13.0, "west": 80.0, "north": 13.5, "east": 80.5})
    assert too_big.status_code == 422 and "too large" in too_big.json()["detail"]
    disabled = client.post("/api/network/import", json={"south": 28.60, "west": 77.20, "north": 28.61, "east": 77.21})
    assert disabled.status_code == 422 and "disabled" in disabled.json()["detail"]


# -------------------------------------------------------------------- auth
ADMIN_ENDPOINTS = ("/api/maintenance/priorities", "/api/analytics/overview", "/api/analytics/damage", "/api/analytics/routes", "/api/reports", "/api/admin/users")


def test_admin_endpoints_require_login(client):
    for path in ADMIN_ENDPOINTS:
        assert client.get(path).status_code == 401, path
    assert client.get("/api/maintenance/priorities", headers={"Authorization": "Bearer not-a-token"}).status_code == 401


def test_normal_users_cannot_use_admin_endpoints(client, user_headers, admin_headers):
    for path in ADMIN_ENDPOINTS:
        assert client.get(path, headers=user_headers).status_code == 403, path
        assert client.get(path, headers=admin_headers).status_code == 200, path
    assert client.patch("/api/maintenance/1", json={"status": "inspected"}, headers=user_headers).status_code == 403
    assert client.post("/api/maintenance/refresh", headers=user_headers).status_code == 403


def test_login_with_the_account_created_at_setup(client):
    from conftest import ADMIN

    ok = client.post("/api/auth/staff/login", json={"identifier": ADMIN["email"], "password": ADMIN["password"]})
    assert ok.status_code == 200 and ok.json()["token_type"] == "bearer"
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {ok.json()['access_token']}"})
    assert me.json()["role"] == "admin" and "password" not in me.text


# ----------------------------------------------------------------- reports
def test_report_on_an_unknown_road_makes_it_known(client, sample_image):
    seg = _first(client, state="UNKNOWN", name="Column Street")
    lat, lng = _midpoint(seg)
    before = client.get("/api/network/info").json()["segments_with_data"]
    r = _submit(client, sample_image, lat, lng, description="Big hole near the junction", severity_confirmation="high")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["location"]["road_id"] == seg["id"] and body["location"]["road_was_unknown"] and not body["location"]["new_road_created"]
    assert body["damage_detected"] and body["detection"]["detections"][0]["label"] == "pothole"
    assert all(0 <= d["confidence"] <= 1 for d in body["detection"]["detections"])
    assert 0 <= body["severity"]["score"] <= 100 and body["severity"]["reporter_confirmation"] == "high"
    assert 0 <= body["prediction"]["risk"] <= 1 and body["priority"]["category"] in {"Immediate", "High Priority", "Medium Priority", "Monitor"}
    assert body["road"]["state"] != "UNKNOWN" and body["road"]["has_data"]
    assert client.get(body["detection"]["annotated_image_url"]).status_code == 200
    now_known = next(s for s in _segments(client) if s["id"] == seg["id"])
    assert now_known["state"] == body["road"]["state"] and now_known["report_count"] == 1
    assert client.get("/api/network/info").json()["segments_with_data"] == before + 1


def test_report_on_a_known_road_adds_to_its_history(client, sample_image):
    seg = _first(client, not_state="UNKNOWN")
    lat, lng = _midpoint(seg)
    r = _submit(client, sample_image, lat, lng)
    assert r.status_code == 201
    assert r.json()["location"]["road_id"] == seg["id"] and not r.json()["location"]["road_was_unknown"]
    assert client.get(f"/api/roads/{seg['id']}").json()["report_count"] == seg["report_count"] + 1


def test_report_far_from_any_network_creates_a_stub_road(client, sample_image):
    r = _submit(client, sample_image, 28.6139, 77.2090, road_name="Test Lane")  # network import disabled in tests
    assert r.status_code == 201
    loc = r.json()["location"]
    assert loc["new_road_created"] and loc["road_name"] == "Test Lane" and not loc["network_loaded"]
    detail = client.get(f"/api/roads/{loc['road_id']}").json()
    assert detail["stub"] and detail["has_data"]


def test_report_outside_the_network_loads_it_when_importing_is_allowed(client, app, sample_image, monkeypatch):
    from app.services import osm

    cfg = app.state.app_state.settings.network
    fetched = []

    def fake_fetch(bbox, c, timeout_s=None):
        fetched.append(bbox)
        extract = make_extract(28.6100, 77.2050, id_offset=900_000)
        extract["places"] = {"elements": []}  # keep place names unique across the shared test database
        return {**extract, "bbox": list(bbox)}

    monkeypatch.setattr(osm, "fetch_area", fake_fetch)
    monkeypatch.setattr(cfg, "remote_enabled", True)
    r = _submit(client, sample_image, 28.6155, 77.2095)  # on a street of the freshly imported grid
    assert r.status_code == 201, r.text
    loc = r.json()["location"]
    assert fetched and loc["network_loaded"] and not loc["new_road_created"]
    assert client.get(f"/api/roads/{loc['road_id']}").json()["osm_way_id"] is not None  # a real network segment, not a stub


def test_invalid_uploads_are_rejected(client, sample_image):
    assert _submit(client, b"this is not an image", 13.06, 80.25).status_code == 415
    assert _submit(client, b"", 13.06, 80.25).status_code == 400
    assert _submit(client, b"\0" * (9 * 1024 * 1024), 13.06, 80.25).status_code == 413
    tiny = io.BytesIO()
    Image.new("RGB", (20, 20)).save(tiny, "JPEG")
    assert _submit(client, tiny.getvalue(), 13.06, 80.25).status_code == 400
    gif = io.BytesIO()
    Image.new("RGB", (200, 200)).save(gif, "GIF")
    assert _submit(client, gif.getvalue(), 13.06, 80.25).status_code == 415
    assert _submit(client, sample_image, 123.0, 80.25).status_code == 422  # latitude out of range
    assert _submit(client, sample_image, 13.06, 80.25, severity_confirmation="catastrophic").status_code == 422


def test_uploaded_image_metadata_is_stripped(client, app, sample_image):
    img = Image.open(io.BytesIO(sample_image))
    exif = Image.Exif()
    exif[0x010F] = "SecretPhoneMaker"  # camera make
    exif[0x8825] = {1: "N", 2: (13.0, 3.0, 0.0), 3: "E", 4: (80.0, 15.0, 0.0)}  # GPS block
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    sent = Image.open(io.BytesIO(buf.getvalue())).getexif()
    assert sent.get(0x010F) == "SecretPhoneMaker" and sent.get_ifd(0x8825)  # the upload really carries metadata
    lat, lng = _midpoint(_first(client, not_state="UNKNOWN"))
    r = _submit(client, buf.getvalue(), lat, lng)
    assert r.status_code == 201
    stored = app.state.settings.media_dir / r.json()["detection"]["annotated_image_url"].removeprefix("/media/")
    assert len(Image.open(stored).getexif()) == 0
    original = stored.with_name(stored.name.replace("_annotated", ""))
    assert len(Image.open(original).getexif()) == 0


def test_detect_endpoint_does_not_store(client, sample_image):
    before = client.get("/api/analytics/public-summary").json()["total_reports"]
    r = client.post("/api/detect", files={"image": ("x.jpg", sample_image, "image/jpeg")})
    assert r.status_code == 200
    assert r.json()["annotated_image"].startswith("data:image/jpeg;base64,")
    assert client.get("/api/analytics/public-summary").json()["total_reports"] == before


def test_public_road_detail_hides_admin_only_data(client, admin_headers, sample_image):
    seg = _first(client, not_state="UNKNOWN")
    lat, lng = _midpoint(seg)
    assert _submit(client, sample_image, lat, lng).status_code == 201
    public = client.get(f"/api/roads/{seg['id']}").json()
    assert "notes" not in public["priority"]
    assert all("image_url" not in rep for rep in public["recent_reports"])
    admin = client.get(f"/api/roads/{seg['id']}", headers=admin_headers).json()
    assert any(rep.get("image_url") for rep in admin["recent_reports"])


# ------------------------------------------------------------------ routes
@pytest.fixture(scope="module")
def trip(client, places, admin_headers):
    """A trip the seed designed: its fastest route is damaged and an alternative is in good condition.
    Found through the route analytics (the trip whose fastest route carries the highest risk)."""
    affected = client.get("/api/analytics/routes", headers=admin_headers).json()["most_affected_routes"]
    assert affected, "the seed should have produced route history"
    top = affected[0]
    a, b = places[top["origin"]], places[top["destination"]]
    return {"origin": {"lat": a["lat"], "lng": a["lng"], "name": a["name"]}, "destination": {"lat": b["lat"], "lng": b["lng"], "name": b["name"]}}


def test_route_recommendation_runs_on_the_complete_network(client, trip):
    res = client.post("/api/routes/recommend", json=trip)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["provider"] == "network" and len(out["routes"]) >= 2
    rec = next(r for r in out["routes"] if r["recommendation"] == "Recommended")
    assert rec["label"] == out["recommended"]
    assert rec["score"] == min(r["score"] for r in out["routes"])
    for r in out["routes"]:
        assert {"distance_km", "duration_min", "damage_level", "reason", "data_coverage", "unknown_km", "geometry"} <= r.keys()
        assert 0 <= r["data_coverage"] <= 1 and len(r["geometry"]) > 2
        if r["risk"] is None:
            assert r["damage_level"] == "Unknown" and r["risk_percent"] is None
    assert len({tuple(map(tuple, r["geometry"])) for r in out["routes"]}) == len(out["routes"])  # genuinely different routes
    text = (out["summary"] + " ".join(r["reason"] for r in out["routes"])).lower()
    assert "unsafe" not in text.replace("not a finding that the road is unsafe", "")
    assert "disclaimer" in out


def test_designed_trip_prefers_the_lower_risk_route(client, trip):
    out = client.post("/api/routes/recommend", json=trip).json()
    rec = next(r for r in out["routes"] if r["recommendation"] == "Recommended")
    fastest = next(r for r in out["routes"] if r["is_fastest"])
    assert fastest["risk"] is not None and fastest["risk"] >= 0.5  # the fastest route runs over damaged roads
    assert rec["label"] != fastest["label"] and rec["risk"] is not None and rec["risk"] < fastest["risk"]
    assert fastest["recommendation"] == "Avoid" and rec["distance_km"] >= fastest["distance_km"]
    assert "Avoids" in rec["reason"] or "lower damage risk" in rec["reason"]


def test_route_weights_are_configurable(client, trip):
    base = trip
    only_speed = client.post("/api/routes/recommend", json={**base, "weights": {"distance": 0.5, "time": 0.5, "damage_risk": 0.0}}).json()
    assert next(r for r in only_speed["routes"] if r["recommendation"] == "Recommended")["is_fastest"]
    only_condition = client.post("/api/routes/recommend", json={**base, "weights": {"distance": 0, "time": 0, "damage_risk": 1}}).json()
    rec = next(r for r in only_condition["routes"] if r["recommendation"] == "Recommended")
    assert rec["effective_risk"] == min(r["effective_risk"] for r in only_condition["routes"])


def test_route_outside_coverage_gives_a_clear_error(client, app):
    cfg = app.state.app_state.route_engine.cfg
    old = (cfg.provider, cfg.osrm_base_url)
    try:
        cfg.provider = "network"
        body = {"origin": {"lat": 28.61, "lng": 77.20}, "destination": {"lat": 28.62, "lng": 77.21}}
        r = client.post("/api/routes/recommend", json=body)
        assert r.status_code == 422 and "outside" in r.json()["detail"].lower()
        cfg.provider, cfg.osrm_base_url = "auto", "http://127.0.0.1:9"  # nothing listens here
        assert client.post("/api/routes/recommend", json=body).status_code == 503
    finally:
        cfg.provider, cfg.osrm_base_url = old


def test_summary_is_honest_when_there_is_no_road_data(client, app, monkeypatch):
    from app.services.routing.types import Candidate

    class FakeProvider:
        name = "osrm"

        def routes(self, origin, destination, max_routes):
            return [
                Candidate([[28.60, 77.20], [28.61, 77.21]], 1500, 200),
                Candidate([[28.60, 77.20], [28.605, 77.215], [28.61, 77.21]], 1800, 260),
            ]

    monkeypatch.setattr(app.state.app_state.route_engine, "_provider", lambda db, o, d: FakeProvider())
    res = client.post("/api/routes/recommend", json={"origin": {"lat": 28.60, "lng": 77.20}, "destination": {"lat": 28.61, "lng": 77.21}}).json()
    assert "little or no road-condition data" in res["summary"].lower()
    assert "lowest damage risk" not in res["summary"]
    assert res["warnings"]
    for r in res["routes"]:
        assert r["data_coverage"] == 0 and r["risk"] is None and r["damage_level"] == "Unknown"
        assert r["recommendation"] != "Avoid"  # missing data is never treated as bad


def test_geocode_finds_stored_places(client):
    hits = client.get("/api/routes/geocode", params={"q": "hospital"}).json()
    assert {h["name"] for h in hits} >= {"Test General Hospital", "West Clinic Hospital"}
    assert client.get("/api/routes/geocode", params={"q": "100%_"}).json() == []  # LIKE wildcards are escaped


# ------------------------------------------------------ maintenance/admin
def test_priorities_are_sorted_and_filterable(client, admin_headers):
    rows = client.get("/api/maintenance/priorities", headers=admin_headers).json()
    assert rows and all(r["has_data"] for r in rows)
    scores = [r["priority_score"] for r in rows]
    assert scores == sorted(scores, reverse=True)
    asc = client.get("/api/maintenance/priorities", params={"sort": "severity", "order": "asc"}, headers=admin_headers).json()
    sev = [r["current_severity"] for r in asc]
    assert sev == sorted(sev)
    cats = {r["priority_category"] for r in client.get("/api/maintenance/priorities", params={"category": "Monitor"}, headers=admin_headers).json()}
    assert cats <= {"Monitor"}


def test_maintenance_workflow(client, admin_headers):
    top = client.get("/api/maintenance/priorities", headers=admin_headers).json()[0]
    rid = top["id"]
    assert top["current_severity"] > 30
    r = client.patch(f"/api/maintenance/{rid}", json={"status": "inspected", "notes": "Site visit done"}, headers=admin_headers).json()
    assert r["maintenance_status"] == "inspected" and "Site visit done" in r["notes"]
    r = client.patch(f"/api/maintenance/{rid}", json={"status": "repair_planned"}, headers=admin_headers).json()
    assert r["maintenance_status"] == "repair_planned"
    r = client.patch(f"/api/maintenance/{rid}", json={"status": "repair_completed", "notes": "Resurfaced"}, headers=admin_headers).json()
    assert r["maintenance_status"] == "repair_completed"
    assert r["current_severity"] < top["current_severity"]
    assert r["priority_score"] < top["priority_score"]
    assert r["state"] == "GOOD"  # repaired recently: data says good, and says why
    detail = client.get(f"/api/roads/{rid}", headers=admin_headers).json()
    assert detail["repairs"][0]["status"] == "completed" and detail["last_repair_date"]
    assert client.patch("/api/maintenance/999999", json={"status": "inspected"}, headers=admin_headers).status_code == 404
    assert client.patch(f"/api/maintenance/{rid}", json={"status": "bogus"}, headers=admin_headers).status_code == 422


def test_analytics_endpoints(client, admin_headers):
    ov = client.get("/api/analytics/overview", headers=admin_headers).json()
    info = client.get("/api/network/info").json()
    assert ov["network_segments"] == info["segments"] and ov["total_roads"] == info["segments_with_data"] < ov["network_segments"]
    assert 0 < ov["data_coverage"] < 1 and ov["total_reports"] > 100
    for key in ("critical_roads", "high_risk_roads", "predicted_deteriorations", "pending_maintenance"):
        assert isinstance(ov[key], int)
    dm = client.get("/api/analytics/damage", headers=admin_headers).json()
    assert dm["by_type"] and len(dm["by_severity"]) == 4 and dm["by_location"] and len(dm["over_time"]) == 26
    pr = client.get("/api/analytics/predictions", headers=admin_headers).json()
    assert set(pr["levels"]) == {"high", "medium", "low"} and pr["model_metrics"]["selected_model"]
    rt = client.get("/api/analytics/routes", headers=admin_headers).json()
    assert rt["total_queries"] > 0 and rt["most_affected_routes"]


def test_api_docs_are_served(client):
    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/api/docs").status_code == 200
