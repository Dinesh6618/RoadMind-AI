import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAdminApi } from '../../auth'
import { Disclaimer, Empty, ErrorBox, FactorBars, PriorityBadge, RiskBadge, SeverityBadge, Spinner, StatusBadge } from '../../components'
import { STATUS_LABELS, fmtDate, highwayLabel, num, sortRows, timeAgo } from '../../format'

const COLUMNS = [
  ['name', 'Road'],
  ['current_severity', 'Severity', 'num'],
  ['risk', 'Risk', 'num'],
  ['priority_score', 'Priority', 'num'],
  ['recommended_action', 'Recommended action'],
  ['maintenance_status', 'Status'],
  ['assigned_name', 'Assigned to'],
]
const CATEGORIES = ['Immediate', 'High Priority', 'Medium Priority', 'Monitor']
const COMPONENT_LABELS = {
  severity: 'Severity', risk: 'Predicted risk', danger: 'Danger (severity + risk)', reports: 'Recent reports', traffic: 'Traffic',
  facilities: 'Schools / hospitals nearby', people_affected: 'People affected', time_since_repair: 'Time since repair', exposure: 'Exposure',
}

function Drawer({ row, assignees, onClose, onSaved }) {
  const detail = useAdminApi(`/roads/${row.id}`)
  const [status, setStatus] = useState(row.maintenance_status)
  const [notes, setNotes] = useState('')
  const [plannedDate, setPlannedDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)

  async function save(nextStatus = status) {
    if (nextStatus === 'repair_completed' && !window.confirm(`Mark the repair on "${row.name}" as completed? Its severity history will restart from today.`)) return
    setBusy(true); setError(null); setSaved(null)
    try {
      const body = { status: nextStatus, notes: notes.trim() || null }
      if (nextStatus === 'repair_planned' && plannedDate) body.planned_date = plannedDate
      await api(`/maintenance/${row.id}`, { method: 'PATCH', json: body })
      setNotes('')
      setStatus(nextStatus)
      setSaved(`Saved: ${STATUS_LABELS[nextStatus]}`)
      detail.reload()
      onSaved()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const d = detail.data
  const comps = d?.priority?.components

  async function assign(userId) {
    setBusy(true); setError(null); setSaved(null)
    try {
      const res = await api(`/maintenance/${row.id}/assignment`, { method: 'PUT', json: { user_id: userId ? Number(userId) : null } })
      setSaved(res.assigned_to ? `Assigned to ${res.assigned_to.name}` : 'Assignment removed')
      onSaved()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card drawer stack">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div><h2>{row.name}</h2><div className="small muted">{row.zone} · {highwayLabel(row.highway)} · {row.traffic_level} traffic (est.)</div></div>
        <button className="btn btn-small btn-ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="row">
        <SeverityBadge level={row.severity_level} /> <RiskBadge level={row.risk_level} percent={row.risk_percent} /> <PriorityBadge category={row.priority_category} />
        <strong>{Math.round(row.priority_score)}/100</strong>
      </div>
      <p style={{ margin: 0 }}><strong>Recommended:</strong> {row.recommended_action}</p>

      {comps && (
        <div>
          <h3>How the priority was calculated</h3>
          <FactorBars items={Object.entries(COMPONENT_LABELS).map(([k, label]) => ({ label, value: comps[k] ?? 0 }))} />
          <p className="small muted" style={{ marginBottom: 0 }}>Priority = 100 × danger × {comps.multiplier} (context multiplier from exposure).</p>
        </div>
      )}

      <div>
        <h3>Assigned to</h3>
        <div className="row">
          <select aria-label="Maintenance employee responsible for this road" style={{ width: 'auto', minWidth: 220 }} value={row.assigned_to?.id ?? ''} disabled={busy || !assignees} onChange={(e) => assign(e.target.value)}>
            <option value="">Not assigned</option>
            {(assignees || []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.assigned_roads} roads)</option>)}
          </select>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>Maintenance staff see, inspect and update only the roads assigned to them.</p>
      </div>

      <div>
        <h3>Update maintenance</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn-small" disabled={busy} onClick={() => save('inspected')}>Mark inspected</button>
          <button className="btn btn-small" disabled={busy} onClick={() => save('repair_planned')}>Mark repair planned</button>
          <button className="btn btn-small" disabled={busy} onClick={() => save('repair_completed')}>Mark repair completed</button>
        </div>
        <div className="field">
          <label htmlFor="pd">Planned repair date <span className="muted" style={{ fontWeight: 400 }}>(used with “repair planned”; default +14 days)</span></label>
          <input id="pd" type="date" className="input" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="notes">Repair notes</label>
          <textarea id="notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Add a note - it is saved with your name and the date." />
        </div>
        <div className="row">
          <select aria-label="Status" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn btn-primary" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save status & note'}</button>
        </div>
        {saved && <div className="alert alert-ok" style={{ marginTop: 10 }} role="status">{saved}</div>}
        <ErrorBox error={error} />
      </div>

      {d?.priority?.notes && <div><h3>Notes</h3><div className="note-log">{d.priority.notes}</div></div>}
      {d && (
        <div>
          <h3>Repair history</h3>
          {d.repairs.length === 0 ? <p className="muted small">No repairs on file.</p> : (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {d.repairs.slice(0, 5).map((r, i) => <li key={i}>{r.status === 'completed' ? `Completed ${fmtDate(r.completed_date)}` : `Planned for ${fmtDate(r.planned_date)}`}{r.notes ? ` — ${r.notes}` : ''}</li>)}
            </ul>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>{d.report_count} reports · last {timeAgo(d.last_report_at)}.</p>
        </div>
      )}
    </div>
  )
}

export default function Maintenance() {
  const { data, loading, error, reload } = useAdminApi('/maintenance/priorities')
  const staffList = useAdminApi('/maintenance/assignees')
  const [sort, setSort] = useState({ key: 'priority_score', dir: 'desc' })
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [params] = useSearchParams()
  const [selectedId, setSelectedId] = useState(Number(params.get('road')) || null) // deep link from the dashboard table

  const rows = useMemo(() => {
    const filtered = (data || []).map((r) => ({ ...r, assigned_name: r.assigned_to?.name || '' })).filter((r) => (!category || r.priority_category === category) && (!status || r.maintenance_status === status) && r.name.toLowerCase().includes(q.toLowerCase()))
    return sortRows(filtered, sort.key, sort.dir)
  }, [data, sort, category, status, q])
  const selected = (data || []).find((r) => r.id === selectedId)
  // with a road open the panel already shows the recommendation, the risk and the assignee, so the table keeps only what it needs to stay readable
  const cols = selected ? COLUMNS.filter(([key]) => !['recommended_action', 'risk', 'assigned_name'].includes(key)) : COLUMNS
  const shown = (key) => cols.some(([k]) => k === key)

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' || key === 'recommended_action' || key === 'assigned_name' ? 'asc' : 'desc' }))

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div className="row">
            <select aria-label="Filter by priority" style={{ width: 'auto' }} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All priorities</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select aria-label="Filter by status" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="input" style={{ width: 220 }} placeholder="Search road…" aria-label="Search road" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <span className="small muted">{rows.length} of {data?.length ?? 0} roads · click a column to sort</span>
        </div>
      </div>

      <ErrorBox error={error} onRetry={reload} />
      {loading && <Spinner />}
      {data && (
        <div className="split">
          <div className="card card-flush">
            <div className="table-wrap" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              <table className="data wide">
                <thead>
                  <tr>
                    {cols.map(([key, label, cls]) => (
                      <th key={key} className={`sortable ${cls || ''}`} onClick={() => toggleSort(key)} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                        {label} {sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={`clickable ${r.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelectedId(r.id)}>
                      <td><strong>{r.name}</strong><div className="small muted">{r.zone} · {num(r.length_m)} m · #{r.id}</div></td>
                      <td className="num">{num(r.current_severity)} <SeverityBadge level={r.severity_level} /></td>
                      {shown('risk') && <td className="num"><RiskBadge level={r.risk_level} percent={r.risk_percent} /></td>}
                      <td className="num nowrap"><strong>{num(r.priority_score)}</strong> <PriorityBadge category={r.priority_category} /></td>
                      {shown('recommended_action') && <td style={{ minWidth: 220 }} className="small">{r.recommended_action}</td>}
                      <td><StatusBadge status={r.maintenance_status} /></td>
                      {shown('assigned_name') && <td className="small">{r.assigned_to ? r.assigned_to.name : <span className="muted">—</span>}</td>}
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={cols.length}><Empty>No roads match these filters.</Empty></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          {selected ? <Drawer key={selected.id} row={selected} assignees={staffList.data} onClose={() => setSelectedId(null)} onSaved={() => { reload(); staffList.reload() }} /> : (
            <div className="card empty">Select a road to see how its priority was calculated, record an inspection or repair, and add notes.</div>
          )}
        </div>
      )}
      <Disclaimer>Priorities are decision support built from AI estimates. Inspections and repairs recorded here are the authoritative maintenance record.</Disclaimer>
    </div>
  )
}
