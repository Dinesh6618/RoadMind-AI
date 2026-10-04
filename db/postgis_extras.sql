-- Optional PostGIS enhancements for RoadMind (reference only - NOT executed in the dev environment).
--
-- The application stores road geometry as a JSON list of [lat, lng] pairs so the same code runs on
-- SQLite and PostgreSQL. On PostgreSQL you can mirror it into a real geometry column and use spatial
-- indexes for matching reports to roads and routes to roads at scale.
--
-- Run after the application has created its tables (it does so on first start):
--   psql -U roadmind -d roadmind -f db/postgis_extras.sql

CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. A geometry column kept in sync with roads.geometry ([[lat, lng], ...]).
ALTER TABLE roads ADD COLUMN IF NOT EXISTS geom geometry(LineString, 4326);

UPDATE roads r
SET geom = ST_SetSRID(
  ST_MakeLine(ARRAY(
    SELECT ST_MakePoint((p ->> 1)::float8, (p ->> 0)::float8)      -- lng, lat
    FROM json_array_elements(r.geometry::json) AS p
  )), 4326)
WHERE geom IS NULL;

CREATE INDEX IF NOT EXISTS roads_geom_gix ON roads USING GIST (geom);

-- The map's "roads in view" query is already a bounding-box filter on roads.min_lat/max_lat/min_lng/max_lng (indexed),
-- so it works without PostGIS; ST_Intersects(geom, ST_MakeEnvelope(:west, :south, :east, :north, 4326)) is the spatial equivalent.
--
-- 2. Example: the road nearest to a reported point, within 60 m (what services.pipeline.match_or_create_road does).
--   SELECT id, name, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography) AS metres
--   FROM roads
--   WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, 60)
--   ORDER BY metres LIMIT 1;

-- 3. Example: roads a candidate route passes within 25 m of (what the route engine does in Python).
--   SELECT r.id, r.name, r.current_severity
--   FROM roads r
--   WHERE ST_DWithin(r.geom::geography, ST_SetSRID(ST_GeomFromGeoJSON(:route_geojson), 4326)::geography, 25);
