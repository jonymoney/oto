import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OtoApp } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OtoApp />
  </StrictMode>,
)
