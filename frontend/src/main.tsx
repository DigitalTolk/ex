import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initErrorReporting } from '@/lib/sentry'

// Before first render so boot-time crashes (the blank-screen class) are
// captured. No-op unless the server injected a Sentry DSN.
initErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
