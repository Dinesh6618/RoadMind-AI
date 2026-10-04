# RoadMind AI

**AI-powered road damage detection, risk prediction, maintenance prioritisation and safer route recommendation - as an intelligence layer on top of the complete road network.**

RoadMind AI is a software-only web application. Users upload a road photo; computer vision finds potholes and cracks, a severity score is calculated, a machine-learning model estimates whether the road is likely to get worse, roads are ranked for maintenance, and a route planner recommends lower-risk routes. Everything is shown on an interactive map and an administrator dashboard.

**The map always shows the complete road network** (from OpenStreetMap). RoadMind never hides a road because it has no data for it: it colours the roads it *does* know about and leaves the rest as **UNKNOWN** - which is not "good" and not "damaged".

| State | Colour | Meaning |
|---|---|---|
| GOOD | 🟢 green | recent RoadMind data indicates low damage |
| MODERATE | 🟡 yellow | some damage detected |
| HIGH RISK | 🟠 orange | significant damage or deterioration risk |
| CRITICAL | 🔴 red | severe damage requiring attention |
| UNKNOWN | ⚪ grey | no sufficient RoadMind data - never counted as good or as damaged |

> **Read this first.** All scores are *AI-generated estimates* - not official engineering assessments, and predictions are probabilities, not guaranteed events. In the built-in demo the **roads and places are real (OpenStreetMap) but the condition data on top of them is simulated**. See [What is real and what is demo](#what-is-real-and-what-is-demo).

## Quick start

Developed and tested with Python 3.14 and Node.js 26 (3.11+ / 20+ should work but were not tried). Node is only needed to build the frontend.

```powershell
# from the project folder
python -m venv .venv
.\.venv\Scripts\Activate.ps1            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

python scripts/start.py                  # prepares demo data/models, builds the frontend, serves everything
```

Open **http://127.0.0.1:8000**. API documentation is at **http://127.0.0.1:8000/api/docs**.

* **There is no default login.** No username or password exists anywhere in the code. On a fresh install, choosing *Admin & Road Maintenance* → *Login* (or opening `/setup`) on this computer asks you to **Create Initial Administrator** (full name, authorised email, password, confirm). A verification link is emailed to that address and the account only works after you open it. See [Accounts and security](#accounts-and-security) - and note that **no mail server is configured by default**, so the "email" is a text file in `backend/data/outbox/`.
* First start creates `backend/data/` (SQLite database, uploaded images), imports the bundled OpenStreetMap extract (~2,600 road segments of central Chennai, works offline) and adds simulated condition data to roughly 18 % of them.
* **Upgrading from an earlier build:** the database is upgraded in place (new columns are added, nothing is deleted). If it still contains the old built-in `admin` account, that account is **removed at start-up** and `/admin/login` asks you to create your own administrator.
* Frontend development with hot reload: run `python scripts/start.py` (API on :8000), then in `frontend/` run `npm run dev` and open http://localhost:5173.

## Accounts and security

The first screen (`/`) asks **"Who are you?"** and offers two doors. They are different pages with different designs, never one combined form, and the server refuses an account that tries the wrong door (correct password, wrong door → "This account signs in through the Admin & Road Maintenance portal", with a pointer).

| Door | Addresses | Who | How accounts come to exist |
|---|---|---|---|
| **I'm a User** (bright, friendly) | `/user/login`, `/user/register`, then `/user/home`, `/user/map`, `/user/report`, `/user/routes`, `/user/profile` | normal users, plus **Continue as Guest** | anyone can create one (full name, email, password, confirm) |
| **Admin & Road Maintenance** (dark navy, security-focused) | the **Admin Portal** home `/admin/portal` ("Welcome to the RoadMind AI Admin Portal") with two choices: **Login** → `/admin/login` ("Authorized Access", one sign-in page) and **Create Account** → `/admin/register` ("Create Authorized Account") | administrators *and* road-maintenance employees - the account's role decides the dashboard: `/admin/dashboard` or `/maintenance/dashboard` | the first administrator at `/setup` on the server computer; every other account is **requested** at `/admin/register` and approved by an administrator, or **invited** by an administrator (Admin → Users) |

| Role | Can do |
|---|---|
| **Administrator** | everything: dashboard, road map, all damage reports, AI detection results, risk predictions, maintenance priorities and records, route analytics, **user management** (approve or reject account requests, invite staff, change roles, suspend), assign roads to maintenance staff, system settings |
| **Road maintenance staff** | only the roads assigned to them: view damage, severity, predicted risk and priority; update inspection and repair status; add notes; upload repair-evidence photos; mark repairs completed. Cannot touch other roads, users, security settings, AI models or administrator credentials |
| **Normal user** | view the map and road conditions, search roads, plan routes and get safer-route recommendations, report damage with photos, see the AI result, see their own reports. **Guests** can do everything except store a report (they can still preview the AI result); `auth.require_login_to_report` controls that |

**Email verification.** Administrator and maintenance accounts are unusable until their email address is verified:

```
first administrator:  /setup  ->  account created (unverified)  ->  verification link emailed  ->  link opened  ->  active  ->  /admin/login
other staff (A):      administrator invites (name, email, role)  ->  invitation emailed  ->  invitee opens it, chooses their own password (this also verifies the address)  ->  portal login
other staff (B):      /admin/register (request)  ->  verification link emailed  ->  link opened  ->  PENDING ADMIN APPROVAL  ->  an administrator approves  ->  ACTIVE  ->  portal login
```

**Create Account at the Admin Portal is a request, not a way in.** `/admin/register` asks for Full Name, Gmail/Email, Account Type (Administrator or Road Maintenance Staff), Password and Confirm Password. Choosing *Administrator* **does not make anyone an administrator**: the account is stored as a plain `user` with a *requested* role, can't sign in anywhere, and moves through these states:

| Status | Meaning |
|---|---|
| `PENDING_EMAIL_VERIFICATION` | created; waiting for the emailed link to be opened (also: invited staff who have not accepted yet) |
| `PENDING_ADMIN_APPROVAL` | address verified; waiting for an administrator (Admin → Users → *Pending approvals*) |
| `ACTIVE` | approved - the account now has the role the administrator granted (which may differ from the one requested) and can log in |
| `REJECTED` | the administrator declined it (an optional reason is emailed); it can still be approved later |
| `SUSPENDED` | an administrator switched the account off; it can be reactivated |

After the form is sent the page says *"Your account has been created successfully. Please wait for administrator approval."* Trying to log in earlier gets a precise message (email not verified / waiting for approval / not approved / suspended) - only after the correct password, so strangers learn nothing. Requests are rate-limited (5 per minute per client IP; at most 50 waiting at a time, `auth.max_pending_requests`), the password is hashed (Argon2id) from the first moment, and the form only works once an administrator exists to approve it - the very first administrator is still created at `/setup` on the server computer, because nobody could approve them. Approving also emails the person; both decisions are checked on the server and need an administrator.

* **No mail server is configured by default**, so every "email" is written to `backend/data/outbox/` (newest file = newest message) and logged on the server console; the web page says so (including the folder) and never shows the link itself. To send real mail follow [Real email with Gmail](#real-email-with-gmail) - SMTP settings come from a git-ignored `.env` file or `ROADMIND_SMTP_*` variables - and set `auth.public_url` to the address people use to reach the site. If a configured mail server rejects a message, the page shows why.
* **First run:** `/setup` works only from the computer that runs the server (`auth.setup_local_only`), so nobody else on the network can claim the installation. Running it again before verification replaces the unverified account (for example after a mistyped address). A weak, common or name-containing password is refused (10+ characters).
* **No hidden accounts.** There is no predefined or backdoor administrator; nothing in the source, config or front end contains credentials, and the role always comes from the database - never from the browser. Old builds' `admin` account is deleted at start-up, and administrators created before verification existed must verify their email too.
* **Passwords** are hashed with **Argon2id**. The original password is never stored, logged or returned. Hashes from earlier scrypt builds still work and are upgraded at the next login.
* **Sessions** are signed JWTs with an expiry (`auth.token_hours` 8 h for users, `auth.staff_token_hours` 4 h for staff). **Logout** revokes that token on the server; changing or resetting a password, deactivating an account or changing its role revokes all of a person's sessions. Tokens travel in the `Authorization` header (not cookies), so classic CSRF does not apply; responses with account data are `Cache-Control: no-store` and the site cannot be framed.
* **Login protection:** one generic error ("Incorrect email or password"), uniform timing for unknown accounts, throttling per address and per account, and separate rate limits on registration, verification, invitations and resets.
* **The user area has no Admin item** and no first-run banner: the only visible way to the staff door is the second card on the role-selection screen, which opens the Admin Portal home. On a fresh install that page says no administrator exists yet, and **Login** (or opening `/admin/login` / `/setup`) on the server computer leads to **Create Initial Administrator**. The admin login page has no role selector and no way to pick a role; its only sign-up path is the approval-gated request described above.
* **Access control:** unauthenticated visitors to `/admin/*` or `/maintenance/*` are sent to `/admin/login`; a normal user opening an admin page sees **"Access Denied - Administrator privileges are required to access this page"** with a *Return to User Dashboard* button; a maintenance employee at an admin-only page sees *"Administrator privileges are required."* The server enforces the same on the API (401 / 403), the React guards are only a courtesy. Old addresses (`/login`, `/map`, `/report`, `/routes`...) redirect to their `/user/...` equivalents.
* **Account Settings** (Settings / Profile): change name, username and password (current + new + confirm). Normal users may change their email too; for staff the verified email *is* the identity, so it can only be changed by an administrator.
* **Forgot password:** a single-use link valid for 30 minutes (only its SHA-256 hash is stored), identical reply for known and unknown accounts, never reveals the old password. Staff accounts must have a verified address first.
* **Locked out of the only administrator account?** On the computer that hosts RoadMind run `python scripts/set_admin.py` - it resets an administrator's password (and marks the address verified, because whoever runs it controls the machine), or creates the first administrator if there is none. If the address you want is already a normal-user account (setup answers "An account with that email address already exists"), the script offers to make that account the administrator.
* Uploads (damage photos and repair evidence) are validated (type, size, real image decode, dimensions) and stripped of EXIF/GPS; public upload and import endpoints are rate-limited per IP; no reporter personal data is exposed.

## Real email with Gmail

Out of the box RoadMind cannot send email (it has no mail account), so verification links, staff invitations and password resets are saved as text files in `backend/data/outbox/` - nothing arrives in anyone's inbox. To make real email work with a Gmail account:

1. In the Google account that will *send* the mail, turn on **2-Step Verification** (https://myaccount.google.com/security).
2. Create an **App Password** at https://myaccount.google.com/apppasswords (name it "RoadMind"). Google shows 16 letters in four groups. This is *not* your normal Gmail password, and a normal password will be rejected.
3. Copy `.env.example` to `.env` in the project folder and fill in:
   ```
   ROADMIND_SMTP_HOST=smtp.gmail.com
   ROADMIND_SMTP_PORT=587
   ROADMIND_SMTP_USER=your-address@gmail.com
   ROADMIND_SMTP_PASSWORD=xxxx xxxx xxxx xxxx
   ```
   `.env` is git-ignored; the password is never stored in the code, the config file, the database or any web page.
4. Check it: `python scripts/test_email.py you@gmail.com` - it says "OK" or tells you exactly why the mail server refused.
5. Restart RoadMind. On the "Verify the administrator email" page press **Send the link again** - the email now arrives in the inbox (look in spam if it does not). If sending fails, the page shows the reason and still saves the message in the outbox.

Other providers work the same way (`ROADMIND_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD`; `ROADMIND_SMTP_STARTTLS=0` for port 465/plain). Set `auth.public_url` in `config/roadmind.yaml` to the address people use to reach RoadMind, because the links in the emails are built from it.

## Design system

A single premium visual language - lavender and white surfaces, deep-navy type, vivid indigo primary, and one fixed set of road-condition colours (green Good · yellow Moderate · orange High Risk · red Critical · grey No Data). Route lines use green *Recommended*, orange *Alternative* and red *Avoid*. See [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) and the presentation board of all screens, [docs/design/roadmind-design-board.png](docs/design/roadmind-design-board.png) (source: [board.html](docs/design/board.html)). The board is made of screenshots of the running app, desktop (1440 px) and mobile (390 px).

## How the map works

```
              OPENSTREETMAP  ->  complete road network (every drivable segment, junctions, names)
                                      |
                                 LEAFLET MAP   (all segments drawn and clickable)
                                      ^
                                      |
                       ROADMIND CONDITION LAYER  (colour only where RoadMind has data)
                                      ^
                       SQLite / PostgreSQL  (+ optional PostGIS)
                                      ^
                       AI detection + risk prediction (user reports)
```

* **Every road is visible and clickable.** Click a road with data for condition, severity, damage type, report count, last report, predicted risk and maintenance priority; click a grey road to see *"Condition data unavailable"* and a **Report damage here** button.
* **Filters** show or hide each of the five states; hiding UNKNOWN hides only the grey roads. At wide zoom levels minor service streets are drawn only when zoomed in (the same rule for every road, with or without data); roads that have RoadMind data are always drawn.
* **Intersections** appear as dots when zoomed in. A **Roads only** base layer draws the network on a plain background.
* **Reports attach to real road segments.** If a report lands where no network is loaded, RoadMind fetches the roads around it from OpenStreetMap first. A report on an UNKNOWN road gives that road its first condition.
* **More area on demand:** "Load missing roads here" imports the OpenStreetMap network for the current view (size-limited, rate-limited, cached).
* **Routes use the complete network.** Candidate routes are computed on the whole stored network (one-way streets and road classes respected), then scored against RoadMind's condition layer. The recommended route is drawn as a thick line over the visible network. Stretches without data are reported as unknown and are not rewarded or penalised (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Try the full demonstration workflow

| # | Step | Where |
|---|------|-------|
| 1 | User uploads a road image | **Report Damage** - pick one of the generated samples or upload your own |
| 2 | AI detects pothole / crack | Result panel shows boxes, damage type, confidence, count |
| 3 | AI calculates severity | 0-100 meter with the four-band scale and its component breakdown |
| 4 | Location is stored | Click a road on the map (or type coordinates, or "use my location"); the form shows which road segment the report will attach to |
| 5 | Historical data is checked | Reports within 90 days feed the severity "history" component |
| 6 | Future deterioration risk is predicted | Risk % + the factors that drive it |
| 7 | Road receives maintenance priority | Priority score, category and recommended action |
| 8 | User enters a destination | **Route Planner** (pre-filled with a real trip between two OpenStreetMap places) |
| 9 | Route engine checks road conditions | Every route is read against the condition layer; data coverage is shown |
| 10 | RoadMind recommends a lower-risk route | Recommended / Alternative / Avoid, with reasons, on the map |
| 11 | Admin sees everything | **Admin** -> Dashboard, Road Map, Damage Reports, Risk Prediction, Maintenance, Route Analytics, Users, Settings |

## What was built, phase by phase

| Phase | What | Code |
|-------|------|------|
| Base network | OpenStreetMap import (Overpass), junction-aware segments, places, zoom-aware view API | [`services/osm.py`](backend/app/services/osm.py), [`services/network.py`](backend/app/services/network.py), [`routers/network.py`](backend/app/routers/network.py) |
| 1 Data management | Report form, relational schema for the 9 required entities (12 tables incl. places/network areas), repair history, rainfall/traffic fields | [`backend/app/models.py`](backend/app/models.py), [`services/seed.py`](backend/app/services/seed.py) |
| 2 Detection | Detector interface, YOLO wrapper, OpenCV fallback, box rendering, P/R/F1/mAP evaluation, RDD2022 converter + YOLO training script | [`ai/roadmind_ai/detection/`](ai/roadmind_ai/detection) |
| 3 Severity | Transparent 0-100 score (size, type, count, history) | [`ai/roadmind_ai/severity.py`](ai/roadmind_ai/severity.py) |
| 4 Risk prediction | Logistic Regression baseline vs Random Forest, Gradient Boosting, XGBoost with hold-out metrics | [`ai/roadmind_ai/prediction/`](ai/roadmind_ai/prediction) |
| 5 Maintenance priority | Configurable danger x exposure score, categories, admin workflow | [`services/priority.py`](backend/app/services/priority.py), [`routers/maintenance.py`](backend/app/routers/maintenance.py) |
| 6 Safe routes | Routing on the complete network (or OSRM), unknown-aware per-route risk, configurable score | [`services/routing/`](backend/app/services/routing) |
| 7 Web app | React app: Home, 4-step Report wizard + AI result, Road Map, Route Planner + recommendation, admin dashboard, accounts, mobile layouts | [`frontend/`](frontend) |
| Accounts | First-run administrator setup, roles, Argon2id, JWT sessions, password reset, user management | [`routers/auth.py`](backend/app/routers/auth.py), [`security.py`](backend/app/security.py), [`routers/users.py`](backend/app/routers/users.py) |

More detail: [Architecture & formulas](docs/ARCHITECTURE.md) · [API reference](docs/API.md) · [Training real models](docs/MODEL_TRAINING.md) · [OSM data & attribution](data/osm/README.md).

## System architecture

```
                    USER
                     |
                     v
              React Web App  (frontend/)  - Leaflet map: complete network + condition layer
                     |
                     v
              FastAPI Backend  (backend/app)
                     |
       +-------------+-------------+
       |             |             |
       v             v             v
  AI Detection   ML Prediction   Route Engine
  (ai/…/detection) (ai/…/prediction) (services/routing)
       |             |             |
       +-------------+-------------+
                     |
                     v
         SQLite (default) / PostgreSQL (+ PostGIS)
                     |
                     v
              Admin Dashboard
```

The AI models live in their own package (`ai/roadmind_ai`) with no web or database imports - they can be trained, evaluated and swapped independently. Model predictions are stored in the `predictions` table. The routing service is behind a small `RoutingProvider` interface.

## Configuration

Everything tunable is in [`config/roadmind.yaml`](config/roadmind.yaml): the road-network source and import limits, detector thresholds, severity weights and bands, risk-level thresholds, priority weights and category cut-offs, route-score weights (`distance`, `time`, `damage_risk`), unknown-road handling, routing provider, upload limits. Users can also change the route weights per request with the sliders in the Route Planner.

Environment variables (also read from a `.env` file in the project folder; see `.env.example`): `ROADMIND_DATABASE_URL`, `ROADMIND_DATA_DIR`, `ROADMIND_SECRET_KEY`, `ROADMIND_SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_FROM` / `_STARTTLS`, `ROADMIND_CONFIG`, `ROADMIND_SEED_DEMO=0` (real network only, no simulated condition data - every road starts UNKNOWN).

## Tests

```powershell
pip install -r requirements-dev.txt
cd backend
python -m pytest -q
```

147 tests, none of which need internet access (they use a synthetic OpenStreetMap-format street grid). About 80 of them cover accounts and the three portals: no accounts on a fresh install, first-run setup and its email verification (single use, expiry, replacing an unverified account), Argon2 storage, legacy-hash upgrade, portal separation (`wrong_portal`, `email_not_verified`), lockout, roles and the exact 401/403 messages, guest rules, profile and password changes, logout and session revocation, forgot/reset password (expiry, single use, no account enumeration, SMTP and its failure), staff invitations, promotion and demotion, and removal of the legacy `admin`; `test_staff.py` covers road assignment, scoped access, inspections, repairs, notes and photo evidence. The rest cover OSM parsing (excluded ways, junction splitting, one-way normalisation), network import idempotence, the network view API (every road returned, UNKNOWN roads carrying no condition data, zoom generalisation never hiding roads with data), unknown-aware route scoring, one-way and road-class routing, severity bands, the priority formula, the risk model, the detector on generated images, and the API end to end (report pipeline incl. auto-loading the network, upload validation, EXIF stripping, auth, maintenance workflow, analytics).

## What is real and what is demo

Being explicit, so the demo is not mistaken for a validated product:

* **Roads, names, junctions and places are real** - the bundled extract is OpenStreetMap data (ODbL, attribution in the app and in [`data/osm/README.md`](data/osm/README.md)). Road **age, traffic and rainfall are estimates** from the road class (OpenStreetMap has no such data).
* **The condition data on the map is SIMULATED.** The reports, severities, repairs, route history and maintenance statuses in the demo are generated for the demo (about 18 % of segments, in neighbourhood clusters plus a few designed routes) and are labelled "simulated" in the UI. They describe no real road's condition, even though the roads they sit on are real. Start with `ROADMIND_SEED_DEMO=0` for a real-network-only database where everything is UNKNOWN until reports arrive.
* **Damage detector.** Without trained YOLO weights, RoadMind uses a **classical OpenCV fallback** (shown as "demo mode" in the UI). It is tuned for the generated sample images; its metrics (P 0.85 / R 0.81 / mAP@0.5 0.78) were measured on *synthetic* images and **do not describe real-world accuracy** - it will be unreliable on real photographs. The YOLO path (`detection.backend: auto` picks it up when `ai/models/road_damage_yolo.pt` exists), the RDD2022 converter and the training script are written but **were not run** here: that needs the multi-GB RDD2022 dataset and ideally a GPU. See [docs/MODEL_TRAINING.md](docs/MODEL_TRAINING.md).
* **Risk model.** Trained on **synthetic data** drawn from an explicit assumed deterioration process, because no public dataset links road history to later deterioration for an arbitrary city. Its metrics (ROC-AUC ≈ 0.84) show it learned that assumption - not that it forecasts real roads. Retrain on real inspection history when available.
* **Routing.** Inside the loaded network routes come from RoadMind's own graph of the whole network (tested live against the bundled extract). Outside it, RoadMind calls the public OSRM server (tested live) and matches routes to roads it has data for. Where RoadMind has little or no data it says so rather than claiming a route is low-risk.
* **OpenStreetMap services.** Network import uses the public Overpass API (tested live), map tiles come from tile.openstreetmap.org and address search from Nominatim. These are shared services with fair-use limits; the app caches imports and rate-limits the endpoints that call them. Without internet the bundled extract, all roads, routing and every feature still work - only the base-map picture, address search and new-area import need it.
* **Weather and traffic** are stored per road (estimates); there is no live feed.
* **PostgreSQL/PostGIS.** The code uses portable SQLAlchemy types (bounding-box columns provide the spatial filtering), and `docker-compose.yml` + `db/postgis_extras.sql` are provided, but they were **not tested** (no Docker in the dev environment). SQLite is the tested default.
* **Security basics included:** see [Accounts and security](#accounts-and-security). This is a demo project that has not had an independent security review; if you deploy it beyond your own computer, put it behind HTTPS, set a strong `ROADMIND_SECRET_KEY`, configure SMTP and `auth.public_url`, and review `auth.setup_local_only`. Throttling counters live in memory (they reset on restart and are per process).

## Project layout

```
ai/roadmind_ai/      detection/, severity.py, prediction/   (models, training, evaluation)
backend/app/         FastAPI app: routers/, services/ (osm, network, routing, pipeline, seed), models.py, config.py
backend/tests/       pytest suite (+ synthetic OSM fixture)
frontend/src/        React app (styles.css = design tokens, portals.css = the three sign-in designs, NetworkMap.jsx is the map; pages/, pages/auth/, pages/admin/, pages/maintenance/)
config/roadmind.yaml all tunable parameters
data/osm/            bundled OpenStreetMap extract + attribution
data/sample_images/  generated demo photos
scripts/             start.py, setup_demo.py, fetch_osm.py, set_admin.py (administrator recovery)
docs/                architecture, API, model training, design system, design/ (presentation board + screenshots)
```

## Troubleshooting

* **Folder inside OneDrive:** `.venv/` and `frontend/node_modules/` contain tens of thousands of files that OneDrive will try to sync. Consider pausing sync or keeping the project outside OneDrive.
* **The map picture shows "403 Access blocked" tiles:** OpenStreetMap's tile server refuses requests that arrive without a `Referer` header. RoadMind sends the site origin (`Referrer-Policy: strict-origin-when-cross-origin`, plus `referrerPolicy: origin` on the tile layer), so this should not happen; if you front the app with a proxy or browser extension that strips the Referer, it will. Browsers cache the blocked tiles for a while - do a hard refresh (Ctrl+F5).
* **Tiles are blank, or the roads float on a grey background:** the picture under the roads comes from a tile server and needs internet. Choose *Roads only* in the layer switcher (top right of the map) to see the network without it - the roads themselves never depend on tiles.
* **Heavy use / your own map provider:** tile.openstreetmap.org is a shared volunteer service with a [usage policy](https://operations.osmfoundation.org/policies/tiles/). For more than light demo use, set `map.tile_url` (and `map.attribution`) in `config/roadmind.yaml` to your own or a commercial tile provider (MapTiler, Stadia Maps, Thunderforest...) - no code change needed.
* **"Could not reach the OpenStreetMap data service":** importing a new area needs internet and the shared Overpass service may be busy - try again later. The bundled area never needs it.
* **Port 8000 busy:** `python scripts/start.py --port 8010`.
* **Reset the demo data:** stop the server and delete `backend/data/`.
