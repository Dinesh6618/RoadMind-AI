import { ArrowRight, Camera, Eye, Layers, Navigation, Route as RouteIcon, ScanSearch, ShieldCheck, TrendingUp, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useApi } from '../api'
import { ConditionLegend } from '../components'
import { num } from '../format'
import HeroScene from '../HeroScene'
import EmergencyLink from './emergency/EmergencyLink'

const FEATURES = [
  [ScanSearch, 'Detect Damage', 'Upload a photo and the AI outlines potholes, cracks and surface damage in seconds, with a confidence score for each.'],
  [TrendingUp, 'Predict Risks', 'A machine-learning model estimates which roads are likely to get worse, so problems are caught before they spread.'],
  [Wrench, 'Prioritize Maintenance', 'Roads are ranked by severity, risk, traffic and who they affect - so crews fix the right roads first.'],
  [Navigation, 'Safer Routes', 'Compare routes by distance, time and road condition, and see why one is recommended over another.'],
]

export default function Home() {
  const { data } = useApi('/analytics/public-summary')
  const stats = [
    ['Roads Mapped', data?.network_segments],
    ['Damage Reports', data?.total_reports],
    ['High Risk Roads', data?.high_risk_roads],
    ['Repairs Completed', data?.repairs_completed],
  ]
  return (
    <>
      <section className="hero">
        <div className="container">
          <div className="hero-grid">
            <div>
              <span className="eyebrow"><ShieldCheck size={14} aria-hidden="true" /> AI-powered road intelligence</span>
              <h1>Safer Roads for a <em>Better Tomorrow</em></h1>
              <p className="lead">AI-powered road damage detection, risk prediction, maintenance prioritization and safer route recommendations.</p>
              <div className="hero-actions">
                <Link className="btn btn-primary btn-lg" to="/user/report"><Camera size={20} aria-hidden="true" /> Report Road Damage</Link>
                <Link className="btn btn-lg btn-white" to="/user/routes"><RouteIcon size={20} aria-hidden="true" /> Plan a Safer Route</Link>
                <EmergencyLink badge />
              </div>
              <div className="hero-proof">
                <span><Layers size={17} aria-hidden="true" /> The complete road network, always visible</span>
                <span><Eye size={17} aria-hidden="true" /> Honest about roads it has no data for</span>
              </div>
            </div>
            <div className="hero-visual">
              <HeroScene />
              <div className="float-card detect glass">
                <div className="row nowrap-row" style={{ gap: 10, marginBottom: 6 }}>
                  <span className="stat-icon" style={{ '--accent': 'var(--high)', margin: 0, width: 36, height: 36, borderRadius: 12 }}><ScanSearch size={18} aria-hidden="true" /></span>
                  <h4>Pothole Detected</h4>
                </div>
                <div className="row between small" style={{ marginBottom: 2 }}>
                  <span className="muted">Severity</span>
                  <span className="priority" style={{ '--c': 'var(--high)', '--ink-c': 'var(--high-ink)' }}>High</span>
                </div>
                <div className="row between small"><span className="muted">Confidence</span><b>93%</b></div>
                <div className="conf-bar"><i style={{ width: '93%' }} /></div>
              </div>
              <div className="float-card mini glass">
                <span className="stat-icon" style={{ '--accent': 'var(--good)', margin: 0, width: 38, height: 38, borderRadius: 12 }}><Navigation size={18} aria-hidden="true" /></span>
                <div><b style={{ display: 'block', lineHeight: 1.2 }}>Safer route found</b><span className="muted small">Road risk 22%</span></div>
              </div>
            </div>
          </div>

          <div className="stats-strip glass" role="list">
            {stats.map(([label, value]) => (
              <div key={label} role="listitem">
                <b>{value == null ? '…' : num(value)}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="eyebrow">What RoadMind does</span>
            <h2>From a single photo to a safer journey</h2>
            <p className="muted">One platform that finds damage, forecasts where it is heading, guides repair work and helps drivers choose better roads.</p>
          </div>
          <div className="grid cols-4">
            {FEATURES.map(([Icon, title, text]) => (
              <article key={title} className="card feature">
                <div className="ico"><Icon size={26} aria-hidden="true" /></div>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="card two-col">
            <div>
              <span className="eyebrow"><Layers size={14} aria-hidden="true" /> The whole map, always</span>
              <h2>Every road is on the map - even the ones nobody has reported</h2>
              <p className="muted">RoadMind shows the complete road network and layers its own condition data on top. A road with no data is shown in grey as <b>No Data</b> - never as safe and never as damaged - so the map never pretends to know more than it does.</p>
              <Link className="btn btn-soft" to="/user/map">Explore the road map <ArrowRight size={17} aria-hidden="true" /></Link>
            </div>
            <div className="card card-soft stack">
              <h3 style={{ marginBottom: 0 }}>Road condition</h3>
              <ConditionLegend />
              <p className="small muted" style={{ margin: 0 }}>Green means recent data indicates low damage. Orange and red mean significant or severe damage. Grey means RoadMind has not got enough data to say.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="container">
        <div className="cta-band">
          <div>
            <h2>See a damaged road? Tell RoadMind in a minute.</h2>
            <p>Add a photo and a location - the AI does the rest.</p>
          </div>
          <Link className="btn btn-lg btn-white" to="/user/report"><Camera size={20} aria-hidden="true" /> Report Road Damage</Link>
        </div>
        <p className="note" style={{ margin: '22px 0 56px' }}>All scores are AI-generated estimates, not official engineering assessments; predictions are probabilities, not guaranteed events. In this demo the roads are real (OpenStreetMap) and the condition data on top of them is simulated.</p>
      </section>
    </>
  )
}
