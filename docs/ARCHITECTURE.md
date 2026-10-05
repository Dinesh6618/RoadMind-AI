# Architecture, data model and formulas

## The principle: a real-world map underneath, RoadMind intelligence on top

```
                 GOOGLE MAPS (browser)                          OpenStreetMap tiles (fallback when there is no Google key)
        complete real road network, names, live traffic layer  -> the map ALWAYS shows every real road
                                |
              RoadMind overlays, fetched separately - their absence never hides the map
   /api/road-conditions   roads that HAVE data: damage, severity, risk, maintenance   (colour only there; every other road keeps the
   /api/road-events       blockages, closures, construction... (verified / pending)    normal base-map look = "condition data unavailable")
                                |
              SMART ROUTES  POST /api/routes/calculate
   Google Routes API (traffic-aware alternatives)  +  road condition  +  verified events  ->  RoadMind Route Risk Score
```

* **The base map is never built from RoadMind's own road table.** `frontend/src/maps/MapCanvas.jsx` renders the map as soon as the map engine is ready - Google Maps when a browser key exists, otherwise Leaflet with OpenStreetMap tiles - and only then asks the backend for overlays. Zero RoadMind records, an empty database or a failing RoadMind API leave the real roads fully visible; the status box says "RoadMind data: No data for this area".
* **Nothing live is invented.** Traffic is Google's (Traffic Layer in the browser; speed readings from the Routes API on the server). Without Google the answer says "Live traffic unavailable". Events come only from reports and staff; every event expires.
* The older **OpenStreetMap import** (`services/osm.py` → `roads` table) still exists: it gives reports a road to attach to, feeds RoadMind's offline routing and is used to match Google routes to roads that have condition data. It is no longer the source of the map.

### The roads table (RoadMind's own record of roads it has data about)

* `services/osm.py` imports drivable OpenStreetMap ways, cuts them at junctions into *segments* and stores them in `roads`. A freshly imported segment has `has_data = false`, no severity, no prediction and no priority - it is **UNKNOWN**.
* **RoadMind is the overlay**: reports are attached to a segment; only then does the segment get a current severity, a stored prediction and a maintenance priority (`has_data = true`).
* **UNKNOWN is a state, not a score.** Nothing downstream treats it as good or as damaged: the map draws it grey, the API returns it without condition fields, analytics and the maintenance list cover only roads with data, and the route engine reports it as unknown (see below).
* A road drops back to UNKNOWN when its last report is older than `road_condition.history_window_days` (180 d) and it has no repair within that window.

## Request flow for a new report

```
POST /api/reports  (image, lat, lng, road name, description, time, optional severity confirmation)
  1. services/images.py     validate size / real image / format / dimensions; fix orientation; strip EXIF
  2. detector.detect()      ai/…/detection      -> damage type, confidence, box for every damaged area
  3. match_or_create_road   nearest road SEGMENT within 60 m; if none, fetch the OpenStreetMap network around the
                            point (when enabled) and retry; only then create a short stub road
  4. severity.assess()      ai/…/severity.py    -> 0-100 score, level, breakdown (uses recent reports on the road)
  5. store                  road_reports + damage_detections + annotated image
  6. refresh_roads()        data status -> current severity -> features -> risk model -> priority score
                            appends to predictions, upserts maintenance_priorities, writes road_condition_history
  7. response               detection, severity, road record (state, was it unknown before?), risk, priority
```

## Entities

```
users                         accounts: full name, unique email (+ a derived handle), Argon2id hash, role admin|maintenance|user,
                                  is_active (false = SUSPENDED), email_verified_at, must_set_password (invited, no password yet),
                              created_by_id, approval_status ACTIVE|PENDING_EMAIL|PENDING_APPROVAL|REJECTED, requested_role (only a
                              REQUEST), reviewed_by_id/reviewed_at, token_version (revokes sessions), last_login_at
email_tokens        N:1 users          SHA-256 of an emailed verification / invitation token, purpose, expiry, used_at (single use)
password_resets     N:1 users          SHA-256 of the emailed reset token, expiry, used_at (single use)
revoked_tokens                         ids (jti) of logged-out session tokens, kept until they would have expired anyway
road_assignments    N:1 roads, users   which maintenance employee is responsible for a road (one per road)
repair_evidence     N:1 roads, users   photos uploaded by maintenance staff (inspection / repair), caption, who, when
roads                         one network SEGMENT between junctions: OSM way id/seq, node ids, highway class, one-way,
                              geometry JSON [[lat,lng],…] + indexed bounding box, estimated age/traffic/rainfall,
                              facilities nearby, last repair, has_data + cached current severity
places                        named OpenStreetMap places (hospitals, schools, stations...) for route search + facility counts
network_areas                 bounding boxes whose network has been imported (avoids re-fetching)
road_reports        N:1 roads one row per submitted photo (severity, level, summary, image paths, source user|seed)
damage_detections   N:1 road_reports   label, confidence, box, area ratio
road_condition_history  N:1 roads      severity snapshots over time (report / repair events)
repairs             N:1 roads          planned / completed, dates, notes
predictions         N:1 roads          risk probability, level, model name/version, input features, explanation
maintenance_priorities  1:1 roads      priority score, category, action, status, notes, score components
road_events         N:1 roads (optional) blockages, closures, construction, accidents, flooding, severe damage: point + radius, type, description,
                                       verification_status PENDING|VERIFIED|REJECTED, status ACTIVE|RESOLVED|EXPIRED, expires_at, evidence photo
route_queries       1:N route_options  every comparison asked, provider (network | osrm | google), weights used
route_options                          per-route distance, time, effective risk, data coverage, score, label, geometry
```

Geometry is stored as JSON with an indexed bounding box so the same code runs on SQLite and PostgreSQL (the map's "roads in view" query is a bounding-box filter). [`db/postgis_extras.sql`](../db/postgis_extras.sql) shows how to mirror it into a PostGIS column with a GIST index (untested).

## Authentication and authorisation

The first screen (`/`) asks "Who are you?" and offers two doors - and the server is the only authority on who may walk through:

```
                       RoadMind AI  "Who are you?"
                       /                          \
              USER door                    ADMIN & ROAD MAINTENANCE door
         /user/login (+ /user/register)          /admin/portal  (Admin Portal home: Login | Create Account)
                 |                                    |                          |
     POST /auth/login (role "user")           /admin/login (both roles)    /admin/register
                 |                                    |                          |
             /user/home        POST /auth/staff/login: password ► account status ► role
                                                      |             (verified? approved? not rejected/suspended?)
                                      role admin ──► /admin/dashboard
                                      role maintenance ──► /maintenance/dashboard

first administrator:  /setup ─► unverified admin + emailed link ─► link opened ─► verified ─► /admin/login
staff by invitation:  admin invites (name, email, role) ─► emailed invitation ─► invitee sets own password (= verification) ─► /admin/login
staff by request:     /admin/register ─► PENDING_EMAIL_VERIFICATION ─► link opened ─► PENDING_ADMIN_APPROVAL
                                          ─► administrator approves ─► ACTIVE (role granted by the administrator) ─► /admin/login
                                          ─► administrator rejects  ─► REJECTED
```

* **No built-in credentials.** `users` is empty on a new database. `POST /api/auth/setup` is the only way the first administrator appears; it refuses once a *verified* administrator exists (atomic under a lock) and, by default, from any address except the server's own (`auth.setup_local_only`). Until the emailed link is opened the account exists but cannot sign in, and running setup again replaces it (a mistyped address cannot lock anyone out). At start-up `purge_legacy_admins` deletes administrator rows that have no email address - that is how the old built-in `admin` of earlier builds is removed. `ensure_schema` adds new columns to an existing database without touching its data.
* **Only an administrator creates staff.** `POST /api/admin/users` creates an administrator or maintenance account with a random placeholder password hash and `must_set_password`; the invitee's emailed link (`email_tokens`, purpose `invite`) sets their own password and verifies the address in one step. Promoting a normal user to staff sends a verification link first. There is no public endpoint that can produce a staff role (`/auth/register` always creates `user`, and ignores any `role` field).
* **Registration is a request.** `POST /api/auth/staff/register` (public, rate-limited, only once an administrator exists to approve) stores the person as `role = "user"` with `approval_status = PENDING_EMAIL` and the chosen account type in `requested_role` - a request, never a privilege; the role in the body is not trusted for anything else. Opening the emailed link (`verify-email`) moves it to `PENDING_APPROVAL`. Only `POST /api/admin/users/{id}/approve` (administrator) writes a staff `role`, taking the administrator's choice (default: the requested one), setting `ACTIVE`, bumping `token_version` and emailing the person; `/reject` marks it `REJECTED`. `accounts.status_of()` derives the five displayed states (`PENDING_EMAIL_VERIFICATION`, `PENDING_ADMIN_APPROVAL`, `ACTIVE`, `REJECTED`, `SUSPENDED`) from `approval_status`, `is_active`, `email_verified_at` and `must_set_password`.
* **Portal separation.** `_portal_login` checks the password first (constant-time work even for unknown accounts), then the **account status** (`403` with a code: `email_not_verified`, `pending_admin_approval`, `rejected`, `suspended`), then the portal: a staff account at the user door - or a normal user at the staff door - gets `403 wrong_portal` with the right address (only revealed after a correct password). `_user_from_token` also refuses tokens of inactive, unverified or not-yet-approved accounts, so a session can never outlive its verification or approval.
* **Hashing.** `security.py`: Argon2id via `argon2-cffi` with a per-password random salt. Legacy `scrypt$…` hashes still verify and are re-hashed at the next successful login. A dummy hash is verified when the account does not exist so response time does not reveal valid accounts.
* **Sessions.** HS256 JWT: `sub` (user id), `role`, `tv` (token version), `jti`, `exp` (8 h for users, 4 h for staff). Every request re-reads the user, so a deactivated account, a changed role or a token with an old `tv` is rejected at once; `POST /auth/logout` records the `jti` in `revoked_tokens`, so a logged-out token is dead even before it expires. `token_version` is incremented on password change/reset, deactivation, role change and "sign out everywhere". The signing key is `ROADMIND_SECRET_KEY` or a generated `backend/data/secret.key`. Tokens are sent in the `Authorization` header, not cookies, so CSRF does not apply; `X-Frame-Options: DENY` and `Cache-Control: no-store` (on `/api/auth|admin|staff`) are set on responses.
* **Authorisation.** FastAPI dependencies: `current_user` (401 if not signed in), `require_admin` (403, with a different message for normal users and maintenance staff), `require_staff` (administrators + maintenance employees, 403 for users), `optional_user` (public endpoints that link a report to the account if a token is present). Every `/api/admin/*`, `/api/maintenance/*`, analytics and system endpoint is admin-only. `/api/staff/*` is the work API: a maintenance employee is scoped to the roads in `road_assignments` (`403 This road is not assigned to you`), an administrator sees every road. The React app also guards its routes (`RequireAdmin`, `RequireMaintenance`, `RequireAuth`), but that is only a courtesy - the API refuses the same requests.
* **Guests.** Anonymous visitors can use every read endpoint, routing and `POST /api/detect` (an AI preview that stores nothing). Storing a report needs an account while `auth.require_login_to_report` is on (default).
* **Password policy.** Minimum length (`auth.min_password_length`, 10), maximum 128, a list of common passwords and common words (including with digits/symbols added or one or two letters either side), may not contain the username or the email name, not digits only / few unique characters. The checks run on the server; the form repeats the easy ones for instant feedback.
* **Verification, invitation and reset links.** `secrets.token_urlsafe(32)`; only `SHA-256(token)` is stored; one live link per user and purpose; expiry (`auth.verify_hours` 48, `auth.invite_hours` 72, `auth.reset_minutes` 30); used once; generic replies that never reveal whether an address has an account; sent from a background task where the reply must not depend on mail delivery. `services/mailer.py` sends through SMTP when `email.smtp_host` is set (from `config/roadmind.yaml`, a git-ignored `.env`, or `ROADMIND_SMTP_*` variables - the password only from the environment/`.env`), otherwise - or when the server refuses the message - writes `backend/data/outbox/*.txt` and logs. The result (`Delivery`) carries the reason a configured server failed (never the password); the link is never in an HTTP response (the setup and invite replies only say *where* the message went and why). Staff accounts need a verified address before a password reset works.
* **Abuse limits** (in memory, per process): login failures 8 / 5 min per client and per identifier; separate limits for setup, registration, verification, resend, forgot-password and reset; uploads of repair evidence 30 / min.

## Front-end structure

`frontend/src/styles.css` holds the design tokens and components ([docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)); `portals.css` the three sign-in designs. `auth.jsx` provides the auth context, the `PORTALS` table and the guards. `pages/` are the public screens, `pages/auth/` the portal logins and account-recovery screens (`UserPortal`, `StaffLogin`, `Setup`, `VerifyEmail`, `AcceptInvite`, ...), `pages/admin/` the administrator screens, `pages/maintenance/` the maintenance screens and `pages/PortalShell.jsx` the sidebar frame both staff portals share (different navigation and accent). `NetworkMap.jsx` is the only map component (canvas-drawn network, condition overlay, route layer above it).

| Area | Routes |
|---|---|
| First screen | `/` (role selection) |
| User door (guests included) | `/user/login`, `/user/register`, `/user/forgot-password`, then `/user/home`, `/user/map`, `/user/report`, `/user/routes`, `/user/about`; `/user/profile` needs a login |
| Admin & Road Maintenance door | `/admin/portal` (home: Login / Create Account), `/admin/login` (one page for both roles), `/admin/register` (request an account), `/admin/forgot-password`, `/setup` (first run, server computer only) |
| Administrator | `/admin/dashboard`, `/admin/map`, `/admin/reports`, `/admin/risk`, `/admin/maintenance`, `/admin/routes`, `/admin/users`, `/admin/settings` |
| Maintenance staff | `/maintenance/dashboard`, `/maintenance/map`, `/maintenance/inspections`, `/maintenance/repairs`, plus `/maintenance/roads`, `/maintenance/reports`, `/maintenance/profile` |
| From emails | `/verify-email`, `/accept-invite`, `/reset-password` |

Old addresses (`/`, `/routes`, `/admin`, `/admin/predictions`, `/admin/routes`) redirect to the new ones. The user area does not advertise the staff door: there is no Admin item in its header and no first-run banner. The only visible way in is the second card of the role-selection screen, which opens `/admin/portal` (or typing `/admin/login`); on a fresh install `/admin/login` sends the person at the server computer to `/setup`. `/maintenance/login` redirects to `/admin/login` - there is a single staff sign-in page. Signed-in staff see a link to their dashboard in the account menu. Old addresses (`/login`, `/map`, `/report`, `/routes`, `/admin/predictions`, `/admin/route-analytics`...) redirect to the new ones.

## Map API

`GET /api/network?south&west&north&east&zoom` returns every segment in the box:
`{id, name, highway, oneway, length_m, geometry, state, state_label}` and, **only for roads with data**,
`severity, damage_type, report_count, last_report_at, risk_percent, priority_category, maintenance_status, simulated`.
It also returns junction coordinates (nodes where three or more returned segments meet) and per-state counts.
The only roads ever left out are minor classes on wide views (`road_classes.MIN_ZOOM`) - the same rule for every
road - and roads with data are always included. A hard cap (`network.max_segments_per_view`) keeps payloads bounded and
says when it truncated.

## Formulas (all weights/thresholds live in `config/roadmind.yaml`)

### Severity (0-100) - `ai/roadmind_ai/severity.py`

```
size    = 50 × min(1, sqrt(effective_area / 0.15))     effective_area = Σ box_area × fill (crack boxes count 25 %)
type    = 25 × max(type_weight × confidence)            pothole 1.0, alligator 0.85, transverse 0.55, longitudinal 0.5, other 0.4
count   = 15 × min(1, damaged_areas / 6)
history = 15 × min(1, reports_on_road_last_90_days / 10)
score   = size + type + count + history
Low 0-30 · Moderate 31-60 · High 61-80 · Critical 81-100          ->  GOOD · MODERATE · HIGH RISK · CRITICAL
```

### Road current severity and state - `services/condition.py`

Reports newer than the last completed repair and within 180 days are combined:
`0.6 × worst (age-discounted) + 0.4 × recency-weighted mean` (half-life 60 days). If there are none, the road has no
data (UNKNOWN) - unless a repair was completed inside the window, in which case the data says GOOD and why.

### Deterioration risk - `ai/roadmind_ai/prediction`

Ten features: current severity, worst severity in 90 d, severity trend, reports in 90 d, total reports, road age, months since repair, repair count, rainfall (30 d), traffic. Output: probability that severity rises ≥ 10 points (or becomes Critical) within ~90 days. `HIGH ≥ 70 %`, `MEDIUM ≥ 40 %`. Only roads with data are scored. Age, traffic and rainfall of imported roads are class-based estimates (`services/road_classes.py`).

### Maintenance priority - `services/priority.py`

```
danger   = 0.55 × severity + 0.45 × predicted_risk
exposure = 0.25 reports + 0.25 traffic + 0.15 nearby schools/hospitals + 0.15 people affected + 0.20 time since repair
priority = 100 × danger × (0.85 + 0.30 × exposure)
Immediate ≥ 90 · High Priority ≥ 70 · Medium Priority ≥ 40 · Monitor < 40
```

Severity and predicted risk set the base; exposure scales it by −15 % … +15 %. Roads with severity < 10 are capped below "Medium". Only roads with data are ranked.

### Routing on the complete network - `services/routing/`

* **Candidates.** `graph.py` builds a directed graph from *all* stored segments (one-way streets honoured, travel time from the road class) and finds up to three distinct routes with the penalty method (edges of each found route become 1.7x more expensive, near-duplicates are dropped). Outside the loaded network `provider: auto` falls back to OSRM.
* **Reading condition.** Routes from the graph know their exact segments; OSRM routes are matched to roads with data within 25 m (at junctions the road the route was already on wins). Samples every 25 m along the route are either on a road with data or **unknown**.

```
known_risk       = 0.65 × mean + 0.35 × 90th percentile of road risk over the samples on roads WITH data
road risk        = 0.5 × current severity/100 + 0.5 × predicted risk
coverage         = share of the route that has data
effective_risk   = the same blend where unknown samples take a neutral prior = the average risk of all roads with data
                   (used ONLY for ranking, so that missing data neither rewards nor penalises a route)
extra_distance   = min(1, (distance / shortest − 1) / 0.5)        a 50 % detour counts as the maximum
extra_time       = min(1, (time / fastest − 1) / 0.5)
score            = w_distance × extra_distance + w_time × extra_time + w_damage × effective_risk      (lower = better)
```

* The response shows `risk` = `known_risk` (null when coverage is below 15 %, damage level "Unknown"), `data_coverage` and the unknown kilometres. A route is only ever labelled *Avoid* on evidence (risk ≥ 60 % on at least 15 % coverage), and when mean coverage is below 15 % the summary says RoadMind cannot rank the routes by damage risk and suggests one on distance/time alone.
* Labels: lowest score = *Recommended*; clearly worse high-risk routes = *Avoid*; the rest = *Alternative*. Damage levels: Low < 25 %, Moderate < 50 %, High < 70 %, Severe ≥ 70 %.

### Road events - `services/events.py`, `routers/events.py`

A `road_events` row is a place (point + radius, optionally the blocked stretch) and a time window: `event_type` (ROAD_BLOCKED, ROAD_CLOSED, TEMPORARY_CLOSURE, CONSTRUCTION, ACCIDENT, FLOODED, SEVERE_DAMAGE, ROAD_REOPENED), `description`, reporter, `created_at`, `expires_at`, optional photo, and two state fields: `verification_status` (PENDING → VERIFIED / REJECTED) and `status` (ACTIVE → RESOLVED / EXPIRED).

* Community reports (`POST /road-reports`) start **PENDING**; staff-entered events (administrators and road-maintenance staff) are **VERIFIED** at once. An unverified report stops counting after `events.pending_hours`; every event expires (`events.default_hours` per type, `events.max_hours` cap); staff can resolve it earlier or post a `ROAD_REOPENED` record, which resolves the live blockages around that point.
* Only a **VERIFIED, ACTIVE, unexpired** `ROAD_BLOCKED / ROAD_CLOSED / TEMPORARY_CLOSURE` event makes a route *AVOID*; other verified events (construction, accident, flooding, severe damage) raise the risk score; an unverified report only nudges it (`route_risk.unverified_blockage_risk`).
* A route is "on" an event when it passes within the event's radius (default 50 m) of the event point or of its blocked stretch (`route_hits`: point-to-polyline distance; works on Google, OSRM and RoadMind polylines alike).

### Smart routing - `services/routing/intelligence.py`, `google.py`

```
candidates   Google Routes API computeRoutes: DRIVE, routingPreference TRAFFIC_AWARE_OPTIMAL, computeAlternativeRoutes,
             extraComputations TRAFFIC_ON_POLYLINE  (field mask: distance, duration, staticDuration, polyline, speedReadingIntervals)
             - or, without a key / when Google fails, RoadMind's own routing with traffic = unavailable (never invented)
traffic      congestion = length-weighted speed risk (NORMAL 0, SLOW 55, TRAFFIC_JAM 100) along the polyline
             delay      = 100 × min(1, (duration/staticDuration − 1) / 0.5)
             traffic    = 0.6 × congestion + 0.4 × delay                                   (Normal < 15 · Moderate < 40 · Heavy < 70 · Traffic jam)
road_damage  blend of current severity of the roads WITH data on the route (neutral prior for the rest)      x100
predicted    blend of the predicted deterioration risk of those roads                                         x100
blockage     100 for a verified blockage/closure on the route; construction 60, accident 70, flooding 85; unverified report 35
risk         = 0.30·traffic + 0.25·road_damage + 0.15·predicted + 0.30·blockage      (unavailable components are dropped and the rest re-normalised)
rank         = risk + 10 × extra_travel_time        (tie-breaker only: the shortest route is never recommended blindly)
status       blocked route -> AVOID (unless every route is blocked: the least risky stays RECOMMENDED with a warning);
             risk ≥ 70 and ≥ 5 points above the best -> AVOID; lowest rank -> RECOMMENDED; the rest ALTERNATIVE
```

`selected` is the fastest route (what a driver would take without RoadMind); if it is blocked, `alert` carries the 🚧 ROAD BLOCKED notice and the recommended alternative. All weights and thresholds are under `route_risk:` in `config/roadmind.yaml`. RoadMind estimates risk from reports, AI detections and live traffic; it cannot guarantee that a road is physically safe.

### Emergency routes - `services/emergency.py`, `services/routing/emergency.py`

* **Nearby services.** Google Places (New) `searchNearby` (`hospital` / `fire_station` / `police`, ranked by distance) when a server key exists, else OpenStreetMap (`amenity=…` stored places + a live Overpass query). The nearest few get a real travel time from the Google **Route Matrix** (one request, `TRAFFIC_AWARE`) or RoadMind's own routing (no traffic, labelled); results are cached for `emergency.cache_seconds`. Availability fields (`open_now`, `opening_hours`, `has_emergency`) are passed through only when the source states them - RoadMind never infers that a hospital can take patients.
* **Hard rule, then scoring.** `gather()` (shared with `intelligence.calculate`) produces candidates and per-route facts (traffic, road condition, events). A route with a **verified, live blockage/closure** is `UNAVAILABLE`: not scored, never recommended; if all are closed nothing is recommended. The others: `score = 0.45·travel_time + 0.20·traffic + 0.15·road_damage + 0.10·flood + 0.10·other` (`emergency:` in `config/roadmind.yaml`), where travel_time = `100·min(1, (t/t_fastest − 1)/0.5)`, flood = reported flooding events, other = max(construction/accident/severe-damage events, predicted deterioration risk). Unavailable parts are dropped and the weights re-normalised. The shortest route does not automatically win; the lowest score does.
* **Monitoring** is split by cost: `POST /emergency/route-status` only compares the route polyline with the live events (database, every ~60 s: BLOCKED / CHANGED / OK); a new `POST /emergency/route` (one Google call) is made only after a BLOCKED / CHANGED answer, or every ~180 s for traffic when Google is configured. The client never polls GPS.

## Swapping components

* **Detector:** implement `detect(image_bgr) -> DetectionResult` (see `detection/factory.py`); drop YOLO weights at `ai/models/road_damage_yolo.pt` for automatic use.
* **Routing / map service:** implement `RoutingProvider.routes(origin, destination, max_routes)` in `services/routing/` and return it from `RouteEngine._provider` (the Google provider, `GoogleRoutesProvider`, is used first by `intelligence.calculate` when a server key is set).
* **Map engine:** `frontend/src/maps/` - `MapCanvas` takes plain overlay descriptions (lines, markers, circles), so a Google, Leaflet or any other engine can sit behind it.
* **Road network source:** `services/osm.py` is the only OpenStreetMap-specific code; any source that yields segments with node ids can feed `import_extract`.
* **Risk model:** `python -m roadmind_ai.prediction.train` rewrites `ai/models/risk_model.joblib`; keep `FEATURES` in `prediction/features.py` in sync.
