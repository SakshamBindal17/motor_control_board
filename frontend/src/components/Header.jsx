import React, { useState, useRef } from 'react'
import { Settings, Moon, Sun, Save, FolderOpen, FileText, SlidersHorizontal } from 'lucide-react'
import { useProject } from '../context/ProjectContext.jsx'
import toast from 'react-hot-toast'

export default function Header() {
  const { state, dispatch } = useProject()
  const { settings, project } = state
  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(project.name)
  const loadRef = useRef(null)

  const done = ['mcu', 'driver', 'mosfet'].filter(k => project.blocks[k]?.status === 'done').length

  function save() {
    try {
      const exportData = {
        version: 2,
        state: { ...state, settings: { ...state.settings, api_key: '' } }
      }
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project.name.replace(/\s+/g, '_')}_session.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Session saved')
    } catch { toast.error('Save failed') }
  }

  function load() { loadRef.current?.click() }

  function handleLoad(e) {
    const f = e.target.files?.[0]; if (!f) return
    const r = new FileReader()
    r.onload = ev => {
      try {
        dispatch({ type: 'LOAD_PROJECT', payload: JSON.parse(ev.target.result) })
        toast.success('Session loaded')
      } catch { toast.error('Invalid session file') }
    }
    r.readAsText(f)
    e.target.value = ''
  }

  return (
    <header style={{
      height: 52,
      background: 'var(--bg-0)',
      borderBottom: '1px solid var(--border-1)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: 10,
      flexShrink: 0,
      position: 'sticky',
      top: 0,
      zIndex: 30,
    }}>
      {/* Project name */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {editingName ? (
          <input
            className="inp inp-mono"
            style={{ maxWidth: 300, padding: '4px 8px', fontSize: 13 }}
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={() => { setEditingName(false); if (nameVal.trim()) dispatch({ type: 'SET_PROJECT_NAME', payload: nameVal.trim() }) }}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditingName(false) }}
            autoFocus
          />
        ) : (
          <button
            onClick={() => { setEditingName(true); setNameVal(project.name) }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--txt-1)', fontSize: 14, fontWeight: 600,
              fontFamily: 'var(--font-ui)',
              padding: '2px 6px', borderRadius: 5,
              transition: 'background .1s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-3)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
            title="Click to rename"
          >
            {project.name}
          </button>
        )}
      </div>

      {/* Status indicators */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`badge ${done === 3 ? 'badge-done' : 'badge-busy'}`}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{done}/3</span> sheets
        </span>
        {project.calculations && <span className="badge badge-done">Calculated</span>}
        {!settings.api_key && (
          <span
            className="badge badge-error"
            style={{ cursor: 'pointer' }}
            onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
          >
            ⚠ No API key
          </span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 4 }}>
        {[
          { icon: <Save size={15} />, tip: 'Save session', fn: save },
          { icon: <FolderOpen size={15} />, tip: 'Load session', fn: load },
          { icon: <FileText size={15} />, tip: 'Generate report', fn: () => dispatch({ type: 'TOGGLE_REPORT' }) },
          {
            icon: <SlidersHorizontal size={15} />,
            tip: 'Design Constants',
            fn: () => dispatch({ type: 'TOGGLE_CONSTANTS' }),
            highlight: Object.keys(project.design_constants || {}).length > 0,
            highlightColor: 'var(--amber)',
          },
          {
            icon: settings.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />,
            tip: 'Toggle theme',
            fn: () => dispatch({ type: 'SET_SETTINGS', payload: { theme: settings.theme === 'dark' ? 'light' : 'dark' } }),
          },
          {
            icon: <Settings size={15} />,
            tip: 'Settings',
            fn: () => dispatch({ type: 'TOGGLE_SETTINGS' }),
            highlight: !settings.api_key,
          },
        ].map((btn, i) => (
          <button
            key={i}
            onClick={btn.fn}
            className="btn btn-ghost btn-icon"
            data-tip={btn.tip}
            style={btn.highlight ? { borderColor: btn.highlightColor || 'var(--red)', color: btn.highlightColor || 'var(--red)' } : {}}
          >
            {btn.icon}
          </button>
        ))}
      </div>

      <input ref={loadRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoad} />
    </header>
  )
}
