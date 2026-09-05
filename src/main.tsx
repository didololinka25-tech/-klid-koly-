import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import SystemApp from './system/SystemApp'
import './styles.css'

registerSW({
  immediate: true,
  onRegisteredSW: (_url, registration) => {
    if (!registration) return
    void registration.update()
    window.setInterval(() => void registration.update(), 60 * 60 * 1000)
  },
})
createRoot(document.getElementById('root')!).render(<StrictMode><SystemApp /></StrictMode>)
