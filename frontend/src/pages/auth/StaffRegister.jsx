import { ArrowLeft, Mail, MailCheck, ShieldCheck, User, Wrench } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { ErrorBox, Notice, PasswordInput, Spinner } from '../../components'
import DeliveryNotice from './DeliveryNotice'
import PortalLayout from './PortalLayout'
import { validateAccount } from './validate'

const TYPES = [
  ['admin', 'Administrator', ShieldCheck, 'Reviews reports and approves new accounts.'],
  ['maintenance', 'Road Maintenance Staff', Wrench, 'Works on the roads assigned to them.'],
]

/**
 * /admin/register - ask for an administrator or maintenance account. This only creates a REQUEST: the account keeps the
 * plain user role, cannot sign in anywhere, and becomes usable after (1) the emailed link verifies the address and
 * (2) an existing administrator approves it. The Account Type is what is being requested - it grants nothing.
 */
export default function StaffRegister() {
  const { user, setup } = useAuth()
  const [f, setF] = useState({ full_name: '', email: '', account_type: '', password: '', confirm_password: '' })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null) // reply of /auth/staff/register

  if (setup.loading) return <PortalLayout title="Create Authorized Account"><Spinner /></PortalLayout>
  if (user && (user.role === 'admin' || user.role === 'maintenance')) return <Navigate to="/admin/users" replace />

  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError(null)
    const problems = validateAccount(f)
    if (!f.account_type) problems.account_type = 'Choose the account you are asking for.'
    setErrors(problems)
    if (Object.keys(problems).length) return
    setBusy(true)
    try {
      const res = await api('/auth/staff/register', { method: 'POST', json: { ...f, email: f.email.trim() } })
      setDone(res)
      setF((v) => ({ ...v, password: '', confirm_password: '' }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <PortalLayout title="Account created" subtitle="Your account has been created successfully. Please wait for administrator approval.">
        <ol className="portal-steps">
          <li><span>Open the verification email sent to <strong>{done.email}</strong> and click the link.</span></li>
          <li><span>An administrator reviews your request.</span></li>
          <li><span>You get an email when it is approved - then you can log in.</span></li>
        </ol>
        <DeliveryNotice delivery={done.delivery} outboxDir={done.outbox_dir} error={done.delivery_error} host={setup.email?.host} />
        <Notice kind="info">
          Until it is approved this account can't sign in and has no administrator or maintenance access
          ({done.requested_role === 'admin' ? 'Administrator' : 'Road Maintenance Staff'} was requested).
        </Notice>
        <div className="stack-sm" style={{ marginTop: 14 }}>
          <Link className="btn btn-primary btn-block" to="/admin/portal"><MailCheck size={18} aria-hidden="true" /> Back to Admin Portal</Link>
        </div>
      </PortalLayout>
    )
  }

  return (
    <PortalLayout title="Create Authorized Account" subtitle="Request an administrator or road-maintenance account. An existing administrator has to approve it before you can log in.">
      {setup.required && (
        <Notice kind="warn">
          No administrator exists yet to approve requests. {setup.allowedHere ? <>Create the initial administrator <Link to="/setup">here</Link> first.</> : 'The first administrator is created once, on the computer that runs RoadMind.'}
        </Notice>
      )}
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="fn">Full Name</label>
          <div className="input-icon"><User size={18} aria-hidden="true" /><input id="fn" className="input" autoComplete="name" value={f.full_name} onChange={set('full_name')} aria-invalid={!!errors.full_name} /></div>
          {errors.full_name && <div className="form-error">{errors.full_name}</div>}
        </div>
        <div className="field">
          <label htmlFor="em">Gmail / Email</label>
          <div className="input-icon"><Mail size={18} aria-hidden="true" /><input id="em" className="input" type="email" autoComplete="email" inputMode="email" value={f.email} onChange={set('email')} aria-invalid={!!errors.email} /></div>
          {errors.email ? <div className="form-error">{errors.email}</div> : <div className="hint">We send a verification link to this address. You will sign in with it.</div>}
        </div>

        <fieldset className="field type-field" aria-describedby="type-hint">
          <legend>Account Type</legend>
          <div className="type-grid">
            {TYPES.map(([value, label, Icon, hint]) => (
              <label key={value} className={`type-option${f.account_type === value ? ' on' : ''}`}>
                <input type="radio" name="account_type" value={value} checked={f.account_type === value} onChange={set('account_type')} />
                <span className="type-icon" aria-hidden="true"><Icon size={18} /></span>
                <span><b>{label}</b><small>{hint}</small></span>
              </label>
            ))}
          </div>
          {errors.account_type ? <div className="form-error">{errors.account_type}</div> : <div className="hint" id="type-hint">This is a request. Nobody becomes an administrator by choosing it - an administrator approves each account.</div>}
        </fieldset>

        <div className="field">
          <label htmlFor="pw">Password</label>
          <PasswordInput id="pw" value={f.password} onChange={set('password')} autoComplete="new-password" meter />
          {errors.password ? <div className="form-error">{errors.password}</div> : <div className="hint">At least 10 characters. Not a common password, and it must not contain your name or email.</div>}
        </div>
        <div className="field">
          <label htmlFor="cp">Confirm Password</label>
          <PasswordInput id="cp" value={f.confirm_password} onChange={set('confirm_password')} autoComplete="new-password" />
          {errors.confirm_password && <div className="form-error">{errors.confirm_password}</div>}
        </div>
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Creating account…' : 'Create Account'}</button>
        <div className="auth-links">
          <Link to="/admin/login">Already have an account? Login</Link>
          <Link to="/admin/portal"><ArrowLeft size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Back to Admin Portal</Link>
        </div>
      </form>
    </PortalLayout>
  )
}
