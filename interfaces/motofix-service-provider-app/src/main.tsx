import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'

// Apply the theme before first paint (light is the default) to avoid a dark flash.
// Wrapped: Safari with storage blocked throws on localStorage — must not crash boot.
try {
  const theme = localStorage.getItem('motofix_sp_theme2') || 'light'
  document.documentElement.classList.remove('dark', 'light')
  document.documentElement.classList.add(theme)
} catch { /* storage blocked — html already defaults to class="light" */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
