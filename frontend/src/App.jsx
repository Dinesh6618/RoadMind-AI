import { Camera, Home as HomeIcon, Info, LayoutDashboard, LogOut, Map as MapIcon, Route as RouteIcon, User as UserIcon, Wrench } from 'lucide-react'
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { RequireAdmin, RequireAuth, RequireMaintenance, useAuth } from './auth'
import { Logo, Spinner } from './components'
import { initials } from './format'
import AcceptInvite from './pages/auth/AcceptInvite'
import AdminPortal from './pages/auth/AdminPortal'
import ForgotPassword from './pages/auth/ForgotPassword'
import ResetPassword from './pages/auth/ResetPassword'
import Setup from './pages/auth/Setup'
import StaffLogin from './pages/auth/StaffLogin'
import StaffRegister from './pages/auth/StaffRegister'
import UserLogin from './pages/auth/UserLogin'
import UserRegister from './pages/auth/UserRegister'
import VerifyEmail from './pages/auth/VerifyEmail'
import About from './pages/About'
import Home from './pages/Home'
import ReportDamage from './pages/ReportDamage'
import RoleSelect from './pages/RoleSelect'
import RoutePlanner from './pages/RoutePlanner'

// Charts, the dashboards and the portals load on demand.
const RoadMapPage = lazy(() => import('./pages/RoadMapPage'))
const Profile = lazy(() => import('./pages/Profile'))
const AccountSettings = lazy(() => import('./pages/AccountSettings'))
const PortalShell = lazy(() => import('./pages/PortalShell'))
const Dashboard = lazy(() => import('./pages/admin/Dashboard'))
const DamageReports = lazy(() => import('./pages/admin/DamageReports'))
const PredictionAnalytics = lazy(() => import('./pages/admin/PredictionAnalytics'))
const Maintenance = lazy(() => import('./pages/admin/Maintenance'))
const RouteAnalytics = lazy(() => import('./pages/admin/RouteAnalytics'))
const Users = lazy(() => import('./pages/admin/Users'))
const Settings = lazy(() => import('./pages/admin/Settings'))
const StaffDashboard = lazy(() => import('./pages/maintenance/Dashboard'))
const WorkList = lazy(() => import('./pages/maintenance/WorkList'))
const StaffReports = lazy(() => import('./pages/maintenance/Reports'))

const NAV = [
  ['/user/home', 'Home', HomeIcon],
  ['/user/map', 'Map', MapIcon],
  ['/user/report', 'Report Damage', Camera],
  ['/user/routes', 'Route Planner', RouteIcon],
  ['/user/about', 'About', Info],
]

function UserMenu() {
  const { user, isAdmin, isMaintenance, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const location = useLocation()
  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  return (
    <div className="menu" ref={box}>
      <button className="avatar" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">{initials(user.full_name || user.username)}</button>
      {open && (
        <div className="menu-panel" role="menu">
          <div className="who"><b>{user.full_name || user.username}</b><span className="muted small">{user.email}</span></div>
          {isAdmin && <Link to="/admin/dashboard" role="menuitem"><LayoutDashboard size={18} /> Admin dashboard</Link>}
          {isMaintenance && <Link to="/maintenance/dashboard" role="menuitem"><Wrench size={18} /> Maintenance dashboard</Link>}
          <Link to="/user/profile" role="menuitem"><UserIcon size={18} /> Account settings</Link>
          <Link to="/user/profile?tab=reports" role="menuitem"><Camera size={18} /> My reports</Link>
          <button onClick={logout} role="menuitem"><LogOut size={18} /> Log out</button>
        </div>
      )}
    </div>
  )
}

/** The user area (/user/*): open to guests, with the account-only pages guarded. */
function PublicLayout() {
  const { user } = useAuth()
  const location = useLocation()
  const fullBleed = location.pathname === '/user/map'
  useEffect(() => {
    document.body.classList.add('has-bottom-nav')
    return () => document.body.classList.remove('has-bottom-nav')
  }, [])
  return (
    <>
      <header className="topbar">
        <div className="container topbar-inner">
          <Link to="/user/home" aria-label="RoadMind AI home"><Logo /></Link>
          <nav className="nav" aria-label="Main">
            {NAV.map(([to, label, Icon]) => <NavLink key={to} to={to}><Icon size={17} aria-hidden="true" />{label}</NavLink>)}
          </nav>
          <div className="top-actions">
            {user ? <UserMenu /> : (
              <>
                <Link className="btn btn-ghost" to="/user/login">Login</Link>
                <Link className="btn btn-primary hide-sm" to="/user/register">Create Account</Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main>
        <Suspense fallback={<div className="container page"><Spinner /></div>}><Outlet /></Suspense>
      </main>
      {!fullBleed && (
        <footer className="footer">
          <div className="container">
            <p><strong>RoadMind AI</strong> shows AI-generated road-condition <em>estimates</em>. They are not official engineering assessments, and predictions are probabilities - not guaranteed events.</p>
            <p>Roads and places © OpenStreetMap contributors. In this demo the condition data (reports, severity, risk) is simulated; roads without data are shown as No Data. <Link to="/">Choose a different portal</Link></p>
          </div>
        </footer>
      )}
      <nav className="bottom-nav" aria-label="Mobile">
        <NavLink to="/user/home"><HomeIcon size={21} aria-hidden="true" />Home</NavLink>
        <NavLink to="/user/map"><MapIcon size={21} aria-hidden="true" />Map</NavLink>
        <NavLink to="/user/report" className="fab" aria-label="Report damage"><Camera size={26} aria-hidden="true" /></NavLink>
        <NavLink to="/user/routes"><RouteIcon size={21} aria-hidden="true" />Routes</NavLink>
        <NavLink to={user ? '/user/profile' : '/user/login'}><UserIcon size={21} aria-hidden="true" />{user ? 'Profile' : 'Login'}</NavLink>
      </nav>
    </>
  )
}

function NotFound() {
  return (
    <div className="container page"><div className="card empty" style={{ maxWidth: 520, margin: '60px auto' }}><h2>Page not found</h2><Link className="btn btn-primary" to="/">Back to role selection</Link></div></div>
  )
}

/** Old addresses keep working: same path under a new name, query string (deep links) preserved. */
function Redirect({ to }) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}

export default function App() {
  return (
    <Suspense fallback={<div className="container page"><Spinner /></div>}>
      <Routes>
        {/* ---------- first screen: "Who are you?" ---------- */}
        <Route path="/" element={<RoleSelect />} />

        {/* ---------- user door ---------- */}
        <Route path="/user/login" element={<UserLogin />} />
        <Route path="/user/register" element={<UserRegister />} />
        <Route path="/user/forgot-password" element={<ForgotPassword portal="user" />} />
        <Route path="/user" element={<PublicLayout />}>
          <Route index element={<Navigate to="/user/home" replace />} />
          <Route path="home" element={<Home />} />
          <Route path="map" element={<RoadMapPage />} />
          <Route path="report" element={<ReportDamage />} />
          <Route path="routes" element={<RoutePlanner />} />
          <Route path="about" element={<About />} />
          <Route path="profile" element={<RequireAuth><Profile /></RequireAuth>} />
          <Route path="*" element={<NotFound />} />
        </Route>

        {/* links in old emails, bookmarks and earlier versions */}
        <Route path="/login" element={<Redirect to="/user/login" />} />
        <Route path="/register" element={<Redirect to="/user/register" />} />
        <Route path="/forgot-password" element={<Redirect to="/user/forgot-password" />} />
        <Route path="/home" element={<Redirect to="/user/home" />} />
        <Route path="/map" element={<Redirect to="/user/map" />} />
        <Route path="/report" element={<Redirect to="/user/report" />} />
        <Route path="/routes" element={<Redirect to="/user/routes" />} />
        <Route path="/route-planner" element={<Redirect to="/user/routes" />} />
        <Route path="/about" element={<Redirect to="/user/about" />} />
        <Route path="/profile" element={<Redirect to="/user/profile" />} />
        <Route path="/my-reports" element={<Navigate to="/user/profile?tab=reports" replace />} />

        {/* ---------- links from emails (any role) ---------- */}
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />

        {/* ---------- Admin & Road Maintenance door: one sign-in, the role decides the dashboard ---------- */}
        <Route path="/setup" element={<Setup />} />
        <Route path="/admin/setup" element={<Setup />} />
        <Route path="/admin/portal" element={<AdminPortal />} />
        <Route path="/admin/login" element={<StaffLogin />} />
        <Route path="/admin/register" element={<StaffRegister />} />
        <Route path="/admin/forgot-password" element={<ForgotPassword portal="staff" />} />
        <Route path="/maintenance/login" element={<Redirect to="/admin/login" />} />
        <Route path="/maintenance/forgot-password" element={<Redirect to="/admin/forgot-password" />} />

        <Route path="/admin" element={<RequireAdmin><PortalShell portal="admin" /></RequireAdmin>}>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="map" element={<RoadMapPage portal="admin" />} />
          <Route path="reports" element={<DamageReports />} />
          <Route path="risk" element={<PredictionAnalytics />} />
          <Route path="maintenance" element={<Maintenance />} />
          <Route path="routes" element={<RouteAnalytics />} />
          <Route path="users" element={<Users />} />
          <Route path="settings" element={<Settings />} />
          <Route path="predictions" element={<Navigate to="/admin/risk" replace />} />
          <Route path="route-analytics" element={<Navigate to="/admin/routes" replace />} />
          <Route path="damage" element={<Navigate to="/admin/reports" replace />} />
          <Route path="account" element={<Navigate to="/admin/settings" replace />} />
          <Route path="models" element={<Navigate to="/admin/settings?tab=system" replace />} />
          <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
        </Route>

        <Route path="/maintenance" element={<RequireMaintenance><PortalShell portal="maintenance" /></RequireMaintenance>}>
          <Route index element={<Navigate to="/maintenance/dashboard" replace />} />
          <Route path="dashboard" element={<StaffDashboard />} />
          <Route path="roads" element={<WorkList mode="roads" />} />
          <Route path="map" element={<RoadMapPage portal="maintenance" />} />
          <Route path="inspections" element={<WorkList mode="inspections" />} />
          <Route path="repairs" element={<WorkList mode="repairs" />} />
          <Route path="reports" element={<StaffReports />} />
          <Route path="profile" element={<AccountSettings />} />
          <Route path="*" element={<Navigate to="/maintenance/dashboard" replace />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}
