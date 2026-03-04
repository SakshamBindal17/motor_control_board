import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { ProjectProvider } from './context/ProjectContext.jsx'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ProjectProvider>
      <App />
      <Toaster
        position="bottom-right"
        gutter={10}
        toastOptions={{
          duration: 4000,
          style: {
            background: 'var(--bg-3)',
            color: 'var(--txt-1)',
            border: '1px solid var(--border-2)',
            borderRadius: '8px',
            fontSize: '13px',
            fontFamily: 'var(--font-ui)',
            boxShadow: '0 8px 32px rgba(0,0,0,.4)',
          },
          success: { iconTheme: { primary: '#00e676', secondary: '#060b14' } },
          error:   { iconTheme: { primary: '#ff4444', secondary: '#060b14' } },
        }}
      />
    </ProjectProvider>
  </React.StrictMode>
)
