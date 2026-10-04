import { ArrowRight, ShieldCheck, User } from 'lucide-react'
import { Link } from 'react-router-dom'
import { homeOf, useAuth } from '../auth'
import { Logo } from '../components'

/**
 * The first screen: "Who are you?" Two doors with deliberately different looks. Nothing here signs anyone in or
 * grants anything - the staff door only leads to a login page, and the server decides the role after the password.
 */
export default function RoleSelect() {
  const { user } = useAuth()
  return (
    <div className="roles-page">
      <header className="roles-head">
        <Logo />
        <span className="roles-tag">Smarter Roads • Safer Journeys</span>
      </header>
      <main className="roles-main">
        <h1>Welcome to RoadMind AI</h1>
        <p className="roles-sub">Choose how you want to access RoadMind AI.</p>
        {user && (
          <Link className="roles-resume" to={homeOf(user.role)}>
            Signed in as <strong>{user.full_name || user.username}</strong> - continue <ArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
        <h2 className="roles-q">Who are you?</h2>

        <div className="roles-grid">
          <Link to="/user/login" className="role-card role-user" aria-label="I'm a User - continue as user">
            <span className="role-icon" aria-hidden="true"><User size={34} /></span>
            <h3>I'm a User</h3>
            <p className="role-lead">I'm a road user / citizen</p>
            <p>Report road damage, explore road conditions and find safer routes.</p>
            <span className="role-cta">Continue as User <ArrowRight size={20} aria-hidden="true" /></span>
          </Link>

          <Link to="/admin/portal" className="role-card role-staff" aria-label="Admin and Road Maintenance - continue to the admin portal">
            <span className="role-icon" aria-hidden="true"><ShieldCheck size={34} /></span>
            <h3>Admin &amp; Road Maintenance</h3>
            <p className="role-lead">I'm an authorized administrator or road maintenance staff</p>
            <p>Manage road reports, inspections, maintenance and road-risk information.</p>
            <span className="role-cta">Continue to Admin Portal <ArrowRight size={20} aria-hidden="true" /></span>
          </Link>
        </div>
        <p className="roles-foot">Administrator and maintenance accounts need a verified email address and an administrator's approval. AI-generated road-condition estimates are not official engineering assessments.</p>
      </main>
    </div>
  )
}
