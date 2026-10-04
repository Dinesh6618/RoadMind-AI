import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the API runs on :8000 and Vite proxies to it, so no CORS setup is needed.
const api = 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/media': api, '/samples': api },
  },
  build: { chunkSizeWarningLimit: 900 },
})
