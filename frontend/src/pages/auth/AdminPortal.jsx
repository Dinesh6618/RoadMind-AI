import { ArrowLeft, ArrowRight, KeyRound, ShieldCheck, UserPlus } from 'lucide-react'
import { Link, Navigate } from 'react-router-dom'
import { homeOf, useAuth } from '../../auth'
import { BackButton, Logo, Notice } from '../../components'

/**
 * /admin/portal - the front door of the Administration Portal. Two clearly different choices: sign in to an existing
 * account, or ask for a new one. Neither button grants anything; the server decides every role.
 */
export default function AdminPortal() {
  const { user, setup } = useAuth()
  if (user && (user.role === 'admin' || user.role === 'maintenance')) return <Navigate to={homeOf(user.role)} replace />

  return (
    <div className="portal portal-admin portal-home">
      <div className="portal-bg" aria-hidden="true" />
      <header className="portal-top">
        <div className="portal-top-left">
          <BackButton tone="dark" to="/welcome" />
          <Link to="/welcome" aria-label="RoadMind AI - back to role selection" className="portal-brand"><Logo dark /><small>ADMINISTRATION PORTAL</small></Link>
        </div>
        <span className="portal-chip"><ShieldCheck size={14} aria-hidden="true" /> Authorized access</span>
      </header>

      <main className="portal-main portal-home-main">
        <div className="portal-home-head">
          <span className="portal-icon" aria-hidden="true"><ShieldCheck size={28} /></span>
          <h1>Welcome to the RoadMind AI Admin Portal</h1>
          <p>Manage roads, reports, inspections and maintenance.</p>
        </div>

        {!setup.loading && setup.required && (
          <div className="portal-home-note">
            <Notice kind="warn">
              No administrator exists yet, so there is nobody to approve new accounts.{' '}
              {setup.allowedHere
                ? <>First <Link to="/setup">create the initial administrator</Link>.</>
                : <>The first administrator has to be created once, on the computer that runs RoadMind (<code>http://127.0.0.1:8000/setup</code>).</>}
            </Notice>
          </div>
        )}

        <div className="portal-choices">
          <Link to="/admin/login" className="portal-choice choice-login" aria-label="Login - access your dashboard">
            <span className="choice-icon" aria-hidden="true"><KeyRound size={30} /></span>
            <span className="choice-kicker">Login</span>
            <h2>Already have an account?</h2>
            <p>Access your dashboard.</p>
            <span className="choice-cta">Login <ArrowRight size={20} aria-hidden="true" /></span>
          </Link>

          <Link to="/admin/register" className="portal-choice choice-create" aria-label="Create account - new administrator or maintenance staff">
            <span className="choice-icon" aria-hidden="true"><UserPlus size={30} /></span>
            <span className="choice-kicker">Create account</span>
            <h2>New administrator or maintenance staff?</h2>
            <p>Create an authorized account.</p>
            <span className="choice-cta">Create Account <ArrowRight size={20} aria-hidden="true" /></span>
          </Link>
        </div>

        <p className="portal-home-fine">
          New accounts only start as a <strong>request</strong>: the email address is verified first, then an existing administrator approves it.
        </p>
        <Link className="portal-back" to="/welcome"><ArrowLeft size={15} aria-hidden="true" /> Back to User/Admin Selection</Link>
      </main>

      <footer className="portal-foot">Authorized personnel only. Sign-in attempts are rate-limited and sessions expire automatically.</footer>
    </div>
  )
}
