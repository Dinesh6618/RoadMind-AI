import { ArrowLeft, Mail, MailCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { PORTALS } from '../../auth'
import { ErrorBox } from '../../components'
import AuthLayout from './AuthLayout'
import PortalLayout from './PortalLayout'

/** Password reset request. `portal` ("user" or "staff") only changes the look and where "back to login" goes. */
export default function ForgotPassword({ portal = 'user' }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  const login = PORTALS[portal].path
  const staff = portal === 'staff'

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api('/auth/forgot-password', { method: 'POST', json: { identifier: email.trim() } })
      setDone(res.message) // always the same text: it never says whether the account exists
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const body = done ? (
    <>
      <span className="stat-icon" style={{ '--accent': 'var(--good)', width: 56, height: 56, borderRadius: 18 }}><MailCheck size={28} aria-hidden="true" /></span>
      <h1>Check your email</h1>
      <p className="sub">{done}</p>
      <Link className="btn btn-block" to={login}>Back to login</Link>
    </>
  ) : (
    <>
      {!staff && <h1>Forgot your password?</h1>}
      {!staff && <p className="sub">Enter your email address. If an account matches, we will send a link to choose a new password. Your current password is never shown.</p>}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="fid">{staff ? 'Authorized Email / Gmail' : 'Email'}</label>
          <div className="input-icon"><Mail size={18} aria-hidden="true" /><input id="fid" className="input" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
        </div>
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        <div className="auth-links"><Link to={login}>Back to login</Link><Link to="/"><ArrowLeft size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Role Selection</Link></div>
      </form>
    </>
  )

  if (staff) {
    return (
      <PortalLayout title={done ? undefined : 'Reset your password'} subtitle={done ? undefined : 'Enter your authorised email. If it belongs to a verified account, we will email a single-use reset link. Your current password is never shown.'}>
        {body}
      </PortalLayout>
    )
  }
  return <AuthLayout>{body}</AuthLayout>
}
