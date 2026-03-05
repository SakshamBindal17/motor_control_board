import React, { useState } from 'react'
import { X, Eye, EyeOff, Save } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'

export default function SettingsModal() {
  const { state, dispatch } = useProject()
  const { settings, project } = state
  const [showKey,    setShowKey]    = useState(false)
  const [localKey,   setLocalKey]   = useState(settings.api_key)
  const [localSpecs, setLocalSpecs] = useState({ ...project.system_specs })

  function close() { dispatch({ type: 'TOGGLE_SETTINGS' }) }

  function save() {
    dispatch({ type: 'SET_SETTINGS',  payload: { api_key: localKey.trim() } })
    dispatch({ type: 'SET_SYSTEM_SPECS', payload: localSpecs })
    toast.success('Settings saved')
    close()
  }

  function updateSpec(key, val) {
    setLocalSpecs(prev => ({ ...prev, [key]: isNaN(parseFloat(val)) ? val : parseFloat(val) }))
  }

  const SYS_FIELDS = [
    { key: 'bus_voltage',        label: 'Bus Voltage (Nominal)',  unit: 'V'  },
    { key: 'peak_voltage',       label: 'Bus Voltage (Peak)',     unit: 'V'  },
    { key: 'power',              label: 'Power',                  unit: 'W'  },
    { key: 'max_phase_current',  label: 'Max Phase Current',      unit: 'A'  },
    { key: 'pwm_freq_hz',        label: 'PWM Frequency',          unit: 'Hz' },
    { key: 'ambient_temp_c',     label: 'Ambient Temperature',    unit: '°C' },
    { key: 'gate_drive_voltage', label: 'Gate Drive Voltage',     unit: 'V'  },
  ]

  // overlay
  const overlay = {
    position: 'fixed', inset: 0, zIndex: 50,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(4px)',
  }

  // modal box — uses --bg-2 which is always a solid opaque colour
  const box = {
    background: 'var(--bg-2)',
    border: '1px solid var(--border-2)',
    borderRadius: 12,
    width: '100%',
    maxWidth: 640,
    maxHeight: '90vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
  }

  const sectionTitle = {
    fontSize: 12, fontWeight: 700, color: 'var(--txt-2)',
    marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.06em',
  }

  const label = {
    fontSize: 11, fontWeight: 600, color: 'var(--txt-2)', marginBottom: 4, display: 'block',
  }

  const unitBadge = {
    marginLeft: 5, fontSize: 10,
    color: 'var(--txt-3)', fontFamily: 'var(--font-mono)',
  }

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && close()}>
      <div style={box}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 20px',
          borderBottom: '1px solid var(--border-1)',
        }}>
          <span style={{ fontSize: 18 }}>⚙️</span>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>Settings</span>
          <button
            onClick={close}
            className="btn btn-ghost btn-icon"
            style={{ marginLeft: 'auto' }}
          ><X size={15}/></button>
        </div>

        <div style={{ padding: '20px 20px 0', display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* ── API Key ── */}
          <section>
            <div style={sectionTitle}>🔑 Anthropic API Key</div>
            <div style={{ position: 'relative' }}>
              <input
                type={showKey ? 'text' : 'password'}
                className="inp inp-mono"
                placeholder="sk-ant-api03-..."
                value={localKey}
                onChange={e => setLocalKey(e.target.value)}
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                style={{
                  position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--txt-3)',
                }}
              >
                {showKey ? <EyeOff size={14}/> : <Eye size={14}/>}
              </button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 6, lineHeight: 1.5 }}>
              Get your key at{' '}
              <a href="https://console.anthropic.com" target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                console.anthropic.com
              </a>.
              {' '}Stored locally in your browser only.{' '}
              Model: <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--cyan)' }}>claude-haiku-4-5-20251001</code>
              {' '}(~$0.01 per 3 datasheets).
            </p>
          </section>

          {/* ── System Specs ── */}
          <section>
            <div style={sectionTitle}>⚡ System Specifications</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {SYS_FIELDS.map(f => (
                <div key={f.key}>
                  <label style={label}>
                    {f.label}
                    <span style={unitBadge}>[{f.unit}]</span>
                  </label>
                  <input
                    type="number"
                    className="inp inp-mono"
                    value={localSpecs[f.key] ?? ''}
                    onChange={e => updateSpec(f.key, e.target.value)}
                    placeholder={String(localSpecs[f.key] ?? '')}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* ── Theme ── */}
          <section>
            <div style={sectionTitle}>🎨 Theme</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {['dark', 'light'].map(t => (
                <button
                  key={t}
                  onClick={() => dispatch({ type: 'SET_SETTINGS', payload: { theme: t } })}
                  className="btn"
                  style={{
                    padding: '6px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: settings.theme === t ? 'var(--accent)' : 'var(--bg-3)',
                    color:      settings.theme === t ? '#fff'          : 'var(--txt-2)',
                    border:     `1px solid ${settings.theme === t ? 'var(--accent)' : 'var(--border-2)'}`,
                    cursor: 'pointer',
                  }}
                >
                  {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
                </button>
              ))}
            </div>
          </section>

        </div>

        {/* ── Footer ── */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '16px 20px',
          marginTop: 20,
          borderTop: '1px solid var(--border-1)',
        }}>
          <button
            onClick={close}
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
          >
            <Save size={13}/> Save Settings
          </button>
        </div>

      </div>
    </div>
  )
}
