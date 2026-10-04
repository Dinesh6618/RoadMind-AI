import { Camera, MapPin, Navigation, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTip, XAxis, YAxis } from 'recharts'
import { api, useApi } from '../api'
import { ConditionLegend, Disclaimer, ErrorBox, FactorBars, Notice, PriorityBadge, RiskBadge, SeverityBadge, SeverityMeter, Spinner, StateBadge, StatusBadge } from '../components'
import { CONDITION_LABELS, STATE_COLORS, STATE_INK, fmtDate, highwayLabel, num, timeAgo } from '../format'
import NetworkMap, { LocateControl } from '../NetworkMap'

const FILTERS = [[null, 'All Roads'], ['GOOD', 'Good'], ['MODERATE', 'Moderate'], ['HIGH_RISK', 'High Risk'], ['CRITICAL', 'Critical'], ['UNKNOWN', 'No Data']]

/** Detail records and network segments use slightly different field names; the card reads either. */
const sevOf = (s) => s.severity ?? s.current_severity

function RoadCard({ seg, at, onClose, onDetails }) {
  const navigate = useNavigate()
  const unknown = seg.state === 'UNKNOWN'
  const here = at || { lat: seg.geometry?.[0]?.[0], lng: seg.geometry?.[0]?.[1] }
  const getRoute = () => navigate(`/user/routes?toLat=${here.lat.toFixed(6)}&toLng=${here.lng.toFixed(6)}&toName=${encodeURIComponent(seg.name)}`)
  return (
    <aside className="map-ui road-card glass" aria-label={`Road: ${seg.name}`}>
      <button className="btn btn-icon btn-ghost close btn-small" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <h3>{seg.name}</h3>
      <div className="muted small">{highwayLabel(seg.highway)} · {num(seg.length_m)} m{seg.oneway ? ' · one-way' : ''}</div>
      <div className="cond" style={{ '--c': STATE_COLORS[seg.state], '--ink-c': STATE_INK[seg.state] }}>
        <i /> Condition: {CONDITION_LABELS[seg.state]}
      </div>
      {unknown ? (
        <p className="small" style={{ marginBottom: 14 }}>
          RoadMind does not currently have sufficient condition data for this road. It is not rated good or damaged. <b>You can report road damage.</b>
        </p>
      ) : (
        <div className="facts">
          <div className="fact"><span>Severity</span><b>{sevOf(seg)}/100</b></div>
          <div className="fact"><span>Damage</span><b>{seg.damage_type || 'None recorded'}</b></div>
          <div className="fact"><span>Reports</span><b>{seg.report_count}</b></div>
          <div className="fact"><span>Last Report</span><b>{fmtDate(seg.last_report_at)}</b></div>
          <div className="fact"><span>Predicted Risk</span><b>{seg.risk_percent != null ? `${seg.risk_percent}%` : '—'}</b></div>
          <div className="fact"><span>Maintenance</span><b>{(seg.priority_category || '—').toUpperCase()}{seg.maintenance_status_label ? ` · ${seg.maintenance_status_label}` : ''}</b></div>
          {seg.simulated && <div className="small" style={{ color: 'var(--moderate-ink)' }}>Simulated demo data - not a real observation.</div>}
        </div>
      )}
      <div className="actions">
        {unknown ? (
          <button className="btn btn-primary" onClick={() => navigate(`/user/report?lat=${here.lat.toFixed(6)}&lng=${here.lng.toFixed(6)}&road=${encodeURIComponent(seg.name)}`)}><Camera size={17} /> Report damage</button>
        ) : (
          <button className="btn btn-primary" onClick={() => onDetails(seg)}>View Details</button>
        )}
        <button className="btn" onClick={getRoute}><Navigation size={17} /> Get Route</button>
      </div>
    </aside>
  )
}

/** `portal` is "admin" or "maintenance" inside the staff portals (it changes the extras shown), null on the public map. */
function DetailDrawer({ id, portal, onClose }) {
  const admin = portal === 'admin'
  const { data: d, loading, error } = useApi(`/roads/${id}`)
  const history = (d?.history || []).map((h) => ({ date: new Date(h.date).getTime(), severity: h.severity }))
  return (
    <div className="drawer-panel" role="dialog" aria-label="Road details">
      <div className="row between" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
        <div><h2 style={{ marginBottom: 2 }}>{d?.name || 'Road details'}</h2>{d && <div className="muted small">{d.zone} · {highwayLabel(d.highway)} · {Math.round(d.length_m)} m</div>}</div>
        <button className="btn btn-icon btn-ghost btn-small" onClick={onClose} aria-label="Close details"><X size={18} /></button>
      </div>
      {loading && <Spinner />}
      <ErrorBox error={error} />
      {d && (
        <div className="stack">
          <div className="row"><StateBadge state={d.state} />{d.simulated && <span className="badge" style={{ '--c': '#b7791f', '--ink-c': '#8a5a00' }}>simulated data</span>}</div>
          {d.has_data && <SeverityMeter score={d.current_severity} level={d.severity_level} />}
          <dl className="kv">
            <dt>Damage type</dt><dd>{d.damage_type || 'None recorded'}</dd>
            <dt>Number of reports</dt><dd>{d.report_count} ({d.reports_90d} in 90 days)</dd>
            <dt>Last report</dt><dd>{d.last_report_at ? `${fmtDate(d.last_report_at)} (${timeAgo(d.last_report_at)})` : 'none'}</dd>
            <dt>Predicted risk</dt><dd><RiskBadge level={d.risk_level} percent={d.risk_percent} /></dd>
            <dt>Maintenance status</dt><dd><StatusBadge status={d.maintenance_status} /></dd>
            <dt>Maintenance priority</dt><dd>{d.priority ? <><PriorityBadge category={d.priority.category} /> {Math.round(d.priority.score)}/100</> : '—'}</dd>
            <dt>Last repair</dt><dd>{d.last_repair_date ? fmtDate(d.last_repair_date) : 'no record'} · {d.repair_count} on file</dd>
            <dt>Traffic (estimate)</dt><dd>{d.traffic_level} (~{d.daily_traffic.toLocaleString()}/day)</dd>
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
          {d.recent_reports.length > 0 && (
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
          <Disclaimer>{d.disclaimer} Age, traffic and rainfall are estimates from the road class.</Disclaimer>
        </div>
      )}
    </div>
  )
}

function PlaceSearch({ onPick }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => api(`/routes/geocode?q=${encodeURIComponent(q.trim())}`).then(setHits).catch(() => setHits([])), 300)
    return () => clearTimeout(t)
  }, [q])
  return (
    <div className="search-wrap place-input">
      <div className="search-pill glass">
        <Search size={19} aria-hidden="true" />
        <input placeholder="Search a place or road…" aria-label="Search for a place" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} />
        {q && <button className="btn btn-icon btn-ghost btn-small" onClick={() => { setQ(''); setHits([]) }} aria-label="Clear search"><X size={16} /></button>}
      </div>
      {open && hits.length > 0 && (
        <div className="suggest" role="listbox">
          {hits.map((h) => (
            <button type="button" key={`${h.name}${h.lat}`} onClick={() => { onPick({ lat: h.lat, lng: h.lng, zoom: 17 }); setQ(h.name); setOpen(false) }}>
              <MapPin size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--brand)' }} />{h.name}<small>{h.source === 'osm' ? 'OpenStreetMap search' : h.kind}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RoadMapPage({ portal = null }) {
  const staff = !!portal // inside the administrator / maintenance portals the map fills the content area
  const [params] = useSearchParams()
  const [selected, setSelected] = useState(null) // { seg, at }
  const [drawerId, setDrawerId] = useState(null)
  const [focus, setFocus] = useState(null)
  const [pan, setPan] = useState(null)
  const [data, setData] = useState(null)
  const [toast, setToast] = useState(null)

  // Deep link from a report result: /map?focus=<road id>&lat=&lng=
  useEffect(() => {
    const id = params.get('focus')
    const lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng'))
    if (Number.isFinite(lat) && Number.isFinite(lng)) setPan({ lat, lng, zoom: 17 })
    if (id) {
      api(`/roads/${id}`).then((d) => setSelected({ seg: d, at: Number.isFinite(lat) ? { lat, lng } : null })).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = data?.counts || {}
  return (
    <div className={staff ? 'admin-map' : 'map-screen'}>
      <NetworkMap
        height="100%" focusState={focus} selectedId={selected?.seg.id} pan={pan} onData={setData}
        onSelect={(seg, at) => { setSelected({ seg, at }); setDrawerId(null) }}
      >
        <LocateControl onError={setToast} />
      </NetworkMap>

      <div className="map-ui map-top">
        <PlaceSearch onPick={setPan} />
        <div className="filter-pills glass" role="group" aria-label="Show roads by condition">
          {FILTERS.map(([state, label]) => (
            <button key={label} className={`chip ${focus === state ? 'on' : ''}`} onClick={() => setFocus(state)} aria-pressed={focus === state}
              title={data && state ? `${counts[state] || 0} in the loaded area` : undefined}>
              {state && <i style={{ '--c': STATE_COLORS[state] }} />}{label}
            </button>
          ))}
        </div>
      </div>

      <div className="map-ui map-legend glass"><ConditionLegend /></div>

      {toast && (
        <div className="map-ui" style={{ top: 140, left: 16, maxWidth: 380 }}>
          <Notice kind="warn">{toast} <button className="btn btn-small btn-ghost" onClick={() => setToast(null)}>OK</button></Notice>
        </div>
      )}

      {selected && !drawerId && (
        <RoadCard seg={selected.seg} at={selected.at} onClose={() => setSelected(null)} onDetails={(s) => setDrawerId(s.id)} />
      )}
      {drawerId && <DetailDrawer key={drawerId} id={drawerId} portal={portal} onClose={() => setDrawerId(null)} />}
    </div>
  )
}
