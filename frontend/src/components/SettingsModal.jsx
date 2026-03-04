import React, { useState } from 'react'
import { X, Eye, EyeOff, Save } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'

export default function SettingsModal() {
  const { state, dispatch } = useProject()
  const { settings, project } = state
  const [showKey, setShowKey] = useState(false)
  const [localKey, setLocalKey] = useState(settings.api_key)
  const [localSpecs, setLocalSpecs] = useState({ ...project.system_specs })

  function close() { dispatch({ type: 'TOGGLE_SETTINGS' }) }

  function save() {
    dispatch({ type: 'SET_SETTINGS', payload: { api_key: localKey.trim() } })
    dispatch({ type: 'SET_SYSTEM_SPECS', payload: localSpecs })
    toast.success('Settings saved')
    close()
  }

  function updateSpec(key, val) {
    setLocalSpecs(prev => ({ ...prev, [key]: isNaN(parseFloat(val)) ? val : parseFloat(val) }))
  }

  const SYS_FIELDS = [
    { key: 'bus_voltage', label: 'Bus Voltage (Nominal)', unit: 'V', type: 'number' },
    { key: 'peak_voltage', label: 'Bus Voltage (Peak)', unit: 'V', type: 'number' },
    { key: 'power', label: 'Power', unit: 'W', type: 'number' },
    { key: 'max_phase_current', label: 'Max Phase Current', unit: 'A', type: 'number' },
    { key: 'pwm_freq_hz', label: 'PWM Frequency', unit: 'Hz', type: 'number' },
    { key: 'ambient_temp_c', label: 'Ambient Temperature', unit: '°C', type: 'number' },
    { key: 'gate_drive_voltage', label: 'Gate Drive Voltage', unit: 'V', type: 'number' },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => e.target === e.currentTarget && close()}
    >
      <div
        className="card w-full max-w-2xl max-h-[90vh] overflow-auto flex flex-col"
        style={{ background: 'var(--bg-card)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 p-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <span className="text-xl">⚙️</span>
          <h2 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Settings</h2>
          <button onClick={close} className="ml-auto p-1.5 rounded-lg btn-secondary">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-6">
          {/* API Key */}
          <section>
            <h3 className="font-semibold text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              🔑 Anthropic API Key
            </h3>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  className="input-field font-mono pr-10"
                  placeholder="sk-ant-..."
                  value={localKey}
                  onChange={e => setLocalKey(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer"
                className="underline" style={{ color: 'var(--accent)' }}>console.anthropic.com</a>.
              Key is stored locally in your browser only. Model: <code className="font-mono">claude-haiku-4-5-20251001</code> (~$0.01 per 3 datasheets).
            </p>
          </section>

          {/* System Specs */}
          <section>
            <h3 className="font-semibold text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              ⚡ System Specifications
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {SYS_FIELDS.map(f => (
                <div key={f.key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {f.label}
                    <span className="ml-1" style={{ color: 'var(--text-muted)' }}>[{f.unit}]</span>
                  </label>
                  <input
                    type={f.type}
                    className="input-field font-mono text-sm"
                    value={localSpecs[f.key] ?? ''}
                    onChange={e => updateSpec(f.key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* Theme */}
          <section>
            <h3 className="font-semibold text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              🎨 Theme
            </h3>
            <div className="flex gap-2">
              {['dark', 'light'].map(t => (
                <button
                  key={t}
                  onClick={() => dispatch({ type: 'SET_SETTINGS', payload: { theme: t } })}
                  className={settings.theme === t ? 'btn-primary' : 'btn-secondary'}
                >
                  {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="p-5 border-t flex justify-end gap-2" style={{ borderColor: 'var(--border)' }}>
          <button onClick={close} className="btn-secondary">Cancel</button>
          <button onClick={save} className="btn-primary flex items-center gap-2">
            <Save size={14} /> Save Settings
          </button>
        </div>
      </div>
    </div>
  )
}
