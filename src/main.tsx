import './tracing'
import './console-capture'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { Providers } from './providers'
import { installShareSync } from './lib/share'
import './index.css'

installShareSync()

// iOS Safari only applies :active (the press feedback) when a touch listener exists on the page.
document.addEventListener('touchstart', () => {}, { passive: true })

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
)
