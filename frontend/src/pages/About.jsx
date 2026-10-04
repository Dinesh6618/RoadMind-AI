import { Eye, Layers, Lock, Map as MapIcon, ScanSearch, ShieldCheck, TrendingUp, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ConditionLegend } from '../components'

const PARTS = [
  [ScanSearch, 'Damage detection', 'Upload a road photo and a computer-vision model outlines potholes and cracks, with a confidence score for each.'],
  [TrendingUp, 'Risk prediction', 'A machine-learning model estimates how likely a road is to get worse in the coming months.'],
  [Wrench, 'Maintenance priority', 'Roads are ranked by severity, predicted risk, traffic and the people they affect, so crews can fix the right ones first.'],
  [MapIcon, 'Safer routes', 'Routes are computed on the complete road network and compared by distance, time and road condition.'],
]

export default function About() {
  return (
    <div className="container page">
      <div className="page-head">
        <span className="eyebrow"><ShieldCheck size={14} aria-hidden="true" /> About RoadMind AI</span>
        <h1>Smarter roads. Safer journeys.</h1>
        <p>RoadMind AI turns road photos and public map data into an intelligence layer for drivers, citizens and the teams that look after the roads.</p>
      </div>

      <div className="grid cols-2" style={{ marginTop: 24 }}>
        {PARTS.map(([Icon, title, text]) => (
          <article key={title} className="card">
            <span className="stat-icon" style={{ '--accent': 'var(--brand)' }}><Icon size={21} aria-hidden="true" /></span>
            <h3>{title}</h3>
            <p className="muted" style={{ margin: 0 }}>{text}</p>
          </article>
        ))}
      </div>

      <section className="card" style={{ marginTop: 24 }}>
        <h2><Layers size={20} aria-hidden="true" style={{ verticalAlign: '-3px' }} /> The whole network, always</h2>
        <p>The map shows every road in OpenStreetMap. RoadMind adds a colour layer only where it has condition data - roads it knows nothing about stay grey and are <strong>never counted as good or as damaged</strong>.</p>
        <ConditionLegend />
      </section>

      <section className="card" style={{ marginTop: 24 }}>
        <h2><Eye size={20} aria-hidden="true" style={{ verticalAlign: '-3px' }} /> Honest about what it is</h2>
        <ul className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Every score is an <strong>AI-generated estimate</strong>, not an official engineering assessment. Predictions are probabilities, not guaranteed events.</li>
          <li>Roads, names and map tiles are real OpenStreetMap data. In this demo the <strong>condition data on top of them is simulated</strong> and labelled as such.</li>
          <li>The damage detector in the demo is a simple computer-vision fallback; a trained model can be plugged in.</li>
        </ul>
      </section>

      <section className="card" style={{ marginTop: 24 }}>
        <h2><Lock size={20} aria-hidden="true" style={{ verticalAlign: '-3px' }} /> Who can do what</h2>
        <ul className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
          <li><strong>Everyone, including guests:</strong> browse the map, search roads, see public road conditions, plan routes and get safer-route recommendations.</li>
          <li><strong>Registered users:</strong> also report damage with photos, see the AI result and keep track of their own reports.</li>
          <li><strong>Authorised staff</strong> (administrators and road-maintenance employees) sign in through their own verified-email portals, which are separate from this public site.</li>
        </ul>
        <div className="row" style={{ marginTop: 18 }}>
          <Link className="btn btn-primary" to="/user/map">Explore the map</Link>
          <Link className="btn" to="/user/register">Create a free account</Link>
        </div>
      </section>
    </div>
  )
}
