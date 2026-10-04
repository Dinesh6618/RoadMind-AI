import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { useAdminApi } from '../../auth'
import { Disclaimer, ErrorBox, SeverityBadge, Spinner } from '../../components'
import { RISK_COLORS } from '../../format'
import { RiskMetrics } from './Models'

const GROUPS = [['high', 'HIGH', 'High risk'], ['medium', 'MEDIUM', 'Medium risk'], ['low', 'LOW', 'Low risk']]

export default function PredictionAnalytics() {
  const { data, loading, error, reload } = useAdminApi('/analytics/predictions')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  const pie = GROUPS.map(([k, level, name]) => ({ name, level, value: data.levels[k].count }))
  const t = data.thresholds

  return (
    <div className="stack">
      <div className="grid cols-3">
        <div className="card">
          <h3>Roads by predicted risk</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={pie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {pie.map((p) => <Cell key={p.level} fill={RISK_COLORS[p.level]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="legend" style={{ justifyContent: 'center' }}>
            {pie.map((p) => <li key={p.level}><i style={{ background: RISK_COLORS[p.level] }} />{p.name}: <strong>{p.value}</strong></li>)}
          </ul>
          <p className="small muted" style={{ marginBottom: 0 }}>High ≥ {Math.round(t.high * 100)}% · Medium ≥ {Math.round(t.medium * 100)}% · otherwise Low. Probabilities, not certainties.</p>
        </div>
        {GROUPS.slice(0, 2).map(([k, level, name]) => (
          <div className="card card-flush" key={k}>
            <h3 style={{ padding: '14px 18px 0' }}>{name} roads ({data.levels[k].count})</h3>
            <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
              <table className="data">
                <tbody>
                  {data.levels[k].roads.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}<div className="small muted">{r.zone}</div></td>
                      <td className="num"><strong style={{ color: RISK_COLORS[level] }}>{r.risk_percent}%</strong></td>
                      <td><SeverityBadge level={r.severity_level} /></td>
                    </tr>
                  ))}
                  {data.levels[k].roads.length === 0 && <tr><td className="muted">None</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="card card-flush">
        <h3 style={{ padding: '14px 18px 0' }}>Low-risk roads ({data.levels.low.count}, highest first)</h3>
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data">
            <tbody>
              {data.levels.low.roads.map((r) => (
                <tr key={r.id}><td>{r.name}</td><td className="muted">{r.zone}</td><td className="num">{r.risk_percent}%</td><td><SeverityBadge level={r.severity_level} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Model evaluation</h2>
        <RiskMetrics metrics={data.model_metrics} />
      </div>
      <Disclaimer>Predictions estimate the chance that a road's condition worsens within about 90 days. They support planning and are never guaranteed outcomes.</Disclaimer>
    </div>
  )
}
