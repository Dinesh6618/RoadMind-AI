import { ClipboardCheck, ExternalLink, FileText, LayoutDashboard, LogOut, Map as MapIcon, Menu, Route as RouteIcon, Settings as SettingsIcon, TrafficCone, TrendingUp, User as UserIcon, Users as UsersIcon, Wrench } from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth'
import { Logo, Spinner } from '../components'
import { initials } from '../format'

// [path, label, icon, subtitle]
const PORTALS = {
  admin: {
    badge: 'AUTHORIZED PORTAL',
    role: 'Administrator',
    home: '/admin/dashboard',
    items: [
      ['/admin/dashboard', 'Dashboard', LayoutDashboard, 'Road conditions, reports and maintenance at a glance'],
      ['/admin/map', 'Road Map', MapIcon, 'The complete road network with the condition layer'],
      ['/admin/reports', 'Damage Reports', FileText, 'What was reported, what the AI found and where'],
      ['/admin/events', 'Road Events', TrafficCone, 'Verify reports, mark roads blocked or reopened'],
      ['/admin/risk', 'Risk Prediction', TrendingUp, 'Which roads are likely to deteriorate next'],
      ['/admin/maintenance', 'Maintenance', Wrench, 'Priorities, assignments, inspections, repairs and notes'],
      ['/admin/routes', 'Route Analytics', RouteIcon, 'Which routes drivers are steered away from'],
      ['/admin/users', 'Users', UsersIcon, 'Staff accounts, roles and access'],
      ['/admin/settings', 'Settings', SettingsIcon, 'Your account, models and system'],
    ],
  },
  maintenance: {
    badge: 'MAINTENANCE PORTAL',
    role: 'Maintenance staff',
    home: '/maintenance/dashboard',
    items: [
      ['/maintenance/dashboard', 'Dashboard', LayoutDashboard, 'Your roads and what needs doing next'],
      ['/maintenance/roads', 'Assigned Roads', Wrench, 'The roads assigned to you, with severity, risk and priority'],
      ['/maintenance/map', 'Road Map', MapIcon, 'The complete road network with the condition layer'],
      ['/maintenance/inspections', 'Inspections', ClipboardCheck, 'Roads waiting for an inspection'],
      ['/maintenance/repairs', 'Repairs', Wrench, 'Plan repairs, record progress and mark them completed'],
      ['/maintenance/reports', 'Reports', FileText, 'Damage reports on your roads'],
      ['/maintenance/events', 'Road Events', TrafficCone, 'Verify reports, mark roads blocked or reopened'],
      ['/maintenance/profile', 'Profile', UserIcon, 'Your account and password'],
    ],
  },
}

/** Sidebar frame of the administrator and maintenance portals. */
export default function PortalShell({ portal = 'admin' }) {
  const cfg = PORTALS[portal]
  const { user, requestSignOut } = useAuth()
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  const current = cfg.items.find(([to]) => pathname.startsWith(to)) || cfg.items[0]
  const fullMap = pathname === `/${portal}/map`
  return (
    <div className={`admin ${portal}`}>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label={portal === 'admin' ? 'Administration' : 'Maintenance'}>
        <Link to={cfg.home} aria-label="RoadMind AI dashboard" className="brand-link"><Logo dark /></Link>
        <div className="side-portal">{cfg.badge}</div>
        <nav className="side-nav">
          {cfg.items.map(([to, label, Icon]) => (
            <NavLink key={to} to={to}><Icon size={20} aria-hidden="true" />{label}</NavLink>
          ))}
          <hr />
          <button type="button" className="nav-btn" onClick={requestSignOut}><LogOut size={20} aria-hidden="true" />Logout</button>
        </nav>
        <div className="side-user">
          <span className="avatar" aria-hidden="true">{initials(user.full_name || user.username)}</span>
          <div className="who"><b>{user.full_name || user.username}</b><small>{cfg.role}</small></div>
          <button onClick={requestSignOut} aria-label="Log out" title="Log out"><LogOut size={18} /></button>
        </div>
      </aside>
      <div className="admin-main">
        <div className="admin-top">
          <div className="row nowrap-row">
            <button className="btn btn-icon menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
            <div><h1>{current[1]}</h1><p>{current[3]}</p></div>
          </div>
          <Link className="btn btn-small" to="/user/home"><ExternalLink size={15} aria-hidden="true" /> View site</Link>
        </div>
        <Suspense fallback={<Spinner />}>{fullMap ? <Outlet /> : <div className="stack"><Outlet /></div>}</Suspense>
      </div>
    </div>
  )
}
