import { Check } from 'lucide-react'
import { REPORT_TYPES } from './reportTypes'

/** Step 1 of the report flow: seven large cards, one choice. */
export default function TypePicker({ value, onChange }) {
  return (
    <div className="ev-types" role="radiogroup" aria-label="What are you reporting?">
      {REPORT_TYPES.map((t) => {
        const Icon = t.icon
        const on = value === t.value
        return (
          <button
            type="button" key={t.value} role="radio" aria-checked={on} className={`ev-type ${on ? 'on' : ''}`}
            style={{ '--tc': t.color }} onClick={() => onChange(t.value)}
          >
            <span className="ev-type-ico"><Icon size={26} aria-hidden="true" /></span>
            <span className="ev-type-text">
              <b>{t.label}</b>
              <small>{t.help}</small>
            </span>
            {on && <span className="ev-type-check" aria-hidden="true"><Check size={16} /></span>}
          </button>
        )
      })}
    </div>
  )
}
