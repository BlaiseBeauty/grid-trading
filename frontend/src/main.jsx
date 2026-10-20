import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/design-system.css'
import './styles/animations.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary'
import { initTheme } from './lib/theme'
import { registerServiceWorker } from './lib/pwa'

// Apply the saved theme before first paint of React content (index.html also does this inline)
initTheme()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

registerServiceWorker()
