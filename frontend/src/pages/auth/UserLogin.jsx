import { ArrowLeft, Compass, Mail } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { PORTALS, portalOf, useAuth } from '../../auth'
import { ErrorBox, Notice, PasswordInput } from '../../components'
import UserLayout from './UserLayout'

/**
 * /user/login - for normal users only. Administrators and maintenance staff have their own door (/admin/login): the
 * server refuses their accounts here, whatever this page says, and points them there.
 */
export default function UserLogin() {
  const { user, login } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const back = location.state?.from || '/user/home'
  if (user && portalOf(user.role) === 'user') return <Navigate to={back} replace />

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(email.trim(), password)
      navigate(back, { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UserLayout back="/">
      <h2>Welcome Back</h2>
      <p className="sub">Sign in to make your journeys safer.</p>
      {location.state?.notice && <Notice kind="ok">{location.state.notice}</Notice>}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="ul-email">Email</label>
          <div className="input-icon"><Mail size={18} aria-hidden="true" /><input id="ul-email" className="input" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
        </div>
        <div className="field">
          <label htmlFor="ul-pw">Password</label>
          <PasswordInput id="ul-pw" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <ErrorBox error={error} />
        {error?.code === 'wrong_portal' && error.info?.login_path && (
          <p className="small"><Link to={error.info.login_path}>Open the {PORTALS[error.info.portal]?.label} sign-in</Link></p>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Login'}</button>
        <div className="auth-links"><Link to="/user/forgot-password">Forgot Password?</Link><span /></div>
      </form>

      <div className="or">or</div>
      <div className="stack-sm">
        <Link className="btn btn-lg btn-block btn-soft" to="/user/register">Create User Account</Link>
        <button type="button" className="btn btn-lg btn-block" onClick={() => navigate('/user/home')}><Compass size={19} aria-hidden="true" /> Continue as Guest</button>
      </div>
      <p className="guest-note">Guests can browse the map, search roads and plan routes. A free account is needed to submit a damage report.</p>
      <Link className="back-link" to="/"><ArrowLeft size={16} aria-hidden="true" /> Back to Role Selection</Link>
    </UserLayout>
  )
}
