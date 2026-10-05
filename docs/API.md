# API reference

Interactive documentation (Swagger UI): **`/api/docs`** · ReDoc: `/api/redoc` · OpenAPI JSON: `/api/openapi.json`.
Protected endpoints need `Authorization: Bearer <token>` from one of the two login endpoints (the **Authorize** button in Swagger accepts it). **There is no default account**: the first administrator is created with `POST /api/auth/setup` and must verify their email. There are two doors - users (`/auth/login`) and Admin & Road Maintenance (`/auth/staff/login`); an account that uses the wrong one gets `403 wrong_portal` (only after a correct password). The role is always read from the database.

Access levels: *public* = no login; *user* = any signed-in account; *staff* = administrator or maintenance employee; *admin* = administrator only. Not signed in → `401`. Signed in but not allowed → `403` ("Access Denied — Administrator privileges are required to access this page." for a normal user, "Access Denied — Administrator privileges are required." for a maintenance employee).

| Method & path | Access | Purpose |
|---|---|---|
| `GET /api/auth/setup-status` | public | `{setup_required, setup_allowed_here, verification_pending, pending_email, email}` - `setup_required` is true until an administrator with a **verified** email exists (drives the first-run screen; `pending_email` is masked, and `email` = `{mode: "smtp"\|"outbox", host \| outbox_dir}` says where the verification mail goes - both only sent to the server computer while an account is waiting) |
| `POST /api/auth/setup/resend` | public, server computer only | no body: sends a fresh verification link to the waiting initial administrator (the earlier link stops working) → `{email (masked), message, delivery, outbox_dir?, delivery_error?}`; `409` if nobody is waiting |
| `POST /api/auth/setup` | public, first run only | `{full_name, email, password, confirm_password}` (`username` optional) creates the **unverified** initial administrator and emails a verification link → `201` `{created, email, verification_required, delivery: "smtp"\|"outbox", outbox_dir?, delivery_error?, message}` (`delivery_error` says why a configured mail server was not used; no token, nothing secret echoed). Running it again before verification replaces the unverified account. `409` once a verified administrator exists, `403` if not called from the server's own computer (`auth.setup_local_only`), `422` invalid or weak input |
| `POST /api/auth/register` | public (rate-limited) | `{full_name, email, password, confirm_password}` → creates a **normal user** (the role cannot be requested) and signs them in. A unique username is derived from the email |
| `POST /api/auth/login` | public (throttled) | **User door.** `{identifier, password}` (email; `email`/`username` accepted as aliases) → session response. `401` "Invalid email or password." for any failure; `403 wrong_portal` for a staff account (`detail` = `{message, code, portal: "staff", login_path: "/admin/login"}`); `429` after repeated failures |
| `POST /api/auth/staff/login` | public (throttled) | **Admin & Road Maintenance door** (administrators and maintenance staff share it). Same body. After a correct password the server checks, in order, the **account status** - `403` with `detail.code` `email_not_verified`, `pending_admin_approval`, `rejected` or `suspended` (each with `detail.message` and `detail.status`) - and then the role; a normal user gets `403 wrong_portal` → `/user/login`. The reply carries `home`: `/admin/dashboard` for an administrator, `/maintenance/dashboard` for maintenance staff |
| `POST /api/admin/login` | public (throttled) | The same checks as `/auth/staff/login` with the simpler reply `{success: true, message: "Login successful", user: {id, name, email, role: "ADMINISTRATOR"\|"ROAD_MAINTENANCE"}, token, ...}` (the session fields `access_token`, `expires_in`, `home` are included too). Body `{email, password}` (`identifier` works as well). Status codes: `401` wrong email or password, `403` email not verified / pending approval / rejected / suspended / normal user (`detail.code`), `429` throttled, `500` **only** for a genuine server or database failure |
| `POST /api/auth/staff/register` | public (rate-limited 5/min per IP) | **Request** an account from the Admin Portal: `{full_name, email, account_type: "admin"\|"maintenance", password, confirm_password}` → `201` `{created, email, status: "PENDING_EMAIL_VERIFICATION", requested_role, message, delivery, outbox_dir?, delivery_error?}`. Grants nothing: the row keeps `role: "user"`, `requested_role` is only a request, the password is hashed and a verification link is emailed. `409` if the email is taken **or no administrator exists yet** (nobody could approve; use `/setup`), `429` when `auth.max_pending_requests` are already waiting, `422` for weak/mismatched passwords or an invalid `account_type` |
| `POST /api/auth/verify-email` | public (rate-limited) | `{token}` from the verification email → `{verified, message, role, portal, login_path, home, status}`; for a registration request `status` becomes `PENDING_ADMIN_APPROVAL` (still cannot sign in); `400` if invalid, used or expired |
| `POST /api/auth/accept-invite` | public (rate-limited) | `{token, new_password, confirm_password}` from an invitation email: sets the invitee's own password and verifies the address |
| `POST /api/auth/resend-verification` | public (rate-limited) | `{email}` → identical reply for every address; only unverified staff accounts receive a new link |
| `GET /api/auth/me` | user | current account (`email_verified` included) |
| `POST /api/auth/logout` | user | revokes the token used for this request only |
| `PATCH /api/auth/profile` | user | `{full_name?, username?, email?, current_password}` (current password required to change username or email); `409` taken. Staff cannot change their verified email (`403`) |
| `POST /api/auth/change-password` | user | `{current_password, new_password, confirm_password}` → new session; every other session is revoked. `401` wrong current password, `422` weak / unchanged password, `429` too many wrong guesses |
| `POST /api/auth/logout-all` | user | revokes every session of the account |
| `POST /api/auth/forgot-password` | public (rate-limited) | `{identifier}` → `200` with the identical `{message}` whether or not the account exists; if it does, a single-use link (valid `auth.reset_minutes`, only its hash is stored) is emailed - or written to `backend/data/outbox/` when no SMTP server is configured. The link and the old password never appear in any response |
| `POST /api/auth/reset-password` | public (rate-limited) | `{token, new_password, confirm_password}` - `400` for an expired, used or unknown token, `422` for a weak password; on success every session of that account is revoked |
| `GET /api/admin/users` | admin | all accounts (requests waiting for approval first): role (`admin`/`maintenance`/`user`), `status` (`PENDING_EMAIL_VERIFICATION`, `PENDING_ADMIN_APPROVAL`, `ACTIVE`, `REJECTED`, `SUSPENDED`), `requested_role`, `invited`, assigned roads, reports, last login, `reviewed_at` |
| `POST /api/admin/users/{id}/approve` | admin | `{role?: "admin"\|"maintenance"}` - grants the requested role (or the one chosen here, which may be less) and makes the account `ACTIVE`; emails the person. `409` unless the request's email address is verified (a `REJECTED` request can be approved later), `422` without a valid role, `404` unknown id. Revokes the account's old tokens |
| `POST /api/admin/users/{id}/reject` | admin | `{reason?}` - marks a pending request `REJECTED` (the reason is emailed); `409` for an account that is already active (suspend it instead) |
| `POST /api/admin/users` | admin | `{full_name, email, role: "admin"\|"maintenance"}` - **the only way to create staff accounts**. The person gets an invitation email (valid `auth.invite_hours`) and sets their own password. `409` duplicate email → `201` row + `delivery` |
| `POST /api/admin/users/{id}/resend` | admin | new invitation / verification link for an unverified staff account |
| `PATCH /api/admin/users/{id}` | admin | `{role?: admin\|maintenance\|user, is_active?}` - `is_active: false` is **SUSPENDED**, `true` reactivates. Cannot change yourself, cannot remove the last active administrator; promoting a user to staff sends a verification link; revokes that user's sessions (and, when leaving the maintenance role, their road assignments). Registration requests are decided with `/approve` and `/reject` (`409` here) |
| `GET /api/reports/mine` | user | reports submitted while signed in |
| `POST /api/reports` | user (a guest gets `401` while `auth.require_login_to_report` is on; rate-limited) | multipart: `image`, `lat`, `lng`, `road_name`, `description`, `reported_at`, `severity_confirmation` → detection, severity, road record, prediction, priority |
| `POST /api/detect` | public (rate-limited) | detection + severity for an image **without storing it**; annotated image returned as a data URL |
| `GET /api/reports` | admin | paginated reports with photo links (`road_id`, `level`, `source`, `limit`, `offset`) |
| `GET /api/reports/{id}` | public* | one report (*photo links only for admins) |
| `GET /api/network` | public | **every road segment in a map view** (`south,west,north,east,zoom`): geometry, name, class, state `GOOD/MODERATE/HIGH_RISK/CRITICAL/UNKNOWN`, plus condition fields only for roads with data; junctions; per-state counts |
| `GET /api/network/info` | public | segments loaded, how many have RoadMind data (coverage), bounds, attribution |
| `GET /api/network/match?lat&lng[&radius]` | public | which road segment a report at that point would attach to (and its state) |
| `POST /api/network/import` | public (rate-limited) | `{south,west,north,east}` load the OpenStreetMap network for an area (size-limited, skipped if already loaded) |
| `GET /api/roads` | public | only the roads that HAVE RoadMind data, with summary fields (UNKNOWN roads are not listed) |
| `GET /api/roads/{id}` | public* | any segment: state, and for roads with data prediction + factors, priority, history, repairs, recent reports (*notes and photos for admins); an UNKNOWN road returns `state: UNKNOWN` with null prediction/priority |
| `GET /api/map/config` | public | which map engine to use: `{google: {js_api_key \| null, routes_enabled}, traffic, default_center, default_zoom, tiles, simulated_data, refresh_seconds}`. Only the **browser** key is ever returned; the server key (Routes API) never leaves the server |
| `GET /api/road-conditions` | public | **overlay only**: the roads that HAVE RoadMind data, optionally inside `south,west,north,east`: `road_id`, `road_name`, `lat`/`lng`, `geometry`, `state` (`GOOD/MODERATE/HIGH_RISK/CRITICAL`), `damage_type`, `severity`, `ai_confidence`, `pothole_count`, `crack_count`, `report_count`, `last_report_at`, `risk_percent`, `maintenance_status`; plus `counts`, `total_with_data`, `updated_at`. An empty list (`message: "No RoadMind condition data available in this area."`) is a normal answer - the base map never depends on it |
| `GET /api/traffic` | public | `{provider, layer_available, routing_available, message}` - where live traffic can come from (Google). RoadMind stores and fabricates no traffic |
| `GET /api/road-events/active` | public | live road events (`south,west,north,east`, `verified_only`): `event_type` (`ROAD_BLOCKED`, `ROAD_CLOSED`, `CONSTRUCTION`, `ACCIDENT`, `FLOODED`, `SEVERE_DAMAGE`, `TEMPORARY_CLOSURE`; `ROAD_REOPENED` is a record only), `headline` (🚧 BLOCKED / ⛔ ROAD CLOSED…), `description`, `lat`/`lng`/`radius_m`, `created_at`, `expires_at` (= expected reopening), `verification_status` `PENDING\|VERIFIED\|REJECTED`, `status` `ACTIVE\|RESOLVED\|EXPIRED`, `is_blocking`, `evidence_url`, `reported_by: {kind}` (no personal data). Expired, resolved and rejected events never appear |
| `GET /api/road-events` | staff | every event with review state and names (`verification`, `status`, `event_type`, `source`, `limit`, `offset`); reports needing a decision first |
| `POST /api/road-events` | staff | record an event / mark a road blocked or **reopened** (`ROAD_REOPENED` resolves the live blockages within its radius): `{event_type, lat, lng, road_name?, description?, hours?\|expires_at?, radius_m?, geometry?}` → VERIFIED at once, still expires |
| `PATCH /api/road-events/{id}` · `/verify` · `/resolve` | staff | update wording / duration / radius (construction progress) · `{approved, note?, hours?}` verify or reject a report · `{note?}` resolve ("road reopened") |
| `POST /api/road-events/{id}/evidence` | staff | attach a photo (validated, EXIF stripped) |
| `POST /api/road-reports` | user (guests `401` while `auth.require_login_to_report`) | multipart: `report_type` (`POTHOLE`, `CRACK`, `FLOODING`, `ACCIDENT`, `BLOCKED_ROAD`, `CONSTRUCTION`, `DANGEROUS_CONDITION`), `lat`, `lng`, `road_name`, `description`, `image`. Potholes / cracks (photo required) and dangerous conditions go through the AI damage detector → `kind: "damage"`; the others (and dangerous conditions) become a **PENDING** event → `kind: "event"`. Community reports never block a route by themselves |
| `GET /api/road-reports` · `/mine` | staff · user | community event reports with their review state · what you reported and what became of it |
| `POST /api/routes/calculate` | public (rate-limited) | `{origin:{lat,lng,name?}, destination:{…}, departure_time?}` → **traffic-aware routes scored by RoadMind**. Routes come from the Google Routes API when `GOOGLE_MAPS_API_KEY` is set, else RoadMind's own routing with `traffic.available: false`. Each route: `distance_km`, `duration_min` (live traffic), `delay_min`, `traffic_level` (`Normal/Moderate/Heavy/Traffic jam/Unknown`), `traffic_segments` (Google speed readings), `traffic_risk`, `road_damage_risk`, `predicted_damage_risk`, `blockage_risk`, `risk` = RoadMind Route Risk Score `0.30·traffic + 0.25·damage + 0.15·predicted + 0.30·blockage` (configurable; unavailable parts are left out), `blocked`/`blocked_by`, `status` `RECOMMENDED\|ALTERNATIVE\|AVOID`, `data_coverage`, `reason`. Top level: `selected` (the fastest route), `recommended`, `summary`, `alert` (`🚧 ROAD BLOCKED` + the alternative, when the selected route has a verified blockage), `messages`, `traffic`, `disclaimer`. `422` no drivable route; `503` "Unable to calculate routes right now." |
| `GET /api/emergency/nearby?kind&lat&lng[&limit][&radius_km]` | public (rate-limited) | **Emergency Route Mode.** `kind` = `hospital`, `fire_station` or `police`; a position is required (never assumed). Real places from Google Places (New) when `GOOGLE_MAPS_API_KEY` is set, else OpenStreetMap (stored places + live Overpass query). Each: `name`, `lat/lng`, `address`, `distance_km` (straight line), `route_distance_km` + `eta_min` (nearest few only: Google Route Matrix, traffic-aware → `eta_traffic_aware: true`; else RoadMind's own routing, `false`; `null` = none could be computed), and `open_now` / `opening_hours` / `has_emergency` / `phone` **only when the source states them**. Sorted nearest-in-time first. `503` "Unable to find nearby hospitals right now."; empty list + `message` is a normal answer. Cached for `emergency.cache_seconds` |
| `POST /api/emergency/route` | public (rate-limited) | `{origin, destination, destination_kind?, current?: {distance_km, duration_min}}` → the best **available** emergency route. Routes with a **verified live closure are `UNAVAILABLE`** (`emergency_score: null`, never recommended; if all are closed `recommended` is `null`). The rest get the Emergency Route Score `0.45·travel_time + 0.20·traffic + 0.15·road_damage + 0.10·flood + 0.10·other` (`emergency.weights`; unavailable parts are left out) and `risk` (RoadMind risk without travel time). Each route also has `steps_available` and `steps` (`[{index, instruction, maneuver, distance_m, duration_s, start, end}]` - turn-by-turn from Google only, `[]` otherwise; requested only here, never by `/routes/calculate`). Also `alert` (🚧 ROAD BLOCKED + `alternative` with `extra_km` / `extra_min` / `delta_text` against `current` or the fastest route), `messages`, `live_data`, `recheck` (intervals), `disclaimer`. `422` no route, `503` "Unable to calculate the route right now." |
| `GET /api/emergency/events` | public | live road events for emergency routing, closures first; `blocking_count` = verified closures (the only events that make a route unavailable) |
| `POST /api/emergency/route-status` | public (rate-limited) | `{geometry: [[lat,lng],…], known_event_ids?}` → `{status: OK\|BLOCKED\|CHANGED, message, blocking_events, new_events, ended_event_ids, event_ids, next_check_s}`. **Database only - no Google call** - so an active route can be checked every minute |
| `POST /api/routes/recommend` | public (rate-limited) | `{origin:{lat,lng,name}, destination:{…}, weights?:{distance,time,damage_risk}}` → routes computed on the complete network, each with `risk` (null = unknown), `data_coverage`, `unknown_km`, `damage_level` (incl. `Unknown`), `recommendation` and `reason` |
| `GET /api/routes/places` | public | stored OpenStreetMap places, map centre/bounds, suggested trips, default route weights |
| `GET /api/routes/geocode?q=` | public | place search (stored OpenStreetMap places, then Nominatim if enabled) |
| `GET /api/maintenance/priorities` | admin | ranked roads; `sort`, `order`, `category`, `status`, `q` |
| `PATCH /api/maintenance/{road_id}` | admin | `{status: pending\|inspected\|repair_planned\|repair_completed, notes?, planned_date?}` |
| `POST /api/maintenance/refresh` | admin | recompute severity, risk and priority for every road |
| `GET /api/maintenance/assignees` | admin | active, verified maintenance employees with how many roads each has |
| `PUT /api/maintenance/{road_id}/assignment` | admin | `{user_id}` assigns a road to a maintenance employee (`null` clears it); `422` if the person is not an active, verified maintenance employee |
| `GET /api/staff/summary` | staff | counts for the maintenance dashboard (assigned roads, immediate priority, awaiting inspection, repairs planned/completed, photos) and the top roads needing attention |
| `GET /api/staff/roads` | staff | roads **assigned to you** (every road for an administrator); `status`, `q`, `sort`, `order` |
| `GET /api/staff/roads/{id}` | staff | one road with prediction, priority breakdown, notes, repairs, reports with photos and `evidence`; `403` if not assigned to you |
| `PATCH /api/staff/roads/{id}/status` | staff | `{status: inspected\|repair_planned\|repair_completed, notes?, planned_date?}` - recalculates severity, risk and priority. Only administrators may set `pending` |
| `POST /api/staff/roads/{id}/notes` | staff | `{note}` appended to the road's signed, dated log |
| `POST /api/staff/roads/{id}/evidence` | staff | multipart `image`, `kind` (`inspection`\|`repair`), `caption` - validated like report photos (type, size, real image, EXIF stripped) |
| `GET /api/staff/reports` | staff | damage reports on your roads (`road_id`, `level`, `limit`, `offset`) |
| `GET /api/analytics/public-summary` | public | headline counters |
| `GET /api/analytics/overview` · `damage` · `predictions` · `routes` | admin | dashboard data |
| `GET /api/system/info` | public | running detector, model metrics, formulas, disclaimers |
| `GET /api/samples` | public | generated sample photos |
| `GET /api/health` | public | liveness |

## Examples

```bash
# log in with the administrator you created at /setup (replace the placeholders)
TOKEN=$(curl -s localhost:8000/api/auth/login -H 'Content-Type: application/json' \
        -d '{"identifier":"YOUR_USERNAME_OR_EMAIL","password":"YOUR_PASSWORD"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# submit a report
curl -s localhost:8000/api/reports -F image=@data/sample_images/large_pothole.jpg -F lat=13.0704 -F lng=80.2616 \
     -F description="Deep hole near the junction"

# compare routes
curl -s localhost:8000/api/routes/recommend -H 'Content-Type: application/json' \
     -d '{"origin":{"lat":13.0637,"lng":80.2512},"destination":{"lat":13.0841,"lng":80.2786}}'

# roads ranked by maintenance priority
curl -s -H "Authorization: Bearer $TOKEN" "localhost:8000/api/maintenance/priorities?sort=priority&order=desc"
```

### Session response (login, register, change-password)

```json
{ "access_token": "<jwt>", "token_type": "bearer", "expires_in": 28800,
  "user": { "id": 1, "username": "…", "full_name": "…", "email": "…", "role": "admin", "is_active": true, "email_verified": true },
  "home": "/admin/dashboard" }
```

`home` is where that role lands after signing in, decided by the server: `/admin/dashboard`, `/maintenance/dashboard` or `/user/home`.

The token is a signed JWT (`sub` = user id, `role`, `tv` = token version, `exp`). Raising the user's token version - password change/reset, deactivation, role change, "sign out everywhere" - invalidates every token issued before.

### Report response (abridged; the values are illustrative)

```json
{
  "report_id": 241,
  "damage_detected": true,
  "location": { "road_id": 17, "road_name": "Example Road", "road_was_unknown": true, "network_loaded": false, "new_road_created": false },
  "detection": { "detector": "OpenCV heuristic detector (demo mode)", "count": 1,
                 "detections": [{ "label": "pothole", "confidence_percent": 94, "bbox": {"x1": 410, "y1": 250, "x2": 502, "y2": 322} }],
                 "annotated_image_url": "/media/reports/….jpg" },
  "severity": { "score": 46.4, "level": "Moderate", "summary": "Medium pothole", "breakdown": {"size": 21.9, "type": 23.5, "count": 2.5, "history": 0.0} },
  "prediction": { "risk_percent": 56, "level": "MEDIUM", "factors": [{ "label": "Rainfall (last 30 d)", "effect_points": 29.0 }] },
  "priority": { "score": 47.0, "category": "Medium Priority", "action": "Add to the next maintenance cycle …" }
}
```

### Errors

`400` unusable image (empty, too small) · `413` too large · `415` not a valid JPEG/PNG/WebP · `401` login required (or wrong credentials) · `403` signed in but not an administrator, or first-run setup from another computer · `422` invalid fields or no route possible (for example outside the loaded road network while offline) · `429` rate limit or too many failed logins · `503` online routing service unreachable.

`500` is reserved for real server failures and always has a JSON body `{"detail": {"message", "code", "request_id"}}`: login failures use `code: "auth_error"` and an id like `AUTH-3FA91C`, any other unexpected error `code: "server_error"` and `ERR-…`. The message is generic; the exception, the failing step (for login) and the traceback are in the server log next to the same request id, and the password is never logged. Login attempts are logged one line each: `[ADMIN LOGIN] Email: … | Step: password verification | Result: 401 wrong password`.
