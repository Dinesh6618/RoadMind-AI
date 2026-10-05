import { Camera, LayoutDashboard } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useApi } from '../api'
import { useAuth } from '../auth'
import { Badge, Empty, ErrorBox, SeverityBadge, Spinner } from '../components'
import { fmtDate, initials } from '../format'
import AccountSettings from './AccountSettings'
import MyEventReports from './report/MyEventReports'
import './events.css'

function DamageReports() {
  const { data, loading, error, reload } = useApi('/reports/mine')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data.items.length) {
    return (
      <div className="card"><Empty icon={Camera}>You have not submitted a pothole or crack report yet while signed in.<br /><Link className="btn btn-primary" style={{ marginTop: 14 }} to="/user/report">Report a road problem</Link></Empty></div>
    )
  }
  return (
    <div className="grid cols-3">
      {data.items.map((r) => (
        <article key={r.id} className="card card-flush">
          {r.annotated_url && <img src={r.annotated_url} alt="Your photo with detected damage outlined" style={{ width: '100%', aspectRatio: '16/10', objectFit: 'cover', display: 'block' }} />}
          <div style={{ padding: 18 }}>
            <div className="row between" style={{ marginBottom: 6 }}><b>Report #{r.id}</b><SeverityBadge level={r.severity_level} /></div>
            <div style={{ fontWeight: 650 }}>{r.damage_summary}</div>
            <div className="muted small">{r.road_name} · {fmtDate(r.reported_at)}</div>
          </div>
        </article>
      ))}
    </div>
  )
}

/** Everything this person reported: AI damage reports (potholes, cracks) and road events (flooding, accidents, blockages...). */
function MyReports() {
  return (
    <div className="stack">
      <section aria-labelledby="my-damage-h">
        <h2 id="my-damage-h" className="ev-mine-h">Damage reports</h2>
        <DamageReports />
      </section>
      <MyEventReports />
    </div>
  )
}

/** Account page for any signed-in person. Administrators also get a shortcut to the dashboard.
 *  /user/profile shows it (tabs through ?tab=reports); /user/settings and /user/my-reports show the same page with that tab open. */
export default function Profile({ tab: fixedTab = null }) {
  const { user, isAdmin, isMaintenance } = useAuth()
  const role = isAdmin ? ['Administrator', '#5b3df5', '#3c24b8'] : isMaintenance ? ['Maintenance staff', '#d97706', '#8a4a00'] : ['Normal user', '#0e8f61', '#0b6e4b']
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const tab = fixedTab || (params.get('tab') === 'reports' ? 'reports' : 'account')
  const openTab = (which) => (fixedTab ? navigate(which === 'reports' ? '/user/my-reports' : '/user/settings', { replace: true }) : which === 'reports' ? setParams({ tab: 'reports' }) : setParams({}))
  return (
    <div className="container page">
      <div className="profile-head">
        <span className="avatar" aria-hidden="true">{initials(user.full_name || user.username)}</span>
        <div>
          <h1 style={{ fontSize: '1.8rem', margin: 0 }}>{user.full_name || user.username}</h1>
          <div className="muted">@{user.username} · {user.email}</div>
          <div style={{ marginTop: 8 }}><Badge color={role[1]} ink={role[2]} dot>{role[0]}</Badge></div>
        </div>
        <div className="spacer" />
        {isAdmin && <Link className="btn btn-primary" to="/admin/dashboard"><LayoutDashboard size={18} /> Open dashboard</Link>}
        {isMaintenance && <Link className="btn btn-primary" to="/maintenance/dashboard"><LayoutDashboard size={18} /> Open maintenance portal</Link>}
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'account'} className={tab === 'account' ? 'on' : ''} onClick={() => openTab('account')}>Account settings</button>
        <button role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'on' : ''} onClick={() => openTab('reports')}>My reports</button>
      </div>
      {tab === 'account' ? <AccountSettings /> : <MyReports />}
    </div>
  )
}
