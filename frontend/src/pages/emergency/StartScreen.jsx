import { ChevronRight, Cross, Flame, MapPin, ShieldCheck } from 'lucide-react'
import { KINDS, KIND_ORDER, TEXT } from './emergencyFormat'

const GLYPH = { hospital: Cross, fire_station: Flame, police: ShieldCheck, custom: MapPin }

/** Screen 2: the dark hero and the four destination options. The start card (StartPanel) is rendered by the page right below. */
export default function StartScreen({ kind, onKind }) {
  return (
    <>
      <section className="em-hero">
        <span className="em-hero-glow" aria-hidden="true" />
        <h1>{TEXT.title}</h1>
        <p className="em-hero-line">{TEXT.hero}</p>
        <p className="em-hero-sub">{TEXT.subtitle}</p>
      </section>

      <ul className="em-options" aria-label="Where do you need to go?">
        {KIND_ORDER.map((k) => {
          const m = KINDS[k]
          const Glyph = GLYPH[k]
          return (
            <li key={k}>
              <button type="button" className={`em-option is-${k}${kind === k ? ' is-on' : ''}`} aria-pressed={kind === k} onClick={() => onKind(k)}>
                <span className="em-option-ico" aria-hidden="true"><Glyph size={26} strokeWidth={2.4} /></span>
                <span className="em-option-txt"><b>{m.emoji} {m.label}</b><small>{k === 'custom' ? 'Search any emergency location' : `Find nearest ${m.plural}`}</small></span>
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
