# RoadMind AI design system

One visual language for the whole product: premium, calm and legible. The tokens and components live in [`frontend/src/styles.css`](../frontend/src/styles.css); the presentation board of every screen is [`docs/design/roadmind-design-board.png`](design/roadmind-design-board.png) (editable source: [`board.html`](design/board.html), screenshots in [`design/screens/`](design/screens)).

The board is composed from **screenshots of the running application** (desktop 1440 px and mobile 390 px), not from separate mock-ups, so what you see is what the code renders. Regenerate the screenshots after UI changes and re-render `board.html` in any Chromium browser.

## Principles

1. **The whole network, always.** The map shows every OpenStreetMap road. Condition colour is a layer on top; roads are never hidden because RoadMind has no data for them.
2. **Honest about unknowns.** Grey *No Data* is a state, not a score. It is never drawn as good or as damaged, and routes are neither rewarded nor penalised for it.
3. **Calm, premium, accessible.** Soft lavender surfaces, deep-navy text, large rounded cards, generous spacing. Colour is never the only signal: every state has a text label.
4. **Clarity before density.** One primary action per screen; results are written in plain language; AI output always says it is an estimate.

## Foundations

### Colour

| Token | Value | Use |
|---|---|---|
| `--bg` / `--bg-2` | `#F5F3FF` / `#EDE9FF` | page canvas, subtle gradients |
| `--surface`, `--surface-2` | `#FFFFFF`, `#FAF9FF` | cards, inputs |
| `--ink`, `--ink-2`, `--muted` | `#0F1A3C`, `#39446B`, `#667094` | headings and body, secondary, hints |
| `--brand`, `--brand-2`, `--brand-dark`, `--brand-soft` | `#5B3DF5`, `#7C5CFF`, `#4527D8`, `#EFEAFF` | primary actions, links, selected states |
| `--grad` | `#7C5CFF -> #5B3DF5 -> #4527D8` | primary buttons, hero accents, logo |
| `--line`, `--line-strong` | `#E7E3F8`, `#D6D0F0` | borders |

**Road condition** (map, badges, charts, tables):

| State | Fill | Text ("ink") on tinted badge | Label |
|---|---|---|---|
| GOOD | `#17A673` | `#0B6E4B` | Good |
| MODERATE | `#F2B01E` | `#8A5A00` | Moderate |
| HIGH_RISK | `#F7762C` | `#A8470B` | High Risk |
| CRITICAL | `#E0342F` | `#A3191A` | Critical |
| UNKNOWN | `#94A3B8` | `#475569` | No Data |

Badges are a 16 % tint of the state colour with the darker "ink" colour for text, which keeps body-size text above WCAG AA contrast on the tint.

**Routes** use their own trio so the recommendation reads at a glance: Recommended `#0FA968` (green), Alternative `#F7762C` (orange), Avoid `#E0342F` (red). Route lines have a white casing and a label chip ("B - Recommended", "A - 68% risk") and sit in a map pane *above* the network, which is dimmed while routes are shown. Note: the Recommended green is deliberately close to the *Good* road colour, as the product brief asked for it; the casing, the label chips and the dimmed network keep a route line distinguishable from a good road.

### Typography

Plus Jakarta Sans (variable, self-hosted via `@fontsource-variable`, so no external font request). Display 800 with tight tracking for hero and scores, headings 750, body 500 at 15 px (14.5 px on phones).

### Shape and depth

Radii `12 / 18 / 24 / 28` px (`--r-sm`, `--r`, `--r-lg`, `--r-xl`); cards use 24 px and map overlays 18-26 px. Shadows are soft and indigo-tinted (`--shadow-sm`, `--shadow`, `--shadow-lg`). Floating map controls and the road card use a glass surface (`--glass`, backdrop blur) so the network stays visible beneath.

### Logo

A rounded-square indigo tile with a white road-inspired **R** (a dashed centre line runs down its stem) and a small green "signal" dot for the AI. It is drawn as inline SVG (`Logo` in `components.jsx`): the full wordmark on light backgrounds, a light "AI" variant on dark/gradient panels (`<Logo dark />`).

## Components

| Component | Notes |
|---|---|
| Buttons | `.btn` (outline), `.btn-primary` (gradient, glow), `.btn-soft`, sizes `-lg`, `-small`, `-block`; min height 46 px for touch |
| Badges | `Badge`, `StateBadge`, `SeverityBadge`, `RiskBadge`, `PriorityBadge`, `StatusBadge` - dot + label, tinted background |
| Stat card | icon tile, big number, label, hint; coloured corner disc; used on the dashboard |
| Severity ring | `SeverityRing` - SVG ring + score `/100` on a card tinted by severity (the AI result screen) |
| Stepper / wizard | numbered circles joined by lines; labels hidden on phones |
| Filter pills | glass pill group over the map: All Roads, Good, Moderate, High Risk, Critical, No Data |
| Road card | floating glass card (bottom sheet on phones): condition, facts, **View Details**, **Get Route** |
| Route card / pill | letter tile A/B/C, distance, time, risk, data-coverage bar, reason text; comparison table below |
| Inputs | icon-prefixed fields, `PasswordInput` with reveal toggle and strength meter, inline error text under the field |
| Admin shell | dark-navy sidebar (Dashboard, Road Map, Damage Reports, Risk Prediction, Maintenance, Route Analytics, Users, Settings), profile + sign-out at the bottom; slides in on tablets/phones |
| Bottom navigation | Home, Map, **Report** (raised centre button), Routes, Profile - shown below 820 px |

## Screens

| # | Screen | Route | Highlights |
|---|---|---|---|
| 00 | Role selection - "Who are you?" | `/` | two large cards: *I'm a User* (bright) and *Admin & Road Maintenance* (dark navy) |
| 00a | Welcome page | `/welcome`, `/` | "Welcome to RoadMind AI · Smarter roads. Safer journeys. · Who are you?" with the **User** and **Admin / Road Maintenance** cards; where logging out lands ("You have been logged out successfully."); no Back button |
| 00c | Emergency Route | `/user/emergency-route` (signed-in users; a red 🚨 button with a NEW pill on Home and the Route Planner) | mobile-first navigation-app look, additions only: dark hero "Reach help faster with smarter routes." + four option cards (Hospital / Fire Station / Police Station / Custom Location) + a light-blue **Use My Location** card (GPS only when tapped) → nearby places with filter chips and a map (no photos; Open/Closed only when stated) → **route comparison** (blue recommended, grey alternative, red dashed unavailable, floating time labels, a "why is the fastest route blocked" box) → route details (distance, ETA, traffic, RoadMind risk, blocked roads, high-risk segments) with a sticky 🚨 **Start Emergency Route** → full-screen **live navigation** (turn card with Google steps when available, remaining time/distance, ETA clock time, real GPS speed only when reported, End) → red **ROAD BLOCKED** alert ("Finding an alternative route…") → green **Alternative Route Found** (+km, +min, Use Alternative) → **Emergency Route Active** status panel → orange **Route Update Available** with the old and the new route |
| 00b | Admin Portal home | `/admin/portal` | "Welcome to the RoadMind AI Admin Portal - Manage roads, reports, inspections and maintenance." Two deliberately different cards: **Login** (solid violet, white button, "Already have an account? Access your dashboard.") and **Create Account** (dark glass, dashed teal edge, outlined button, "New administrator or maintenance staff? Create an authorized account."), plus *Back to User/Admin Selection* |
| 01 | Home | `/user/home` | "Safer Roads for a Better Tomorrow", two actions, AI detection card, live statistics, four feature cards |
| 02-04 | Report Road Damage | `/user/report` | 4 steps: Upload Image, Location (Use Current Location / Select on Map), Road Name, Description; big *Submit Report* |
| 05 | AI Detection Result | after submit | boxed photo, detected damages, severity ring, location / road / date / report ID, *View on Map*, *Report Another* |
| 06 | Interactive Road Map | `/user/map` | full network, condition filters, search, locate, floating road card, details drawer |
| 07-08 | Route Planner / Recommendation | `/user/routes` | From / To, preferences, routes A/B/C, verdict banner, comparison table |
| 09 | Welcome Back (user login) | `/user/login` | email, password, Login, Create User Account, Continue as Guest, Forgot Password?, Back to Role Selection |
| 10 | Create your account | `/user/register` | full name, email, password, confirm |
| 11 | Authorized Access | `/admin/login` | authorised email / Gmail, password, Verify & Login, Forgot Password?, Back to Admin Portal - for administrators *and* maintenance staff; a waiting-for-approval account sees an info notice, a rejected or suspended one an error |
| 11b | Create Authorized Account | `/admin/register` | Full Name, Gmail / Email, Account Type (Administrator / Road Maintenance Staff radio cards), Password with strength meter, Confirm Password, **Create Account**; success: "Your account has been created successfully. Please wait for administrator approval." with the three next steps |
| 12 | Create Initial Administrator | `/setup` (first run, server computer only) | full name, authorised email, password with strength meter, confirm; then a "verify your email" step |
| 13 | Verify email / Accept invitation | `/verify-email`, `/accept-invite` | confirmation and choose-a-password screens reached from the emails |
| 14 | Access Denied | any staff page opened by the wrong role | "Administrator privileges are required to access this page." + *Return to User Dashboard* |
| 15 | Admin | `/admin/*` | Dashboard, Road Map, Damage Reports, Risk Prediction, Maintenance (with road assignment), Route Analytics, Users (a *Pending approvals* panel with Approve / Reject, invite staff, suspend), Settings |
| 16 | Maintenance | `/maintenance/*` | Dashboard, Assigned Roads (work panel with status, notes and photo evidence), Road Map, Inspections, Repairs, Reports, Profile |
| - | Mobile | all user pages | bottom navigation, single column, full-bleed map with bottom sheet |

## "Who are you?" - two doors

The first screen (`/`) is a role selection: *Welcome to RoadMind AI - Choose how you want to access RoadMind AI.* with two large cards. The doors are deliberately different so people always know where they are, and they are never merged into one form. Styles live in `frontend/src/portals.css`.

| | I'm a User | Admin & Road Maintenance |
|---|---|---|
| Card | white-to-lavender gradient, indigo icon tile, soft glow | dark navy gradient with a faint grid, shield icon, white button |
| Description | "Report road damage, explore road conditions and find safer routes." | "Manage road reports, inspections, maintenance and road-risk information." |
| Button | **Continue as User ->** (`/user/login`) | **Continue to Admin Portal ->** (`/admin/portal`, which offers Login and Create Account) |
| Login look | bright and friendly, road imagery on the left, "Welcome Back - Sign in to make your journeys safer." | dark navy / indigo, grid background, shield icon, "ADMINISTRATION PORTAL", "Authorized Access - Administrator & Road Maintenance Portal" |
| Fields / actions | Email, Password, **Login**, **Create User Account**, **Continue as Guest**, Forgot Password?, Back to Role Selection | Authorized Email / Gmail, Password, **Verify & Login**, Forgot Password?, Back to Admin Portal |
| Sign-up | yes (`/user/register`), instant | only as a **request** (`/admin/register`): verify the email, then an administrator approves - or an administrator invites the person |

Inside the staff door one sign-in page serves both roles; after the server has checked the password, account status, verified email and role it sends administrators to `/admin/dashboard` and maintenance staff to `/maintenance/dashboard`. The two dashboards share the sidebar component (`PortalShell`) with a portal label ("AUTHORIZED PORTAL" / "MAINTENANCE PORTAL") and a different navigation list; the maintenance sidebar is slate with an amber accent so a screenshot can never be mistaken for the admin one. The user area has no Admin item and no first-run banner.

## Responsive behaviour

Breakpoints 1180 / 960 / 820 / 480 px. Wide: two-column layouts (form + map, chart rows). Below 1180 grids collapse to one column; below 960 the admin sidebar becomes a slide-in drawer; below 820 the top navigation is replaced by the bottom navigation and the map legend is hidden (the filter pills carry the same information). Every page was checked at 390 px and 768 px for horizontal overflow.

## Accessibility

* Text/background pairs use the "ink" colours above; body text is `#39446B` or darker on white/lavender.
* State colour is always accompanied by a text label; route lines carry text chips.
* Visible keyboard focus rings; icon-only buttons have `aria-label`; form errors are announced (`role="alert"`) and tied to their fields.
* Touch targets are at least 44-46 px.
* Honest-AI notices (`Disclaimer`) accompany estimates.

## Known gaps

* The hero is an SVG illustration. Drop a photograph at `frontend/public/hero.jpg` to replace it.
* The statistics on the home page are the live numbers of the loaded database (simulated condition data in the demo), not marketing placeholders.
* Dark mode is not implemented.
