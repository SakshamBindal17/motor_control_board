import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5742,
    proxy: {
      '/api': {
        target: 'http://localhost:8472',
        changeOrigin: true,
      },
    },
  },
})
