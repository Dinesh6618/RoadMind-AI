import { Gauge, Map as MapIcon, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Logo } from '../../components'

const POINTS = [
  [MapIcon, 'The complete road network, with condition data layered on top'],
  [Gauge, 'AI damage detection, severity scores and risk predictions'],
  [ShieldCheck, 'Passwords stored only as Argon2 hashes - never in plain text'],
]

/** Split-screen frame shared by setup, login, registration and password recovery. */
export default function AuthLayout({ children }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <Link to="/" aria-label="RoadMind AI home"><Logo dark /></Link>
        <div>
          <h2>Safer roads start with better data.</h2>
          <p>Detect road damage, predict where it will get worse, prioritise repairs and guide drivers to lower-risk routes.</p>
          <ul>
            {POINTS.map(([Icon, text]) => (
              <li key={text}><Icon size={20} aria-hidden="true" />{text}</li>
            ))}
          </ul>
        </div>
        <small style={{ opacity: 0.7 }}>AI-generated estimates - not an official engineering assessment.</small>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="mobile-only" style={{ marginBottom: 22 }}>
            <Link to="/"><Logo /></Link>
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

export function FieldError({ children }) {
  return children ? <div className="form-error" role="alert">{children}</div> : null
}
