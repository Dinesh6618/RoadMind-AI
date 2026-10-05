import { ShieldAlert } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { api, getToken, setToken, useApi } from './api'
import { Spinner } from './components'
import ConfirmDialog from './ConfirmDialog'
import { setFlash } from './flash'

const AuthContext = createContext(null)

// Set when the person chose to log out (cleared by the next sign-in): a protected user page opened afterwards - for example with the
// browser Back button, or in another tab - sends them to the Welcome page, not to a login form and never back to the page they signed
// out of. (localStorage, so every tab of this browser agrees.)
const LOGGED_OUT_KEY = 'roadmind_logged_out'
const wasLoggedOut = () => { try { return localStorage.getItem(LOGGED_OUT_KEY) === '1' } catch { return false } }
const markLoggedOut = (on) => { try { on ? localStorage.setItem(LOGGED_OUT_KEY, '1') : localStorage.removeItem(LOGGED_OUT_KEY) } catch { /* storage blocked */ } }
export const LOGGED_OUT_MESSAGE = 'You have been logged out successfully.'

/**
 * Two doors, chosen on the first screen ("Who are you?"): normal users, and Admin & Road Maintenance. The login
 * endpoints refuse accounts that belong to the other door; inside the staff door the account's role (decided by the
 * server) picks the dashboard.
 */
export const PORTALS = {
  user: { path: '/user/login', endpoint: '/auth/login', label: 'user portal' },
  staff: { path: '/admin/login', endpoint: '/auth/staff/login', label: 'Admin & Road Maintenance portal' },
}
export const portalOf = (role) => (role === 'admin' || role === 'maintenance' ? 'staff' : 'user')
/** Where a role lands after signing in (the server sends the same value as `home`). */
export const homeOf = (role) => ({ admin: '/admin/dashboard', maintenance: '/maintenance/dashboard' }[role] || '/user/home')

/**
 * Who is signed in. The server is the authority on roles: this only mirrors what /auth/me says so the interface can
 * show the right menus. Every protected API call is checked again on the server.
 */
export function AuthProvider({ children }) {
  const navigate = useNavigate()
  const [askSignOut, setAskSignOut] = useState(false)
  const [token, setTokenState] = useState(getToken())
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(!getToken()) // with a stored token we must ask who it belongs to first
  const [setup, setSetup] = useState({ loading: true, required: false, allowedHere: false, pending: false, pendingEmail: null, email: null })

  const refreshSetup = useCallback(() => {
    return api('/auth/setup-status')
      .then((s) => setSetup({ loading: false, required: s.setup_required, allowedHere: s.setup_allowed_here, pending: !!s.verification_pending, pendingEmail: s.pending_email, email: s.email }))
      .catch(() => setSetup({ loading: false, required: false, allowedHere: false, pending: false, pendingEmail: null, email: null }))
  }, [])
  useEffect(() => { refreshSetup() }, [refreshSetup])

  const clear = useCallback(() => {
    setToken(null)
    setTokenState(null)
    setUser(null)
    setReady(true)
  }, [])

  /** The session ended without the person asking (an expired or revoked token): end it on the server too (best effort) and forget it here.
   *  The page's guard then sends them to the sign-in page, with the page they were on remembered. */
  const logout = useCallback(() => {
    if (getToken()) api('/auth/logout', { method: 'POST' }).catch(() => {})
    clear()
  }, [clear])

  /** The person chose to log out: a REAL logout - the session is revoked on the server, the token and the signed-in state are removed here,
   *  and they land on the Welcome page (staff on their own sign-in page) with a confirmation line. */
  const signOut = useCallback(() => {
    const staff = user ? portalOf(user.role) === 'staff' : false
    if (getToken()) api('/auth/logout', { method: 'POST' }).catch(() => {})
    markLoggedOut(true)
    setFlash(LOGGED_OUT_MESSAGE)
    setAskSignOut(false)
    clear()
    navigate(staff ? PORTALS.staff.path : '/welcome', { replace: true })
  }, [user, clear, navigate])
  const requestSignOut = useCallback(() => setAskSignOut(true), [])

  // Another tab logged out: this one must not stay signed in. And a page restored from the browser's back/forward cache (Back after
  // logout) skips every guard, so check again when it comes back.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === null || e.key === 'roadmind_token') { if (!getToken()) clear() } }
    const onPageShow = (e) => { if (e.persisted && !getToken()) { clear(); window.location.replace(wasLoggedOut() ? '/welcome' : '/user/login') } }
    window.addEventListener('storage', onStorage)
    window.addEventListener('pageshow', onPageShow)
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('pageshow', onPageShow) }
  }, [clear])

  // After a page load only the token survives: look the account up again (an expired or revoked token logs out).
  useEffect(() => {
    if (!token || user) return
    let cancelled = false
    api('/auth/me')
      .then((me) => { if (!cancelled) setUser(me) })
      .catch((err) => { if (!cancelled && err.status === 401) clear() })
      .finally(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [token, user, clear])

  /** Adopt a session returned by the API (login, register, password change). */
  const adopt = useCallback((res) => {
    markLoggedOut(false)
    setToken(res.access_token)
    setTokenState(res.access_token)
    setUser(res.user ?? null)
    setReady(true)
    return res.user
  }, [])

  const loginTo = useCallback(async (portal, identifier, password) => adopt(await api(PORTALS[portal].endpoint, { method: 'POST', json: { identifier, password } })), [adopt])
  const register = useCallback(async (body) => adopt(await api('/auth/register', { method: 'POST', json: body })), [adopt])

  const value = useMemo(
    () => ({
      user, isAuthed: !!token && !!user, isAdmin: user?.role === 'admin', isMaintenance: user?.role === 'maintenance',
      ready, setup, refreshSetup, loginTo, login: (i, p) => loginTo('user', i, p), register, logout, signOut, requestSignOut, adopt, setUser,
    }),
    [user, token, ready, setup, refreshSetup, loginTo, register, logout, signOut, requestSignOut, adopt],
  )
  return (
    <AuthContext.Provider value={value}>
      {children}
      {askSignOut && (
        <ConfirmDialog
          title="Are you sure you want to log out?" message="You will need to sign in again to use RoadMind." confirmLabel="Logout" cancelLabel="Cancel"
          onConfirm={signOut} onCancel={() => setAskSignOut(false)}
        />
      )}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

/** useApi for protected endpoints: an expired or revoked token logs the person out (and sends them to their login page). */
export function useAdminApi(path) {
  const { logout } = useAuth()
  return useApi(path, { onUnauthorized: logout })
}
export const useStaffApi = useAdminApi

// What each guarded area says when the wrong kind of account opens it: [text, label of the "go back" button].
const DENIED = {
  admin: {
    user: ['Administrator privileges are required to access this page.', 'Return to User Dashboard'],
    maintenance: ['Administrator privileges are required.', 'Return to Maintenance Dashboard'],
  },
  maintenance: {
    user: ['Road maintenance staff privileges are required to access this page.', 'Return to User Dashboard'],
    admin: ['This area is for road-maintenance staff. Administrators manage maintenance from the Admin dashboard.', 'Return to Admin Dashboard'],
  },
}

function Gate({ children, need }) {
  const { user, ready, setup } = useAuth()
  const location = useLocation()
  if (!ready || setup.loading) return <div className="container page"><Spinner label="Checking your session…" /></div>
  if (!user) {
    // first run: there is nobody to sign in as yet, so go straight to the setup page (on the server computer);
    // once the first account exists (even unverified) the normal sign-in page is the right place
    if (setup.required && need === 'admin' && setup.allowedHere && !setup.pending) return <Navigate to="/setup" replace />
    // someone who logged out and comes back to a protected user page (the Back button, a bookmark) starts again at the Welcome page
    if (need === 'user' && wasLoggedOut()) return <Navigate to="/welcome" replace />
    return <Navigate to={PORTALS[need === 'user' ? 'user' : 'staff'].path} replace state={{ from: location.pathname + location.search }} />
  }
  if (need !== 'user' && user.role !== need) return <AccessDenied area={need} />
  return children
}

export const RequireAuth = ({ children }) => <Gate need="user">{children}</Gate>
export const RequireAdmin = ({ children }) => <Gate need="admin">{children}</Gate>
export const RequireMaintenance = ({ children }) => <Gate need="maintenance">{children}</Gate>

export function AccessDenied({ area = 'admin' }) {
  const { user, requestSignOut } = useAuth()
  const [text, button] = DENIED[area]?.[user?.role] || DENIED.admin.user
  return (
    <div className="container page">
      <div className="card empty" style={{ maxWidth: 580, margin: '40px auto' }} role="alert">
        <ShieldAlert size={44} style={{ color: 'var(--high)', marginBottom: 10 }} aria-hidden="true" />
        <h2 style={{ color: 'var(--ink)' }}>Access Denied</h2>
        <p>{text}</p>
        <p className="small muted">Signed in as <strong>{user?.full_name || user?.username}</strong>.</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link className="btn btn-primary" to={homeOf(user?.role)}>{button}</Link>
          <button className="btn" onClick={requestSignOut}>Log out</button>
        </div>
      </div>
    </div>
  )
}
