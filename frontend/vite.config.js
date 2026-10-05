import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the API runs on :8000 and Vite proxies to it, so no CORS setup is needed.
// (Another address: set VITE_API_URL - see .env.example - and add this page's origin to ROADMIND_CORS_ORIGINS.)
const api = process.env.ROADMIND_API || 'http://127.0.0.1:8000'  // (ROADMIND_API: point the dev server at a backend on another port)

// With the API stopped, Vite's own answer is an EMPTY "500 Internal Server Error" - which looked like a login bug.
// Say what is actually wrong instead (JSON in the shape the app already understands).
const proxy = {
  target: api,
  configure: (p) =>
    p.on('error', (err, _req, res) => {
      if (!res || typeof res.writeHead !== 'function' || res.headersSent) return
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: { message: `The RoadMind API (${api}) is not running. Start it with: python scripts/start.py`, code: 'server_unreachable' } }))
    }),
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': proxy, '/media': proxy, '/samples': proxy },
  },
  build: { chunkSizeWarningLimit: 900 },
})
