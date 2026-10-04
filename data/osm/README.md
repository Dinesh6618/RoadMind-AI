# OpenStreetMap extract (base road network)

`demo_area.json` is the road network and named places for the demo area (central Chennai, bounding box
S 13.0600, W 80.2500, N 13.0870, E 80.2790), downloaded from the public Overpass API. The download time is in
its `fetched_at` field. RoadMind loads it on first start so the complete road network is available offline.

**Map data (c) OpenStreetMap contributors, available under the Open Database Licence (ODbL)** -
<https://www.openstreetmap.org/copyright>. If you redistribute this file or anything derived from it, keep that
attribution and the same licence for the data.

Contents: every `highway` way that motor vehicles can use (motorway ... service, including `_link` roads) with full
geometry and node ids, minus footways/paths, driveways, parking aisles and private/no-access ways; plus named
hospitals, clinics, colleges, schools, stations, malls and marketplaces.

Refresh or choose another area:

```
python scripts/fetch_osm.py                                  # re-download the default area
python scripts/fetch_osm.py --bbox S W N E --out data/osm/my_area.json   # keep each side under ~0.06 degrees
```

then point `network.source_file` in `config/roadmind.yaml` at the file and delete `backend/data/` so it is re-imported.
More areas can also be loaded while the app runs ("Load missing roads here" on the maps).
