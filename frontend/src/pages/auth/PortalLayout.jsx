import { ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { BackButton, Logo } from '../../components'

/**
 * The dark, security-focused frame of the Admin & Road Maintenance portal (sign-in, first-run setup, password reset).
 * It must never be mistaken for the friendly user pages. `back` (a fallback address) adds a Back button to the header.
 */
export default function PortalLayout({ title, subtitle, back, children }) {
  return (
    <div className="portal portal-admin">
      <div className="portal-bg" aria-hidden="true" />
      <header className="portal-top">
        <div className="portal-top-left">
          {back && <BackButton tone="dark" to={back} />}
          <Link to="/" aria-label="RoadMind AI - back to role selection" className="portal-brand"><Logo dark /><small>ADMINISTRATION PORTAL</small></Link>
        </div>
        <span className="portal-chip"><ShieldCheck size={14} aria-hidden="true" /> Authorized access</span>
      </header>
      <main className="portal-main">
        <div className="portal-card">
          <span className="portal-icon" aria-hidden="true"><ShieldCheck size={28} /></span>
          {title && <h1>{title}</h1>}
          {subtitle && <p className="sub">{subtitle}</p>}
          {children}
        </div>
      </main>
      <footer className="portal-foot">Authorized personnel only. Sign-in attempts are rate-limited and sessions expire automatically.</footer>
    </div>
  )
}
