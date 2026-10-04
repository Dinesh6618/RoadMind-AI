import { Camera, Map as MapIcon, Navigation } from 'lucide-react'
import { Link } from 'react-router-dom'
import { BackButton, Logo } from '../../components'
import HeroScene from '../../HeroScene'

const POINTS = [
  [MapIcon, 'Explore the complete road map and its condition'],
  [Navigation, 'Plan routes and get safer, lower-risk recommendations'],
  [Camera, 'Report road damage and see the AI detection result'],
]

/** The friendly, bright frame of the user login and sign-up pages: road imagery on the left, a card on the right.
 *  `back` (a fallback address) adds a Back button above the logo. */
export default function UserLayout({ children, back }) {
  return (
    <div className="welcome">
      <section className="welcome-art">
        {back && <div className="welcome-back"><BackButton fallback={back} /></div>}
        <Link to="/" aria-label="RoadMind AI - back to role selection"><Logo /></Link>
        <h1>Make every <span style={{ whiteSpace: 'nowrap' }}>journey safer.</span></h1>
        <p className="tagline">Smarter Roads • Safer Journeys</p>
        <div className="scene" aria-hidden="true"><HeroScene /></div>
        <ul>{POINTS.map(([Icon, text]) => <li key={text}><Icon size={20} aria-hidden="true" />{text}</li>)}</ul>
      </section>
      <section className="welcome-wrap">
        <div className="welcome-card">{children}</div>
      </section>
    </div>
  )
}
