import React from 'react'
import { useProject } from '../context/ProjectContext.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'

const MOTOR_FIELDS = [
  { key: 'type', label: 'Motor Type', type: 'select', options: ['PMSM', 'BLDC', 'ACIM'], note: '' },
  { key: 'max_speed_rpm', label: 'Max Speed', type: 'number', unit: 'RPM', note: '' },
  { key: 'pole_pairs', label: 'Pole Pairs (p)', type: 'number', unit: '', note: 'Electrical = mechanical × pole pairs' },
  { key: 'rph_mohm', label: 'Phase Resistance (Rph)', type: 'number', unit: 'mΩ', note: 'Varies per motor — check datasheet or measure' },
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

  // Derived calculations
  const ke = parseFloat(specs.back_emf_v_per_krpm) || 0
  const kt = parseFloat(specs.kt_nm_per_a) || 0
  const rph = parseFloat(specs.rph_mohm) / 1000 || 0
  const lph = parseFloat(specs.lph_uh) / 1e6 || 0
  const rpm = parseFloat(specs.max_speed_rpm) || 0
  const p = parseFloat(specs.pole_pairs) || 4
  const fsw = state.project.system_specs.pwm_freq_hz
  const imax = state.project.system_specs.max_phase_current

  const we_max = (rpm * p * 2 * Math.PI) / 60
  const vbemf_max = ke * (rpm / 1000)
  const copper_loss_w = imax * imax * rph * 1.5  // 3-phase
  const l_ratio = lph > 0 ? (rph / (2 * Math.PI * (fsw / 10))) / lph : null
  const time_const_ms = rph > 0 ? (lph / rph) * 1000 : null

  return (
    <div className="flex gap-4 h-full">
      {/* Motor form */}
      <div className="flex flex-col gap-4 flex-1">
        {/* Header */}
        <div className="card p-4 flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
            style={{ background: `${config.color}20`, border: `1px solid ${config.color}40` }}>
            🌀
          </div>
          <div>
            <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
              PMSM Motor Parameters
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Manual entry — Rph and Lph vary per motor. Enter values from your motor datasheet or measurements.
            </p>
          </div>
        </div>

        <div className="flex gap-4 flex-1">
          {/* Input form */}
          <div className="card flex-1 overflow-auto">
            <div className="section-header">
              <span>🔧</span>
              <span>Motor Specifications</span>
              <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
                All values mandatory for accurate calculations
              </span>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {MOTOR_FIELDS.map(field => (
                <div key={field.key} className="flex flex-col gap-1">
                  <label className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {field.label}
                    {field.unit && (
                      <span className="ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>
                        [{field.unit}]
                      </span>
                    )}
                  </label>
                  {field.type === 'select' ? (
                    <select
                      className="input-field"
                      value={specs[field.key] || ''}
                      onChange={e => update(field.key, e.target.value)}
                    >
                      {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      type="number"
                      step="any"
                      className="input-field font-mono"
                      value={specs[field.key] || ''}
                      onChange={e => update(field.key, e.target.value)}
                      placeholder="Enter value…"
                    />
                  )}
                  {field.note && (
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{field.note}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Derived values */}
          <div className="w-72 flex-shrink-0 flex flex-col gap-3">
            <div className="card p-3">
              <div className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                📐 Derived Parameters
              </div>
              <div className="flex flex-col gap-2">
                <DerivedRow label="Max Electrical Speed" value={we_max > 0 ? we_max.toFixed(0) : '—'} unit="rad/s" />
                <DerivedRow label="Back-EMF @ Max RPM" value={vbemf_max > 0 ? vbemf_max.toFixed(1) : '—'} unit="V pk" />
                <DerivedRow label="Copper Loss @ Imax" value={copper_loss_w > 0 ? copper_loss_w.toFixed(1) : '—'} unit="W" />
                <DerivedRow label="Phase Time Const" value={time_const_ms ? time_const_ms.toFixed(2) : '—'} unit="ms" />
                <DerivedRow label="L/R Ratio" value={l_ratio ? l_ratio.toFixed(4) : '—'} unit="" />
              </div>
            </div>

            <div className="card p-3">
              <div className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                ⚠️ Design Checks
              </div>
              <div className="flex flex-col gap-1.5 text-xs">
                <Check
                  ok={vbemf_max < state.project.system_specs.bus_voltage * 0.9}
                  text={`Back-EMF (${vbemf_max.toFixed(1)}V) < Bus (${state.project.system_specs.bus_voltage}V)`}
                />
                <Check
                  ok={copper_loss_w < state.project.system_specs.power * 0.05}
                  text={`Copper loss ${copper_loss_w.toFixed(1)}W < 5% of power`}
                />
                <Check
                  ok={!!specs.rph_mohm && !!specs.lph_uh}
                  text="Rph and Lph entered"
                />
                <Check
                  ok={!!specs.pole_pairs}
                  text="Pole pairs specified"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Calculations */}
      <div className="w-80 flex-shrink-0">
        <CalculationsPanel />
      </div>
    </div>
  )
}

function DerivedRow({ label, value, unit }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-mono font-bold" style={{ color: 'var(--accent)' }}>
        {value}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  )
}

function Check({ ok, text }) {
  return (
    <div className="flex items-start gap-1.5">
      <span style={{ color: ok ? 'var(--success)' : 'var(--warning)', flexShrink: 0 }}>
        {ok ? '✓' : '⚠'}
      </span>
      <span style={{ color: ok ? 'var(--text-secondary)' : 'var(--warning)' }}>{text}</span>
    </div>
  )
}
