import { Badge } from '../../components'

// display_status of a road event -> [label, colour, text colour]. Same hues as the rest of the app (see format.js).
const STATUS = {
  PENDING: ['Pending verification', '#f2b01e', '#8a5a00', 'A person reported this. Authorised staff have not checked it yet.'],
  ACTIVE: ['Verified & active', '#17a673', '#0b6e4b', 'Authorised staff verified this report and it is still in effect.'],
  REJECTED: ['Rejected', '#e0342f', '#a3191a', 'Authorised staff decided this report is not correct. It does not count.'],
  RESOLVED: ['Resolved', '#4f6fe0', '#2c47b5', 'The problem was marked as over (for example the road is open again).'],
  EXPIRED: ['Expired', '#94a3b8', '#475569', 'The time window of this report has passed. It no longer counts.'],
}

export const STATUS_LABELS = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v[0]]))

/** One chip for the `display_status` of a road event (PENDING | ACTIVE | REJECTED | RESOLVED | EXPIRED). */
export default function EventStatusChip({ status }) {
  const s = STATUS[status] || [status || 'Unknown', '#94a3b8', '#475569', '']
  return <Badge dot color={s[1]} ink={s[2]} title={s[3]}>{s[0]}</Badge>
}
