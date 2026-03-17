import React, { useState, useRef } from 'react'
import { Zap, RefreshCw, ChevronDown, AlertTriangle, Info, Maximize2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'
import { CALC_CRITICAL } from './BlockPanel.jsx'
import { runCalculations } from '../api.js'
import { fmtNum, thresholdClass } from '../utils.js'

// Which calc sections depend on which block being uploaded
const BLOCK_DEPS = {
  driver: ['gate_resistors', 'bootstrap_cap', 'shunt_resistors', 'dead_time', 'driver_compatibility'],
  mcu: ['dead_time', 'adc_timing'],
  motor: ['input_capacitors', 'motor_validation'],
}

// What fallback values the backend uses when a block is missing
const FALLBACK_WARNINGS = {
  driver: 'io_source=1.5A, io_sink=2.5A, prop_delay=60ns, csa_gain=20',
  mcu: 'dt_resolution=8ns',
  motor: 'Bus cap ripple uses SPWM estimate. Enter Lph in Motor tab for accurate C_bulk sizing.',
}

export default function CalculationsPanel() {
  const { state, dispatch } = useProject()
  const { project } = state
  const [loading, setLoading] = useState(false)
  const calcInFlight = useRef(false)
  const [open, setOpen] = useState({ mosfet_losses: true, gate_resistors: true, thermal: true })
  const [lastWarnings, setLastWarnings] = useState([])
  const [showGrid, setShowGrid] = useState(false)

  function toggle(k) { setOpen(p => ({ ...p, [k]: !p[k] })) }

  // Determine which blocks are missing
  const missing = ['driver', 'mcu', 'motor'].filter(b => {
    if (b === 'motor') {
      const s = project.blocks.motor.specs || {}
      return !s.lph_uh && !s.rph_mohm
    }
    return project.blocks[b]?.status !== 'done'
  })

  async function calc() {
    if (calcInFlight.current) return
    if (project.blocks.mosfet.status !== 'done') {
      toast.error('MOSFET datasheet is required — upload it first'); return
    }

    // ── STRICT PRE-FLIGHT CHECK ──────────────────────────────────────
    let missingCritical = []

    // 1. Check System Specs
    const sysReq = ['bus_voltage', 'power', 'max_phase_current', 'pwm_freq_hz']
    for (const k of sysReq) {
      if (project.system_specs[k] === '' || project.system_specs[k] === null || project.system_specs[k] === undefined) {
        missingCritical.push(`System Specs -> ${k.replace(/_/g, ' ')}`)
      }
    }

    // 2. Check Uploaded Blocks for missing Calc-Critical params
    for (const blockKey of ['mosfet', 'driver', 'mcu']) {
      if (project.blocks[blockKey]?.status === 'done' && CALC_CRITICAL[blockKey]) {
        const flatDict = buildParamsDict(project.blocks[blockKey])
        for (const req of CALC_CRITICAL[blockKey]) {
          // Check if the value is missing or strictly an empty string
          if (flatDict[req] === undefined || flatDict[req] === null || flatDict[req] === '') {
            missingCritical.push(`${blockKey.toUpperCase()} -> ${req}`)
          }
        }
      }
    }

    if (missingCritical.length > 0) {
      toast.error(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong>Cannot Calculate! Missing Critical Inputs:</strong>
          <span style={{ fontSize: 11, color: 'var(--red)', opacity: 0.9 }}>{missingCritical.join(', ')}</span>
          <span style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>Please fill these in the panels before running.</span>
        </div>,
        { duration: 6000 }
      )
      return
    }

    // Build warnings for entire missing blocks (fallback usage)
    const warnings = missing.map(b => `${b.toUpperCase()}: ${FALLBACK_WARNINGS[b]}`)
    setLastWarnings(warnings)

    if (warnings.length > 0) {
      toast(`Running with ${warnings.length} fallback(s) — see warning banner`, {
        id: 'c', icon: '⚠️', duration: 4000,
        style: { background: 'var(--bg-3)', color: 'var(--amber)', border: '1px solid var(--amber)' }
      })
    } else {
      toast.loading('Calculating…', { id: 'c' })
    }

    setLoading(true)
    calcInFlight.current = true
    try {
      const result = await runCalculations({
        system_specs: project.system_specs,
        mosfet_params: buildParamsDict(project.blocks.mosfet),
        driver_params: buildParamsDict(project.blocks.driver),
        mcu_params: buildParamsDict(project.blocks.mcu),
        motor_specs: project.blocks.motor.specs || {},
        passives_overrides: project.blocks.passives.overrides || {},
      })
      dispatch({ type: 'SET_CALCULATIONS', payload: result })
      if (warnings.length === 0) toast.success('Done!', { id: 'c' })
    } catch (e) {
      toast.error(e.message, { id: 'c' })
    } finally { setLoading(false); calcInFlight.current = false }
  }

  const C = project.calculations

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="sec-head">
        <Zap size={13} style={{ color: 'var(--amber)' }} />
        Calculations
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>

        {/* ── Data source status strip ─────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
          {[
            { key: 'mosfet', label: 'MOSFET', required: true },
            { key: 'driver', label: 'Driver', required: false },
            { key: 'mcu', label: 'MCU', required: false },
            { key: 'motor', label: 'Motor', required: false },
          ].map(({ key, label, required }) => {
            const done = key === 'motor'
              ? !!(project.blocks.motor.specs?.lph_uh || project.blocks.motor.specs?.rph_mohm)
              : project.blocks[key]?.status === 'done'
            const tooltip = !done && !required ? (FALLBACK_WARNINGS[key] ? `Fallback: ${FALLBACK_WARNINGS[key]}` : '') : ''
            return (
              <div key={key} title={tooltip} style={{
                padding: '4px 6px', borderRadius: 5, textAlign: 'center', fontSize: 10, fontWeight: 600,
                background: done ? 'rgba(0,230,118,.08)' : required ? 'rgba(255,68,68,.08)' : 'rgba(255,171,0,.06)',
                border: `1px solid ${done ? 'rgba(0,230,118,.2)' : required ? 'rgba(255,68,68,.2)' : 'rgba(255,171,0,.2)'}`,
                color: done ? 'var(--green)' : required ? 'var(--red)' : 'var(--amber)',
                cursor: tooltip ? 'help' : 'default',
              }}>
                {done ? '✓' : required ? '✗' : '~'} {label}
              </div>
            )
          })}
        </div>

        {/* ── System specs ─────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 10px', background: 'var(--bg-3)', borderRadius: 7 }}>
          {[
            ['Bus', `${project.system_specs.bus_voltage}V / ${project.system_specs.peak_voltage}V pk`],
            ['Power', `${project.system_specs.power}W`],
            ['I_max', `${project.system_specs.max_phase_current}A`],
            ['fsw', `${project.system_specs.pwm_freq_hz / 1000}kHz`],
          ].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: 'var(--txt-3)' }}>{l}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--txt-2)' }}>{v}</span>
            </div>
          ))}
        </div>

        {/* ── Run button ───────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={calc} disabled={loading} style={{ flex: 1, justifyContent: 'center' }}>
            {loading ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={13} />}
            {loading ? 'Calculating…' : 'Run All Calculations'}
          </button>
          {C && (
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setShowGrid(true)}
              title="Expand Results Grid"
              style={{ border: '1px solid var(--border-2)', background: 'var(--bg-3)' }}
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>

        {/* ── Fallback warning banner (shown after run if blocks missing) ── */}
        {lastWarnings.length > 0 && C && (
          <div style={{
            padding: '7px 10px', borderRadius: 6,
            background: 'rgba(255,171,0,.07)', border: '1px solid rgba(255,171,0,.25)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
              <AlertTriangle size={11} style={{ color: 'var(--amber)', flexShrink: 0 }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--amber)' }}>
                PARTIAL DATA — some results use fallback values
              </span>
            </div>
            {lastWarnings.map((w, i) => (
              <div key={i} style={{ fontSize: 9, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
                · {w}
              </div>
            ))}
          </div>
        )}

        {/* ── Calculation Audit Log ─────────────────────────────────── */}
        {C?.audit_log?.length > 0 && (
          <div style={{
            padding: '8px 10px', borderRadius: 6,
            background: 'var(--bg-3)', border: '1px solid var(--border-2)',
            marginTop: 4
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <Info size={11} style={{ color: 'var(--cyan)', flexShrink: 0 }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)', letterSpacing: '.05em', textTransform: 'uppercase' }}>
                Assumptions & Audit Log
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {Math.max(C.audit_log.length, 0) > 0 && C.audit_log.map((log, i) => (
                <div key={i} style={{ fontSize: 9, color: 'var(--txt-3)', lineHeight: 1.4, display: 'flex', gap: 6 }}>
                  <span style={{ color: 'var(--border-3)' }}>•</span>
                  <span>{log}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Results sections ─────────────────────────────────── */}
        {C && SECTIONS.map(sec => {
          const d = C[sec.key]
          if (!d) return null
          const isOpen = open[sec.key] !== false
          // Which blocks does this section depend on?
          const missingDeps = Object.entries(BLOCK_DEPS)
            .filter(([blk, keys]) => keys.includes(sec.key) && missing.includes(blk))
            .map(([blk]) => blk)
          return (
            <div key={sec.key} style={{ border: `1px solid ${missingDeps.length ? 'rgba(255,171,0,.3)' : 'var(--border-1)'}`, borderRadius: 7, overflow: 'hidden' }}>
              <button
                className={`collapsible-trigger ${isOpen ? 'open' : ''}`}
                onClick={() => toggle(sec.key)}
                style={{ borderRadius: 0 }}
              >
                <span>{sec.icon}</span>
                <span>{sec.label}</span>
                {missingDeps.length > 0 && (
                  <span style={{
                    marginLeft: 4, fontSize: 9, fontWeight: 700, color: 'var(--amber)',
                    background: 'rgba(255,171,0,.12)', padding: '1px 5px', borderRadius: 3,
                  }}>
                    ~{missingDeps.join('+')}
                  </span>
                )}
                <span className="chevron"><ChevronDown size={11} /></span>
              </button>
              {isOpen && (
                <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {sec.key === 'motor_validation' && d.has_motor_data === false && (
                    <div style={{ padding: '8px 0', fontSize: 11, color: 'var(--txt-3)', textAlign: 'center' }}>
                      Enter motor parameters in the Motor tab to see validation checks
                    </div>
                  )}
                  {sec.rows.map(r => {
                    const v = d[r.key]
                    if (v === undefined || v === null) return null
                    if (r.string) {
                      return (
                        <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '5px 0', fontSize: 12, borderTop: '1px solid var(--border-1)' }}>
                          <span style={{ color: 'var(--txt-2)', flexShrink: 0 }}>{r.label}</span>
                          <span style={{ fontSize: 10, color: 'var(--cyan)', fontFamily: 'var(--font-mono)', textAlign: 'right', lineHeight: 1.4, wordBreak: 'break-word', maxWidth: '55%' }}>{v}</span>
                        </div>
                      )
                    }
                    let wrn = r.warn, dng = r.danger
                    if (r.key === 'v_sw_peak_v' && project.system_specs.peak_voltage) wrn = project.system_specs.peak_voltage
                    if (r.key === 'tj_max_rated_c') return null

                    const tc = (wrn !== undefined || dng !== undefined) ? thresholdClass(v, wrn, dng) : ''

                    let tip = r.explain
                    if (tc) {
                      const isMin = dng !== undefined && wrn !== undefined && dng < wrn
                      const limit = tc === 'danger' ? dng : wrn
                      const thrTip = `Value is ${isMin ? 'below' : 'exceeding'} safe limit of ${limit}${r.unit || ''}`
                      tip = tip ? `${thrTip}\n\nFormula: ${tip}` : thrTip
                    }

                    return (
                      <div key={r.key} className="calc-row" data-tip={tip}>
                        <span className="label">{r.label}</span>
                        <span className={`value ${tc}`}>
                          {fmtNum(v, r.dec ?? 3)}{r.unit ? ` ${r.unit}` : ''}
                          {tc === 'danger' && <AlertTriangle size={9} style={{ marginLeft: 3 }} />}
                        </span>
                      </div>
                    )
                  })}
                  {d.warnings?.length > 0 && (
                    <div className="note-box" style={{ marginTop: 6, background: 'rgba(255,68,68,.06)', border: '1px solid rgba(255,68,68,.2)' }}>
                      {d.warnings.map((w, i) => (
                        <div key={i} style={{ fontSize: 10, color: 'var(--red)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                          <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {d.notes && (
                    <div className="note-box blue" style={{ marginTop: 6 }}>
                      {Object.values(d.notes).slice(0, 3).map((n, i) => <div key={i}>· {n}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {!C && (
          <div style={{ textAlign: 'center', padding: '20px 10px', color: 'var(--txt-3)', fontSize: 12 }}>
            Upload MOSFET datasheet then click Run to see results
          </div>
        )}
      </div>

      {/* ── Grid Viewer Modal ─────────────────────────────────── */}
      {showGrid && C && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex' }}>
          <div style={{ flex: 1, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }} onClick={() => setShowGrid(false)} />
          <div style={{
            width: '85%', maxWidth: 1000, background: 'var(--bg-1)',
            borderLeft: '1px solid var(--border-3)',
            boxShadow: '-10px 0 30px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column',
            animation: 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
          }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Zap size={18} style={{ color: 'var(--amber)' }} />
                <h2 style={{ margin: 0, fontSize: 18, color: 'var(--txt-1)' }}>Engineering Calculations Overview</h2>
              </div>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowGrid(false)}><X size={20} /></button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>

              {/* ── Expanded Audit Log ─────────────────────────────────── */}
              {C?.audit_log?.length > 0 && (
                <div style={{
                  padding: '12px 16px', borderRadius: 8,
                  background: 'var(--bg-2)', border: '1px solid var(--border-2)',
                  marginBottom: 20
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <Info size={14} style={{ color: 'var(--cyan)', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)', letterSpacing: '.05em', textTransform: 'uppercase' }}>
                      Assumptions & Audit Log
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {C.audit_log.map((log, i) => (
                      <div key={i} style={{ fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', lineHeight: 1.5, display: 'flex', gap: 6 }}>
                        <span style={{ color: 'var(--border-3)' }}>·</span>
                        <span>{log}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
                {SECTIONS.map(sec => {
                  const d = C[sec.key]
                  if (!d) return null
                  return (
                    <div key={sec.key} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                      <div className="sec-head" style={{ fontSize: 13 }}>
                        <span>{sec.icon}</span> {sec.label}
                      </div>
                      <div style={{ padding: '10px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {sec.rows.map(r => {
                          const v = d[r.key]
                          if (v === undefined || v === null) return null
                          if (r.string) {
                            return (
                              <div key={r.key} className="calc-row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border-1)', borderTop: 'none' }}>
                                <span className="label" style={{ fontSize: 13 }}>{r.label}</span>
                                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--cyan)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-word', fontSize: 12 }}>{v}</span>
                              </div>
                            )
                          }
                          let wrn = r.warn, dng = r.danger
                          if (r.key === 'v_sw_peak_v' && project.system_specs.peak_voltage) wrn = project.system_specs.peak_voltage
                          if (r.key === 'tj_max_rated_c') return null // skip rendering

                          const tc = (wrn !== undefined || dng !== undefined) ? thresholdClass(v, wrn, dng) : ''

                          let tip = r.explain
                          if (tc) {
                            const isMin = dng !== undefined && wrn !== undefined && dng < wrn
                            const limit = tc === 'danger' ? dng : wrn
                            const thrTip = `Value is ${isMin ? 'below' : 'exceeding'} safe limit of ${limit}${r.unit || ''}`
                            tip = tip ? `${thrTip}\n\nFormula: ${tip}` : thrTip
                          }

                          return (
                            <div key={r.key} className="calc-row" data-tip={tip} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-1)', borderTop: 'none' }}>
                              <span className="label" style={{ fontSize: 13 }}>{r.label}</span>
                              <span className={`value ${tc}`} style={{ fontSize: 13, padding: '3px 8px', minWidth: 80 }}>
                                {fmtNum(v, r.dec ?? 3)}{r.unit ? ` ${r.unit}` : ''}
                                {tc === 'danger' && <AlertTriangle size={11} style={{ marginLeft: 4, display: 'inline-block' }} />}
                              </span>
                            </div>
                          )
                        })}
                        {d.warnings?.length > 0 && (
                          <div className="note-box" style={{ marginTop: 8, background: 'rgba(255,68,68,.06)', border: '1px solid rgba(255,68,68,.2)' }}>
                            {d.warnings.map((w, i) => (
                              <div key={i} style={{ fontSize: 11, color: 'var(--red)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                                <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                                <span>{w}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {d.notes && (
                          <div className="note-box blue" style={{ marginTop: 'auto', paddingTop: 10 }}>
                            {Object.values(d.notes).slice(0, 3).map((n, i) => <div key={i}>· {n}</div>)}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const SECTIONS = [
  {
    key: 'mosfet_rating_check', label: 'MOSFET Rating Check', icon: '🛡️',
    rows: [
      { key: 'vds_max_v', label: 'Vds max (rated)', unit: 'V', dec: 1, explain: 'Maximum drain-source voltage from MOSFET datasheet' },
      { key: 'v_peak_v', label: 'V peak (system)', unit: 'V', dec: 1, explain: 'Peak bus voltage from system specs' },
      { key: 'voltage_margin_pct', label: 'Voltage margin', unit: '%', dec: 1, warn: 25, danger: 10, explain: '(Vds_max - V_peak) / Vds_max × 100 — need ≥ 20%' },
      { key: 'id_cont_a', label: 'Id cont (rated)', unit: 'A', dec: 1, explain: 'Continuous drain current rating from MOSFET datasheet' },
      { key: 'i_max_a', label: 'I max (system)', unit: 'A', dec: 1, explain: 'Maximum phase current from system specs' },
      { key: 'current_margin_pct', label: 'Current margin', unit: '%', dec: 1, warn: 30, danger: 10, explain: '(Id_cont - I_max) / Id_cont × 100' },
    ],
  },
  {
    key: 'driver_compatibility', label: 'Driver Compatibility', icon: '🔗',
    rows: [
      { key: 'vcc_min_v', label: 'VCC min', unit: 'V', dec: 1, explain: 'Minimum supply voltage for gate driver IC' },
      { key: 'vcc_max_v', label: 'VCC max', unit: 'V', dec: 1, explain: 'Maximum supply voltage for gate driver IC' },
      { key: 'gate_drive_v', label: 'V_drive (system)', unit: 'V', dec: 1, explain: 'Gate drive voltage from system specs' },
      { key: 'v_bootstrap_v', label: 'V bootstrap', unit: 'V', dec: 2, explain: 'V_drive - diode Vf drop (0.5V Schottky)' },
      { key: 'vbs_uvlo_v', label: 'VBS UVLO', unit: 'V', dec: 2, explain: 'Bootstrap under-voltage lockout threshold' },
      { key: 'bootstrap_margin_v', label: 'Boot margin', unit: 'V', dec: 2, warn: 1, danger: 0, explain: 'V_bootstrap - VBS_UVLO — must be positive' },
      { key: 'vih_v', label: 'Driver VIH', unit: 'V', dec: 2, explain: 'High-level input voltage threshold on driver' },
      { key: 'mcu_voh_v', label: 'MCU output high', unit: 'V', dec: 1, explain: 'MCU output voltage (from VDD range or assumed 3.3V)' },
    ],
  },
  {
    key: 'adc_timing', label: 'ADC Timing', icon: '📊',
    rows: [
      { key: 'pwm_period_us', label: 'PWM period', unit: 'µs', dec: 2, explain: '1 / f_sw' },
      { key: 'sampling_window_us', label: 'Sample window', unit: 'µs', dec: 2, explain: '10% of half-period (center-aligned)' },
      { key: 'adc_rate_msps', label: 'ADC rate', unit: 'MSPS', dec: 2, explain: 'Extracted ADC sample rate from MCU datasheet' },
      { key: 'adc_conversion_us', label: 'Conversion time', unit: 'µs', dec: 3, explain: '1 / ADC_rate — time for one sample' },
      { key: 't_3_channel_us', label: '3-ch total time', unit: 'µs', dec: 3, explain: '3 × conversion time (sequential sampling for 3-shunt)' },
      { key: 'adc_channels', label: 'ADC channels', unit: 'ch', dec: 0, explain: 'Total ADC channels from MCU datasheet' },
      { key: 'channels_needed', label: 'Channels needed', unit: 'ch', dec: 0, explain: '3 current + bus V + 2 NTC + 1 BEMF = 7 min' },
    ],
  },
  {
    key: 'motor_validation', label: 'Motor Checks', icon: '🌀',
    rows: [
      { key: 'f_electrical_hz', label: 'f_electrical', unit: 'Hz', dec: 1, explain: 'RPM × pole_pairs / 60' },
      { key: 'fsw_to_fe_ratio', label: 'f_sw / f_e ratio', unit: '×', dec: 1, warn: 15, danger: 10, explain: 'PWM freq ÷ electrical freq — must be ≥ 10× for FOC/SPWM' },
      { key: 'v_bemf_peak_v', label: 'Back-EMF peak', unit: 'V', dec: 1, explain: 'Ke × (RPM / 1000)' },
      { key: 'bemf_margin_pct', label: 'V_bus headroom', unit: '%', dec: 1, warn: 15, danger: 0, explain: '(V_bus - V_BEMF) / V_bus × 100 — negative means MOSFET overvoltage risk' },
      { key: 'i_rated_from_kt_a', label: 'I rated (from Kt)', unit: 'A', dec: 1, explain: 'Rated_Torque / Kt — current needed for rated torque' },
      { key: 'copper_loss_3ph_w', label: 'Copper loss (3ph)', unit: 'W', dec: 1, explain: '3 × I_rms² × Rph — winding heat at rated current' },
      { key: 'copper_loss_pct', label: 'Copper loss %', unit: '%', dec: 1, warn: 3, danger: 5, explain: 'Copper loss as percentage of rated power' },
      { key: 'phase_time_const_ms', label: 'L/R time const', unit: 'ms', dec: 2, explain: 'Lph / Rph — electrical time constant of motor winding' },
    ],
  },
  {
    key: 'mosfet_losses', label: 'MOSFET Losses', icon: '🔥',
    rows: [
      { key: 'conduction_loss_per_fet_w', label: 'Cond. Loss / FET', unit: 'W', dec: 3, explain: 'I_rms² × (R_ds_on × 1.5 temp derating)' },
      { key: 'switching_loss_per_fet_w', label: 'SW Loss / FET', unit: 'W', dec: 3, explain: '0.5 × V_peak × I_max × (tr + tf) × fsw  +  Qg × V_drv × fsw' },
      { key: 'recovery_loss_per_fet_w', label: 'Recovery Loss / FET', unit: 'W', dec: 3, explain: 'Qrr × V_peak × fsw' },
      { key: 'total_loss_per_fet_w', label: 'Total / FET', unit: 'W', dec: 3, warn: 8, danger: 15, explain: 'P_cond + P_sw + P_rr' },
      { key: 'total_all_6_fets_w', label: 'Total (×6 FETs)', unit: 'W', dec: 1, warn: 40, danger: 60, explain: 'Total per FET × 6' },
      { key: 'efficiency_mosfet_pct', label: 'Efficiency', unit: '%', dec: 2, explain: '100 × (P_out) / (P_out + Total_Loss)' },
    ],
  },
  {
    key: 'gate_resistors', label: 'Gate Drive', icon: '⚡',
    rows: [
      { key: 'rg_on_recommended_ohm', label: 'Rg ON', unit: 'Ω', dec: 2, explain: 'MAX( (V_drv - V_th)/I_source,  (V_drv - V_th)/(Qg/t_rise_target) ) - R_g_internal' },
      { key: 'rg_off_recommended_ohm', label: 'Rg OFF', unit: 'Ω', dec: 2, explain: 'MAX( V_drv/I_sink, Rg_on/2 ) - R_g_internal' },
      { key: 'rg_bootstrap_ohm', label: 'Rg Bootstrap', unit: 'Ω', dec: 0, explain: 'Hardcoded standard value (10Ω) to limit peak charging current' },
      { key: 'gate_rise_time_ns', label: 'Rise time', unit: 'ns', dec: 1, explain: 'Q_g / ( (V_drv - V_th) / Rg_on_total )' },
      { key: 'gate_fall_time_ns', label: 'Fall time', unit: 'ns', dec: 1, explain: 'Q_g / ( V_drv / Rg_off_total )' },
      { key: 'dv_dt_v_per_us', label: 'dV/dt', unit: 'V/µs', dec: 1, explain: 'V_peak / t_rise_actual' },
    ],
  },
  {
    key: 'thermal', label: 'Thermal', icon: '🌡️',
    rows: [
      { key: 't_junction_est_c', label: 'Tj estimated', unit: '°C', dec: 1, warn: 130, danger: 155, explain: 'T_ambient + (P_fet × (R_thJC + R_thCS + R_thSA))' },
      { key: 'tj_max_rated_c', label: 'Tj max rated', unit: '°C', dec: 0, explain: 'Absolute maximum junction temp from MOSFET datasheet' },
      { key: 'thermal_margin_c', label: 'Thermal margin', unit: '°C', dec: 1, warn: 30, danger: 0, explain: 'Tj_max_rated - Tj_estimated' },
      { key: 'p_per_fet_w', label: 'P / FET', unit: 'W', dec: 3, explain: 'Total power dissipation per individual switch' },
      { key: 'copper_area_per_fet_mm2', label: 'Cu area / FET', unit: 'mm²', dec: 0, explain: 'IPC-2152 estimate for required 3oz copper area to maintain steady state' },
    ],
  },
  {
    key: 'input_capacitors', label: 'Bus Capacitors', icon: '🔋',
    rows: [
      { key: 'ripple_method', label: 'Method', string: true, explain: 'Exact (using L_ph) vs Estimated (3-Phase SPWM factor M=0.9)' },
      { key: 'i_ripple_rms_a', label: 'Ripple current', unit: 'A', dec: 2, explain: 'RMS bus ripple current drawn by the inverter switching' },
      { key: 'c_bulk_required_uf', label: 'C required', unit: 'µF', dec: 1, explain: 'I_ripple_rms / (8 × f_sw × dV_target)' },
      { key: 'n_bulk_caps', label: 'Cap count', unit: 'pcs', dec: 0, explain: 'C_bulk_required / 100uF (minimum of 4 to split ESR heating)' },
      { key: 'c_total_uf', label: 'C total', unit: 'µF', dec: 0, explain: 'Total physical capacitance installed in the bank' },
      { key: 'v_ripple_actual_v', label: 'Actual ripple', unit: 'V', dec: 3, explain: 'Actual voltage droop based on C_total selected' },
      { key: 'esr_budget_per_cap_mohm', label: 'ESR/cap budget', unit: 'mΩ', dec: 1, explain: 'Maximum allowed ESR per capacitor to not exceed 105°C thermal bounds' },
    ],
  },
  {
    key: 'bootstrap_cap', label: 'Bootstrap', icon: '🔄',
    rows: [
      { key: 'c_boot_calculated_nf', label: 'C_boot required', unit: 'nF', dec: 1, explain: '(Q_g + I_leakage×t_on) / dV_boot_droop' },
      { key: 'c_boot_recommended_nf', label: 'C_boot standard', unit: 'nF', dec: 0, explain: 'Calculated requirement buffered by 2x safety margin and snapped to E12 series' },
      { key: 'v_bootstrap_v', label: 'V_bootstrap', unit: 'V', dec: 2, explain: 'V_drive - V_diode_drop' },
      { key: 'min_hs_on_time_ns', label: 'Min on-time', unit: 'ns', dec: 0, explain: '3 × R_boot × C_boot (time required to recharge bootstrap capacitor to ~95%)' },
    ],
  },
  {
    key: 'dead_time', label: 'Dead Time', icon: '⏱️',
    rows: [
      { key: 'dt_minimum_ns', label: 'Minimum DT', unit: 'ns', dec: 0, explain: 't_off_delay + t_fall + t_prop_delay + 20ns baseline margin' },
      { key: 'dt_recommended_ns', label: 'Recommended DT', unit: 'ns', dec: 0, explain: 'Minimum DT × 1.5x safety multiplier, snapped to MCU timer resolution' },
      { key: 'dt_actual_ns', label: 'Actual (MCU)', unit: 'ns', dec: 0, explain: 'Final physical dead time pushed to the timer registers' },
      { key: 'dt_pct_of_period', label: 'DT %', unit: '%', dec: 3, explain: 'Percentage of the PWM period consumed by dead-time (limits max duty cycle)' },
    ],
  },
  {
    key: 'snubber', label: 'RC Snubber', icon: '📡',
    rows: [
      { key: 'voltage_overshoot_v', label: 'V overshoot', unit: 'V', dec: 1, warn: 10, danger: 20, explain: 'I_max × √(L_stray / C_oss)' },
      { key: 'v_sw_peak_v', label: 'V_sw peak', unit: 'V', dec: 1, warn: 60, danger: 80, explain: 'V_bus_peak + Voltage Overshoot (must not exceed MOSFET V_ds_max)' },
      { key: 'rs_recommended_ohm', label: 'Rs snubber', unit: 'Ω', dec: 0, explain: 'Critical Damping: √(L_stray / C_oss) snapped to E24 series' },
      { key: 'cs_recommended_pf', label: 'Cs snubber', unit: 'pF', dec: 0, explain: 'Capacitance required to damp oscillation: 3 × C_oss' },
      { key: 'p_total_6_snubbers_w', label: 'Snubber power', unit: 'W', dec: 3, explain: '6 × (0.5 × C_s × V_peak² × f_sw)' },
    ],
  },
]
