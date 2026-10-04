from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..security import RateLimit, get_db
from ..services import network as net
from ..services import osm

router = APIRouter(prefix="/network", tags=["Road network (base map)"])
_import_limit = RateLimit(4, 60)


class ImportRequest(BaseModel):
    south: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)


@router.get("", summary="Every road segment in a map view, with RoadMind condition where it exists")
def segments_in_view(
    request: Request,
    south: float = Query(..., ge=-90, le=90),
    west: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    zoom: int = Query(15, ge=0, le=22),
    db: Session = Depends(get_db),
):
    """The complete base network for the view. Segments RoadMind has no data for come back with state
    `UNKNOWN` - they are neither good nor damaged. Only zoom-based generalisation (hiding minor
    service streets on wide views) ever omits a road, and it applies to all roads alike except that
    roads with RoadMind data are always included.
    """
    if not (south < north and west < east):
        raise HTTPException(422, "Invalid view box")
    if (north - south) > 1.0 or (east - west) > 1.0:
        raise HTTPException(422, "View too large - zoom in")
    return net.network_in_bbox(db, request.app.state.app_state, south, west, north, east, zoom)


@router.get("/info", summary="What network is loaded and how much of it has RoadMind data")
def info(request: Request, db: Session = Depends(get_db)):
    return net.network_info(db, request.app.state.app_state)


@router.get("/match", summary="Which road segment a report at this point would be attached to")
def match(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius: float | None = Query(None, ge=1, le=1000, description="search radius in metres (default: the report-matching radius)"),
    db: Session = Depends(get_db),
):
    return net.match_point(db, request.app.state.app_state, lat, lng, radius)


@router.post("/import", summary="Load the OpenStreetMap road network for an area", dependencies=[Depends(_import_limit)])
def import_area(body: ImportRequest, request: Request, db: Session = Depends(get_db)):
    """Fetches roads and named places for the box from OpenStreetMap (Overpass API) and adds any
    missing segments as UNKNOWN roads. Areas already loaded are skipped; the box is size-limited."""
    state = request.app.state.app_state
    try:
        res = osm.import_bbox(db, state.settings, (body.south, body.west, body.north, body.east))
    except osm.NetworkImportError as exc:
        raise HTTPException(422 if "too large" in str(exc) or "Invalid" in str(exc) or "disabled" in str(exc) else 503, str(exc)) from None
    return {
        "already_loaded": res.notes == ["already loaded"],
        "segments_added": res.segments_added,
        "segments_replaced": res.segments_replaced,
        "places_added": res.places_added,
        "attribution": osm.ATTRIBUTION,
    }
