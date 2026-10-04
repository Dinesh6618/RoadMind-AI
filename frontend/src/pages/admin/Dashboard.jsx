import { BadgeCheck, ClipboardCheck, EyeOff, FileText, Hourglass, OctagonAlert, Signpost, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAdminApi } from '../../auth'
import { ErrorBox, PriorityBadge, Spinner, Stat } from '../../components'
import { CONDITION_LABELS, STATE_COLORS, STATE_ORDER, num } from '../../format'

const TYPE_COLORS = ['#5b3df5', '#7c5cff', '#9d86ff', '#bdb0ff', '#d9d1ff']
const ACTIONS = { pending: 'Inspect', inspected: 'Schedule repair', repair_planned: 'Track repair', repair_completed: 'Review' }

function ChartCard({ title, hint, children, action }) {
  return (
    <section className="card">
      <div className="row between" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>{title}</h3>{action}</div>
      {hint && <p className="small muted" style={{ margin: '0 0 8px' }}>{hint}</p>}
      <div className="chart-box">{children}</div>
    </section>
  )
}

export default function Dashboard() {
  const ov = useAdminApi('/analytics/overview')
  const dmg = useAdminApi('/analytics/damage')
  const top = useAdminApi('/maintenance/priorities?sort=priority&order=desc')
  if (ov.loading) return <Spinner />
  if (ov.error) return <ErrorBox error={ov.error} onRetry={ov.reload} />
  const o = ov.data

  const condition = STATE_ORDER.slice().reverse().map((s) => ({ key: s, name: CONDITION_LABELS[s], value: o.by_state[s] || 0 })).filter((d) => d.value > 0)
  const weekly = (dmg.data?.over_time || []).map((w) => ({ ...w, label: new Date(w.week_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }))
  const topRows = (top.data || []).slice(0, 5)

  return (
    <>
      <div className="stat-grid four">
        <Stat icon={Signpost} label="Total Roads" value={num(o.network_segments)} color="#5b3df5" hint={`${num(o.total_roads)} with RoadMind data (${Math.round(o.data_coverage * 100)}%)`} />
        <Stat icon={FileText} label="Total Reports" value={num(o.total_reports)} color="#4f6fe0" hint={`${o.reports_last_7_days} in the last 7 days`} />
        <Stat icon={OctagonAlert} label="Critical Roads" value={num(o.critical_roads)} color={STATE_COLORS.CRITICAL} hint="severity above 80" />
        <Stat icon={TriangleAlert} label="High Risk Roads" value={num(o.high_risk_roads)} color={STATE_COLORS.HIGH_RISK} hint="severity 61-80" />
        <Stat icon={BadgeCheck} label="Repairs Completed" value={num(o.repairs_completed)} color={STATE_COLORS.GOOD} hint="on file" />
        <Stat icon={ClipboardCheck} label="Under Inspection" value={num(o.under_inspection)} color="#0ea5c6" hint="inspected, repair not yet planned" />
        <Stat icon={Hourglass} label="Pending Maintenance" value={num(o.pending_maintenance)} color="#a855f7" hint="not completed, excl. Monitor" />
        <Stat icon={EyeOff} label="No RoadMind Data" value={num(o.by_state.UNKNOWN || 0)} color={STATE_COLORS.UNKNOWN} hint="shown in gray, not scored good or bad" />
      </div>

      <div className="grid chart-row">
        <ChartCard title="Road Condition Overview" hint="Every road in the network, including those RoadMind has no data for.">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={condition} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="86%" paddingAngle={2} stroke="none">
                {condition.map((d) => <Cell key={d.key} fill={STATE_COLORS[d.key]} />)}
              </Pie>
              <Tooltip formatter={(v, n) => [num(v), n]} />
              <text x="50%" y="48%" textAnchor="middle" fontSize="26" fontWeight="800" fill="#0f1a3c">{num(o.network_segments)}</text>
              <text x="50%" y="58%" textAnchor="middle" fontSize="12" fill="#667094">roads</text>
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Damage by Type" hint="Individual detections across all reports.">
          {dmg.data ? (
            <ResponsiveContainer>
              <BarChart data={dmg.data.by_type} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid horizontal={false} stroke="#ece9fa" />
                <XAxis type="number" allowDecimals={false} fontSize={12} stroke="#667094" />
                <YAxis type="category" dataKey="name" width={128} fontSize={12} stroke="#667094" />
                <Tooltip cursor={{ fill: '#f3efff' }} />
                <Bar dataKey="count" name="Detections" radius={[0, 10, 10, 0]}>
                  {dmg.data.by_type.map((_, i) => <Cell key={i} fill={TYPE_COLORS[i % TYPE_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <Spinner />}
        </ChartCard>

        <ChartCard title="Reports Over Time" hint="Reports per week, last 26 weeks.">
          {dmg.data ? (
            <ResponsiveContainer>
              <AreaChart data={weekly} margin={{ right: 12, left: -16 }}>
                <defs><linearGradient id="rep" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7c5cff" stopOpacity="0.45" /><stop offset="1" stopColor="#7c5cff" stopOpacity="0.02" /></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="#ece9fa" />
                <XAxis dataKey="label" fontSize={11} interval={4} stroke="#667094" />
                <YAxis allowDecimals={false} fontSize={12} stroke="#667094" />
                <Tooltip />
                <Area type="monotone" dataKey="reports" name="Reports" stroke="#5b3df5" strokeWidth={2.5} fill="url(#rep)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : <Spinner />}
        </ChartCard>
      </div>

      <section className="card card-flush">
        <div className="row between" style={{ padding: '22px 24px 8px' }}>
          <h3 style={{ margin: 0 }}>Top 5 Roads Needing Maintenance</h3>
          <Link to="/admin/maintenance" className="btn btn-small btn-soft">View all</Link>
        </div>
        {top.loading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Road Name</th><th className="num">Severity</th><th className="num">Risk %</th><th>Priority</th><th className="right">Action</th></tr></thead>
              <tbody>
                {topRows.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.name}</b><div className="small muted">{r.zone} · #{r.id}</div></td>
                    <td className="num"><b>{Math.round(r.current_severity)}</b><span className="muted">/100</span></td>
                    <td className="num"><b>{r.risk_percent}%</b></td>
                    <td><PriorityBadge category={r.priority_category} /></td>
                    <td className="right"><Link className="btn btn-small" to={`/admin/maintenance?road=${r.id}`}>{ACTIONS[r.maintenance_status] || 'Open'}</Link></td>
                  </tr>
                ))}
                {!topRows.length && <tr><td colSpan={5} className="muted">No roads have been prioritised yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
