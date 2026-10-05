import { ArrowRight, ShieldCheck, User } from 'lucide-react'
import { Link } from 'react-router-dom'
import { homeOf, useAuth } from '../auth'
import { Logo, Notice } from '../components'
import { readFlash } from '../flash'

/**
 * The Welcome page (/welcome, also /): the clean starting point of the whole app - and where logging out lands. "Who are you?" Two doors
 * with deliberately different looks. Nothing here signs anyone in or grants anything: the staff door only leads to a login page, and
 * the server decides the role after the password. There is no Back button: nothing comes before this page.
 */
export default function RoleSelect() {
  const { user } = useAuth()
  const flash = readFlash() // "You have been logged out successfully." (shown for a few seconds after logging out)
  return (
    <div className="roles-page">
      <header className="roles-head">
        <Logo />
        <span className="roles-tag">Smarter Roads • Safer Journeys</span>
      </header>
      <main className="roles-main">
        <h1>Welcome to RoadMind AI</h1>
        <p className="roles-sub">Smarter roads. Safer journeys.</p>
        {flash && <div className="roles-flash"><Notice kind="ok">{flash}</Notice></div>}
        {user && (
          <Link className="roles-resume" to={homeOf(user.role)}>
            Signed in as <strong>{user.full_name || user.username}</strong> - continue <ArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
        <h2 className="roles-q">Who are you?</h2>

        <div className="roles-grid">
          <Link to="/user/login" className="role-card role-user" aria-label="User - access maps, report road problems and find smarter routes">
            <span className="role-icon" aria-hidden="true"><User size={34} /></span>
            <h3>User</h3>
            <p className="role-lead">Access maps, report road problems and find smarter routes</p>
            <p>Explore road conditions, report damage with a photo and plan lower-risk routes.</p>
            <span className="role-cta">Continue as User <ArrowRight size={20} aria-hidden="true" /></span>
          </Link>

          <Link to="/admin/portal" className="role-card role-staff" aria-label="Admin and Road Maintenance - manage roads, reports, maintenance and analytics">
            <span className="role-icon" aria-hidden="true"><ShieldCheck size={34} /></span>
            <h3>Admin / Road Maintenance</h3>
            <p className="role-lead">Manage roads, reports, maintenance and analytics</p>
            <p>For authorized administrators and road maintenance staff.</p>
            <span className="role-cta">Continue to Admin Portal <ArrowRight size={20} aria-hidden="true" /></span>
          </Link>
        </div>
        <p className="roles-foot">Administrator and maintenance accounts need a verified email address and an administrator's approval. AI-generated road-condition estimates are not official engineering assessments.</p>
      </main>
    </div>
  )
}
