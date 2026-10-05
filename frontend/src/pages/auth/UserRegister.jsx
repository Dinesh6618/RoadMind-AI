import { ArrowLeft, Mail, User } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { portalOf, useAuth } from '../../auth'
import { ErrorBox, PasswordInput } from '../../components'
import UserLayout from './UserLayout'
import { validateAccount } from './validate'

/** /user/register - creates a normal user. The role cannot be chosen here: the server always makes it "user". */
export default function UserRegister() {
  const { user, register } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [f, setF] = useState({ full_name: '', email: '', password: '', confirm_password: '' })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const back = location.state?.from || '/user/home'
  if (user && portalOf(user.role) === 'user') return <Navigate to={back} replace />
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError(null)
    const problems = validateAccount(f)
    setErrors(problems)
    if (Object.keys(problems).length) return
    setBusy(true)
    try {
      await register({ full_name: f.full_name.trim(), email: f.email.trim(), password: f.password, confirm_password: f.confirm_password })
      navigate(back, { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UserLayout back="/user/login">
      <h2>Create your account</h2>
      <p className="sub">Report damage, keep track of your reports and plan safer routes.</p>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="ur-name">Full Name</label>
          <div className="input-icon"><User size={18} aria-hidden="true" /><input id="ur-name" className="input" autoComplete="name" value={f.full_name} onChange={set('full_name')} aria-invalid={!!errors.full_name} autoFocus /></div>
          {errors.full_name && <div className="form-error">{errors.full_name}</div>}
        </div>
        <div className="field">
          <label htmlFor="ur-email">Email</label>
          <div className="input-icon"><Mail size={18} aria-hidden="true" /><input id="ur-email" className="input" type="email" autoComplete="email" inputMode="email" value={f.email} onChange={set('email')} aria-invalid={!!errors.email} /></div>
          {errors.email && <div className="form-error">{errors.email}</div>}
        </div>
        <div className="field">
          <label htmlFor="ur-pw">Password</label>
          <PasswordInput id="ur-pw" value={f.password} onChange={set('password')} autoComplete="new-password" meter />
          {errors.password ? <div className="form-error">{errors.password}</div> : <div className="hint">At least 10 characters; avoid common passwords and your own name.</div>}
        </div>
        <div className="field">
          <label htmlFor="ur-cp">Confirm Password</label>
          <PasswordInput id="ur-cp" value={f.confirm_password} onChange={set('confirm_password')} autoComplete="new-password" />
          {errors.confirm_password && <div className="form-error">{errors.confirm_password}</div>}
        </div>
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Creating account…' : 'Create Account'}</button>
        <div className="auth-links"><span className="muted">Already have an account?</span><Link to="/user/login">Login</Link></div>
      </form>
      <Link className="back-link" to="/user/login"><ArrowLeft size={16} aria-hidden="true" /> Back to Login</Link>
    </UserLayout>
  )
}
