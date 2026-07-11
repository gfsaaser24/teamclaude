import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Dock from './Dock'
import ErrorBoundary from './components/ErrorBoundary'

// One renderer bundle, two windows. `?view=dock` selects the edge micro-HUD; the
// default is the full flyout app. The dock window is OS-transparent, so strip the
// opaque body/root background main.css paints and let the glass panel show the
// desktop through it.
const isDock = new URLSearchParams(window.location.search).get('view') === 'dock'
if (isDock) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDock ? (
      <ErrorBoundary name="dock">
        <Dock />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary name="app">
        <App />
      </ErrorBoundary>
    )}
  </StrictMode>
)
