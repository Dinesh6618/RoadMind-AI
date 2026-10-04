import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { ErrorBox, Notice, PasswordInput } from '../../components'
import AuthLayout from './AuthLayout'

/** Reached from the link in the reset email: /reset-password?token=... */
export default function ResetPassword() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') || ''
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (pw.length < 10) return setError(new Error('The password must be at least 10 characters long.'))
    if (pw !== confirm) return setError(new Error('Password and Confirm Password do not match.'))
    setBusy(true)
    try {
      const res = await api('/auth/reset-password', { method: 'POST', json: { token, new_password: pw, confirm_password: confirm } })
      navigate(res.login_path || '/user/login', { replace: true, state: { notice: res.message } })  // back to the portal the account belongs to
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <h1>Reset link missing</h1>
        <Notice kind="warn">Open the link from your reset email, or request a new one.</Notice>
        <Link className="btn btn-primary btn-block" to="/user/forgot-password">Request a new link</Link>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout>
      <h1>Choose a new password</h1>
      <p className="sub">This link works once and expires soon. Signing in elsewhere will end after you change the password.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="np">New password</label>
          <PasswordInput id="np" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" meter />
        </div>
        <div className="field">
          <label htmlFor="cp">Confirm new password</label>
          <PasswordInput id="cp" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        <ErrorBox error={error} />
        {error?.status === 400 && <p className="small"><Link to="/user/forgot-password">Request a new reset link</Link></p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
      </form>
    </AuthLayout>
  )
}
