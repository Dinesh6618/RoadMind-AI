"""Place search: named places already in RoadMind's database (from OpenStreetMap), then optional online search."""

from __future__ import annotations

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import GeocodingConfig
from ...models import Place


def _like(q: str) -> str:
    # escape LIKE wildcards typed by the user
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def search(db: Session, query: str, cfg: GeocodingConfig, limit: int = 6) -> list[dict]:
    q = query.strip()
    if not q:
        return []
    rows = db.scalars(select(Place).where(Place.name.ilike(_like(q), escape="\\")).order_by(Place.name).limit(limit))
    results = [{"name": p.name, "lat": p.lat, "lng": p.lng, "kind": p.kind, "source": "network"} for p in rows]
    if cfg.nominatim_enabled and len(results) < limit:
        try:
            resp = httpx.get(
                f"{cfg.nominatim_url.rstrip('/')}/search",
                params={"q": query, "format": "json", "limit": limit - len(results)},
                headers={"User-Agent": "RoadMind-AI/1.0 (college project)"},
                timeout=cfg.timeout_s,
            )
            resp.raise_for_status()
            for item in resp.json():
                results.append(
                    {"name": item.get("display_name", query)[:140], "lat": float(item["lat"]), "lng": float(item["lon"]), "kind": item.get("type", "place"), "source": "osm"}
                )
        except (httpx.HTTPError, ValueError, KeyError):
            pass  # offline or rate-limited: the stored places above still work
    return results[:limit]
