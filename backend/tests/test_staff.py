"""Road-maintenance staff: assignments, scoped access, inspections, repairs, notes and photo evidence."""

import pytest


@pytest.fixture(scope="module")
def roads(client, admin_headers):
    """Three roads with RoadMind data that these tests assign / leave alone (picked from the middle of the ranking so
    that other test modules, which use the very top road, are unaffected)."""
    rows = client.get("/api/maintenance/priorities", headers=admin_headers).json()
    assert len(rows) >= 12
    return [r["id"] for r in rows[6:9]]


def assign(client, headers, road_id, user_id):
    return client.put(f"/api/maintenance/{road_id}/assignment", json={"user_id": user_id}, headers=headers)


def test_only_administrators_can_assign_roads_and_only_to_maintenance_staff(client, admin_headers, user_headers, staff, roads):
    a = roads[0]
    assert client.put(f"/api/maintenance/{a}/assignment", json={"user_id": staff["id"]}).status_code == 401
    assert assign(client, user_headers, a, staff["id"]).status_code == 403
    assert assign(client, staff["headers"], a, staff["id"]).status_code == 403  # staff cannot hand out work
    me = client.get("/api/auth/me", headers=admin_headers).json()["id"]
    assert assign(client, admin_headers, a, me).status_code == 422  # an administrator is not a maintenance employee
    assert assign(client, admin_headers, a, 99999).status_code == 422
    assert assign(client, admin_headers, 99999, staff["id"]).status_code == 404
    ok = assign(client, admin_headers, a, staff["id"])
    assert ok.status_code == 200 and ok.json()["assigned_to"]["id"] == staff["id"]
    ranked = {r["id"]: r for r in client.get("/api/maintenance/priorities", headers=admin_headers).json()}
    assert ranked[a]["assigned_to"]["id"] == staff["id"]
    assert any(s["id"] == staff["id"] and s["assigned_roads"] >= 1 for s in client.get("/api/maintenance/assignees", headers=admin_headers).json())
    assert assign(client, admin_headers, a, None).json() == {"road_id": a, "assigned_to": None}  # clearing works...
    assert client.get("/api/staff/roads", headers=staff["headers"]).json() == []  # ...and staff immediately lose sight of the road


def test_staff_see_and_open_only_their_assigned_roads(client, admin_headers, staff, roads):
    a, b, other = roads
    assert assign(client, admin_headers, a, staff["id"]).status_code == 200 and assign(client, admin_headers, b, staff["id"]).status_code == 200
    mine = client.get("/api/staff/roads", headers=staff["headers"]).json()
    assert {r["id"] for r in mine} == {a, b} and all("geometry" not in r and r["assigned_to"]["id"] == staff["id"] for r in mine)
    assert client.get(f"/api/staff/roads/{a}", headers=staff["headers"]).status_code == 200
    denied = client.get(f"/api/staff/roads/{other}", headers=staff["headers"])
    assert denied.status_code == 403 and "not assigned to you" in denied.json()["detail"]
    assert client.get("/api/staff/roads/999999", headers=staff["headers"]).status_code == 404
    detail = client.get(f"/api/staff/roads/{a}", headers=staff["headers"]).json()
    assert detail["prediction"] and detail["priority"] and detail["evidence"] == [] and detail["assigned_to"]["id"] == staff["id"]

    s = client.get("/api/staff/summary", headers=staff["headers"]).json()
    assert s["scope"] == "assigned" and s["assigned_roads"] == 2 and len(s["top_roads"]) <= 2
    admin_view = client.get("/api/staff/roads", headers=admin_headers).json()
    assert len(admin_view) > 2 and client.get("/api/staff/summary", headers=admin_headers).json()["scope"] == "all"  # administrators see every road


def test_staff_endpoints_reject_normal_users_and_anonymous_visitors(client, user_headers, roads):
    for path in ("/api/staff/summary", "/api/staff/roads", f"/api/staff/roads/{roads[0]}", "/api/staff/reports"):
        assert client.get(path).status_code == 401, path
        denied = client.get(path, headers=user_headers)
        assert denied.status_code == 403 and "Maintenance staff privileges are required" in denied.json()["detail"], path
    assert client.patch(f"/api/staff/roads/{roads[0]}/status", json={"status": "inspected"}, headers=user_headers).status_code == 403
    assert client.post(f"/api/staff/roads/{roads[0]}/notes", json={"note": "hi"}, headers=user_headers).status_code == 403


def test_staff_record_inspections_repairs_and_notes(client, admin_headers, staff, roads):
    a, _, other = roads
    h = staff["headers"]
    assign(client, admin_headers, a, staff["id"])
    inspected = client.patch(f"/api/staff/roads/{a}/status", json={"status": "inspected", "notes": "Pothole confirmed on site"}, headers=h)
    assert inspected.status_code == 200 and inspected.json()["maintenance_status"] == "inspected"
    assert "Pothole confirmed on site" in inspected.json()["notes"] and "crew" in inspected.json()["notes"]  # signed with the employee's handle
    planned = client.patch(f"/api/staff/roads/{a}/status", json={"status": "repair_planned", "planned_date": "2031-01-15"}, headers=h).json()
    assert planned["maintenance_status"] == "repair_planned"
    note = client.post(f"/api/staff/roads/{a}/notes", json={"note": "Asphalt ordered"}, headers=h)
    assert note.status_code == 201 and "Asphalt ordered" in note.json()["notes"]
    assert client.post(f"/api/staff/roads/{a}/notes", json={"note": ""}, headers=h).status_code == 422

    assert client.patch(f"/api/staff/roads/{a}/status", json={"status": "pending"}, headers=h).status_code == 422  # only an administrator can reopen
    assert client.patch(f"/api/staff/roads/{a}/status", json={"status": "bogus"}, headers=h).status_code == 422
    assert client.patch(f"/api/staff/roads/{other}/status", json={"status": "inspected"}, headers=h).status_code == 403  # not theirs
    assert client.post(f"/api/staff/roads/{other}/notes", json={"note": "x"}, headers=h).status_code == 403

    done = client.patch(f"/api/staff/roads/{a}/status", json={"status": "repair_completed", "notes": "Resurfaced"}, headers=h).json()
    assert done["maintenance_status"] == "repair_completed" and done["months_since_repair"] < 1  # severity and priority were recalculated
    seen_by_admin = {r["id"]: r for r in client.get("/api/maintenance/priorities", headers=admin_headers).json()}[a]
    assert seen_by_admin["maintenance_status"] == "repair_completed" and "Asphalt ordered" in seen_by_admin["notes"]
    assert client.get("/api/staff/summary", headers=h).json()["repairs_completed"] >= 1
    reopened = client.patch(f"/api/staff/roads/{a}/status", json={"status": "pending"}, headers=admin_headers)  # administrators can
    assert reopened.status_code == 200 and reopened.json()["maintenance_status"] == "pending"


def test_staff_upload_photo_evidence_for_their_roads(client, admin_headers, staff, roads, sample_image):
    a, _, other = roads
    h = staff["headers"]
    assign(client, admin_headers, a, staff["id"])
    files = lambda: {"image": ("repair.jpg", sample_image, "image/jpeg")}  # noqa: E731
    r = client.post(f"/api/staff/roads/{a}/evidence", files=files(), data={"kind": "repair", "caption": "Patched and compacted"}, headers=h)
    assert r.status_code == 201, r.text
    ev = r.json()
    assert ev["kind"] == "repair" and ev["caption"] == "Patched and compacted" and ev["url"].startswith(f"/media/evidence/{a}/") and ev["by"]
    stored = client.app.state.settings.media_dir / ev["url"].removeprefix("/media/")
    assert stored.is_file() and stored.suffix == ".jpg"
    assert client.get(ev["url"]).status_code == 200
    assert [e["id"] for e in client.get(f"/api/staff/roads/{a}", headers=h).json()["evidence"]] == [ev["id"]]
    assert next(x for x in client.get("/api/staff/roads", headers=h).json() if x["id"] == a)["evidence_count"] == 1

    assert client.post(f"/api/staff/roads/{a}/evidence", files={"image": ("x.jpg", b"definitely not an image", "image/jpeg")}, headers=h).status_code == 415
    assert client.post(f"/api/staff/roads/{a}/evidence", files={"image": ("x.jpg", b"", "image/jpeg")}, headers=h).status_code == 400
    assert client.post(f"/api/staff/roads/{a}/evidence", files=files(), data={"kind": "selfie"}, headers=h).status_code == 422
    assert client.post(f"/api/staff/roads/{other}/evidence", files=files(), headers=h).status_code == 403
    assert client.post(f"/api/staff/roads/{a}/evidence", files=files()).status_code == 401


def test_staff_see_only_the_reports_on_their_roads(client, admin_headers, staff, roads):
    a, b, other = roads
    h = staff["headers"]
    for rid in (a, b):
        assign(client, admin_headers, rid, staff["id"])
    mine = client.get("/api/staff/reports", headers=h).json()
    assert mine["total"] > 0 and {i["road_id"] for i in mine["items"]} <= {a, b}
    assert all(i["road_name"] and "annotated_url" in i for i in mine["items"])
    assert client.get("/api/staff/reports", params={"road_id": other}, headers=h).json() == {"total": 0, "items": []}  # filtering cannot widen the scope
    assert client.get("/api/staff/reports", headers=admin_headers).json()["total"] > mine["total"]


def test_demoted_or_deactivated_staff_lose_their_assignments_and_access(client, admin_headers, staff, roads):
    from conftest import STAFF, STAFF_PASSWORD

    a = roads[0]
    assign(client, admin_headers, a, staff["id"])
    assert client.patch(f"/api/admin/users/{staff['id']}", json={"is_active": False}, headers=admin_headers).status_code == 200
    assert client.get("/api/staff/roads", headers=staff["headers"]).status_code == 401  # signed out at once
    assert client.post("/api/auth/staff/login", json={"identifier": STAFF["email"], "password": STAFF_PASSWORD}).status_code == 403  # suspended: a clear message, after the right password
    assert assign(client, admin_headers, a, staff["id"]).status_code == 422  # and cannot be given new work
    assert client.patch(f"/api/admin/users/{staff['id']}", json={"is_active": True}, headers=admin_headers).status_code == 200
    again = client.post("/api/auth/staff/login", json={"identifier": STAFF["email"], "password": STAFF_PASSWORD})
    assert again.status_code == 200
    staff["headers"] = {"Authorization": f"Bearer {again.json()['access_token']}"}  # later tests in this module keep working
    assert [r["id"] for r in client.get("/api/staff/roads", headers=staff["headers"]).json()].count(a) == 1  # reactivation keeps the assignment
