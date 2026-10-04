import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, Legend as ChartLegend, XAxis, YAxis } from 'recharts'
import { useAdminApi } from '../../auth'
import { Disclaimer, Empty, ErrorBox, SeverityBadge, Spinner } from '../../components'
import { LEVEL_COLORS, fmtDate } from '../../format'

const TYPE_COLORS = ['#5b3df5', '#7c5cff', '#9d86ff', '#bdb0ff', '#d9d1ff']

function Box({ title, children, hint }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {hint && <p className="small muted" style={{ margin: '0 0 8px' }}>{hint}</p>}
      <div className="chart-box">{children}</div>
    </section>
  )
}

function ReportsTable() {
  const [level, setLevel] = useState('')
  const [source, setSource] = useState('')
  const qs = new URLSearchParams({ limit: '12', ...(level && { level }), ...(source && { source }) })
  const { data, loading, error, reload } = useAdminApi(`/reports?${qs}`)
  return (
    <section className="card card-flush">
      <div className="row between" style={{ padding: '22px 24px 8px' }}>
        <h3 style={{ margin: 0 }}>Latest reports {data && <span className="muted" style={{ fontWeight: 500 }}>({data.total.toLocaleString()} match)</span>}</h3>
        <div className="row">
          <select aria-label="Filter by severity" style={{ width: 'auto', minHeight: 40 }} value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">All severities</option><option>Critical</option><option>High</option><option>Moderate</option><option>Low</option>
          </select>
          <select aria-label="Filter by source" style={{ width: 'auto', minHeight: 40 }} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">User + demo</option><option value="user">Submitted by users</option><option value="seed">Simulated demo</option>
          </select>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading ? <Spinner /> : !data?.items.length ? <Empty>No reports match.</Empty> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Photo</th><th>Report</th><th>Road</th><th>Damage</th><th className="num">Severity</th><th>Reported</th></tr></thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td style={{ width: 84 }}>{r.annotated_url ? <a href={r.annotated_url} target="_blank" rel="noreferrer"><img src={r.annotated_url} alt={`Report ${r.id}`} style={{ width: 68, height: 48, objectFit: 'cover', borderRadius: 10, display: 'block' }} /></a> : <span className="muted small">no photo</span>}</td>
                  <td><b>#{r.id}</b><div className="small muted">{r.source === 'seed' ? 'simulated' : 'user report'}</div></td>
                  <td>{r.road_name}</td>
                  <td>{r.damage_summary}</td>
                  <td className="num"><b>{Math.round(r.severity_score)}</b> <SeverityBadge level={r.severity_level} /></td>
                  <td className="nowrap">{fmtDate(r.reported_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function DamageReports() {
  const { data, loading, error, reload } = useAdminApi('/analytics/damage')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  const over = data.over_time.map((w) => ({ ...w, label: new Date(w.week_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }))
  return (
    <>
      <div className="grid cols-2">
        <Box title="Damage by type" hint="Number of individual detections stored across all reports.">
          <ResponsiveContainer>
            <BarChart data={data.by_type} layout="vertical" margin={{ left: 20, right: 16 }}>
              <CartesianGrid horizontal={false} stroke="#ece9fa" />
              <XAxis type="number" allowDecimals={false} fontSize={12} stroke="#667094" />
              <YAxis type="category" dataKey="name" width={140} fontSize={12} stroke="#667094" />
              <Tooltip cursor={{ fill: '#f3efff' }} />
              <Bar dataKey="count" name="Detections" radius={[0, 10, 10, 0]}>{data.by_type.map((_, i) => <Cell key={i} fill={TYPE_COLORS[i % TYPE_COLORS.length]} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </Box>
        <Box title="Damage by severity" hint="Reports (coloured) and roads (grey) by severity level.">
          <ResponsiveContainer>
            <BarChart data={data.by_severity.map((s, i) => ({ level: s.level, reports: s.count, roads: data.roads_by_level[i].count }))} margin={{ right: 16 }}>
              <CartesianGrid vertical={false} stroke="#ece9fa" />
              <XAxis dataKey="level" fontSize={12} stroke="#667094" />
              <YAxis allowDecimals={false} fontSize={12} stroke="#667094" />
              <Tooltip cursor={{ fill: '#f3efff' }} />
              <Bar dataKey="reports" name="Reports" radius={[8, 8, 0, 0]}>{data.by_severity.map((s) => <Cell key={s.level} fill={LEVEL_COLORS[s.level]} />)}</Bar>
              <Bar dataKey="roads" name="Roads" radius={[8, 8, 0, 0]} fill="#cfc8ee" />
            </BarChart>
          </ResponsiveContainer>
        </Box>
        <Box title="Damage by location" hint="Reports per zone and the zone's average road severity.">
          <ResponsiveContainer>
            <BarChart data={data.by_location} margin={{ right: 16 }}>
              <CartesianGrid vertical={false} stroke="#ece9fa" />
              <XAxis dataKey="zone" fontSize={11} interval={0} stroke="#667094" />
              <YAxis yAxisId="l" allowDecimals={false} fontSize={12} stroke="#667094" />
              <YAxis yAxisId="r" orientation="right" domain={[0, 100]} fontSize={12} stroke="#667094" />
              <Tooltip cursor={{ fill: '#f3efff' }} />
              <ChartLegend />
              <Bar yAxisId="l" dataKey="reports" name="Reports" fill="#5b3df5" radius={[8, 8, 0, 0]} />
              <Bar yAxisId="r" dataKey="avg_severity" name="Avg severity" fill="#f7762c" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Box>
        <Box title="Damage over time" hint="Weekly reports and the average severity of those reports.">
          <ResponsiveContainer>
            <LineChart data={over} margin={{ right: 16 }}>
              <CartesianGrid vertical={false} stroke="#ece9fa" />
              <XAxis dataKey="label" fontSize={11} interval={3} stroke="#667094" />
              <YAxis yAxisId="l" allowDecimals={false} fontSize={12} stroke="#667094" />
              <YAxis yAxisId="r" orientation="right" domain={[0, 100]} fontSize={12} stroke="#667094" />
              <Tooltip />
              <ChartLegend />
              <Line yAxisId="l" type="monotone" dataKey="reports" name="Reports" stroke="#5b3df5" strokeWidth={2.5} dot={false} />
              <Line yAxisId="r" type="monotone" dataKey="avg_severity" name="Avg severity" stroke="#e0342f" strokeWidth={2.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Box>
      </div>

      <ReportsTable />

      <section className="card card-flush">
        <h3 style={{ padding: '22px 24px 0' }}>Most-reported roads</h3>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Road</th><th className="num">Reports</th><th className="num">Current severity</th><th>Level</th></tr></thead>
            <tbody>
              {data.top_roads.map((r) => (
                <tr key={r.id}><td>{r.name}</td><td className="num">{r.reports}</td><td className="num">{Math.round(r.current_severity)}</td><td><SeverityBadge level={r.severity_level} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Disclaimer>Severity values are experimental AI estimates, not engineering assessments. Reports marked "simulated" are generated demo data.</Disclaimer>
    </>
  )
}
