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
    const parsedParallel = Number.isFinite(parseInt(localSpecs.mosfets_parallel_per_switch, 10))
      ? Math.max(1, Math.min(12, parseInt(localSpecs.mosfets_parallel_per_switch, 10)))
      : Math.max(1, Math.round((localSpecs.num_fets || 6) / 6))

    const syncedSpecs = {
      ...localSpecs,
      mosfets_parallel_per_switch: parsedParallel,
      num_fets: 6 * parsedParallel,
    }

    dispatch({ type: 'SET_SETTINGS', payload: { api_key: localKey.trim() } })
    dispatch({ type: 'SET_SYSTEM_SPECS', payload: syncedSpecs })
    toast.success('Settings saved')
    close()
  }

  function updateSpec(key, val) {
    setLocalSpecs(prev => ({ ...prev, [key]: isNaN(parseFloat(val)) ? val : parseFloat(val) }))
  }

  function updateSpecString(key, val) {
    setLocalSpecs(prev => ({ ...prev, [key]: val }))
  }

  const COOLING_OPTIONS = [
    { value: 'natural',      label: 'Natural Convection',  desc: 'PCB copper only, still air — worst case (40 °C/W)' },
    { value: 'enhanced_pcb', label: 'Enhanced PCB',         desc: 'Copper pours + thermal vias, still air (20 °C/W)' },
    { value: 'forced_air',   label: 'Forced Air',           desc: 'Fan over PCB or heatsink (10 °C/W)' },
    { value: 'heatsink',     label: 'Bolted Heatsink',      desc: 'Heatsink with thermal interface (5 °C/W)' },
    { value: 'custom',       label: 'Custom',               desc: 'Set Rth_SA manually in Design Constants' },
  ]

  const SYS_FIELDS = [
    {
      key: 'bus_voltage',
      label: 'Bus Voltage (Nominal)',
      unit: 'V',
      note: 'DC supply rail voltage. Used for: current sizing, UVP threshold, cap ripple, gate drive ratio.',
    },
    {
      key: 'peak_voltage',
      label: 'Bus Voltage (Peak)',
      unit: 'V',
      note: 'Maximum possible bus voltage including regen overshoot. Used for: OVP trip, TVS selection, MOSFET Vds rating. Must be > Nominal.',
    },
    {
      key: 'power',
      label: 'Output Power',
      unit: 'W',
      note: 'Mechanical output power ≈ V_bus_nominal × I_max_phase (informational — not used in passive sizing calculations directly).',
    },
    {
      key: 'max_phase_current',
      label: 'Max Phase Current (I_max)',
      unit: 'A',
      note: 'Peak phase current at full load. Drives: shunt sizing, capacitor ripple, MOSFET conduction loss, OCP trip threshold.',
    },
    { key: 'pwm_freq_hz',        label: 'PWM Frequency',      unit: 'Hz',  note: 'Switching frequency. Higher = smaller caps/inductors, more switching loss.' },
    { key: 'ambient_temp_c',     label: 'Ambient Temperature', unit: '°C', note: 'Worst-case ambient for thermal calculations.' },
    { key: 'gate_drive_voltage', label: 'Gate Drive Voltage',  unit: 'V',  note: 'Gate driver VCC. Determines Vgs swing and bootstrap capacitor size.' },
  ]

  const parallelPerSwitch = Number.isFinite(parseInt(localSpecs.mosfets_parallel_per_switch, 10))
    ? Math.max(1, Math.min(12, parseInt(localSpecs.mosfets_parallel_per_switch, 10)))
    : Math.max(1, Math.round((localSpecs.num_fets || 6) / 6))
  const totalFetsDerived = 6 * parallelPerSwitch

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
    marginLeft: 5, fontSize: 10, fontWeight: 500,
    color: 'var(--txt-2)', fontFamily: 'var(--font-mono)',
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
          ><X size={15} /></button>
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
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
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
                  {f.note && (
                    <p style={{ fontSize: 10, color: 'var(--txt-4)', margin: '3px 0 0', lineHeight: 1.4 }}>
                      {f.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--txt-3)', lineHeight: 1.5, marginTop: 8 }}>
              MOSFET count is managed from the MOSFET tab parallel configuration.
              {' '}Current: {parallelPerSwitch} per switch, total {totalFetsDerived} devices (fixed 3 limbs, 6 switch positions).
            </p>
          </section>

          {/* ── Cooling Method ── */}
          <section>
            <div style={sectionTitle}>🌡️ Cooling Method</div>
            <select
              className="inp"
              value={localSpecs.cooling || 'natural'}
              onChange={e => updateSpecString('cooling', e.target.value)}
              style={{ width: '100%', marginBottom: 6 }}
            >
              {COOLING_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <p style={{ fontSize: 11, color: 'var(--txt-3)', lineHeight: 1.5, margin: 0 }}>
              {COOLING_OPTIONS.find(o => o.value === (localSpecs.cooling || 'natural'))?.desc}
            </p>
            <p style={{ fontSize: 11, color: 'var(--txt-3)', lineHeight: 1.5, marginTop: 4 }}>
              Sets the PCB-to-ambient thermal resistance (Rth_SA) used in thermal and MOSFET loss calculations.
            </p>
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
                    color: settings.theme === t ? '#fff' : 'var(--txt-2)',
                    border: `1px solid ${settings.theme === t ? 'var(--accent)' : 'var(--border-2)'}`,
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
            <Save size={13} /> Save Settings
          </button>
        </div>

      </div>
    </div>
  )
}
