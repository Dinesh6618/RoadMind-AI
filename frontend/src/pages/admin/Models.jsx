import { Fragment } from 'react'
import { useApi } from '../../api'
import { Badge, Disclaimer, ErrorBox, FactorBars, Spinner } from '../../components'
import { fmtDate } from '../../format'

const f3 = (v) => (v == null ? '—' : Number(v).toFixed(3))

export function RiskMetrics({ metrics }) {
  if (!metrics) return <p className="muted">No metrics file found. Run <code>python scripts/setup_demo.py</code>.</p>
  const rows = Object.entries(metrics.holdout_metrics)
  const imp = metrics.feature_importance.slice(0, 8)
  const top = Math.max(...imp.map((i) => i.importance), 1e-6)
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Target: <em>{metrics.target}</em>. Hold-out set of {metrics.dataset.test.toLocaleString()} samples ({Math.round(metrics.dataset.positive_rate * 100)}% positive).
        5-fold cross-validated ROC-AUC of the selected model: <strong>{metrics.cross_validation_roc_auc.mean}</strong> ± {metrics.cross_validation_roc_auc.std}.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Model</th><th className="num">Accuracy</th><th className="num">Precision</th><th className="num">Recall</th><th className="num">F1</th><th className="num">ROC-AUC</th></tr></thead>
          <tbody>
            {rows.map(([name, m]) => (
              <tr key={name} className={name === metrics.selected_model ? 'selected' : ''}>
                <td>{name} {name === metrics.selected_model && <Badge color="#0f766e">selected</Badge>}</td>
                <td className="num">{f3(m.accuracy)}</td><td className="num">{f3(m.precision)}</td><td className="num">{f3(m.recall)}</td><td className="num">{f3(m.f1)}</td><td className="num">{f3(m.roc_auc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3>Which factors matter most (permutation importance)</h3>
        <FactorBars items={imp.map((i) => ({ label: i.label, value: (100 * Math.max(i.importance, 0)) / top, hint: `${i.importance} ROC-AUC drop when shuffled` }))} />
      </div>
      <Disclaimer kind="warn">{metrics.caveat}</Disclaimer>
    </div>
  )
}

function DetectionMetrics({ m }) {
  if (!m) return <p className="muted">No detector metrics yet. Run <code>python -m roadmind_ai.detection.evaluate</code> from the <code>ai/</code> folder.</p>
  const o = m.overall
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Dataset: {m.dataset.name} - {m.dataset.images} images, {m.dataset.objects} labelled objects · IoU threshold {m.iou_threshold}
        {m.confidence_threshold != null && <> · confidence threshold {m.confidence_threshold}</>} · evaluated {fmtDate(m.generated_at)}
      </p>
      <div className="grid cols-4">
        {[['Precision', o.precision], ['Recall', o.recall], ['F1-score', o.f1], ['mAP@0.5', o.map50]].map(([k, v]) => (
          <div key={k} className="card" style={{ textAlign: 'center', padding: 12 }}><div className="stat-value">{f3(v)}</div><div className="stat-label">{k}</div></div>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Class</th><th className="num">Precision</th><th className="num">Recall</th><th className="num">F1</th><th className="num">AP@0.5</th>{m.dataset.synthetic && <th className="num">Objects</th>}</tr></thead>
          <tbody>
            {Object.entries(m.per_class).map(([c, v]) => (
              <tr key={c}><td>{c.replace('_', ' ')}</td><td className="num">{f3(v.precision)}</td><td className="num">{f3(v.recall)}</td><td className="num">{f3(v.f1)}</td><td className="num">{f3(v.ap50)}</td>{m.dataset.synthetic && <td className="num">{v.support}</td>}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <Disclaimer kind="warn">{m.caveat}</Disclaimer>
    </div>
  )
}

export default function Models() {
  const { data, loading, error, reload } = useApi('/system/info')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  const d = data.detector
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Damage detector</h2>
          <Badge color={d.demo_mode ? '#d9a90a' : '#2a9d5c'}>{d.demo_mode ? 'Demo mode' : 'Trained model'}</Badge>
        </div>
        <p style={{ margin: 0 }}><strong>{d.name}</strong></p>
        {d.demo_mode && (
          <div className="alert alert-warn">
            No trained YOLO weights are installed, so RoadMind is using a classical OpenCV fallback so the platform runs end to end. It is tuned for the generated sample images and will be unreliable on real road photographs.
            See <code>docs/MODEL_TRAINING.md</code> to train YOLO on RDD2022; the weights are picked up automatically.
          </div>
        )}
        <DetectionMetrics m={d.metrics} />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Deterioration-risk model</h2>
        <p style={{ margin: 0 }}><strong>{data.risk_model.name}</strong> · version {data.risk_model.version}</p>
        <RiskMetrics metrics={data.risk_model.metrics} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Severity score</h3>
          <p className="small muted">0-100, built from four components. Levels: {Object.entries(data.severity.scale).map(([k, v]) => `${k} ${v}`).join(' · ')}.</p>
          <FactorBars items={Object.entries(data.severity.max_points).map(([k, v]) => ({ label: `${k[0].toUpperCase()}${k.slice(1)} (max)`, value: v * 2, hint: `${v} points` }))} />
        </div>
        <div className="card">
          <h3>Maintenance priority</h3>
          <p className="small muted" style={{ marginTop: 0 }}>{data.priority.formula}</p>
          <dl className="kv small">
            {Object.entries(data.priority.categories).map(([k, v]) => (<Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>))}
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>Weights are configurable in <code>config/roadmind.yaml</code>.</p>
        </div>
      </div>

      <div className="card">
        <h3>Disclaimers shown across the app</h3>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          {Object.values(data.disclaimers).map((t) => <li key={t}>{t}</li>)}
        </ul>
      </div>
    </div>
  )
}
