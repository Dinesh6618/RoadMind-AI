import { ClipboardCheck } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAdminApi, useAuth } from '../../auth'
import { Disclaimer, Empty, ErrorBox, PriorityBadge, RiskBadge, SeverityBadge, Spinner, StatusBadge } from '../../components'
import { STATUS_LABELS, num, sortRows } from '../../format'
import RoadWork from './RoadWork'
import './maintenance.css'

const STATUS_RANK = { pending: 0, inspected: 1, repair_planned: 2, repair_completed: 3 }
const COLUMNS = [
  ['name', 'Road', ''],
  ['current_severity', 'Severity', 'num'],
  ['risk', 'Risk', 'num'],
  ['priority_score', 'Priority', 'num'],
  ['status_rank', 'Status', ''],
  ['evidence_count', 'Photos', 'num'],
]
const NO_ROADS = 'No roads are assigned to you yet. An administrator assigns roads from the Maintenance page.'

// What each queue shows. A section lists the roads whose maintenance_status is one of `statuses`, highest priority first.
const QUEUES = {
  inspections: {
    intro: <><strong>Inspection queue.</strong> Roads that still need a site inspection come first, then roads that are already inspected and wait for a repair plan. After you have looked at a road, press <em>Mark inspected</em>. Open a road to add a note or photos first.</>,
    sections: [
      { id: 'pending', title: 'Awaiting inspection', hint: 'Highest priority first.', statuses: ['pending'], empty: 'Nothing is waiting for inspection.' },
      { id: 'inspected', title: 'Inspected', hint: 'Inspected, repair not planned yet. Plan these from the Repairs page.', statuses: ['inspected'], empty: 'No inspected roads are waiting for a repair plan.' },
    ],
  },
  repairs: {
    intro: <><strong>Repair queue.</strong> Plan a repair for each inspected road (it is scheduled 14 days ahead unless you pick another date in the road panel), then mark it completed when the work is done. Open a road to attach photos of the work.</>,
    sections: [
      { id: 'todo', title: 'Repairs to do', hint: 'Inspected roads and planned repairs, highest priority first.', statuses: ['inspected', 'repair_planned'], empty: 'No repairs are waiting. Nice work.' },
      { id: 'done', title: 'Completed repairs', hint: 'Finished repairs stay here for reference.', statuses: ['repair_completed'], empty: 'No repairs have been completed yet.' },
    ],
  },
}

function RoadTable({ rows, label, selectedId, onSelect, sort, onSort, actions }) {
  return (
    <div className="table-wrap">
      <table className="data mt-table">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            {COLUMNS.map(([key, text, cls]) => (
              <th key={key} scope="col" className={cls} aria-sort={onSort ? (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}>
                {onSort ? (
                  <button type="button" className="mt-sortbtn" onClick={() => onSort(key)}>
                    {text}<span aria-hidden="true">{sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                ) : text}
              </th>
            ))}
            {actions && <th scope="col" className="right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const selected = r.id === selectedId
            return (
              <tr
                key={r.id}
                className={`clickable ${selected ? 'selected' : ''}`}
                tabIndex={0}
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(r.id)}
                onKeyDown={(e) => {
                  // only when the row itself has focus (a button inside the row handles its own keys)
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(r.id) }
                }}
              >
                <td><strong>{r.name}</strong><div className="small muted">{r.zone} · {num(r.length_m)} m · #{r.id}</div></td>
                <td className="num">{num(r.current_severity)} <SeverityBadge level={r.severity_level} /></td>
                <td className="num"><RiskBadge level={r.risk_level} percent={r.risk_percent} /></td>
                <td className="num"><strong>{num(r.priority_score)}</strong> {r.priority_category ? <PriorityBadge category={r.priority_category} /> : null}</td>
                <td><StatusBadge status={r.maintenance_status} /></td>
                <td className="num">{r.evidence_count ?? 0}</td>
                {actions && <td className="mt-act-cell">{actions(r)}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function WorkListView({ mode }) {
  const { logout } = useAuth()
  const list = useAdminApi('/staff/roads')
  const [params, setParams] = useSearchParams()
  const selectedId = Number(params.get('road')) || null // /maintenance/roads?road=<id> deep link
  const [sort, setSort] = useState({ key: 'priority_score', dir: 'desc' })
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [panelVersion, setPanelVersion] = useState(0) // bumped to reload the open panel after a change made in the table
  const panelRef = useRef(null)

  const all = useMemo(() => (list.data || []).map((r) => ({ ...r, status_rank: STATUS_RANK[r.maintenance_status] ?? 0 })), [list.data])
  const roadsRows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return sortRows(all.filter((r) => (!status || r.maintenance_status === status) && (!needle || r.name.toLowerCase().includes(needle))), sort.key, sort.dir)
  }, [all, sort, status, q])

  function select(id) {
    setParams(id ? { road: String(id) } : {}, { replace: true })
    // on narrow screens the panel is below the table: bring it into view
    if (id && window.matchMedia?.('(max-width: 1180px)').matches) {
      const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      setTimeout(() => panelRef.current?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' }), 60)
    }
  }
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }))

  async function quick(row, next) {
    if (next === 'repair_completed' && !window.confirm(`Mark the repair on "${row.name}" as completed?\n\nIts severity history will restart from today. To attach photos of the finished work, open the road and use Photo evidence in its panel (you can also do that afterwards).`)) return
    setBusyId(row.id); setActionError(null); setNotice(null)
    try {
      await api(`/staff/roads/${row.id}/status`, { method: 'PATCH', json: { status: next } })
      setNotice(next === 'repair_planned'
        ? `${row.name}: repair planned for 14 days from today. Open the road to choose another date or add a note.`
        : `${row.name}: ${STATUS_LABELS[next]}.`)
      if (row.id === selectedId) setPanelVersion((v) => v + 1)
      list.reload()
    } catch (err) {
      if (err.status === 401) logout()
      setActionError(err)
    } finally {
      setBusyId(null)
    }
  }

  // row buttons for the queue screens
  function actionsFor(r) {
    const busy = busyId === r.id
    const button = (text, next, primary = true) => (
      <button type="button" className={`btn btn-small mt-tap ${primary ? 'btn-primary' : ''}`} disabled={busyId != null} aria-label={`${text}: ${r.name}`} onClick={(e) => { e.stopPropagation(); quick(r, next) }}>
        {busy ? 'Saving…' : text}
      </button>
    )
    if (mode === 'inspections') return r.maintenance_status === 'pending' ? button('Mark inspected', 'inspected') : <span className="small muted">Ready for a repair plan</span>
    if (r.maintenance_status === 'inspected') return button('Plan repair', 'repair_planned')
    if (r.maintenance_status === 'repair_planned') return button('Mark completed', 'repair_completed')
    return <span className="small muted">Done</span>
  }

  const queue = QUEUES[mode]
  const hasData = all.length > 0
  const tableProps = { selectedId, onSelect: select }

  return (
    <div className="stack">
      {queue ? (
        <div className="card"><p className="mt-intro">{queue.intro}</p></div>
      ) : (
        <div className="card">
          <div className="mt-toolbar">
            <div className="mt-filters">
              <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input className="input mt-search" type="search" placeholder="Search road…" aria-label="Search road by name" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <span className="small muted" aria-live="polite">{roadsRows.length} of {all.length} roads · use the column headings to sort</span>
          </div>
        </div>
      )}

      <div className="mt-live" role="status">{notice && <div className="alert alert-ok">{notice}</div>}</div>
      <ErrorBox error={actionError} />
      <ErrorBox error={list.error} onRetry={list.reload} />
      {list.loading && !list.data && <Spinner />}

      {list.data && (
        <div className="split mt-split">
          <div className="stack">
            {queue && !hasData && <div className="card"><Empty icon={ClipboardCheck}>{NO_ROADS}</Empty></div>}
            {queue && hasData && queue.sections.map((s) => {
              const rows = sortRows(all.filter((r) => s.statuses.includes(r.maintenance_status)), 'priority_score', 'desc')
              const withActions = s.id !== 'done'
              return (
                <section key={s.id} className="card card-flush" aria-labelledby={`mt-sec-${s.id}`}>
                  <div className="mt-section-head">
                    <h2 className="mt-h" id={`mt-sec-${s.id}`}>{s.title}<span className="mt-count">{rows.length}</span></h2>
                  </div>
                  <p className="small muted mt-section-hint">{s.hint}</p>
                  {rows.length === 0 ? <Empty icon={ClipboardCheck}>{s.empty}</Empty> : (
                    <RoadTable {...tableProps} rows={rows} label={s.title} actions={withActions ? actionsFor : null} />
                  )}
                </section>
              )
            })}
            {!queue && (
              <section className="card card-flush" aria-label="Assigned roads">
                {roadsRows.length === 0 ? <Empty>{hasData ? 'No roads match these filters.' : NO_ROADS}</Empty> : (
                  <RoadTable {...tableProps} rows={roadsRows} label="Assigned roads" sort={sort} onSort={toggleSort} />
                )}
              </section>
            )}
          </div>

          <div className="mt-panel-col" ref={panelRef}>
            {selectedId ? (
              <RoadWork key={`${selectedId}-${panelVersion}`} roadId={selectedId} onClose={() => select(null)} onChanged={list.reload} />
            ) : (
              <div className="card empty">Select a road to see how its priority was calculated, record an inspection or repair, add notes and upload photos.</div>
            )}
          </div>
        </div>
      )}

      <Disclaimer>Priorities are AI-generated decision support built from estimates. Inspections and repairs recorded here are the authoritative maintenance record.</Disclaimer>
    </div>
  )
}

/** Table of the roads assigned to you with the work panel beside it. mode: "roads" | "inspections" | "repairs". */
export default function WorkList({ mode = 'roads' }) {
  // keyed by mode so filters and messages do not carry over when the route changes
  return <WorkListView key={mode} mode={mode} />
}
