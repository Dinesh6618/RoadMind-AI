import { BadgeCheck, Camera, CalendarClock, ClipboardCheck, ClipboardList, Hourglass, OctagonAlert, Signpost, TriangleAlert, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAdminApi } from '../../auth'
import { Disclaimer, Empty, ErrorBox, PriorityBadge, RiskBadge, SeverityBadge, Spinner, Stat, StatusBadge } from '../../components'
import { num } from '../../format'
import './maintenance.css'

export default function Dashboard() {
  const { data, loading, error, reload } = useAdminApi('/staff/summary')
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading || !data) return <Spinner />

  const all = data.scope === 'all' // administrators see every road, maintenance employees only their own
  const total = data.assigned_roads
  const done = data.repairs_completed
  const donePct = total ? Math.round((done / total) * 100) : 0
  const top = data.top_roads || []

  return (
    <div className="stack">
      <div className="stat-grid four">
        <Stat icon={Signpost} label={all ? 'All Roads' : 'Assigned Roads'} value={num(total)} color="var(--brand)" hint={all ? 'administrator view: every road with data' : 'roads an administrator gave you'} />
        <Stat icon={OctagonAlert} label="Immediate Priority" value={num(data.immediate)} color="var(--critical)" hint="not yet repaired" />
        <Stat icon={TriangleAlert} label="High Priority" value={num(data.high_priority)} color="var(--high)" hint="not yet repaired" />
        <Stat icon={Hourglass} label="Awaiting Inspection" value={num(data.awaiting_inspection)} color="var(--moderate)" hint="no inspection recorded yet" />
        <Stat icon={ClipboardCheck} label="Inspected" value={num(data.inspected)} color="var(--brand-2)" hint="awaiting a repair plan" />
        <Stat icon={CalendarClock} label="Repairs Planned" value={num(data.repair_planned)} color="var(--brand)" hint="scheduled, not finished" />
        <Stat icon={BadgeCheck} label="Repairs Completed" value={num(done)} color="var(--good)" hint="finished and recorded" />
        <Stat icon={Camera} label="Photos Uploaded" value={num(data.evidence_uploaded)} color="var(--brand-ink)" hint="inspection and repair evidence" />
      </div>

      {total > 0 && (
        <div className="card mt-progress">
          <div className="row between">
            <h2 className="mt-h">{all ? 'Repair progress' : 'Your repair progress'}</h2>
            <span className="small muted">{num(done)} of {num(total)} roads repaired ({donePct}%)</span>
          </div>
          <div className="mt-progress-track" role="progressbar" aria-label="Roads with a completed repair" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <i style={{ width: `${donePct}%` }} />
          </div>
        </div>
      )}

      {total > 0 && (
        <div className="mt-queues">
          <Link className="mt-queue" to="/maintenance/inspections">
            <span><ClipboardList size={18} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: 8 }} />Inspection queue<small>Roads to inspect on site</small></span>
            <b aria-label={`${data.awaiting_inspection} awaiting inspection`}>{num(data.awaiting_inspection)}</b>
          </Link>
          <Link className="mt-queue" to="/maintenance/repairs">
            <span><Wrench size={18} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: 8 }} />Repair queue<small>Plan and finish repairs</small></span>
            <b aria-label={`${data.inspected + data.repair_planned} repairs to do`}>{num(data.inspected + data.repair_planned)}</b>
          </Link>
        </div>
      )}

      <section className="card card-flush" aria-labelledby="mt-top-h">
        <div className="row between mt-head-pad">
          <div>
            <h2 className="mt-h" id="mt-top-h">Roads needing attention</h2>
            <p className="small muted" style={{ margin: '2px 0 0' }}>
              {all ? 'The five highest-priority roads across the network that still need work.' : 'Your five highest-priority roads that still need work.'}
            </p>
          </div>
          {total > 0 && <Link to="/maintenance/roads" className="btn btn-small btn-soft mt-tap">{all ? 'View all roads' : 'View my roads'}</Link>}
        </div>

        {total === 0 ? (
          <Empty icon={Signpost}>{all ? 'There are no roads with RoadMind data yet.' : 'No roads are assigned to you yet. An administrator assigns roads from the Maintenance page.'}</Empty>
        ) : top.length === 0 ? (
          <Empty icon={BadgeCheck}>Nothing needs attention right now: every {all ? '' : 'assigned '}road has its repair completed.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data mt-table">
              <caption className="sr-only">{all ? 'Highest-priority roads that still need work' : 'Your highest-priority roads that still need work'}</caption>
              <thead>
                <tr><th scope="col">Road</th><th scope="col" className="num">Severity</th><th scope="col" className="num">Risk</th><th scope="col" className="num">Priority</th><th scope="col">Status</th><th scope="col" className="right">Open</th></tr>
              </thead>
              <tbody>
                {top.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong><div className="small muted">{r.zone} · #{r.id}</div></td>
                    <td className="num">{num(r.current_severity)} <SeverityBadge level={r.severity_level} /></td>
                    <td className="num"><RiskBadge level={r.risk_level} percent={r.risk_percent} /></td>
                    <td className="num"><strong>{num(r.priority_score)}</strong> {r.priority_category ? <PriorityBadge category={r.priority_category} /> : null}</td>
                    <td><StatusBadge status={r.maintenance_status} /></td>
                    <td className="right"><Link className="btn btn-small btn-soft mt-tap" to={`/maintenance/roads?road=${r.id}`} aria-label={`Open ${r.name}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Disclaimer>Priorities are AI-generated decision support built from estimates. Inspections and repairs recorded here are the authoritative maintenance record.</Disclaimer>
    </div>
  )
}
