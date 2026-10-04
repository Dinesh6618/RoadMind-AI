import { Camera, LayoutDashboard } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../api'
import { useAuth } from '../auth'
import { Badge, Empty, ErrorBox, SeverityBadge, Spinner } from '../components'
import { fmtDate, initials } from '../format'
import AccountSettings from './AccountSettings'

function MyReports() {
  const { data, loading, error, reload } = useApi('/reports/mine')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data.items.length) {
    return (
      <div className="card"><Empty icon={Camera}>You have not reported anything yet while signed in.<br /><Link className="btn btn-primary" style={{ marginTop: 14 }} to="/user/report">Report road damage</Link></Empty></div>
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

/** Account page for any signed-in person. Administrators also get a shortcut to the dashboard. */
export default function Profile() {
  const { user, isAdmin, isMaintenance } = useAuth()
  const role = isAdmin ? ['Administrator', '#5b3df5', '#3c24b8'] : isMaintenance ? ['Maintenance staff', '#d97706', '#8a4a00'] : ['Normal user', '#0e8f61', '#0b6e4b']
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'reports' ? 'reports' : 'account'
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
        <button role="tab" aria-selected={tab === 'account'} className={tab === 'account' ? 'on' : ''} onClick={() => setParams({})}>Account settings</button>
        <button role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'on' : ''} onClick={() => setParams({ tab: 'reports' })}>My reports</button>
      </div>
      {tab === 'account' ? <AccountSettings /> : <MyReports />}
    </div>
  )
}
