import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAdminApi } from '../../auth'
import { Disclaimer, Empty, ErrorBox, Spinner, Stat } from '../../components'
import { LEVEL_COLORS } from '../../format'

export default function RouteAnalytics() {
  const { data, loading, error, reload } = useAdminApi('/analytics/routes')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  const avoided = data.avoided_roads.map((r) => ({ ...r, short: r.name.replace(' (Block ', ' #').replace(')', '') }))

  return (
    <div className="stack">
      <div className="grid cols-3">
        <Stat label="Route comparisons" value={data.total_queries} color="#2f6fb3" />
        <Stat label="In the last 7 days" value={data.queries_last_7_days} />
        <Stat label="Roads drivers are steered away from" value={data.avoided_roads.length} color={LEVEL_COLORS.High} hint="roads on routes labelled Avoid" />
      </div>

      <div className="grid cols-2-3">
        <div className="card">
          <h3>Frequently avoided roads</h3>
          {avoided.length === 0 ? <Empty>No routes have been marked “Avoid” yet.</Empty> : (
            <div className="chart-box">
              <ResponsiveContainer>
                <BarChart data={avoided} layout="vertical" margin={{ left: 20, right: 16 }}>
                  <CartesianGrid horizontal={false} stroke="#e8eef0" />
                  <XAxis type="number" allowDecimals={false} fontSize={12} />
                  <YAxis type="category" dataKey="short" width={150} fontSize={11} />
                  <Tooltip formatter={(v) => [v, 'Times on an “Avoid” route']} />
                  <Bar dataKey="times_avoided" fill={LEVEL_COLORS.High} radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card card-flush">
          <h3 style={{ padding: '14px 18px 0' }}>Most affected routes</h3>
          <p className="small muted" style={{ padding: '0 18px', margin: '0 0 6px' }}>Trips whose fastest route carries the highest road-condition risk.</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Trip</th><th className="num">Queries</th><th className="num">Fastest route risk</th><th className="num">Recommended route risk</th></tr></thead>
              <tbody>
                {data.most_affected_routes.map((r, i) => (
                  <tr key={i}><td>{r.origin} → {r.destination}</td><td className="num">{r.queries}</td><td className="num"><strong>{r.fastest_route_risk_percent}%</strong></td><td className="num">{r.recommended_route_risk_percent}%</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card card-flush">
        <h3 style={{ padding: '14px 18px 0' }}>Recommended alternative routes</h3>
        <p className="small muted" style={{ padding: '0 18px', margin: '0 0 6px' }}>Trips where RoadMind recommended a route other than the fastest one.</p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Trip</th><th className="num">Times recommended</th><th className="num">Avg extra distance</th><th className="num">Avg risk reduction</th></tr></thead>
            <tbody>
              {data.recommended_alternatives.map((r, i) => (
                <tr key={i}><td>{r.origin} → {r.destination}</td><td className="num">{r.times_recommended}</td><td className="num">{r.avg_extra_km >= 0 ? '+' : ''}{r.avg_extra_km} km</td><td className="num">−{r.avg_risk_reduction_points} pts</td></tr>
              ))}
              {data.recommended_alternatives.length === 0 && <tr><td colSpan={4} className="muted">None yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Disclaimer>Includes sample route queries generated for the demo. Route suggestions are data-based estimates, not determinations that a road is unsafe.</Disclaimer>
    </div>
  )
}
