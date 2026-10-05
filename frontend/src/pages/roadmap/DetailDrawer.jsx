import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTip, XAxis, YAxis } from 'recharts'
import { useApi } from '../../api'
import { Disclaimer, ErrorBox, Notice, PriorityBadge, RiskBadge, SeverityBadge, SeverityMeter, Spinner, StateBadge, StatusBadge } from '../../components'
import { fmtDate, highwayLabel, timeAgo } from '../../format'
import { reopeningText, reportedAgo, verifiedText } from './overlays'
import { liveTrafficText } from './panels'

/**
 * The right-hand "View Details" drawer. `item` is the map's own record of the road (AI confidence and the pothole / crack
 * counts only exist there); `/roads/{id}` adds the history, the reports and the maintenance priority.
 * `portal` is "admin" or "maintenance" inside the staff portals (it changes the extras shown), null on the public map.
 */
export default function DetailDrawer({ id, item, portal, status, blocking = [], onClose }) {
  const admin = portal === 'admin'
  const ref = useRef(null)
  const { data: d, loading, error } = useApi(`/roads/${id}`)
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  const history = (d?.history || []).map((h) => ({ date: new Date(h.date).getTime(), severity: h.severity }))
  const name = d?.name || item?.name
  const conf = item?.ai_confidence != null ? `${Math.round(item.ai_confidence * 100)}%` : null

  return (
    <div ref={ref} tabIndex={-1} className="drawer-panel rm-drawer" role="dialog" aria-label="Road details">
      <div className="row between nowrap-row" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>{name || 'Road details'}</h2>
          {d && <div className="muted small">{d.zone ? `${d.zone} · ` : ''}{highwayLabel(d.highway)} · {Math.round(d.length_m)} m</div>}
        </div>
        <button type="button" className="btn btn-icon btn-ghost btn-small" onClick={onClose} aria-label="Close details"><X size={18} /></button>
      </div>
      {loading && <Spinner />}
      <ErrorBox error={error} />
      {d && (
        <div className="stack">
          <div className="row"><StateBadge state={d.state} />{d.simulated && <span className="badge" style={{ '--c': '#b7791f', '--ink-c': '#8a5a00' }}>simulated data</span>}</div>
          {blocking.length > 0 && (
            <Notice kind="warn">
              <b>🚧 BLOCKED</b> - {blocking[0].event_type_label}{blocking[0].description ? `: ${blocking[0].description}` : ''}. Reported {reportedAgo(blocking[0])}.
              {' '}Verified: {verifiedText(blocking[0])}. Expected reopening {reopeningText(blocking[0]) || 'unknown'} (an estimate).
            </Notice>
          )}
          {d.has_data && <SeverityMeter score={d.current_severity} level={d.severity_level} />}
          <dl className="kv">
            <dt>Live traffic</dt><dd>{liveTrafficText(status)}</dd>
            <dt>Road status</dt><dd>{blocking.length ? '🚧 BLOCKED' : 'OPEN (no blocking event reported)'}</dd>
            <dt>Latest damage</dt><dd>{d.damage_type || 'None recorded'}</dd>
            {conf && <><dt>AI confidence</dt><dd>{conf}</dd></>}
            {item?.pothole_count != null && <><dt>Potholes / cracks</dt><dd>{item.pothole_count} / {item.crack_count ?? 0}</dd></>}
            <dt>User reports</dt><dd>{d.report_count} ({d.reports_90d} in 90 days)</dd>
            <dt>Last report</dt><dd>{d.last_report_at ? `${fmtDate(d.last_report_at)} (${timeAgo(d.last_report_at)})` : 'none'}</dd>
            <dt>Predicted deterioration risk (about 90 days)</dt><dd><RiskBadge level={d.risk_level} percent={d.risk_percent} /></dd>
            <dt>Maintenance status</dt><dd><StatusBadge status={d.maintenance_status} /></dd>
            <dt>Maintenance priority</dt><dd>{d.priority ? <><PriorityBadge category={d.priority.category} /> {Math.round(d.priority.score)}/100</> : '—'}</dd>
            <dt>Last repair</dt><dd>{d.last_repair_date ? fmtDate(d.last_repair_date) : 'no record'} · {d.repair_count} on file</dd>
            <dt>Typical traffic (road-class estimate)</dt><dd>{d.traffic_level}{d.daily_traffic != null ? ` (~${Number(d.daily_traffic).toLocaleString()}/day)` : ''}</dd>
          </dl>
          {d.priority && <Notice kind="info"><b>Suggested action:</b> {d.priority.action}</Notice>}
          {d.prediction?.factors?.length > 0 && (
            <div>
              <h3>What drives the risk estimate</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {d.prediction.factors.map((f) => <li key={f.feature}>{f.label} ({f.display}) {f.effect_points >= 0 ? 'raises' : 'lowers'} risk by {Math.abs(f.effect_points).toFixed(0)} pts</li>)}
              </ul>
            </div>
          )}
          {history.length > 1 && (
            <div>
              <h3>Severity over time</h3>
              <div className="sparkline">
                <ResponsiveContainer>
                  <LineChart data={history} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="#ece9fa" vertical={false} />
                    <XAxis dataKey="date" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} fontSize={11} />
                    <YAxis domain={[0, 100]} fontSize={11} />
                    <ChartTip labelFormatter={(t) => new Date(t).toLocaleDateString()} formatter={(v) => [Math.round(v), 'Severity']} />
                    <Line type="monotone" dataKey="severity" stroke="#5b3df5" strokeWidth={2.5} dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {d.recent_reports?.length > 0 && (
            <div>
              <h3>Recent reports</h3>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {d.recent_reports.slice(0, 5).map((r) => (
                      <tr key={r.id}>
                        <td className="nowrap">{fmtDate(r.reported_at)}</td>
                        <td>{r.damage_summary}</td>
                        <td className="right"><SeverityBadge level={r.severity_level} /></td>
                        {admin && <td>{r.annotated_url ? <a href={r.annotated_url} target="_blank" rel="noreferrer">photo</a> : <span className="muted">—</span>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {admin && d.priority?.notes && <div><h3>Notes</h3><div className="note-log">{d.priority.notes}</div></div>}
          {admin && <Link className="btn" to={`/admin/maintenance?road=${id}`}>Manage in Maintenance</Link>}
          {portal === 'maintenance' && <Link className="btn" to={`/maintenance/roads?road=${id}`}>Open in my work list</Link>}
          <Disclaimer>{d.disclaimer} The predicted risk is a probability of further deterioration within about 90 days, not a guarantee. Age, traffic and rainfall are estimates from the road class.</Disclaimer>
        </div>
      )}
    </div>
  )
}
