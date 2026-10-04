import { CheckCircle2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { ErrorBox, Notice, PasswordInput } from '../../components'
import AuthLayout from './AuthLayout'
import { validatePassword } from './validate'

/** Reached from the invitation email: /accept-invite?token=... The invited person verifies the address by choosing their own password. */
export default function AcceptInvite() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [f, setF] = useState({ password: '', confirm_password: '' })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    const problems = validatePassword(f.password, f.confirm_password)
    setErrors(problems)
    if (Object.keys(problems).length) return
    setBusy(true)
    try {
      setDone(await api('/auth/accept-invite', { method: 'POST', json: { token, new_password: f.password, confirm_password: f.confirm_password } }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <h1>Invitation link missing</h1>
        <Notice kind="warn">Open the link from your invitation email, or ask an administrator to send a new one.</Notice>
      </AuthLayout>
    )
  }
  if (done) {
    return (
      <AuthLayout>
        <span className="stat-icon" style={{ '--accent': 'var(--good)', width: 56, height: 56, borderRadius: 18 }}><CheckCircle2 size={28} aria-hidden="true" /></span>
        <h1>You're all set</h1>
        <p className="sub">{done.message}</p>
        <Link className="btn btn-primary btn-lg btn-block" to={done.login_path} state={{ notice: 'Your account is ready. Log in with your email and the password you just chose.' }}>Continue to login</Link>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout>
      <h1>Accept your invitation</h1>
      <p className="sub">An administrator created a RoadMind AI account for you. Choose a password to verify your email address and activate it. Nobody else sees this password.</p>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="ip">Password</label>
          <PasswordInput id="ip" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" meter />
          {errors.password ? <div className="form-error">{errors.password}</div> : <div className="hint">At least 10 characters; avoid common passwords and your own name.</div>}
        </div>
        <div className="field">
          <label htmlFor="ic">Confirm Password</label>
          <PasswordInput id="ic" value={f.confirm_password} onChange={(e) => setF({ ...f, confirm_password: e.target.value })} autoComplete="new-password" />
          {errors.confirm_password && <div className="form-error">{errors.confirm_password}</div>}
        </div>
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Saving…' : 'Verify email & activate account'}</button>
      </form>
    </AuthLayout>
  )
}
