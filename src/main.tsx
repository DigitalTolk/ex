import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initErrorReporting } from '@/lib/sentry'
import { startLayoutTierTracking } from '@/lib/device'

// Before first render so boot-time crashes (the blank-screen class) are
// captured. No-op unless the server injected a Sentry DSN.
initErrorReporting()

// Stamp the layout-tier classes (mobile/compact/full + device kind) on <html>
// before the first paint so the tier-scoped Tailwind variants apply from the
// very first frame — no mobile-chrome flash on a narrow desktop window.
startLayoutTierTracking()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
