import React from 'react'
import { useProject } from '../context/ProjectContext.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'

const MOTOR_FIELDS = [
  { key: 'type', label: 'Motor Type', type: 'select', options: ['PMSM', 'BLDC', 'ACIM'], unit: '', note: '' },
  { key: 'max_speed_rpm', label: 'Max Speed', type: 'number', unit: 'RPM', note: '' },
  { key: 'pole_pairs', label: 'Pole Pairs (p)', type: 'number', unit: '', note: 'Electrical = mechanical × pole pairs' },
  { key: 'rph_mohm', label: 'Phase Resistance (Rph)   [Phase to Neutral]', type: 'number', unit: 'mΩ', note: 'Varies per motor — check datasheet or measure' },
  { key: 'lph_uh', label: 'Phase Inductance (Lph)', type: 'number', unit: 'µH', note: 'Ld/Lq for PMSM (use avg if not salient)' },
  { key: 'kt_nm_per_a', label: 'Torque Constant (Kt)', type: 'number', unit: 'Nm/A', note: 'From motor datasheet' },
  { key: 'rated_torque_nm', label: 'Rated Torque', type: 'number', unit: 'Nm', note: '' },
  { key: 'back_emf_v_per_krpm', label: 'Back-EMF Constant (Ke)', type: 'number', unit: 'V/kRPM', note: 'Line-to-line, peak or RMS (note which)' },
]

export default function MotorForm({ config }) {
  const { state, dispatch } = useProject()
  const specs = state.project.blocks.motor.specs

  function update(key, value) {
    dispatch({ type: 'SET_MOTOR_SPECS', payload: { [key]: value } })
  }

  // Derived live calculations
  const ke = parseFloat(specs.back_emf_v_per_krpm) || 0
  const kt = parseFloat(specs.kt_nm_per_a) || 0
  const rph = parseFloat(specs.rph_mohm) / 1000 || 0
  const lph = parseFloat(specs.lph_uh) / 1e6 || 0
  const rpm = parseFloat(specs.max_speed_rpm) || 0
  const p = parseFloat(specs.pole_pairs) || 4
  const fsw = state.project.system_specs.pwm_freq_hz
  const imax = state.project.system_specs.max_phase_current
  const vbus = state.project.system_specs.bus_voltage

  const we_max = (rpm * p * 2 * Math.PI) / 60
  const vbemf_max = ke * (rpm / 1000)
  const copper_loss_w = imax * imax * rph * 1.5
  const time_const_ms = rph > 0 ? (lph / rph) * 1000 : null

  const sectionTitle = {
    fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
    textTransform: 'uppercase', letterSpacing: '.06em',
    padding: '10px 16px 6px',
    borderBottom: '1px solid var(--border-1)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0 }}>

      {/* ── Left: form ─────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>

        {/* Header card */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${config.color}18`, border: `1px solid ${config.color}35`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>🌀</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>PMSM Motor Parameters</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>
              Manual entry — Rph and Lph vary per motor. Enter values from your motor datasheet or measurements.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, minHeight: 0, flex: 1 }}>

          {/* Input form */}
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
            <div style={sectionTitle}>
              <span>🔧 Motor Specifications</span>
              <span style={{ fontSize: 10, color: 'var(--txt-3)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                All values needed for accurate calculations
              </span>
            </div>

            <div style={{
              padding: 16,
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
              alignContent: 'start',
            }}>
              {MOTOR_FIELDS.map(field => (
                <div key={field.key}>
                  <label style={{
                    display: 'block', fontSize: 11, fontWeight: 600,
                    color: 'var(--txt-2)', marginBottom: 5,
                  }}>
                    {field.label}
                    {field.unit && (
                      <span style={{ marginLeft: 5, fontSize: 10, color: 'var(--txt-2)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                        [{field.unit}]
                      </span>
                    )}
                  </label>

                  {field.type === 'select' ? (
                    <select
                      className="inp"
                      value={specs[field.key] || ''}
                      onChange={e => update(field.key, e.target.value)}
                    >
                      {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      type="number"
                      step="any"
                      className="inp inp-mono"
                      value={specs[field.key] || ''}
                      onChange={e => update(field.key, e.target.value)}
                      placeholder="Enter value…"
                    />
                  )}

                  {field.note && (
                    <div style={{ fontSize: 10, color: 'var(--txt-3)', marginTop: 4, lineHeight: 1.4 }}>
                      {field.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Derived + checks */}
          <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* Derived values */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ ...sectionTitle, fontSize: 10 }}>📐 Derived Parameters</div>
              <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <DerivedRow label="Max Electrical Speed" value={we_max > 0 ? we_max.toFixed(0) : '—'} unit="rad/s" />
                <DerivedRow label="Back-EMF @ Max RPM" value={vbemf_max > 0 ? vbemf_max.toFixed(1) : '—'} unit="V pk" />
                <DerivedRow label="Copper Loss @ Imax" value={copper_loss_w > 0 ? copper_loss_w.toFixed(1) : '—'} unit="W" />
                <DerivedRow label="Phase Time Const" value={time_const_ms ? time_const_ms.toFixed(2) : '—'} unit="ms" />
              </div>
            </div>

            {/* Design checks */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ ...sectionTitle, fontSize: 10 }}>⚠️ Design Checks</div>
              <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <CheckRow
                  ok={vbemf_max > 0 && vbemf_max < vbus * 0.9}
                  warn={vbemf_max === 0}
                  text={`Back-EMF ${vbemf_max > 0 ? vbemf_max.toFixed(1) + 'V' : '?'} < Bus ${vbus}V`}
                />
                <CheckRow
                  ok={copper_loss_w > 0 && copper_loss_w < state.project.system_specs.power * 0.05}
                  warn={copper_loss_w === 0}
                  text={`Copper loss ${copper_loss_w > 0 ? copper_loss_w.toFixed(1) + 'W' : '?'} < 5% power`}
                />
                <CheckRow
                  ok={!!specs.rph_mohm && !!specs.lph_uh}
                  warn={false}
                  text="Rph and Lph entered"
                />
                <CheckRow
                  ok={!!specs.pole_pairs}
                  warn={false}
                  text="Pole pairs specified"
                />
                <CheckRow
                  ok={!!specs.kt_nm_per_a}
                  warn={false}
                  text="Torque constant Kt entered"
                />
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── Right: calculations ─────────────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <CalculationsPanel />
      </div>
    </div>
  )
}

function DerivedRow({ label, value, unit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11, color: 'var(--accent)' }}>
        {value}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  )
}

function CheckRow({ ok, warn, text }) {
  const color = warn ? 'var(--txt-3)' : ok ? 'var(--green)' : 'var(--amber)'
  const icon = warn ? '○' : ok ? '✓' : '⚠'
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <span style={{ color, flexShrink: 0, fontSize: 11, fontWeight: 700 }}>{icon}</span>
      <span style={{ fontSize: 11, color: warn ? 'var(--txt-3)' : ok ? 'var(--txt-2)' : 'var(--amber)', lineHeight: 1.4 }}>
        {text}
      </span>
    </div>
  )
}
