"""OpenStreetMap parsing, junction splitting and import (no network access)."""

import pytest
from sqlalchemy import func, select

from app.config import load_settings
from app.database import Base, make_engine, make_session_factory
from app.models import NetworkArea, Place, Road, RoadReport
from app.services import osm
from osm_fixture import COLS, ROWS, make_extract


@pytest.fixture()
def db(tmp_path):
    engine = make_engine("sqlite://")
    Base.metadata.create_all(engine)
    with make_session_factory(engine)() as session:
        yield session


@pytest.fixture()
def settings(tmp_path):
    return load_settings({"data_dir": tmp_path, "network": {"remote_enabled": False}})


def test_only_drivable_open_ways_are_parsed():
    ways = osm.parse_ways(make_extract()["roads"])
    names = {w.name for w in ways}
    assert "Pedestrian Path" not in names and "Driveway X" not in names and "Private Yard" not in names
    assert {"Main Boulevard", "Central Avenue", "Depot Access", "One Way Street"} <= names
    assert len(ways) == ROWS + COLS + 2  # grid rows + columns + service road + unnamed road


def test_ways_are_split_at_every_junction():
    segs = osm.split_ways(osm.parse_ways(make_extract()["roads"]))
    main = [s for s in segs if s.name == "Main Boulevard"]
    assert len(main) == COLS - 1  # one segment between each pair of crossing streets
    assert all(s.node_a != s.node_b for s in segs)
    # every segment of a way starts where the previous one ended
    seq = sorted(main, key=lambda s: s.seq)
    assert all(a.node_b == b.node_a for a, b in zip(seq, seq[1:]))


def test_oneway_normalisation_and_roundabouts():
    one = [s for s in osm.split_ways(osm.parse_ways(make_extract()["roads"])) if s.name == "One Way Street"]
    assert one and all(s.oneway == 1 for s in one)
    reverse = {"elements": [{"type": "way", "id": 1, "nodes": [1, 2], "geometry": [{"lat": 0.0, "lon": 0.0}, {"lat": 0.0, "lon": 0.001}],
                             "tags": {"highway": "residential", "oneway": "-1", "name": "Back Street"}}]}
    seg = osm.split_ways(osm.parse_ways(reverse))[0]
    assert seg.oneway == 1 and (seg.node_a, seg.node_b) == (2, 1) and seg.coords[0] == (0.0, 0.001)  # flipped to travel direction
    ring = {"elements": [{"type": "way", "id": 2, "nodes": [1, 2, 3, 1], "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 0.001}, {"lat": 0.001, "lon": 0.001}, {"lat": 0, "lon": 0}],
                          "tags": {"highway": "residential", "junction": "roundabout"}}]}
    assert osm.parse_ways(ring)[0].oneway == 1


def test_names_prefer_english_then_ref_then_placeholder():
    mk = lambda tags: {"elements": [{"type": "way", "id": 1, "nodes": [1, 2], "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1e-3}], "tags": {"highway": "primary", **tags}}]}  # noqa: E731
    assert osm.parse_ways(mk({"name": "Tamil", "name:en": "English Road"}))[0].name == "English Road"
    assert osm.parse_ways(mk({"ref": "NH48"}))[0].name == "NH48"
    assert osm.parse_ways(mk({}))[0].name == ""  # the placeholder is added when stored


def test_zone_names_cover_the_area():
    bbox = (0.0, 0.0, 3.0, 3.0)
    assert osm.zone_for(0.5, 0.5, bbox) == "South-West" and osm.zone_for(2.5, 2.5, bbox) == "North-East"
    assert osm.zone_for(1.5, 1.5, bbox) == "Central" and osm.zone_for(1.5, 0.5, bbox) == "West"


def test_import_stores_every_segment_as_unknown(db, settings):
    res = osm.import_extract(db, settings, make_extract())
    total = db.scalar(select(func.count(Road.id)))
    assert res.segments_added == total > 50 and res.places_added == 6
    roads = list(db.scalars(select(Road)))
    assert all(not r.has_data and r.current_severity == 0 and r.source == "osm" for r in roads)  # nothing is "good" or "bad" yet
    assert all(r.min_lat <= r.max_lat and r.min_lng <= r.max_lng and r.length_m > 0 for r in roads)
    assert {r.name for r in roads if r.highway == "residential" and r.osm_way_id % 1000 == 103} == {"Unnamed residential road"}
    assert any(r.facilities_nearby > 0 for r in roads)  # schools / hospitals counted for the priority score
    assert db.scalar(select(func.count(NetworkArea.id))) == 1 and db.scalar(select(func.count(Place.id))) == 6


def test_reimport_is_idempotent_and_overlaps_do_not_duplicate(db, settings):
    osm.import_extract(db, settings, make_extract())
    n = db.scalar(select(func.count(Road.id)))
    again = osm.import_extract(db, settings, make_extract())
    assert again.segments_added == 0 and again.segments_kept == n and again.places_added == 0
    assert db.scalar(select(func.count(Road.id))) == n


def test_reimport_keeps_roads_that_have_reports(db, settings):
    osm.import_extract(db, settings, make_extract())
    road = db.scalars(select(Road).where(Road.name == "Main Boulevard")).first()
    db.add(RoadReport(road_id=road.id, lat=road.geometry[0][0], lng=road.geometry[0][1], severity_score=50, severity_level="Moderate"))
    db.commit()
    # a later extract that adds a new junction in the middle of the way would re-split it; data-bearing segments are never discarded
    changed = make_extract()
    way = next(e for e in changed["roads"]["elements"] if e["id"] == 5002)
    changed["roads"]["elements"].append({
        "type": "way", "id": 8000, "nodes": [way["nodes"][2], 77777],
        "geometry": [way["geometry"][2], {"lat": way["geometry"][2]["lat"] + 0.001, "lon": way["geometry"][2]["lon"]}],
        "tags": {"highway": "residential", "name": "New Link"},
    })
    osm.import_extract(db, settings, changed)
    assert db.get(Road, road.id) is not None


def test_overpass_failures_raise_a_clear_error():
    with pytest.raises(osm.NetworkImportError):
        osm.fetch_overpass("[out:json];", ["http://127.0.0.1:9/api"], 1.0)


def test_import_bbox_rules(db, settings):
    with pytest.raises(osm.NetworkImportError, match="too large"):
        osm.import_bbox(db, settings, (13.0, 80.0, 13.5, 80.5))
    with pytest.raises(osm.NetworkImportError, match="disabled"):
        osm.import_bbox(db, settings, (13.00, 80.00, 13.01, 80.01))
    osm.import_extract(db, settings, make_extract())
    s, w, n, e = make_extract()["bbox"]
    assert osm.import_bbox(db, settings, (s + 0.001, w + 0.001, n - 0.001, e - 0.001)).notes == ["already loaded"]


def test_ensure_network_loads_the_bundled_file_once(db, settings, tmp_path):
    path = tmp_path / "extract.json"
    osm.save_extract(path, make_extract())
    settings.network.source_file = str(path)
    first = osm.ensure_network(db, settings)
    assert first and first.segments_added > 50
    assert osm.ensure_network(db, settings) is None  # already loaded: nothing to do
