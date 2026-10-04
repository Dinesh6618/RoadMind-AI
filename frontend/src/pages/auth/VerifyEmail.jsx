import { CheckCircle2, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { Spinner } from '../../components'
import AuthLayout from './AuthLayout'

/** Reached from the verification email: /verify-email?token=... The link works once. */
export default function VerifyEmail() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const { refreshSetup } = useAuth()
  const [state, setState] = useState(token ? { phase: 'working' } : { phase: 'failed', message: 'This page needs the link from your verification email.' })
  const started = useRef(false)

  useEffect(() => {
    if (!token || started.current) return // (a single call even when React runs effects twice in development)
    started.current = true
    api('/auth/verify-email', { method: 'POST', json: { token } })
      .then(async (res) => {
        await refreshSetup() // the first administrator may just have become active: "setup required" is no longer true
        setState({ phase: 'done', ...res })
      })
      .catch((err) => setState({ phase: 'failed', message: err.message }))
  }, [token, refreshSetup])

  return (
    <AuthLayout>
      {state.phase === 'working' && <><h1>Verifying your email…</h1><Spinner label="One moment" /></>}
      {state.phase === 'done' && (
        <>
          <span className="stat-icon" style={{ '--accent': 'var(--good)', width: 56, height: 56, borderRadius: 18 }}><CheckCircle2 size={28} aria-hidden="true" /></span>
          <h1>Email verified</h1>
          {state.status === 'PENDING_ADMIN_APPROVAL' ? (
            <>
              <p className="sub">{state.message}</p>
              <p className="sub" style={{ marginTop: -8 }}>We will email you as soon as an administrator has decided. Until then the account cannot sign in.</p>
              <Link className="btn btn-primary btn-lg btn-block" to="/admin/portal">Back to Admin Portal</Link>
            </>
          ) : (
            <>
              <p className="sub">{state.message} The account is now active.</p>
              <Link className="btn btn-primary btn-lg btn-block" to={state.login_path} state={{ notice: 'Email verified. You can log in now.' }}>Continue to login</Link>
            </>
          )}
        </>
      )}
      {state.phase === 'failed' && (
        <>
          <span className="stat-icon" style={{ '--accent': 'var(--critical)', width: 56, height: 56, borderRadius: 18 }}><XCircle size={28} aria-hidden="true" /></span>
          <h1>This link can't be used</h1>
          <p className="sub">{state.message}</p>
          <Link className="btn btn-primary btn-block" to="/admin/login">Go to the login page to request a new link</Link>
        </>
      )}
    </AuthLayout>
  )
}
