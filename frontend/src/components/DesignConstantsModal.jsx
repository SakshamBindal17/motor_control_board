import React, { useState, useEffect } from 'react'
import { X, SlidersHorizontal, RotateCcw, ChevronDown, LoaderCircle } from 'lucide-react'
import { useProject } from '../context/ProjectContext.jsx'
import { fetchDesignConstants } from '../api.js'

// UI-only metadata (grouping, labels, step sizes, engineering bounds, affects) to merge with backend numeric defaults
const UI_META = {
  'thermal.rds_derating': { cat: 'Thermal',    label: 'Rds(on) thermal derating',   step: 0.1,   min: 1.0,  max: 5.0,    affects: 'MOSFET Losses, Thermal' },
  'thermal.rth_cs':       { cat: 'Thermal',    label: 'TIM resistance (case-to-PCB)',step: 0.1,   min: 0.01, max: 10.0,   affects: 'Thermal' },
  'thermal.rth_sa':       { cat: 'Thermal',    label: 'PCB-to-ambient Rth',          step: 1,     min: 0.5,  max: 100.0,  affects: 'Thermal' },
  'thermal.safe_margin':  { cat: 'Thermal',    label: 'Safe margin threshold',       step: 5,     min: 1,    max: 100,    affects: 'Thermal' },
  'thermal.vias_per_fet': { cat: 'Thermal',    label: 'Thermal vias per FET',        step: 1,     min: 0,    max: 100,    affects: 'Thermal (PCB trace)' },
  'thermal.rds_alpha':    { cat: 'Thermal',    label: 'Rds temp exponent',           step: 0.1,   min: 0.1,  max: 5.0,    affects: 'MOSFET Losses, Thermal' },
  'gate.rise_time_target':{ cat: 'Gate Drive', label: 'Rise time target',            step: 5,     min: 5,    max: 500,    affects: 'Gate Drive (Rg sizing)' },
  'gate.rg_bootstrap':    { cat: 'Gate Drive', label: 'Bootstrap series R',          step: 1,     min: 0.1,  max: 100,    affects: 'Gate Drive, Bootstrap' },
  'gate.bootstrap_vf':    { cat: 'Gate Drive', label: 'Bootstrap diode Vf',          step: 0.1,   min: 0.1,  max: 2.0,    affects: 'Bootstrap' },
  'gate.driver_derating_per_c': { cat: 'Gate Drive', label: 'Driver IO derating',   step: 0.001, min: 0.0,  max: 0.02,   affects: 'Gate Drive, Waveform' },
  'boot.min_cap':         { cat: 'Bootstrap',  label: 'Min practical boot cap',      step: 10,    min: 10,   max: 10000,  affects: 'Bootstrap' },
  'boot.safety_margin':   { cat: 'Bootstrap',  label: 'Safety margin multiplier',    step: 0.5,   min: 1.0,  max: 10.0,   affects: 'Bootstrap' },
  'input.spwm_mod_index': { cat: 'Input Caps', label: 'SPWM modulation index',       step: 0.05,  min: 0.1,  max: 1.0,    affects: 'Input Caps, MOSFET Losses' },
  'input.min_bulk_count': { cat: 'Input Caps', label: 'Min bulk cap count',          step: 1,     min: 1,    max: 64,     affects: 'Input Caps' },
  'input.bulk_cap_uf':    { cat: 'Input Caps', label: 'Bulk cap size',               step: 10,    min: 1,    max: 10000,  affects: 'Input Caps' },
  'input.esr_per_cap':    { cat: 'Input Caps', label: 'Typical ESR per cap',         step: 5,     min: 0.1,  max: 1000,   affects: 'Input Caps' },
  'prot.adc_ref':         { cat: 'Protection', label: 'ADC reference voltage',       step: 0.1,   min: 1.0,  max: 5.0,    affects: 'Protection, Shunts' },
  'prot.ovp_margin':      { cat: 'Protection', label: 'OVP trip margin',             step: 0.01,  min: 1.0,  max: 2.0,    affects: 'Protection (OVP divider)' },
  'prot.uvp_trip':        { cat: 'Protection', label: 'UVP trip threshold',          step: 0.05,  min: 0.3,  max: 0.95,   affects: 'Protection (UVP divider)' },
  'prot.ocp_hw':          { cat: 'Protection', label: 'OCP hardware threshold',      step: 0.05,  min: 1.0,  max: 5.0,    affects: 'Protection (OCP)' },
  'prot.ocp_sw':          { cat: 'Protection', label: 'OCP software threshold',      step: 0.05,  min: 1.0,  max: 3.0,    affects: 'Protection (OCP)' },
  'prot.otp_warn':        { cat: 'Protection', label: 'OTP warning temp',            step: 5,     min: 40,   max: 200,    affects: 'Protection (OTP NTC)' },
  'prot.otp_shutdown':    { cat: 'Protection', label: 'OTP shutdown temp',           step: 5,     min: 50,   max: 250,    affects: 'Protection (OTP NTC)' },
  'dt.abs_margin':        { cat: 'Dead Time',  label: 'Absolute margin',             step: 5,     min: 0,    max: 500,    affects: 'Dead Time' },
  'dt.safety_mult':       { cat: 'Dead Time',  label: 'Safety multiplier',           step: 0.1,   min: 1.0,  max: 5.0,    affects: 'Dead Time' },
  'snub.coss_mult':       { cat: 'Snubber',    label: 'Coss multiplier',             step: 1,     min: 1,    max: 20,     affects: 'Snubber' },
  'snub.ring_q_factor':   { cat: 'Snubber',    label: 'Ring Q factor',               step: 1,     min: 1.0,  max: 50.0,   affects: 'Snubber, Waveform' },
  'emi.cm_choke_uh':      { cat: 'EMI Filter', label: 'CM choke inductance',         step: 10,    min: 1,    max: 10000,  affects: 'EMI Filter' },
  'adc.max_duty_cycle':   { cat: 'ADC Timing', label: 'Max SPWM duty cycle',         step: 0.01,  min: 0.5,  max: 0.99,   affects: 'ADC Timing' },
}

export default function DesignConstantsModal() {
  const { state, dispatch } = useProject()
  const dc = state.project.design_constants || {}
  
  const [schema, setSchema] = useState(null)
  const [open, setOpen] = useState({})

  useEffect(() => {
    fetchDesignConstants().then(data => {
      const grouped = {}
      const catOrder = ['Thermal', 'Gate Drive', 'Bootstrap', 'Input Caps', 'Protection', 'Dead Time', 'Snubber', 'EMI Filter', 'ADC Timing']
      catOrder.forEach(c => grouped[c] = [])
      
      for (const [key, bData] of Object.entries(data)) {
        const uMeta = UI_META[key] || { cat: bData.category, label: key, step: 1 }
        const cat = uMeta.cat || bData.category
        if (!grouped[cat]) grouped[cat] = []
        grouped[cat].push({
          key,
          label: uMeta.label,
          unit: bData.unit,
          default: bData.default,
          desc: bData.description,
          step: uMeta.step,
          min: uMeta.min,
          max: uMeta.max,
          affects: uMeta.affects,
        })
      }
      const finalSchema = Object.keys(grouped).filter(k => grouped[k].length > 0).map(cat => ({
        cat,
        items: grouped[cat]
      }))
      
      setSchema(finalSchema)
      const o = {}
      finalSchema.forEach(s => { o[s.cat] = true })
      setOpen(o)
    }).catch(err => console.error("Failed to fetch design constants", err))
  }, [])

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
          {!schema ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 40, color: 'var(--txt-3)' }}>
              <LoaderCircle size={24} className="spin" style={{ marginBottom: 12, color: 'var(--amber)' }} />
              <div>Loading backend constants...</div>
            </div>
          ) : schema.map(section => {
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

                          {/* Label + desc + affects */}
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
                            {item.affects && (
                              <div style={{ fontSize: 9, color: 'var(--cyan)', marginTop: 2, fontStyle: 'italic' }}>
                                affects: {item.affects}
                              </div>
                            )}
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
                            min={item.min}
                            max={item.max}
                            onChange={e => {
                              const v = e.target.value
                              if (v === '' || v === item.default.toString()) {
                                resetOne(item.key)
                              } else {
                                setValue(item.key, parseFloat(v))
                              }
                            }}
                            onBlur={e => {
                              let v = parseFloat(e.target.value)
                              if (isNaN(v) || v === item.default) { resetOne(item.key); return }
                              if (item.min !== undefined && v < item.min) v = item.min
                              if (item.max !== undefined && v > item.max) v = item.max
                              setValue(item.key, v)
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
