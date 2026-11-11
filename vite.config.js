import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    allowedHosts: true,
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/terms': 'http://127.0.0.1:5000',
      '/query': 'http://127.0.0.1:5000',
      '/dissociate': 'http://127.0.0.1:5000',
      '/locations': 'http://127.0.0.1:5000',
      '/test_db': 'http://127.0.0.1:5000'
    }
  }
})

