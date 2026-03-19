import React, { useState } from 'react'
import { X, SlidersHorizontal, RotateCcw, ChevronDown } from 'lucide-react'
import { useProject } from '../context/ProjectContext.jsx'

// Mirrors backend DESIGN_CONSTANTS — kept here to avoid API call, instant modal
const SCHEMA = [
  { cat: 'Thermal', items: [
    { key: 'thermal.rds_derating',  label: 'Rds(on) thermal derating',     unit: 'x',    default: 1.5,  desc: 'Worst-case multiplier at ~100°C junction', step: 0.1 },
    { key: 'thermal.rth_cs',        label: 'TIM resistance (case-to-PCB)', unit: '°C/W', default: 0.5,  desc: 'Thermal interface material resistance', step: 0.1 },
    { key: 'thermal.rth_sa',        label: 'PCB-to-ambient Rth',           unit: '°C/W', default: 20.0, desc: 'Natural convection, no heatsink', step: 1 },
    { key: 'thermal.safe_margin',   label: 'Safe margin threshold',        unit: '°C',   default: 30,   desc: 'Minimum acceptable Tj headroom', step: 5 },
    { key: 'thermal.vias_per_fet',  label: 'Thermal vias per FET',         unit: 'pcs',  default: 16,   desc: '0.3mm vias under thermal pad', step: 1 },
  ]},
  { cat: 'Gate Drive', items: [
    { key: 'gate.rise_time_target', label: 'Rise time target',             unit: 'ns',   default: 40,   desc: 'Default target for Rg_on sizing', step: 5 },
    { key: 'gate.rg_off_ratio',    label: 'Rg_off ratio',                 unit: 'x',    default: 0.47, desc: 'Rg_off as fraction of Rg_on (faster turn-off)', step: 0.05 },
    { key: 'gate.rg_bootstrap',    label: 'Bootstrap series R',           unit: 'Ω',    default: 10.0, desc: 'Limits bootstrap diode charging current', step: 1 },
    { key: 'gate.bootstrap_vf',    label: 'Bootstrap diode Vf',           unit: 'V',    default: 0.5,  desc: 'Assumed Schottky forward voltage drop', step: 0.1 },
  ]},
  { cat: 'Bootstrap', items: [
    { key: 'boot.min_cap',         label: 'Min practical boot cap',       unit: 'nF',   default: 100,  desc: 'Floor for bootstrap capacitor value', step: 10 },
    { key: 'boot.safety_margin',   label: 'Safety margin multiplier',     unit: 'x',    default: 2.0,  desc: 'Applied before E12 snap', step: 0.5 },
    { key: 'boot.leakage_ua',      label: 'Leakage current budget',       unit: 'µA',   default: 3.0,  desc: 'Gate 1µA + driver quiescent 2µA', step: 0.5 },
  ]},
  { cat: 'Input Caps', items: [
    { key: 'input.spwm_mod_index', label: 'SPWM modulation index',        unit: '',     default: 0.9,  desc: '3-phase SPWM approx when Lph unavailable', step: 0.05 },
    { key: 'input.min_bulk_count', label: 'Min bulk cap count',           unit: 'pcs',  default: 4,    desc: 'Minimum parallel caps for ESR distribution', step: 1 },
    { key: 'input.bulk_cap_uf',    label: 'Bulk cap size',                unit: 'µF',   default: 100,  desc: 'Standard electrolytic per-cap value', step: 10 },
    { key: 'input.esr_per_cap',    label: 'Typical ESR per cap',          unit: 'mΩ',   default: 50,   desc: 'Electrolytic ESR estimate for thermal calc', step: 5 },
  ]},
  { cat: 'Protection', items: [
    { key: 'prot.adc_ref',         label: 'ADC reference voltage',        unit: 'V',    default: 3.3,  desc: 'MCU ADC full-scale reference', step: 0.1 },
    { key: 'prot.ovp_margin',      label: 'OVP trip margin',              unit: 'x',    default: 1.03, desc: 'Multiplier above peak bus voltage', step: 0.01 },
    { key: 'prot.uvp_trip',        label: 'UVP trip threshold',           unit: 'x',    default: 0.75, desc: 'Fraction of nominal bus voltage', step: 0.05 },
    { key: 'prot.ocp_hw',          label: 'OCP hardware threshold',       unit: 'x',    default: 1.25, desc: 'Hardware overcurrent trip multiplier', step: 0.05 },
    { key: 'prot.ocp_sw',          label: 'OCP software threshold',       unit: 'x',    default: 1.1,  desc: 'Software overcurrent limit multiplier', step: 0.05 },
    { key: 'prot.otp_warn',        label: 'OTP warning temp',             unit: '°C',   default: 80,   desc: 'Temperature at which to warn user', step: 5 },
    { key: 'prot.otp_shutdown',    label: 'OTP shutdown temp',            unit: '°C',   default: 100,  desc: 'Temperature at which to shut down', step: 5 },
  ]},
  { cat: 'Dead Time', items: [
    { key: 'dt.abs_margin',        label: 'Absolute margin',              unit: 'ns',   default: 20,   desc: 'Fixed safety margin added to minimum DT', step: 5 },
    { key: 'dt.safety_mult',       label: 'Safety multiplier',            unit: 'x',    default: 1.5,  desc: 'Recommended margin over minimum DT', step: 0.1 },
  ]},
  { cat: 'Snubber', items: [
    { key: 'snub.coss_mult',       label: 'Coss multiplier',              unit: 'x',    default: 3,    desc: 'Snubber cap = N × Coss for overdamped response', step: 1 },
    { key: 'snub.stray_l_default', label: 'Default stray inductance',     unit: 'nH',   default: 10,   desc: 'Assumed PCB power loop inductance', step: 1 },
  ]},
  { cat: 'EMI Filter', items: [
    { key: 'emi.cm_choke_uh',      label: 'CM choke inductance',          unit: 'µH',   default: 330,  desc: 'Common-mode choke baseline value', step: 10 },
  ]},
]

export default function DesignConstantsModal() {
  const { state, dispatch } = useProject()
  const dc = state.project.design_constants || {}
  const [open, setOpen] = useState(() => {
    const o = {}
    SCHEMA.forEach(s => { o[s.cat] = true })
    return o
  })

  function close() { dispatch({ type: 'TOGGLE_CONSTANTS' }) }

  function toggle(cat) { setOpen(p => ({ ...p, [cat]: !p[cat] })) }

  function setValue(key, val) {
    dispatch({ type: 'SET_DESIGN_CONSTANT', payload: { key, value: val } })
  }

  function resetOne(key) {
    dispatch({ type: 'SET_DESIGN_CONSTANT', payload: { key, value: null } })
  }

  function resetAll() {
    dispatch({ type: 'RESET_ALL_DESIGN_CONSTANTS' })
  }

  const overrideCount = Object.keys(dc).length

  const sectionTitle = {
    fontSize: 12, fontWeight: 700, color: 'var(--txt-2)',
    textTransform: 'uppercase', letterSpacing: '.06em',
    marginBottom: 2,
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
      }}
      onClick={e => { if (e.target === e.currentTarget) close() }}
    >
      <div style={{
        background: 'var(--bg-2)', border: '1px solid var(--border-2)',
        borderRadius: 12, width: '100%', maxWidth: 720, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--border-1)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <SlidersHorizontal size={18} style={{ color: 'var(--amber)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>Design Constants</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
              Override calculation assumptions — {overrideCount > 0 ? `${overrideCount} modified` : 'all defaults'}
            </div>
          </div>
          <button onClick={close} className="btn btn-ghost btn-icon"><X size={16} /></button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px' }}>
          {SCHEMA.map(section => {
            const isOpen = open[section.cat]
            const modCount = section.items.filter(it => dc[it.key] !== undefined).length
            return (
              <div key={section.cat} style={{ marginBottom: 8 }}>
                {/* Category header */}
                <button
                  className="collapsible-trigger"
                  onClick={() => toggle(section.cat)}
                  style={{
                    width: '100%', background: 'var(--bg-3)', border: 'none',
                    padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8,
                    color: 'var(--txt-2)', fontSize: 12, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '.06em',
                  }}
                >
                  <ChevronDown size={14} style={{
                    transition: 'transform .15s',
                    transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                  }} />
                  <span style={{ flex: 1, textAlign: 'left' }}>{section.cat}</span>
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--txt-3)' }}>
                    {section.items.length} constants
                  </span>
                  {modCount > 0 && (
                    <span style={{
                      background: 'var(--amber)', color: '#000', fontSize: 10,
                      fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                    }}>
                      {modCount} modified
                    </span>
                  )}
                </button>

                {/* Items */}
                {isOpen && (
                  <div style={{ padding: '8px 0 4px 0' }}>
                    {section.items.map(item => {
                      const isModified = dc[item.key] !== undefined
                      const currentVal = isModified ? dc[item.key] : item.default
                      return (
                        <div key={item.key} style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '6px 12px', borderRadius: 5,
                          background: isModified ? 'rgba(255,171,0,0.06)' : 'transparent',
                          marginBottom: 2,
                        }}>
                          {/* Modified dot */}
                          <div style={{
                            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                            background: isModified ? 'var(--amber)' : 'transparent',
                          }} />

                          {/* Label + desc */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 12, fontWeight: 600, color: 'var(--txt-1)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>
                              {item.label}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--txt-3)', lineHeight: 1.3 }}>
                              {item.desc}
                            </div>
                          </div>

                          {/* Input */}
                          <input
                            type="number"
                            className="inp inp-mono"
                            style={{
                              width: 80, padding: '4px 6px', fontSize: 12, textAlign: 'right',
                              borderColor: isModified ? 'var(--amber)' : undefined,
                            }}
                            value={currentVal}
                            step={item.step}
                            onChange={e => {
                              const v = e.target.value
                              if (v === '' || v === item.default.toString()) {
                                resetOne(item.key)
                              } else {
                                setValue(item.key, parseFloat(v))
                              }
                            }}
                            onBlur={e => {
                              const v = parseFloat(e.target.value)
                              if (isNaN(v) || v === item.default) {
                                resetOne(item.key)
                              }
                            }}
                          />

                          {/* Unit */}
                          <span style={{
                            fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)',
                            minWidth: 32, textAlign: 'left',
                          }}>
                            {item.unit}
                          </span>

                          {/* Reset per-row */}
                          {isModified && (
                            <button
                              className="btn btn-ghost btn-icon"
                              style={{ padding: 3, opacity: 0.7 }}
                              data-tip={`Reset to ${item.default}`}
                              onClick={() => resetOne(item.key)}
                            >
                              <RotateCcw size={12} />
                            </button>
                          )}
                          {!isModified && <div style={{ width: 22 }} />}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--border-1)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button
            className="btn btn-ghost"
            onClick={resetAll}
            disabled={overrideCount === 0}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
          >
            <RotateCcw size={13} />
            Reset All to Defaults
          </button>
          <button className="btn btn-primary" onClick={close} style={{ fontSize: 12 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
