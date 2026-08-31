import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles.css'

const hadServiceWorkerController = 'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller)
let reloadingForUpdate = false

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadServiceWorkerController || reloadingForUpdate) return
    reloadingForUpdate = true
    window.location.reload()
  })
}

registerSW({
  immediate: true,
  onRegisteredSW: (_url, registration) => {
    if (!registration) return
    void registration.update()
    window.setInterval(() => void registration.update(), 60 * 60 * 1000)
  },
})
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
