import { ArrowLeft, Mail } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { PORTALS, homeOf, useAuth } from '../../auth'
import { ErrorBox, Notice, PasswordInput, Spinner } from '../../components'
import { readFlash } from '../../flash'
import PortalLayout from './PortalLayout'

const TITLE = 'Authorized Access'
const SUBTITLE = 'Administrator & Road Maintenance Portal'

/** Honour a "come back to" address only if it belongs to the area this role may use. */
const landing = (from, role) => (from && from.startsWith(role === 'admin' ? '/admin/' : '/maintenance/') ? from : homeOf(role))

/**
 * /admin/login - ONE sign-in page for administrators and road-maintenance staff. Accounts come from an administrator's
 * invitation, from an approved request made at /admin/register, or (the very first one) from /setup on the server
 * computer. The server checks the password, the account status (email verified? approved? not rejected / suspended?)
 * and the role; the role it finds decides the dashboard - nothing here (or in the URL) can pick it.
 */
export default function StaffLogin() {
  const { user, loginTo, setup } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [resent, setResent] = useState(null)
  const flash = readFlash() // "You have been logged out successfully." right after a staff logout

  if (setup.loading) return <PortalLayout title={TITLE} subtitle={SUBTITLE}><Spinner /></PortalLayout>
  // first run with nobody created yet -> the setup page; but once an account exists (even if its email is not verified
  // yet) "Login" must show the sign-in form, so the person can enter their email / username and password
  if (setup.required && setup.allowedHere && !setup.pending) return <Navigate to="/setup" replace />
  if (user && (user.role === 'admin' || user.role === 'maintenance')) return <Navigate to={landing(location.state?.from, user.role)} replace />

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null); setResent(null)
    try {
      const u = await loginTo('staff', email.trim(), password)
      navigate(landing(location.state?.from, u.role), { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    try {
      // the server tells us the account's address when the password was right, so a username works too
      const res = await api('/auth/resend-verification', { method: 'POST', json: { email: error?.info?.email || email.trim() } })
      setResent(setup.email?.mode === 'outbox'
        ? 'A new link was prepared. No mail server is set up, so it was saved in the outbox folder on the computer that runs RoadMind - open the newest file there.'
        : res.message)
    } catch (err) {
      setError(err)
    }
  }

  return (
    <PortalLayout title={TITLE} subtitle={SUBTITLE} back="/admin/portal">
      {location.state?.notice && <Notice kind="ok">{location.state.notice}</Notice>}
      {flash && !location.state?.notice && <Notice kind="ok">{flash}</Notice>}
      {setup.required && !setup.allowedHere && !setup.pending && (
        <Notice kind="warn">No administrator account exists yet. It has to be created once, on the computer that runs RoadMind.</Notice>
      )}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="sid">Authorized Email / Gmail</label>
          <div className="input-icon"><Mail size={18} aria-hidden="true" /><input id="sid" className="input" type="text" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck="false" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
          <div className="hint">Your email address - or your username.</div>
        </div>
        <div className="field">
          <label htmlFor="spw">Password</label>
          <PasswordInput id="spw" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error?.code === 'pending_admin_approval'
          ? <Notice kind="info">{error.message}</Notice> // a status, not a failure: the password was right
          : <ErrorBox error={error} />}
        {error?.code === 'wrong_portal' && error.info?.login_path && (
          <p className="small"><Link to={error.info.login_path}>Go to the {PORTALS[error.info.portal]?.label} sign-in</Link></p>
        )}
        {error?.code === 'email_not_verified' && (
          <div className="stack-sm" style={{ marginBottom: 14 }}>
            <button type="button" className="btn btn-block" onClick={resend}>Send me a new verification link</button>
            {resent && <Notice kind="ok">{resent}</Notice>}
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Verifying…' : 'Verify & Login'}</button>
        <div className="auth-links">
          <Link to="/admin/forgot-password">Forgot Password?</Link>
          <Link to="/admin/portal"><ArrowLeft size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Back to Admin Portal</Link>
        </div>
      </form>
      <p className="small muted" style={{ marginTop: 22, marginBottom: 0 }}>
        Only verified, approved accounts can sign in here. Need an account? <Link to="/admin/register">Create one</Link> - an administrator approves it first.
      </p>
    </PortalLayout>
  )
}
