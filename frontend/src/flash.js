// A one-line message that survives a single page change ("You have been logged out successfully."), kept in sessionStorage.
// It is read without being deleted (React StrictMode mounts pages twice in development) and simply expires after a few seconds.
const KEY = 'roadmind_flash'

export function setFlash(text) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ text, at: Date.now() })) } catch { /* storage blocked: the message is just not shown */ }
}

export function readFlash(maxAgeMs = 8000) {
  try {
    const f = JSON.parse(sessionStorage.getItem(KEY) || 'null')
    if (f && Date.now() - f.at < maxAgeMs) return f.text
  } catch { /* unreadable: no message */ }
  return null
}

export function clearFlash() {
  try { sessionStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}
