import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[^/]+\.supabase\.co\/(?:rest|auth|functions)\/v1\//,
            handler: 'NetworkOnly',
          },
        ],
      },
      manifest: {
        name: 'Školní systém', short_name: 'Škola', lang: 'cs', display: 'standalone',
        theme_color: '#165e56', background_color: '#f5f8f7', start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
      }
    })
  ]
})
