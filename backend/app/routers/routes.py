
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Place, RouteQuery
from ..schemas import RouteRequest
from ..security import RateLimit, get_db
from ..services import network as net
from ..services.routing import geocode
from ..services.routing.types import RoutingUnavailable

router = APIRouter(prefix="/routes", tags=["Route planner"])
_limit = RateLimit(60, 60)

# Kinds worth suggesting in the start/destination drop-down (all named places remain searchable).
FEATURED = ("station", "hospital", "college", "university", "school", "mall", "marketplace")


@router.post("/recommend", summary="Compare routes and recommend the lower-risk one", dependencies=[Depends(_limit)])
def recommend(body: RouteRequest, request: Request, db: Session = Depends(get_db)):
    """Gets candidate routes from the configured provider (RoadMind's graph of the complete stored road
    network, or OSRM), reads each against RoadMind's condition data and ranks them with the configurable
    route score `w_distance*extra_distance + w_time*extra_time + w_damage*road_damage_risk` (lower is better).

    Stretches without RoadMind data are reported as unknown, not as good or damaged.
    """
    engine = request.app.state.app_state.route_engine
    weights = body.weights.model_dump(exclude_none=True) if body.weights else None
    try:
        return engine.recommend(
            db,
            (body.origin.lat, body.origin.lng),
            (body.destination.lat, body.destination.lng),
            origin_name=body.origin.name,
            destination_name=body.destination.name,
            weights=weights,
        )
    except RoutingUnavailable as exc:
        raise HTTPException(503 if exc.retryable else 422, str(exc)) from None


@router.get("/places", summary="Suggested places, map centre and default route weights")
def places(request: Request, db: Session = Depends(get_db)):
    state = request.app.state.app_state
    info = net.network_info(db, state)
    rows = db.scalars(select(Place).where(Place.kind.in_(FEATURED)).order_by(Place.name).limit(150)).all()
    center = info["center"] or [13.0735, 80.2645]

    # trips worth showing first: the ones with the most (simulated) route history, resolved to stored places
    by_name = {}
    for p in db.scalars(select(Place)):
        by_name.setdefault(p.name, p)
    top = db.execute(
        select(RouteQuery.origin_name, RouteQuery.dest_name, func.count().label("n"))
        .where(RouteQuery.source == "seed", RouteQuery.origin_name != "")
        .group_by(RouteQuery.origin_name, RouteQuery.dest_name)
        .order_by(func.count().desc())
        .limit(3)
    ).all()
    trips = [
        {"origin": {"name": o, "lat": by_name[o].lat, "lng": by_name[o].lng}, "destination": {"name": d, "lat": by_name[d].lat, "lng": by_name[d].lng}}
        for o, d, _ in top
        if o in by_name and d in by_name
    ]
    return {
        "center": {"lat": center[0], "lng": center[1]},
        "bounds": info["bounds"],
        "places": [{"name": p.name, "kind": p.kind, "lat": p.lat, "lng": p.lng} for p in rows],
        "suggested_trips": trips,
        "default_weights": state.settings.routing.weights,
    }


@router.get("/geocode", summary="Search places (stored OpenStreetMap places first, then Nominatim if enabled)")
def search_places(request: Request, q: str = Query(..., min_length=2, max_length=120), db: Session = Depends(get_db)):
    return geocode.search(db, q, request.app.state.app_state.settings.geocoding)
