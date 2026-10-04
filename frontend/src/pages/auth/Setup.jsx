import { Mail, MailCheck, User } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { ErrorBox, Notice, PasswordInput, Spinner } from '../../components'
import DeliveryNotice from './DeliveryNotice'
import PortalLayout from './PortalLayout'
import { validateAccount } from './validate'

/**
 * First run only: there is no built-in account, so the person installing RoadMind creates the initial administrator
 * here. The account is created unverified; the emailed link activates it.
 */
export default function Setup() {
  const { setup, refreshSetup } = useAuth()
  const [f, setF] = useState({ full_name: '', email: '', password: '', confirm_password: '' })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(null) // reply of /auth/setup or /auth/setup/resend
  const [again, setAgain] = useState(false) // chose "wrong address? start again"
  const [resending, setResending] = useState(false)

  // an account waiting for its link: created a moment ago in this tab, or earlier (page reloaded / opened later)
  const waiting = sent ? { email: sent.email, masked: setup.pendingEmail } : setup.pending && !again ? { email: null, masked: setup.pendingEmail } : null

  if (setup.loading) return <PortalLayout title="Create Initial Administrator"><Spinner /></PortalLayout>
  if (!setup.required && !sent) return <Navigate to="/admin/login" replace />

  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError(null)
    const problems = validateAccount(f)
    setErrors(problems)
    if (Object.keys(problems).length) return
    setBusy(true)
    try {
      const res = await api('/auth/setup', { method: 'POST', json: { ...f, email: f.email.trim() } })
      setSent(res)
      setF((v) => ({ ...v, password: '', confirm_password: '' }))
      refreshSetup()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setError(null); setResending(true)
    try {
      // works without typing the address: the server knows which administrator is waiting
      const res = await api('/auth/setup/resend', { method: 'POST' })
      setSent((s) => ({ ...(s || {}), ...res, email: s?.email || null }))
    } catch (err) {
      setError(err)
    } finally {
      setResending(false)
    }
  }

  if (waiting) {
    const delivery = sent?.delivery ?? setup.email?.mode
    const outboxDir = sent?.outbox_dir ?? setup.email?.outbox_dir
    return (
      <PortalLayout title="Verify the administrator email" subtitle={`${delivery === 'smtp' ? 'We sent' : 'RoadMind prepared'} a verification link for ${waiting.email || waiting.masked || 'the address you entered'}.`}>
        <ol className="portal-steps">
          <li>Open the email and click the verification link.</li>
          <li>The administrator account is activated.</li>
          <li>Log in at the Authorized Access page.</li>
        </ol>
        {delivery && <DeliveryNotice delivery={delivery} outboxDir={outboxDir} error={sent?.delivery_error} host={setup.email?.host} known={!!sent?.delivery} />}
        <ErrorBox error={error} />
        <div className="stack-sm" style={{ marginTop: 14 }}>
          <button className="btn btn-block" onClick={resend} disabled={resending}><MailCheck size={18} aria-hidden="true" /> {resending ? 'Sending…' : 'Send the link again'}</button>
          <button className="btn btn-block" onClick={() => { setSent(null); setAgain(true) }}>Wrong address? Start again</button>
          <Link className="btn btn-primary btn-block" to="/admin/login">I have verified it - go to login</Link>
        </div>
      </PortalLayout>
    )
  }

  return (
    <PortalLayout title="Create Initial Administrator" subtitle="RoadMind has no built-in account. This email address becomes the administrator's verified identity - we will send a verification link to it.">
      {!setup.allowedHere && (
        <Notice kind="warn">For safety, the administrator can only be created from the computer that runs RoadMind. Open <code>http://127.0.0.1:8000/setup</code> on that computer.</Notice>
      )}
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="fn">Full Name</label>
          <div className="input-icon"><User size={18} aria-hidden="true" /><input id="fn" className="input" autoComplete="name" value={f.full_name} onChange={set('full_name')} aria-invalid={!!errors.full_name} /></div>
          {errors.full_name && <div className="form-error">{errors.full_name}</div>}
        </div>
        <div className="field">
          <label htmlFor="em">Authorized Gmail</label>
          <div className="input-icon"><Mail size={18} aria-hidden="true" /><input id="em" className="input" type="email" autoComplete="email" inputMode="email" value={f.email} onChange={set('email')} aria-invalid={!!errors.email} /></div>
          {errors.email ? <div className="form-error">{errors.email}</div> : <div className="hint">A Gmail or work address you can open now. You will sign in with it.</div>}
        </div>
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
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !setup.allowedHere}>{busy ? 'Creating account…' : 'Create Initial Administrator'}</button>
      </form>
    </PortalLayout>
  )
}
