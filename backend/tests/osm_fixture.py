"""A small synthetic OpenStreetMap extract (Overpass JSON format) for hermetic tests.

A 6 x 7 street grid (about 3 km x 2.5 km): every row and column is ONE way crossing several others, so
splitting at junctions is exercised. It also contains a one-way street, a service road, an unnamed
road, and ways that must be excluded (footway, driveway, private road), plus named places.
"""

from __future__ import annotations

ROWS, COLS = 6, 7
DLAT, DLNG = 0.0045, 0.0048


def make_extract(lat0: float = 13.0600, lng0: float = 80.2500, id_offset: int = 0) -> dict:
    def node_id(r: int, c: int) -> int:
        return id_offset + 1000 + r * 10 + c

    def pos(r: int, c: int) -> tuple[float, float]:
        return lat0 + r * DLAT, lng0 + c * DLNG

    def way(wid: int, nodes: list[tuple[int, tuple[float, float]]], tags: dict) -> dict:
        return {
            "type": "way", "id": id_offset + wid, "nodes": [n for n, _ in nodes],
            "geometry": [{"lat": p[0], "lon": p[1]} for _, p in nodes], "tags": tags,
        }

    elements = []
    for r in range(ROWS):  # one long way per row
        tags = {"highway": "primary", "name": "Main Boulevard"} if r == 2 else (
            {"highway": "tertiary", "name": f"Cross Street {r}"} if r in (1, 4) else {"highway": "residential", "name": f"Row Lane {r}"}
        )
        elements.append(way(5000 + r, [(node_id(r, c), pos(r, c)) for c in range(COLS)], tags))
    for c in range(COLS):  # one long way per column
        if c == 3:
            tags = {"highway": "secondary", "name": "Central Avenue"}
        elif c == 6:
            tags = {"highway": "residential", "name": "One Way Street", "oneway": "yes"}
        else:
            tags = {"highway": "residential", "name": f"Column Street {c}"}
        elements.append(way(6000 + c, [(node_id(r, c), pos(r, c)) for r in range(ROWS)], tags))

    # a service road and an unnamed residential road hanging off the grid
    elements.append(way(7000, [(node_id(1, 1), pos(1, 1)), (id_offset + 9000, (pos(1, 1)[0] + 0.0010, pos(1, 1)[1]))], {"highway": "service", "name": "Depot Access"}))
    elements.append(way(7103, [(node_id(3, 2), pos(3, 2)), (id_offset + 9003, (pos(3, 2)[0], pos(3, 2)[1] + 0.0012))], {"highway": "residential"}))
    # ways that must NOT be imported
    elements.append(way(7100, [(id_offset + 9100, pos(2, 2)), (id_offset + 9101, (pos(2, 2)[0] + 0.0005, pos(2, 2)[1]))], {"highway": "footway", "name": "Pedestrian Path"}))
    elements.append(way(7101, [(node_id(2, 4), pos(2, 4)), (id_offset + 9102, (pos(2, 4)[0] + 0.0004, pos(2, 4)[1]))], {"highway": "service", "service": "driveway", "name": "Driveway X"}))
    elements.append(way(7102, [(node_id(4, 4), pos(4, 4)), (id_offset + 9103, (pos(4, 4)[0] + 0.0004, pos(4, 4)[1]))], {"highway": "service", "access": "private", "name": "Private Yard"}))

    def place(pid: int, r: int, c: int, tags: dict) -> dict:
        lat, lng = pos(r, c)
        return {"type": "node", "id": id_offset + pid, "lat": lat, "lon": lng, "tags": tags}

    places = [
        place(1, 0, 1, {"railway": "station", "name": "Test Central Station"}),
        place(2, 4, 5, {"amenity": "hospital", "name": "Test General Hospital"}),
        place(3, 5, 1, {"amenity": "college", "name": "Test College"}),
        place(4, 1, 5, {"shop": "mall", "name": "Test Mall"}),
        place(5, 3, 3, {"amenity": "school", "name": "Test School"}),
        place(6, 2, 0, {"amenity": "hospital", "name": "West Clinic Hospital"}),
    ]
    south, west = lat0 - 0.001, lng0 - 0.001
    north, east = lat0 + (ROWS - 1) * DLAT + 0.002, lng0 + (COLS - 1) * DLNG + 0.002
    return {
        "bbox": [south, west, north, east],
        "fetched_at": "2026-01-01T00:00:00+00:00",
        "attribution": "test fixture",
        "roads": {"elements": elements},
        "places": {"elements": places},
    }
