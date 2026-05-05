import React, { useState, useRef, useMemo } from 'react'
import { Zap, RefreshCw, ChevronDown, AlertTriangle, Maximize2, X, Eye, Pencil, CornerDownLeft, ArrowRight, ArrowDownRight, Check, Shield, Clock, Activity } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'
import { CALC_CRITICAL } from './BlockPanel.jsx'
import { runCalculations, runReverseCalculation } from '../api.js'
import { fmtNum, thresholdClass } from '../utils.js'

// Which calc sections depend on which block being uploaded
const BLOCK_DEPS = {
  driver: ['gate_resistors', 'bootstrap_cap', 'shunt_resistors', 'dead_time', 'driver_compatibility', 'cross_validation'],
  mcu: ['dead_time', 'adc_timing', 'cross_validation'],
  motor: ['input_capacitors', 'motor_validation'],
}

// What fallback values the backend uses when a block is missing
const FALLBACK_WARNINGS = {
  driver: 'io_source=1.5A, io_sink=2.5A, prop_delay=60ns, csa_gain=20',
  mcu: 'dt_resolution=8ns',
  motor: 'Bus cap ripple uses SPWM estimate. Enter Lph in Motor tab for accurate C_bulk sizing.',
}

// ── Reverse calculation: which output keys are invertible ─────────────────
const REVERSIBLE_KEYS = new Set([
  'gate_rise_time_ns', 'gate_fall_time_ns', 'dv_dt_v_per_us',
  'c_boot_recommended_nf', 'min_hs_on_time_ns',
  'dt_pct_of_period', 'dt_actual_ns',
  'voltage_overshoot_v', 'p_total_all_snubbers_w', 'p_total_6_snubbers_w',
])

const REVERSE_IMPACT_MAP = {
  gate_rise_time_ns: [
    'Gate Drive: Rg ON, gate rise time, dV/dt',
    'MOSFET Losses: switching loss, total loss, efficiency',
    'Thermal: Tj estimate and thermal margin',
  ],
  gate_fall_time_ns: [
    'Gate Drive: Rg OFF, gate fall time',
    'MOSFET Losses: switching/overlap behavior and total loss',
    'Thermal: Tj estimate and thermal margin',
  ],
  dv_dt_v_per_us: [
    'Gate Drive: Rg ON and rise-time-derived behavior',
    'Switching profile: EMI tendency and switching losses',
    'Thermal: total loss and junction temperature',
  ],
  c_boot_recommended_nf: [
    'Bootstrap: C_boot, min on-time, hold time, droop',
    'Driver Compatibility: UVLO margin against gate minimum voltage',
  ],
  min_hs_on_time_ns: [
    'Bootstrap: required C_boot and applied droop target',
    'Bootstrap refresh/hold behavior across PWM operation',
    'Driver Compatibility: UVLO safety margin',
  ],
  dt_pct_of_period: [
    'Dead Time: dt_actual_ns, register count, duty loss',
    'MOSFET Losses: dead-time body-diode loss component',
    'Cross Validation: dead-time compatibility checks',
  ],
  dt_actual_ns: [
    'Dead Time: dt_pct_of_period and register quantization',
    'MOSFET Losses: dead-time body-diode loss component',
    'Cross Validation: MCU dead-time feasibility checks',
  ],
  voltage_overshoot_v: [
    'Snubber: Cs and Rs recommendations',
    'Snubber: switch-node peak voltage and dissipation',
    'Cross Validation: Vds headroom with ringing',
  ],
  p_total_all_snubbers_w: [
    'Snubber: Cs sizing and snubber thermal dissipation',
    'Snubber: overshoot/peak-voltage behavior',
  ],
  p_total_6_snubbers_w: [
    'Snubber: Cs sizing and snubber thermal dissipation',
    'Snubber: overshoot/peak-voltage behavior',
  ],
}

// ── Bootstrap what-if: keys that get the enhanced downstream card ─────────
const BOOTSTRAP_WHATIF_KEYS = new Set(['min_hs_on_time_ns', 'c_boot_recommended_nf'])

function uvloDataBadgeInfo(status) {
  if (status === 'verified') {
    return {
      label: 'UVLO DATA: VERIFIED',
      cls: 'ok',
      note: 'Driver bootstrap UVLO extraction is present and plausible.',
    }
  }
  if (status === 'suspicious') {
    return {
      label: 'UVLO DATA: SUSPICIOUS',
      cls: 'bad',
      note: 'Extracted UVLO value looks implausible. Re-check datasheet mapping/units.',
    }
  }
  return {
    label: 'UVLO DATA: UNVERIFIED',
    cls: 'warn',
    note: 'Bootstrap UVLO was not extracted. Margin decision is not trusted yet.',
  }
}

// Maps section keys to friendly labels for the transparency panel
const SECTION_LABELS = {}
// Will be populated from SECTIONS after definition

export default function CalculationsPanel() {
  const { state, dispatch } = useProject()
  const { project } = state
  const [loading, setLoading] = useState(false)
  const calcInFlight = useRef(false)
  const [open, setOpen] = useState({ mosfet_losses: true, gate_resistors: true, thermal: true })
  const [lastWarnings, setLastWarnings] = useState([])
  const [showGrid, setShowGrid] = useState(false)
  const [showTransparency, setShowTransparency] = useState(false)
  const [expandedTransMods, setExpandedTransMods] = useState({})
  const [reverseEditing, setReverseEditing] = useState({}) // { key: value_string }
  const [reverseResults, setReverseResults] = useState({}) // { key: result_object }
  const [reverseLoading, setReverseLoading] = useState({}) // { key: bool }

  function toggle(k) { setOpen(p => ({ ...p, [k]: !p[k] })) }
  function toggleTransMod(k) { setExpandedTransMods(p => ({ ...p, [k]: !p[k] })) }

  function startReverseEdit(key) {
    const impacts = REVERSE_IMPACT_MAP[key] || [
      'This target is linked to multiple calculation outputs.',
      'Running solve/apply can update section values and warnings.',
    ]
    const impactLines = impacts.map((line, i) => `${i + 1}. ${line}`).join('\n')
    const ok = window.confirm(
      `Editing this target can change multiple results.\n\nAffected outputs:\n${impactLines}\n\nDo you want to continue?`
    )
    if (!ok) return
    setReverseEditing(p => ({ ...p, [key]: '' }))
  }

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
          // Exception: If we have avalanche_energy, we can estimate avalanche_current. So it's not strictly blocking.
          if (req === 'avalanche_current') {
            const hasEnergy = flatDict['avalanche_energy'] !== undefined && flatDict['avalanche_energy'] !== null && flatDict['avalanche_energy'] !== ''
            const hasCurrent = flatDict[req] !== undefined && flatDict[req] !== null && flatDict[req] !== ''
            if (!hasEnergy && !hasCurrent) {
               missingCritical.push(`${blockKey.toUpperCase()} -> avalanche_energy OR avalanche_current`)
            }
            continue // Handled by the conditional above, or it's implicitly fine if energy exists
          }
          if (req === 'avalanche_energy') continue // Handled by the 'avalanche_current' check above safely

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
          <span style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>Go to the relevant tab → scroll to "Missing / Not Extracted" → enter values manually.</span>
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
      const basePayload = {
        system_specs: project.system_specs,
        driver_params: buildParamsDict(project.blocks.driver),
        mcu_params: buildParamsDict(project.blocks.mcu),
        motor_specs: project.blocks.motor.specs || {},
        passives_overrides: project.blocks.passives.overrides || {},
        design_constants: project.design_constants || {},
        pcb_trace_thermal_params: {
          common: project.pcb_trace_thermal?.common || {},
          sections: project.pcb_trace_thermal?.sections || [],
        },
      }

      // Run primary MOSFET calculation
      const result = await runCalculations({
        ...basePayload,
        mosfet_params: buildParamsDict(project.blocks.mosfet),
      })
      dispatch({ type: 'SET_CALCULATIONS', payload: result })

      // Legacy compare sidebar flow removed: dedicated Compare tab handles analyzer + selection.
      dispatch({ type: 'SET_COMPARISON_RESULTS', payload: null })

      if (warnings.length === 0) toast.success('Done!', { id: 'c' })
    } catch (e) {
      toast.error(e.message, { id: 'c' })
    } finally { setLoading(false); calcInFlight.current = false }
  }

  // Reverse calculation solver
  async function solveReverse(key) {
    const targetVal = reverseEditing[key]
    if (targetVal === '' || targetVal === undefined) return
    setReverseLoading(p => ({ ...p, [key]: true }))
    try {
      const result = await runReverseCalculation({
        system_specs: project.system_specs,
        mosfet_params: buildParamsDict(project.blocks.mosfet),
        driver_params: buildParamsDict(project.blocks.driver),
        mcu_params: buildParamsDict(project.blocks.mcu),
        motor_specs: project.blocks.motor.specs || {},
        passives_overrides: project.blocks.passives.overrides || {},
        design_constants: project.design_constants || {},
        targets: { [key]: parseFloat(targetVal) },
      })
      if (result[key]) {
        setReverseResults(p => ({ ...p, [key]: result[key] }))
      }
    } catch (e) {
      toast.error(`Reverse calc failed: ${e.message}`)
    } finally {
      setReverseLoading(p => ({ ...p, [key]: false }))
    }
  }

  // Apply bootstrap what-if result: set override and re-run calculations
  async function applyBootstrapWhatIf(revResult) {
    if (!revResult?.downstream) return
    const targetKey = revResult.target_key
    const proceed = window.confirm(
      'Applying this bootstrap solve will recalculate dependent outputs:\n\n'
      + '1. Bootstrap: C_boot, min on-time, hold time, droop\n'
      + '2. Driver compatibility: UVLO margin and safety state\n'
      + '3. Any section using updated passives overrides\n\n'
      + 'Do you want to apply and re-run calculations?'
    )
    if (!proceed) return

    // Use backend-provided apply override when available so forward calc reproduces the solved C_boot.
    const newDroop = revResult.apply_bootstrap_droop_v ?? revResult.downstream.droop_v
    if (newDroop && newDroop > 0) {
      dispatch({ type: 'SET_PASSIVES_OVERRIDE', payload: { key: 'bootstrap_droop_v', value: newDroop } })
    }
    // Clear the reverse editing state
    setReverseEditing(p => { const n = { ...p }; delete n[targetKey]; return n })
    setReverseResults(p => { const n = { ...p }; delete n[targetKey]; return n })
    // Toast feedback
    toast.success(`Bootstrap override applied (droop=${newDroop}V). Re-running calculations…`, { duration: 3000 })
    // Trigger re-run
    setTimeout(() => calc(), 150)
  }

  const C = project.calculations
  const T = C?.transparency

  // Get _meta for a section
  function getMeta(secKey) {
    const d = C?.[secKey]
    return d?._meta || null
  }

  // Build tooltip for a row including formula + assumptions
  function buildRowTip(r, tc, secKey) {
    const meta = getMeta(secKey)
    const d = C?.[secKey]
    let parts = []

    if (r.full) {
      parts.push(`📖 ${r.full}`)
      parts.push(``)
    }

    // Row label + computed value
    const v = d?.[r.key]
    if (v !== undefined && v !== null && !r.string) {
      parts.push(`${r.label}  =  ${fmtNum(v, r.dec ?? 3)}${r.unit ? ' ' + r.unit : ''}`)
    }

    // Formula / explanation
    if (r.explain) {
      parts.push(``)
      parts.push(`Calculation:  ${r.explain}`)
    }

    // Threshold warning
    if (tc) {
      const wrn = r.warn, dng = r.danger
      const isMin = dng !== undefined && wrn !== undefined && dng < wrn
      const limit = tc === 'danger' ? dng : wrn
      parts.push(``)
      parts.push(`⚠ ${isMin ? 'Below' : 'Exceeds'} safe limit of ${limit}${r.unit || ''}`)
    }

    // Hardcoded/fallback assumptions used in this module
    if (meta) {
      const hc = meta.hardcoded || []
      const fb = meta.fallbacks || []
      if (hc.length > 0 || fb.length > 0) {
        parts.push(``)
        parts.push(`── Assumptions ──`)
        for (const h of hc) {
          parts.push(`  HC  ${h.name} = ${h.value}`)
        }
        for (const f of fb) {
          parts.push(`  FB  ${f.param} = ${f.value}  (${f.block})`)
        }
      }
    }

    return parts.length > 0 ? parts.join('\n') : undefined
  }

  // Render the transparency summary section
  function renderTransparency() {
    if (!T) return null
    const { total_hardcoded: thc, total_fallbacks: tfb, by_module } = T
    if (thc === 0 && tfb === 0) return null
    const mods = Object.entries(by_module).filter(([, m]) =>
      (m.hardcoded?.length > 0 || m.fallbacks?.length > 0)
    )

    return (
      <div className="transparency-panel">
        <button
          className="transparency-header"
          onClick={() => setShowTransparency(p => !p)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Eye size={12} className="transparency-icon" />
            <span className="transparency-title">Calculation Transparency</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="transparency-count">
              <span className="trans-hc-count">{thc} HC</span>
              <span className="trans-sep">·</span>
              <span className="trans-fb-count">{tfb} FB</span>
            </span>
            <ChevronDown size={11} style={{ transform: showTransparency ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
          </div>
        </button>

        {showTransparency && (
          <div className="transparency-body">
            <div className="transparency-legend">
              <span><span className="trans-dot trans-dot-hc" /> Hardcoded constant</span>
              <span><span className="trans-dot trans-dot-fb" /> Fallback value</span>
            </div>
            {mods.map(([modKey, meta]) => {
              const hc = meta.hardcoded || []
              const fb = meta.fallbacks || []
              const label = SECTION_LABELS[modKey] || modKey.replace(/_/g, ' ')
              const isExpanded = expandedTransMods[modKey]

              return (
                <div key={modKey} className="transparency-module">
                  <button className="transparency-mod-trigger" onClick={() => toggleTransMod(modKey)}>
                    <span className="transparency-mod-label">{label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {hc.length > 0 && <span className="trans-badge trans-badge-hc">{hc.length} HC</span>}
                      {fb.length > 0 && <span className="trans-badge trans-badge-fb">{fb.length} FB</span>}
                      <ChevronDown size={10} style={{ color: 'var(--txt-3)', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="transparency-mod-body">
                      {hc.map((h, i) => (
                        <div key={`hc-${i}`} className="trans-entry trans-entry-hc" data-tip={`${h.name} = ${h.value}\n${h.reason}`}>
                          <span className="trans-dot trans-dot-hc" />
                          <span className="trans-entry-name">{h.name}</span>
                          <span className="trans-entry-eq">=</span>
                          <span className="trans-entry-value">{h.value}</span>
                          <span className="trans-entry-reason">{h.reason}</span>
                        </div>
                      ))}
                      {fb.map((f, i) => (
                        <div key={`fb-${i}`} className="trans-entry trans-entry-fb" data-tip={`${f.param} = ${f.value}\nMissing from ${f.block} datasheet — using fallback default`}>
                          <span className="trans-dot trans-dot-fb" />
                          <span className="trans-entry-name">{f.param}</span>
                          <span className="trans-entry-eq">=</span>
                          <span className="trans-entry-value">{f.value}</span>
                          <span className="trans-entry-reason">Missing from {f.block}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // Render section meta badge (HC/FB counts)
  function renderMetaBadge(secKey) {
    const meta = getMeta(secKey)
    if (!meta) return null
    const hc = meta.hardcoded?.length || 0
    const fb = meta.fallbacks?.length || 0
    if (hc === 0 && fb === 0) return null

    const fbTip = fb > 0
      ? (meta.fallbacks || []).map(f => f.message || `${f.param} fallback ${f.value}`).join('\n')
      : ''

    return (
      <span className="section-meta-badge" title={`${hc} hardcoded constants, ${fb} fallback values used${fbTip ? '\n' + fbTip : ''}`}>
        {hc > 0 && <span className="smb-hc">{hc} HC</span>}
        {hc > 0 && fb > 0 && <span className="smb-sep">·</span>}
        {fb > 0 && (
          <span style={{
            fontSize: 9, fontWeight: 700, color: 'var(--amber)',
            background: 'rgba(255,171,0,.18)', padding: '1px 6px', borderRadius: 3,
          }}>
            ⚠ {fb} FB
          </span>
        )}
      </span>
    )
  }

  // Check if a row's section has any HC/FB (for dot indicator)
  function getRowIndicator(secKey) {
    const meta = getMeta(secKey)
    if (!meta) return null
    const hc = meta.hardcoded?.length || 0
    const fb = meta.fallbacks?.length || 0
    if (fb > 0) return 'fb'
    if (hc > 0) return 'hc'
    return null
  }

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

        {/* ── Stale results warning ── */}
        {project.calcs_stale && C && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
            background: 'rgba(255,171,0,0.12)', border: '1px solid var(--amber)',
            borderRadius: 6, fontSize: 11, color: 'var(--amber)',
          }}>
            <AlertTriangle size={13} />
            <span>Parameters changed since last run — click <b>Run All Calculations</b> to update results</span>
          </div>
        )}

        {/* ── Run button ───────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={calc} disabled={loading} style={{
            flex: 1, justifyContent: 'center',
            ...(project.calcs_stale && C ? { animation: 'pulse-border 2s ease-in-out infinite' } : {}),
          }}>
            {loading ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={13} />}
            {loading ? 'Calculating…' : project.calcs_stale && C ? '⟳ Re-run Calculations' : 'Run All Calculations'}
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

        {C && (
          <div className="calc-edit-hint">
            <span className="calc-edit-hint-icon"><Pencil size={10} /></span>
            <span>
              Editable targets are marked with a pencil. Click <strong>Edit target</strong> on a row to set your desired value and solve required design parameters.
            </span>
          </div>
        )}

        {/* ── Transparency Panel (below run button) ───────────── */}
        {C && renderTransparency()}

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

        {/* ── Cross-Datasheet Validation ──────────────────────── */}
        {C?.cross_validation && (() => {
          const cv = C.cross_validation
          const sm = cv.summary || {}
          const isOpen = open.cross_validation !== false
          const statusColors = { pass: 'var(--green)', warn: 'var(--amber)', fail: 'var(--red)', skip: 'var(--txt-4)' }
          const statusIcons = { pass: '\u2713', warn: '!', fail: '\u2717', skip: '\u2013' }
          const scorePct = sm.health_score
          const scoreColor = scorePct == null ? 'var(--txt-4)' : scorePct >= 80 ? 'var(--green)' : scorePct >= 50 ? 'var(--amber)' : 'var(--red)'
          return (
            <div style={{ border: `1px solid ${sm.fail > 0 ? 'rgba(255,68,68,.35)' : sm.warn > 0 ? 'rgba(255,171,0,.3)' : 'var(--border-1)'}`, borderRadius: 7 }}>
              <button
                className={`collapsible-trigger ${isOpen ? 'open' : ''}`}
                onClick={() => toggle('cross_validation')}
                style={{ borderRadius: isOpen ? '7px 7px 0 0' : 7 }}
              >
                <span>{'\u{1F50D}'}</span>
                <span>Cross-Datasheet Validation</span>
                {scorePct != null && (
                  <span style={{
                    marginLeft: 6, fontSize: 10, fontWeight: 700, color: scoreColor,
                    background: `${scoreColor}15`, padding: '1px 6px', borderRadius: 3, fontFamily: 'var(--font-mono)',
                  }}>
                    {scorePct}/100
                  </span>
                )}
                {sm.fail > 0 && <span style={{ fontSize: 9, color: 'var(--red)', fontWeight: 700, marginLeft: 4 }}>{sm.fail} FAIL</span>}
                {sm.warn > 0 && <span style={{ fontSize: 9, color: 'var(--amber)', fontWeight: 700, marginLeft: 4 }}>{sm.warn} WARN</span>}
                <span className="chevron"><ChevronDown size={11} /></span>
              </button>
              {isOpen && (
                <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {/* Summary bar */}
                  <div style={{ display: 'flex', gap: 10, fontSize: 10, color: 'var(--txt-3)', marginBottom: 4, padding: '4px 0', borderBottom: '1px solid var(--border-1)' }}>
                    <span style={{ color: 'var(--green)' }}>{sm.pass || 0} pass</span>
                    <span style={{ color: 'var(--amber)' }}>{sm.warn || 0} warn</span>
                    <span style={{ color: 'var(--red)' }}>{sm.fail || 0} fail</span>
                    <span style={{ color: 'var(--txt-4)' }}>{sm.skip || 0} skip</span>
                    <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{sm.total || 0} checks</span>
                  </div>
                  {(cv.checks || []).map((chk, i) => (
                    <div key={chk.id || i} style={{
                      display: 'flex', gap: 6, padding: '4px 6px', borderRadius: 5,
                      background: chk.status === 'fail' ? 'rgba(255,68,68,.06)' : chk.status === 'warn' ? 'rgba(255,171,0,.05)' : 'transparent',
                      alignItems: 'flex-start', fontSize: 10,
                    }}>
                      <span style={{
                        width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 700, flexShrink: 0, marginTop: 1,
                        color: statusColors[chk.status], border: `1.5px solid ${statusColors[chk.status]}`,
                        background: `${statusColors[chk.status]}12`,
                      }}>
                        {statusIcons[chk.status]}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: 'var(--txt-1)', fontSize: 11 }}>{chk.title}</div>
                        <div style={{ color: 'var(--txt-3)', lineHeight: 1.5 }}>{chk.detail}</div>
                        {chk.advice && (
                          <div style={{ color: statusColors[chk.status], fontSize: 9, marginTop: 2, fontStyle: 'italic' }}>
                            {chk.advice}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })()}

        {/* ── Results sections ─────────────────────────────────── */}
        {C && SECTIONS.map(sec => {
          const d = C[sec.key]
          if (!d) return null
          const isOpen = open[sec.key] !== false
          const missingDeps = Object.entries(BLOCK_DEPS)
            .filter(([blk, keys]) => keys.includes(sec.key) && missing.includes(blk))
            .map(([blk]) => blk)
          const rowIndicator = getRowIndicator(sec.key)
          return (
            <div key={sec.key} style={{ border: `1px solid ${missingDeps.length ? 'rgba(255,171,0,.3)' : 'var(--border-1)'}`, borderRadius: 7, position: 'relative' }}>
              <button
                className={`collapsible-trigger ${isOpen ? 'open' : ''}`}
                onClick={() => toggle(sec.key)}
                style={{ borderRadius: isOpen ? '7px 7px 0 0' : 7 }}
              >
                <span>{sec.icon}</span>
                <span>{sec.label}</span>
                {renderMetaBadge(sec.key)}
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
                    const tip = buildRowTip(r, tc, sec.key)

                    // Reverse calculation state
                    const isReversible = REVERSIBLE_KEYS.has(r.key)
                    const isEditing = reverseEditing[r.key] !== undefined
                    const revResult = reverseResults[r.key]
                    const revLoading = reverseLoading[r.key]

                    return (
                      <div key={r.key}>
                        <div className={`calc-row ${isReversible ? 'calc-row-reversible' : ''}`} data-tip={tip}>
                          <span className="label">
                            {rowIndicator && <span className={`row-indicator row-indicator-${rowIndicator}`} />}
                            {isReversible && (
                              <span className="editable-pen" title="Editable parameter - changing this target can affect multiple calculations">
                                <Pencil size={9} />
                              </span>
                            )}
                            {r.label}
                          </span>
                          <div className="calc-row-values">
                            {isEditing ? (
                              <div className="reverse-input-row">
                                <input
                                  type="number" step="any"
                                  className="inp inp-mono reverse-input"
                                  value={reverseEditing[r.key]}
                                  onChange={e => setReverseEditing(p => ({ ...p, [r.key]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') solveReverse(r.key); if (e.key === 'Escape') setReverseEditing(p => { const n = { ...p }; delete n[r.key]; return n }) }}
                                  autoFocus
                                  placeholder={fmtNum(v, r.dec ?? 3)}
                                />
                                <span className="reverse-input-unit">{r.unit || ''}</span>
                                <button
                                  className="btn btn-ghost reverse-solve-btn"
                                  onClick={() => solveReverse(r.key)}
                                  disabled={revLoading || !reverseEditing[r.key]}
                                  title="Solve reverse"
                                >
                                  {revLoading ? <RefreshCw size={9} style={{ animation: 'spin 1s linear infinite' }} /> : <CornerDownLeft size={9} />}
                                  <span>Solve</span>
                                </button>
                                <button
                                  className="btn btn-ghost reverse-cancel-btn"
                                  onClick={() => { setReverseEditing(p => { const n = { ...p }; delete n[r.key]; return n }); setReverseResults(p => { const n = { ...p }; delete n[r.key]; return n }) }}
                                  title="Cancel"
                                >
                                  <X size={9} />
                                </button>
                              </div>
                            ) : (
                              <>
                                <span className={`value ${tc}`}>
                                  {fmtNum(v, r.dec ?? 3)}{r.unit ? ` ${r.unit}` : ''}
                                  {tc === 'danger' && <AlertTriangle size={9} style={{ marginLeft: 3 }} />}
                                </span>
                                {isReversible && (
                                  <button
                                    className="reverse-trigger"
                                    onClick={() => startReverseEdit(r.key)}
                                    title="Set target value (reverse calculate)"
                                  >
                                    <Pencil size={8} />
                                    <span className="reverse-trigger-text">Edit target</span>
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        {/* Reverse result card — enhanced for bootstrap what-if */}
                        {revResult && BOOTSTRAP_WHATIF_KEYS.has(r.key) && revResult.downstream ? (
                          <div className={`boot-whatif ${revResult.feasible ? 'feasible' : 'infeasible'}`}>
                            {/* ── Header ── */}
                            <div className="boot-whatif-header">
                              <div className="boot-whatif-title-row">
                                <span className={`boot-whatif-badge ${revResult.feasible ? 'feasible' : 'infeasible'}`}>
                                  {revResult.feasible ? <Check size={10} /> : <AlertTriangle size={10} />}
                                </span>
                                <span className="boot-whatif-title">Bootstrap What-If Analysis</span>
                              </div>
                              <span className="boot-whatif-target">
                                Target: <strong>{revResult.target_value}{revResult.actual_output_unit ? ` ${revResult.actual_output_unit}` : ''}</strong>
                                {revResult.ideal_value !== revResult.solved_value && (
                                  <span className="boot-whatif-snap"> → E12: {revResult.solved_value} {revResult.solved_unit}</span>
                                )}
                              </span>
                            </div>

                            {/* ── Before / After comparison grid ── */}
                            {revResult.current_vals && (() => {
                              const ds = revResult.downstream
                              const cv = revResult.current_vals
                              const rows = [
                                { label: 'C_boot', before: cv.c_boot_nf, after: ds.c_boot_nf, unit: 'nF', icon: <Activity size={10} /> },
                                { label: 'Voltage Droop', before: cv.droop_v, after: ds.droop_v, unit: 'V', icon: <ArrowDownRight size={10} />, lowerBetter: true },
                                { label: 'Min On-Time', before: cv.min_on_time_ns, after: ds.min_on_time_ns, unit: 'ns', icon: <Clock size={10} />, lowerBetter: true },
                                { label: 'Hold Time', before: cv.hold_time_ms, after: ds.hold_time_ms, unit: 'ms', icon: <Clock size={10} />, higherBetter: true },
                              ]
                              return (
                                <div className="boot-whatif-grid">
                                  <div className="boot-whatif-grid-header">
                                    <span>Parameter</span>
                                    <span>Current</span>
                                    <span></span>
                                    <span>What-If</span>
                                  </div>
                                  {rows.map(row => {
                                    const changed = row.before !== row.after
                                    const better = row.lowerBetter ? row.after < row.before : row.higherBetter ? row.after > row.before : null
                                    return (
                                      <div key={row.label} className={`boot-whatif-grid-row ${changed ? 'changed' : ''}`}>
                                        <span className="boot-whatif-grid-label">
                                          {row.icon}
                                          {row.label}
                                        </span>
                                        <span className="boot-whatif-grid-val before">{row.before ?? '—'} {row.unit}</span>
                                        <span className="boot-whatif-grid-arrow">{changed ? <ArrowRight size={10} /> : '='}</span>
                                        <span className={`boot-whatif-grid-val after ${changed ? (better === true ? 'better' : better === false ? 'worse' : 'neutral') : ''}`}>
                                          {row.after ?? '—'} {row.unit}
                                        </span>
                                      </div>
                                    )
                                  })}
                                </div>
                              )
                            })()}

                            {/* ── UVLO Data Quality + Safety Check ── */}
                            {(() => {
                              const ds = revResult.downstream
                              const dataStatus = ds.uvlo_data_status || 'missing'
                              const dataBadge = uvloDataBadgeInfo(dataStatus)
                              return (
                                <div className={`boot-whatif-uvlo boot-whatif-uvlo--${ds.uvlo_status}`}>
                                  <Shield size={12} className="boot-whatif-uvlo-icon" />
                                  <div className="boot-whatif-uvlo-content">
                                    <div className="boot-whatif-uvlo-title">
                                      <span className={`boot-whatif-uvlo-badge ${dataBadge.cls}`}>{dataBadge.label}</span>
                                      {ds.vbs_uvlo_v != null && ds.uvlo_margin_v != null && (
                                        <>
                                          <span style={{ marginLeft: 6 }}>UVLO Margin: <strong>{ds.uvlo_margin_v}V</strong></span>
                                          <span className={`boot-whatif-uvlo-badge ${ds.uvlo_status}`}>
                                            {ds.uvlo_status === 'ok' ? 'SAFE' : ds.uvlo_status === 'warning' ? 'TIGHT' : 'FAIL'}
                                          </span>
                                        </>
                                      )}
                                    </div>
                                    <div className="boot-whatif-uvlo-detail">
                                      {dataBadge.note}
                                      {ds.vbs_uvlo_v != null
                                        ? ` V_gate after droop: ${ds.v_gate_min_v}V vs UVLO: ${ds.vbs_uvlo_v}V.`
                                        : ''}
                                    </div>
                                  </div>
                                </div>
                              )
                            })()}

                            {/* ── RC Detail ── */}
                            <div className="boot-whatif-rc">
                              τ = R_boot × C_boot = {revResult.downstream.r_boot_ohm}Ω × {revResult.downstream.c_boot_nf}nF = {revResult.downstream.tau_ns}ns
                              <span className="boot-whatif-rc-note">({revResult.downstream.min_on_time_ns}ns = 3τ → 95% charge)</span>
                            </div>

                            {/* ── Constraint warning ── */}
                            {revResult.constraint && (
                              <div className="boot-whatif-constraint">
                                <AlertTriangle size={10} />
                                {revResult.constraint}
                              </div>
                            )}

                            {/* ── Apply button ── */}
                            <div className="boot-whatif-actions">
                              <button
                                className="btn boot-whatif-apply"
                                onClick={() => applyBootstrapWhatIf(revResult)}
                                disabled={!revResult.feasible}
                                title={revResult.feasible ? 'Apply this configuration and re-run all calculations' : 'Cannot apply — design constraint violated'}
                              >
                                <Check size={11} />
                                Apply & Re-Run
                              </button>
                              <button
                                className="btn btn-ghost boot-whatif-dismiss"
                                onClick={() => {
                                  setReverseEditing(p => { const n = { ...p }; delete n[r.key]; return n })
                                  setReverseResults(p => { const n = { ...p }; delete n[r.key]; return n })
                                }}
                              >
                                <X size={10} />
                                Dismiss
                              </button>
                            </div>
                          </div>
                        ) : revResult && (
                          <div className={`reverse-result ${revResult.feasible ? 'feasible' : 'infeasible'}`}>
                            <div className="reverse-result-header">
                              <span className={`reverse-result-badge ${revResult.feasible ? 'feasible' : 'infeasible'}`}>
                                {revResult.feasible ? '✓' : '✗'}
                              </span>
                              <span className="reverse-result-label">
                                Set <strong>{revResult.solved_key?.replace(/_/g, ' ')}</strong> = <strong>{revResult.solved_value} {revResult.solved_unit}</strong>
                              </span>
                            </div>
                            <div className="reverse-result-detail">
                              <span>Achieves: {revResult.actual_output} {revResult.actual_output_unit}</span>
                              {revResult.ideal_value !== revResult.solved_value && (
                                <span className="reverse-result-snap">E-series: {revResult.ideal_value} → {revResult.solved_value} {revResult.solved_unit}</span>
                              )}
                            </div>
                            {revResult.constraint && (
                              <div className="reverse-result-constraint">{revResult.constraint}</div>
                            )}
                            {revResult.note && (
                              <div className="reverse-result-note">{revResult.note}</div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {(d.warnings?.length > 0 || d.ripple_warning || d.driver_current_limited || d.trr_warning) && (
                    <div className="note-box" style={{ marginTop: 6, background: 'rgba(255,68,68,.06)', border: '1px solid rgba(255,68,68,.2)' }}>
                      {d.warnings?.map((w, i) => (
                        <div key={i} style={{ fontSize: 10, color: 'var(--red)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                          <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>{w}</span>
                        </div>
                      ))}
                      {d.ripple_warning && (
                        <div style={{ fontSize: 10, color: 'var(--amber)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                          <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>{d.ripple_warning}</span>
                        </div>
                      )}
                      {d.driver_current_limited && (
                        <div style={{ fontSize: 10, color: 'var(--amber)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                          <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>Gate current clamped by driver source/sink limits — actual switching time longer than Rg alone would predict.</span>
                        </div>
                      )}
                      {d.trr_warning && (
                        <div style={{ fontSize: 10, color: 'var(--red)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                          <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>{d.trr_warning}</span>
                        </div>
                      )}
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

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
                {SECTIONS.map(sec => {
                  const d = C[sec.key]
                  if (!d) return null
                  const rowIndicator = getRowIndicator(sec.key)
                  return (
                    <div key={sec.key} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                      <div className="sec-head" style={{ fontSize: 13 }}>
                        <span>{sec.icon}</span> {sec.label}
                        {renderMetaBadge(sec.key)}
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
                          if (r.key === 'tj_max_rated_c') return null

                          const tc = (wrn !== undefined || dng !== undefined) ? thresholdClass(v, wrn, dng) : ''
                          const tip = buildRowTip(r, tc, sec.key)

                          return (
                            <div key={r.key} className="calc-row" data-tip={tip} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-1)', borderTop: 'none' }}>
                              <span className="label" style={{ fontSize: 13 }}>
                                {rowIndicator && <span className={`row-indicator row-indicator-${rowIndicator}`} />}
                                {r.label}
                              </span>
                              <span className={`value ${tc}`} style={{ fontSize: 13, padding: '3px 8px', minWidth: 80 }}>
                                {fmtNum(v, r.dec ?? 3)}{r.unit ? ` ${r.unit}` : ''}
                                {tc === 'danger' && <AlertTriangle size={11} style={{ marginLeft: 4, display: 'inline-block' }} />}
                              </span>
                            </div>
                          )
                        })}
                        {(d.warnings?.length > 0 || d.ripple_warning || d.driver_current_limited || d.trr_warning) && (
                          <div className="note-box" style={{ marginTop: 8, background: 'rgba(255,68,68,.06)', border: '1px solid rgba(255,68,68,.2)' }}>
                            {d.warnings?.map((w, i) => (
                              <div key={i} style={{ fontSize: 11, color: 'var(--red)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                                <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                                <span>{w}</span>
                              </div>
                            ))}
                            {d.ripple_warning && (
                              <div style={{ fontSize: 11, color: 'var(--amber)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                                <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                                <span>{d.ripple_warning}</span>
                              </div>
                            )}
                            {d.driver_current_limited && (
                              <div style={{ fontSize: 11, color: 'var(--amber)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                                <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                                <span>Gate current clamped by driver source/sink limits — actual switching time longer than Rg alone would predict.</span>
                              </div>
                            )}
                            {d.trr_warning && (
                              <div style={{ fontSize: 11, color: 'var(--red)', lineHeight: 1.5, display: 'flex', gap: 5 }}>
                                <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                                <span>{d.trr_warning}</span>
                              </div>
                            )}
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
      { key: 'vds_max_v', label: 'Vds max (rated)', full: 'Maximum Drain-to-Source Voltage', unit: 'V', dec: 1, explain: 'Absolute max voltage before avalanche breakdown. Rated at 25°C, V_breakdown often has a positive temperature coefficient.' },
      { key: 'v_peak_v', label: 'V peak (system)', full: 'Peak System Bus Voltage', unit: 'V', dec: 1, explain: 'Expected peak DC bus voltage under worst-case regeneration or ringing. User-specified.' },
      { key: 'voltage_margin_pct', label: 'Voltage margin', full: 'MOSFET Voltage Margin', unit: '%', dec: 1, warn: 25, danger: 10, explain: 'Formula: (Vds_max - V_peak) / Vds_max. Industry best practice is ≥ 20% to absorb severe inductive kickbacks and transient ringing.' },
      { key: 'id_cont_a', label: 'Id cont (rated)', full: 'Continuous Drain Current', unit: 'A', dec: 1, explain: 'Theoretical max DC current from datasheet (often Tc=25°C with infinite heatsink). NOT a practical continuous limit on an FR4 board.' },
      { key: 'i_max_a', label: 'I max (system)', full: 'Maximum Phase Current', unit: 'A', dec: 1, explain: 'Worst-case peak operational phase current.' },
      { key: 'current_margin_pct', label: 'Current margin', full: 'MOSFET Current Margin', unit: '%', dec: 1, warn: 30, danger: 10, explain: 'Formula: (Id_cont - I_max) / Id_cont. Because Tc=25°C ratings are extremely optimistic, ≥ 25% margin is crucial to avoid thermal runaway.' },
      { key: 'avalanche_energy_mj', label: 'Eas (rated)', full: 'Single-Pulse Avalanche Energy', unit: 'mJ', dec: 1, explain: 'Maximum energy (E_AS) the die can safely dissipate during unclamped inductive switching before fracturing.' },
      { key: 'ias_source', label: 'Ias source', full: 'Avalanche Current Source', string: true, explain: 'Indicates if the peak avalanche current (Ias) was extracted from the datasheet or mathematically estimated using the Motor L_ph.' },
      { key: 'ias_av_a', label: 'Ias (avalanche)', full: 'Peak Avalanche Current', unit: 'A', dec: 1, explain: 'Absolute peak current for avalanche survivability. Formula (if estimated): Ias = √((2·Eas / L_ph) · (Vds / (Vds - Vbus)))' },
      { key: 'avalanche_margin_pct', label: 'Ias margin', full: 'Avalanche Current Margin', unit: '%', dec: 1, warn: 25, danger: 10, explain: 'Formula: (Ias - I_max) / Ias. Margin required to ensure survival against hard faults driving unclamped inductive switching. ≥ 25% recommended.' },
    ],
  },
  {
    key: 'driver_compatibility', label: 'Driver Compatibility', icon: '🔗',
    rows: [
      { key: 'vcc_min_v', label: 'VCC min', full: 'Driver Minimum Supply Voltage', unit: 'V', dec: 1, explain: 'Absolute minimum supply voltage required to operate the logic and gate drive stages. If V_drive < VCC_min, the driver enters UVLO and shuts down.' },
      { key: 'vcc_max_v', label: 'VCC max', full: 'Driver Maximum Supply Voltage', unit: 'V', dec: 1, explain: 'Absolute maximum gate drive supply voltage before internal logic breakdown. V_drive must not exceed this.' },
      { key: 'gate_drive_v', label: 'V_drive (system)', full: 'System Gate Drive Voltage', unit: 'V', dec: 1, explain: 'The nominal DC supply voltage fed to the gate driver VCC pin. Set in System Specs.' },
      { key: 'v_bootstrap_v', label: 'V bootstrap', full: 'Bootstrap Voltage', unit: 'V', dec: 2, explain: 'Steady-state voltage across the high-side floating supply capacitor. Formula: V_drive - V_diode_drop. Assumes standard 1V drop for integrated diodes (configurable in Design Constants).' },
      { key: 'vbs_uvlo_v', label: 'VBS UVLO', full: 'Bootstrap UVLO Threshold', unit: 'V', dec: 2, explain: 'Under-Voltage Lockout for the high-side supply. If V_bootstrap drops below this during a long ON-cycle, the driver shuts off to prevent linear-mode thermal destruction.' },
      { key: 'bootstrap_margin_v', label: 'Boot margin', full: 'Bootstrap Voltage Margin', unit: 'V', dec: 2, warn: 1, danger: 0, explain: 'Safety headroom before hitting UVLO. Formula: V_bootstrap - VBS_UVLO. Margin must be > 0.5V to prevent nuisance tripping during sudden PWM transients.' },
      { key: 'vih_v', label: 'Driver VIH', full: 'Driver High-Level Input Threshold', unit: 'V', dec: 2, explain: 'The absolute lowest voltage the gate driver will reliably interpret as a logic \'1\' on its PWM input pins.' },
      { key: 'mcu_voh_v', label: 'MCU output high', full: 'MCU Output High Voltage', unit: 'V', dec: 1, explain: 'The expected voltage output from the MCU logic pins. If MCU VOH < Driver VIH, the driver cannot detect the PWM signal. Defauts to 3.3V.' },
    ],
  },
  {
    key: 'adc_timing', label: 'ADC Timing', icon: '📊',
    rows: [
      { key: 'pwm_period_us', label: 'PWM period', full: 'PWM Switching Period', unit: 'µs', dec: 2, explain: 'Definition: Total duration of one PWM cycle. Formula: 1 / f_sw. Meaning: Dictates the absolute upper bound time limit for your FOC control loop execution.' },
      { key: 'sampling_window_us', label: 'Sample window', full: 'Center-Aligned Sampling Window', unit: 'µs', dec: 2, explain: 'Definition: Center-aligned zero-vector sampling window. Formula: (Half-Period) × (1 - 0.90 D_max). At a 90% duty cycle, the low-side switch is ON for a very short time. Your ADC MUST finish sampling phase currents in this narrow quiet window before switching noise corrupts the reading.' },
      { key: 'adc_rate_msps', label: 'ADC rate', full: 'ADC Sampling Rate', unit: 'MSPS', dec: 2, explain: 'Definition: Maximum ADC sampling rate extracted from the MCU datasheet.' },
      { key: 'adc_conversion_us', label: 'Conversion time', full: 'Single ADC Conversion Time', unit: 'µs', dec: 3, explain: 'Definition: Theoretical minimum time to complete a single ADC conversion (ignoring multiplexer settling). Formula: 1 / ADC_rate.' },
      { key: 't_3_channel_us', label: '3-ch total time', full: '3-Channel Sequential Conversion Time', unit: 'µs', dec: 3, explain: 'Definition: Time to sequentially sample all 3 phase shunts on a single ADC. Formula: 3 × Conversion_Time. Best Practice: If this exceeds the sampling window, you MUST use simultaneous sampling (multiple ADCs) or hardware DMA triggers.' },
      { key: 'adc_channels', label: 'ADC channels', full: 'Available MCU ADC Channels', unit: 'ch', dec: 0, explain: 'Definition: Total analog-to-digital converter input pins available on the chosen microcontroller.' },
      { key: 'channels_needed', label: 'Channels needed', full: 'Required ADC Channels', unit: 'ch', dec: 0, explain: 'Definition: Minimum recommended ADC channels for a fully protected FOC drive. Assumption: 3x Phase Shunts + 1x Bus Voltage + 2x Thermistors (FETs/Motor) + 1x Throttle/BEMF = 7 channels.' },
      { key: 'adc_settling_ns', label: 'ADC settling', full: 'ADC Single Conversion Time in ns', unit: 'ns', dec: 1, explain: 'Definition: ADC conversion time expressed in nanoseconds for dead-time comparison. Formula: 1/ADC_rate × 1e9.' },
      { key: 'dead_time_ns', label: 'Dead time (DT)', full: 'Actual Gate Dead Time', unit: 'ns', dec: 1, explain: 'Definition: Actual programmed dead time from the dead_time module. Included here for comparison with ADC settling time.' },
      { key: 'adc_fits_in_dead_time', label: 'ADC fits in DT?', full: 'ADC Settles Within Dead Time', unit: '', dec: 0, explain: 'Definition: True if ADC conversion time < dead time. If false, the ADC cannot sample during the dead-time window — use center-aligned sampling instead.' },
    ],
  },
  {
    key: 'motor_validation', label: 'Motor Checks', icon: '🌀',
    rows: [
      { key: 'f_electrical_hz', label: 'f_electrical', full: 'Electrical Frequency', unit: 'Hz', dec: 1, explain: 'RPM × pole_pairs / 60' },
      { key: 'fsw_to_fe_ratio', label: 'f_sw / f_e ratio', full: 'PWM vs Electrical Frequency Ratio', unit: '×', dec: 1, warn: 15, danger: 10, explain: 'PWM freq ÷ electrical freq — must be ≥ 10× for FOC/SPWM' },
      { key: 'v_bemf_peak_v', label: 'Back-EMF peak', full: 'Peak Motor Back-EMF Voltage', unit: 'V', dec: 1, explain: 'Ke × (RPM / 1000)' },
      { key: 'bemf_margin_pct', label: 'V_bus headroom', full: 'Bus Voltage vs BEMF Headroom', unit: '%', dec: 1, warn: 15, danger: 0, explain: '(V_bus - V_BEMF) / V_bus × 100 — negative means MOSFET overvoltage risk' },
      { key: 'i_rated_from_kt_a', label: 'I rated (from Kt)', full: 'Required Rated Current', unit: 'A', dec: 1, explain: 'Rated_Torque / Kt — current needed for rated torque' },
      { key: 'copper_loss_3ph_w', label: 'Copper loss (3ph)', full: 'Total Stator Copper Loss', unit: 'W', dec: 1, explain: '3 × I_rms² × Rph — winding heat at rated current' },
      { key: 'copper_loss_pct', label: 'Copper loss %', full: 'Copper Loss Percentage', unit: '%', dec: 1, warn: 3, danger: 5, explain: 'Copper loss as percentage of rated power' },
      { key: 'phase_time_const_ms', label: 'L/R time const', full: 'Electrical Time Constant (L/R)', unit: 'ms', dec: 2, explain: 'Lph / Rph — electrical time constant of motor winding' },
      { key: 'i_stall_a', label: 'I stall (SVPWM)', full: 'SVPWM Stall Current (V_bus/√3 / Rph)', unit: 'A', dec: 1, warn: 80, danger: 120, explain: 'Worst-case phase current at stall with SVPWM drive. Formula: (V_bus/√3) / Rph. Firmware OCP must trip before this current flows for more than a few ms.' },
      { key: 'i_stall_dc_a', label: 'I stall (DC)', full: 'DC Locked-Rotor Stall Current (V_bus / Rph)', unit: 'A', dec: 1, warn: 100, danger: 150, explain: 'True DC locked-rotor current if drive voltage is applied directly (no modulation). Formula: V_bus / Rph. Represents the absolute worst-case for a firmware bug that drives DC continuously.' },
      { key: 'i_fault_shoot_through_a', label: 'I fault (shoot-thru)', full: 'MOSFET Shoot-Through Fault Current', unit: 'A', dec: 0, warn: 200, danger: 400, explain: 'Shoot-through fault current if both high-side and low-side MOSFETs conduct simultaneously. Formula: V_bus / (2 × Rds_hot at Tj_max). Gate-driver DESAT/OCP must trip < 1µs.' },
      { key: 'rds_hot_mohm_at_tjmax', label: 'Rds(on) @ Tj_max', full: 'Hot Rds(on) at Tj_max (fault model)', unit: 'mΩ', dec: 2, explain: 'Rds(on) at maximum rated junction temperature, used for shoot-through fault current estimate. Formula: Rds25 × (Tj_max/298K)^α.' },
    ],
  },
  {
    key: 'mosfet_losses', label: 'MOSFET Losses', icon: '🔥',
    rows: [
      { key: 'i_rms_switch_a', label: 'I_rms / switch', full: 'RMS Current per Switch (total)', unit: 'A', dec: 2, explain: 'Definition: Total RMS current passing through ONE switch in the half-bridge. Formula: √(I_fund² + (I_ripple / √2)²). The ripple component is divided by √2 because heating from high-frequency triangle ripple is shared 50/50 between the top and bottom switch across a fundamental cycle.' },
      { key: 'i_rms_fundamental_a', label: 'I_rms (fund.)', full: 'Fundamental RMS per Switch', unit: 'A', dec: 2, explain: 'Definition: Fundamental sine wave RMS current. Formula: I_pk × √(1/8 + M/(3π)). Takes into account the pulse-width duty cycle weighting (Mohan textbook).' },
      { key: 'conduction_loss_per_fet_w', label: 'Cond. Loss / FET', unit: 'W', dec: 3, explain: 'Definition: Resistive heating loss. Formula: I_rms_switch² × Rds_hot. Evaluates Rds(on) iteratively using a (Tj_est / 25°C)^2.1 scaling factor to model silicon carrier mobility degradation at high temperatures.' },
      { key: 'switching_loss_per_fet_w', label: 'SW Loss / FET', unit: 'W', dec: 3, explain: 'Definition: Overlap energy loss during V/I transition. Formula: E_overlap × fsw. Uses Qgd / I_gate to determine exact Miller plateau time. NOTE: Qgd is dynamically scaled up based on junction temperature to model Vth droop.' },
      { key: 'recovery_loss_per_fet_w', label: 'Recovery Loss / FET', unit: 'W', dec: 3, explain: 'Definition: Body diode reverse recovery energy. Formula: Qrr_hot × V_bus × fsw. NOTE: Qrr increases fiercely at high temperatures; the engine actively scales Qrr up by +0.5% per °C of estimated junction rise for rigorous safety.' },
      { key: 'body_diode_loss_per_fet_w', label: 'Body Diode / FET', unit: 'W', dec: 3, explain: 'Definition: Diode conduction during dead-time. Formula: Vf × I_avg × t_dead × fsw × (2 events / 2 FETs). Current is sinusoidally averaged.' },
      { key: 'coss_loss_per_fet_w', label: 'Coss Loss / FET', unit: 'W', dec: 3, explain: 'Definition: Output capacitance loss. Formula: E_oss × fsw = 0.5 × Qoss × V_bus × fsw. Energy stored in Coss at turn-off is dissipated in the channel at hard turn-on.' },
      { key: 'total_loss_per_fet_w', label: 'Total / FET', unit: 'W', dec: 3, warn: 8, danger: 15, explain: 'Definition: Sum of Conduction, Switching, Recovery, Gate Charge, Coss, and Body Diode losses for a single MOSFET.' },
      { key: 'total_all_6_fets_w', label: 'Total (all FETs)', unit: 'W', dec: 1, warn: 40, danger: 60, explain: 'Definition: Total thermal dissipation of the entire inverter power stage. Controls heatsink and cooling requirements.', dynamic: d => d?.num_fets ? `Total (×${d.num_fets} FETs)` : 'Total (all FETs)' },
      { key: 'efficiency_mosfet_pct', label: 'Efficiency', unit: '%', dec: 2, explain: 'Definition: Efficiency of the silicon switching stage. Formula: 100 × P_out / (P_out + Total_Loss).' },
    ],
  },
  {
    key: 'gate_resistors', label: 'Gate Drive', icon: '⚡',
    rows: [
      { key: 'hs_rg_on_ohm', label: 'HS Rg ON', full: 'High-Side Turn-On Resistor', unit: 'Ω', dec: 2, explain: 'Definition: External gate resistor required for high-side turn-on. Formula: MAX( V_drv/I_source, (V_drv - V_pl) / (Q_gd / t_rise) ) - Rg_int. Physics: Sizes for specific rise target while strictly clamping absolute peak driver output current.' },
      { key: 'hs_rg_off_ohm', label: 'HS Rg OFF', full: 'High-Side Turn-Off Resistor', unit: 'Ω', dec: 2, explain: 'Definition: External gate resistor required for high-side turn-off. Formula: Solves for induced Miller current (I_miller = Crss × dV/dt) and caps Rg_off to guarantee I_miller × Rg_off_total < V_th × 0.8. Physics: Rigorously prevents parasitic shoot-through at high dV/dt.' },
      { key: 'ls_rg_on_ohm', label: 'LS Rg ON', full: 'Low-Side Turn-On Resistor', unit: 'Ω', dec: 2, explain: 'Definition: External gate resistor required for low-side turn-on, matching high-side topology.' },
      { key: 'ls_rg_off_ohm', label: 'LS Rg OFF', full: 'Low-Side Turn-Off Resistor', unit: 'Ω', dec: 2, explain: 'Definition: External gate resistor required for low-side turn-off, sized with direct Miller threshold safety margin.' },
      { key: 'rg_bootstrap_ohm', label: 'Rg Bootstrap', full: 'Bootstrap Charging Resistor', unit: 'Ω', dec: 1, explain: 'Definition: Current-limiting resistor in series with the bootstrap diode. Physics: Restricts peak C_boot charging surge (I_surge = V_drv / Rg_boot) to protect the 15V rail from brownouts.' },
      { key: 'hs_gate_rise_time_ns', label: 'Actual Rise', full: 'Calculated Gate Rise Time', unit: 'ns', dec: 1, explain: 'Definition: Physical switching transition time. Formula: (Rg_on_total × Q_gd) / (V_drv - V_pl).' },
      { key: 'hs_gate_fall_time_ns', label: 'Actual Fall', full: 'Calculated Gate Fall Time', unit: 'ns', dec: 1, explain: 'Definition: Physical switching transition time. Formula: (Rg_off_total × Q_gd) / V_pl.' },
      { key: 'hs_dv_dt_bus', label: 'Switch dV/dt', full: 'Phase Node Slew Rate', unit: 'V/µs', dec: 1, warn: 40, danger: 65, explain: 'Definition: Voltage slew rate on the inverter phase leg. Formula: V_bus / t_rise_actual. Physics: Excessive dV/dt (>50 V/µs) triggers severe EMI, capacitive motor bearing currents, and false MOSFET triggering.' },
      { key: 'hs_i_peak_on_a', label: 'I_peak Driver', full: 'Absolute Peak Gate Current', unit: 'A', dec: 2, warn: 2, danger: 3, explain: 'Definition: Maximum instantaneous current pulled from the driver. Formula: V_drv / Rg_on_total. Physics: Validates driver sizing (UCC27302 has a specific source/sink saturation limit).' },
      { key: 'hs_rg_power_w', label: 'Rg Power Loss', full: 'Gate Resistor Dissipation', unit: 'W', dec: 3, warn: 0.125, danger: 0.25, explain: 'Definition: Thermal power dissipated specifically in the physical gate resistors. Formula: Q_g × V_drv × fsw, proportionally split. Physics: Verifies 0603/0805 package power limits.' },
      { key: 'dvdt_on_v_per_ns', label: 'dV/dt Turn-On', full: 'MOSFET Turn-On Slew Rate (datasheet tr)', unit: 'V/ns', dec: 2, warn: 30, danger: 50, explain: 'Definition: Voltage slew rate from MOSFET datasheet rise time. Formula: V_bus / tr. Physics: MOSFET-intrinsic bound — independent of gate resistor. EMC guideline: <50 V/ns.' },
      { key: 'dvdt_off_v_per_ns', label: 'dV/dt Turn-Off', full: 'MOSFET Turn-Off Slew Rate (datasheet tf)', unit: 'V/ns', dec: 2, warn: 30, danger: 50, explain: 'Definition: Voltage slew rate from MOSFET datasheet fall time. Formula: V_bus / tf. Physics: MOSFET-intrinsic bound — independent of gate resistor. EMC guideline: <50 V/ns.' },
    ],
  },
  {
    key: 'thermal', label: 'Thermal', icon: '🌡️',
    rows: [
      { key: 't_junction_est_c', label: 'Tj estimated', full: 'Estimated Junction Temperature', unit: '°C', dec: 1, warn: 130, danger: 155, explain: 'Definition: Maximum steady-state temperature of the silicon die. Formula: T_ambient + P_fet × (R_thJC + R_thCS + R_thSA). Physics: Integrates the selected cooling method (e.g. Heatsinks drop R_thSA massively).' },
      { key: 'tj_max_rated_c', label: 'Tj max rated', full: 'Maximum Rated Junction Temperature', unit: '°C', dec: 0, explain: 'Definition: Absolute maximum thermal limit from the manufacturer datasheet before catastrophic silicon failure.' },
      { key: 'thermal_margin_c', label: 'Thermal margin', full: 'Thermal Safety Margin', unit: '°C', dec: 1, warn: 30, danger: 0, explain: 'Definition: Buffer between the estimated operating state and absolute failure. Formula: Tj_max_rated - Tj_estimated.' },
      { key: 'p_per_fet_w', label: 'P / FET', full: 'Power Dissipation per Switch', unit: 'W', dec: 3, explain: 'Definition: Total thermal wattage dissipated by one MOSFET wrap. Matches the rigorous sum from the MOSFET Losses phase.' },
      
      { key: 'tj_driver_est_c', label: 'Driver Tj estimated', full: 'Estimated Gate Driver Junction Temperature', unit: '°C', dec: 1, warn: 125, danger: 145, explain: 'Definition: Thermal state of the Gate Driver IC. Formula: T_amb + P_driver × Rth_JA. P_driver rigorous calculated by subtracting external resistor heat from the total gate charge energy.' },
      { key: 'p_driver_per_ic_w', label: 'Driver P / IC', full: 'Power Dissipation per Driver IC', unit: 'W', dec: 3, explain: 'Definition: Dissipation inside the Driver IC. Physics: Precisely computes Q_g × V_drv × fsw, dynamically scaled for parallel topologies, and actively subtracts heat burned cleanly in external gate resistors.' },

      { key: 'motor_copper_loss_w', label: 'Motor Cu loss', full: 'Motor Copper Stator Loss', unit: 'W', dec: 1, explain: 'Definition: Ohmic heating strictly in the motor windings. Formula: 1.5 × I_max² × Rph. (Note: True 3-phase RMS sum). Physics: Dominant cause of motor thermal saturation.' },
      { key: 'trace_conduction_loss_w', label: 'Trace Loss', full: 'Trace Conduction Ohmic Loss', unit: 'W', dec: 2, explain: 'Definition: Ohmic heating dissipated physically inside the PCB traces. Formula: Dynamically evaluated from your PCB Trace dimensions/vias. Crucial for system integration.' },
      { key: 'system_total_loss_w', label: 'System total', full: 'Total System Power Loss', unit: 'W', dec: 1, explain: 'Definition: The true unified heat envelope of the drive. Formula: (P_fet × 6) + Cu_loss + Trace_loss + Driver_loss. Sizing metric for chassis cooling.' },
      { key: 'copper_area_per_fet_mm2', label: 'Cu pad / FET', full: 'Required PCB Copper Area per Switch', unit: 'mm²', dec: 0, explain: 'Definition: Only relevant for natural/enhanced PCB cooling. Formula: IPC convective heuristic (P × 645mm² / 30°C rise). Physics: Mechanically nullified (displays 0) if forced air or heatsinks are selected in system specs.' },
      { key: 'power_trace_width_mm', label: 'Min Trace Width', full: 'Baseline Minimum Power Trace Width', unit: 'mm', dec: 1, explain: 'Definition: Baseline trace width approximation. Physics: Actively switches between IPC-2221B and IPC-2152 depending on your System Config selection. Overrides automatically if PCB Trace module is used.' },
    ],
  },
  {
    key: 'input_capacitors', label: 'Bus Capacitors', icon: '🔋',
    rows: [
      { key: 'ripple_method', label: 'Method', full: 'Calculation Method', string: true, explain: 'Exact (using L_ph) vs Estimated (3-Phase SPWM factor M=0.9)' },
      { key: 'i_ripple_rms_a', label: 'Ripple current', full: 'RMS Bus Ripple Current', unit: 'A', dec: 2, explain: 'RMS bus ripple current drawn by the inverter switching' },
      { key: 'c_bulk_required_uf', label: 'C required', full: 'Required Bulk Capacitance', unit: 'µF', dec: 1, explain: 'I_ripple_rms / (8 × f_sw × dV_target)' },
      { key: 'n_bulk_caps', label: 'Cap count', full: 'Recommended Capacitor Quantity', unit: 'pcs', dec: 0, explain: 'C_bulk_required / 100uF (minimum of 4 to split ESR heating)' },
      { key: 'c_total_uf', label: 'C total', full: 'Total Installed Capacitance', unit: 'µF', dec: 0, explain: 'Total physical capacitance installed in the bank' },
      { key: 'v_ripple_actual_v', label: 'Actual ripple', full: 'Actual DC Bus Voltage Ripple', unit: 'V', dec: 3, explain: 'Actual voltage droop based on C_total selected' },
      { key: 'esr_budget_per_cap_mohm', label: 'ESR/cap budget', full: 'Thermal ESR Budget per Capacitor', unit: 'mΩ', dec: 1, explain: 'Maximum allowed ESR per capacitor to not exceed 105°C thermal bounds' },
    ],
  },
  {
    key: 'bootstrap_cap', label: 'Bootstrap', icon: '🔄',
    rows: [
      { key: 'c_boot_calculated_nf', label: 'C_boot min', full: 'Charge-Budget Minimum Bootstrap Capacitance', unit: 'nF', dec: 1,
        explain: 'Formula: C_min = Q_total / ΔV_droop_target. Q_total = Qg + I_leakage/fsw (gate charge + per-cycle leakage). This is the absolute physical minimum — below this, the gate will droop below the threshold threshold before the HS switch turns on.' },
      { key: 'c_boot_recommended_nf', label: 'C_boot standard', full: 'Recommended E12 Bootstrap Capacitor', unit: 'nF', dec: 0,
        explain: 'C_min × safety_margin (default 2×), then snapped UP to the nearest purchasable E12 standard value. The ×2 safety margin combats MLCC DC-bias capacitance derating and temperature degradation.' },
      { key: 'droop_actual_v', label: 'Droop (actual)', full: 'Actual Per-Cycle Gate Voltage Droop', unit: 'V', dec: 3,
        explain: 'droop_actual = Q_total / C_chosen. Since C_chosen > C_min, droop_actual < droop_target. This is the true gate voltage decay per switching cycle. Must leave sufficient margin above the driver VBS_UVLO threshold.' },
      { key: 'v_bootstrap_v', label: 'V_bootstrap', full: 'Peak Bootstrap Bias Voltage', unit: 'V', dec: 2,
        explain: 'V_boot = V_drive − Vf_diode. Maximum steady-state bootstrap voltage after the bootstrap diode. This is what the high-side MOSFET gate is driven to at the start of each HS on-time.' },
      { key: 'v_boot_min_v', label: 'V_boot min', full: 'Worst-Case Gate Voltage at End of HS On-Time', unit: 'V', dec: 2,
        explain: 'V_boot − droop_actual. Minimum gate voltage seen by the high-side MOSFET at end of maximum on-time. Must always exceed driver VBS_UVLO threshold (typically 5.3V for UCC27302A).' },
      { key: 'min_hs_on_time_ns', label: 'Min LS on-time', full: 'Minimum Low-Side On-Time per PWM Cycle', unit: 'ns', dec: 0,
        explain: 'Formula: t_refresh = 3τ = −τ × ln(0.05). Derived from exponential RC charging: Q_restored = C × droop_actual × (1 − exp(−t/τ)). Setting Q_restored = 95% × Q_total always yields exactly 3τ, independent of C or droop values. This is the hard duty-cycle constraint for bootstrap operation.' },
      { key: 'bootstrap_hold_time_ms', label: 'Hold time', full: 'Maximum Continuous High-Side ON Duration', unit: 'ms', dec: 1,
        explain: 't_hold = C_boot × droop_actual / I_leakage. Maximum time HS can remain continuously ON before the bootstrap cap droops below UVLO threshold. Directly coupled to driver quiescent current from the datasheet.' },
    ],
  },
  {
    key: 'dead_time', label: 'Dead Time', icon: '⏱️',
    rows: [
      { key: 'dt_minimum_ns', label: 'Minimum DT', full: 'Absolute Minimum Required Dead Time', unit: 'ns', dec: 0, explain: 't_off_delay + t_fall + t_prop_delay + 20ns baseline margin' },
      { key: 'dt_recommended_ns', label: 'Recommended DT', full: 'Recommended Safety Dead Time', unit: 'ns', dec: 0, explain: 'Minimum DT × 1.5x safety multiplier, snapped to MCU timer resolution' },
      { key: 'dt_actual_ns', label: 'Actual (MCU)', full: 'MCU Programmed Dead Time', unit: 'ns', dec: 0, explain: 'Final physical dead time pushed to the timer registers' },
      { key: 'dt_pct_of_period', label: 'DT %', full: 'Dead Time Percentage of Period', unit: '%', dec: 3, explain: 'Percentage of the PWM period consumed by dead-time (limits max duty cycle)' },
    ],
  },
  {
    key: 'snubber', label: 'RC Snubber', icon: '📡',
    rows: [
      { key: 'voltage_overshoot_v', label: 'V overshoot', full: 'Parasitic Inductance Voltage Overshoot', unit: 'V', dec: 1, warn: 10, danger: 20, explain: 'I_max × √(L_stray / C_oss)' },
      { key: 'v_sw_peak_v', label: 'V_sw peak', full: 'Peak Switch Node Voltage', unit: 'V', dec: 1, warn: 60, danger: 80, explain: 'V_bus_peak + Voltage Overshoot (must not exceed MOSFET V_ds_max)' },
      { key: 'rs_recommended_ohm', label: 'Rs snubber', full: 'Snubber Damping Resistor', unit: 'Ω', dec: 0, explain: 'Critical Damping: √(L_stray / C_oss) snapped to E24 series' },
      { key: 'cs_recommended_pf', label: 'Cs snubber', full: 'Snubber Damping Capacitor', unit: 'pF', dec: 0, explain: 'Capacitance required to damp oscillation: 3 × C_oss' },
      { key: 'p_total_all_snubbers_w', altKey: 'p_total_6_snubbers_w', label: 'Snubber power', full: 'Total Snubber Network Dissipation', unit: 'W', dec: 3, explain: 'N × (0.5 × C_s × V_peak² × f_sw)' },
    ],
  },
  {
    key: 'pcb_trace_thermal', label: 'PCB Trace Thermal', icon: '🔥',
    rows: [
      { key: 'worst_dt_c', label: 'Worst ΔT', full: 'Worst-Case Temperature Rise', unit: '°C', dec: 1, warn: 30, danger: 60, explain: 'Max of trace ΔT and via ΔT — IPC-2221B/2152 empirical model with ρ(T) iteration' },
      { key: 'max_conductor_temp_c', label: 'Max Temp', full: 'Maximum Conductor Temperature', unit: '°C', dec: 1, warn: 105, danger: 130, explain: 'T_ambient + ΔT_total — must not exceed FR4 Tg or max conductor temp' },
      { key: 'max_safe_current_a', label: 'Max Safe I', full: 'Maximum Safe Current (all layers)', unit: 'A', dec: 1, explain: 'IPC-2221B Imax at ΔT_allow across all copper layers — binary search with thermal feedback' },
      { key: 'voltage_drop_mv', label: 'V drop', full: 'Trace Voltage Drop', unit: 'mV', dec: 2, explain: 'I × R_total (trace + via), with ρ(T) temperature correction' },
      { key: 'power_dissipated_w', label: 'P loss', full: 'Trace Ohmic Power Dissipation', unit: 'W', dec: 3, explain: 'I² × R_total — contributes to system total loss budget' },
      { key: 'current_density_a_mm2', label: 'J density', full: 'Current Density per Layer', unit: 'A/mm²', dec: 2, warn: 8, danger: 15, explain: 'I_per_layer / (W × T_copper) — IPC limit ~8 A/mm² external, ~15 A/mm² critical' },
      { key: 'thermal_status', label: 'Status', full: 'Thermal Status', string: true, explain: 'Overall assessment: safe/warn/danger based on ΔT, Tmax, J_density, and via thermal' },
    ],
  },
  {
    key: 'emi_dm', label: 'EMI DM Noise', icon: '📻',
    rows: [
      { key: 'harmonic_freq_khz', label: 'Eval harmonic', full: 'Evaluated CISPR Harmonic Frequency', unit: 'kHz', dec: 1, explain: 'First harmonic of fsw that falls within the CISPR 25 conducted emissions band (> 150 kHz).' },
      { key: 'dm_noise_harmonic_dbmuv', label: 'DM noise', full: 'Estimated DM Noise at CISPR Harmonic', unit: 'dBµV', dec: 1, warn: 56, danger: 79, explain: 'Estimated differential-mode conducted emission at evaluated harmonic. Model: V_bus × C_mlcc × 2π × fsw × Z_LISN / n (Fourier harmonic decay).' },
      { key: 'cispr_limit_dbmuv', label: 'CISPR 25 limit', full: 'CISPR 25 Class 3 Limit at Harmonic', unit: 'dBµV', dec: 0, explain: 'CISPR 25 Class 3 quasi-peak limit: 79 dBµV (0.15–0.53 MHz), 56 dBµV (0.53–1.7 MHz).' },
      { key: 'required_attenuation_db', label: 'Attenuation needed', full: 'Required DM Filter Attenuation', unit: 'dB', dec: 1, warn: 20, danger: 40, explain: 'How much the DM noise exceeds the CISPR limit. This is how much the DM filter must attenuate.' },
      { key: 'filter_attenuation_db', label: 'Filter provides', full: 'Estimated DM Filter Attenuation (L_dm || C_x LC)', unit: 'dB', dec: 1, explain: 'Estimated -40dB/decade LC filter attenuation above corner frequency. L_dm = 1% of CM choke inductance.' },
      { key: 'additional_attenuation_db', label: 'Gap (needed−actual)', full: 'Attenuation Gap to Close', unit: 'dB', dec: 1, warn: 10, danger: 20, explain: 'Zero means filter is adequate. Positive = add more DM filtering (larger X cap or additional DM choke).' },
      { key: 'emi_filter_adequate', label: 'Filter OK?', full: 'DM Filter Adequate for CISPR 25 Class 3?', unit: '', dec: 0, explain: 'true = estimated DM filter provides enough attenuation for CISPR 25 Class 3.' },
      { key: 'dm_filter_corner_khz', label: 'Filter corner', full: 'DM LC Filter Corner Frequency', unit: 'kHz', dec: 1, explain: '1/(2π√(L_dm × C_x)). EMI attenuation is -40 dB/decade above this frequency.' },
    ],
  },
  {
    key: 'vpeak_check', label: 'V_peak Worst-Case', icon: '⚡',
    rows: [
      { key: 'v_bus_nominal_v', label: 'V_bus nominal', full: 'Nominal Bus Voltage', unit: 'V', dec: 1, explain: 'Configured nominal DC bus voltage from Settings.' },
      { key: 'v_supply_transient_v', label: 'Supply transient', full: 'Supply Transient Peak (V_bus × 1.1)', unit: 'V', dec: 1, explain: 'Worst-case supply voltage including ±10% grid variation (IEC 61000). Always add this on top of nominal.' },
      { key: 'v_overshoot_v', label: 'Switching overshoot', full: 'Switching Spike (L_stray × dI/dt)', unit: 'V', dec: 1, explain: 'Voltage spike from MOSFET turn-off into stray bus inductance. From snubber module: I_max × √(L_stray/Coss).' },
      { key: 'v_regen_delta_v', label: 'Regen overshoot', full: 'Regenerative Braking Delta Voltage', unit: 'V', dec: 1, explain: 'Additional bus voltage rise during regenerative braking, above supply transient. From motor back-EMF estimate.' },
      { key: 'v_peak_worst_v', label: 'Worst-case V_peak', full: 'Total Worst-Case Bus Voltage', unit: 'V', dec: 1, warn: 55, danger: 65, explain: 'Sum of supply transient + switching overshoot + regen overshoot. MOSFETs, TVS, OVP threshold must all be rated above this.' },
      { key: 'v_peak_configured_v', label: 'V_peak configured', full: 'System V_peak Setting', unit: 'V', dec: 1, explain: 'Peak voltage configured in Settings. Used for OVP threshold, TVS selection, MOSFET Vds rating.' },
      { key: 'v_peak_margin_v', label: 'V_peak margin', full: 'Margin: configured − worst-case', unit: 'V', dec: 1, warn: 5, danger: 0, explain: 'V_peak_configured − V_peak_worst. Negative = configured peak voltage is too low for the expected worst case.' },
      { key: 'v_peak_sufficient', label: 'V_peak OK?', full: 'Is Configured V_peak Sufficient?', unit: '', dec: 0, explain: 'true = configured peak voltage covers all worst-case scenarios.' },
    ],
  },
  {
    key: 'adc_bandwidth', label: 'ADC BW Check', icon: '📡',
    rows: [
      { key: 'adc_rate_msps', label: 'ADC rate', full: 'ADC Sample Rate', unit: 'MSPS', dec: 3, explain: 'Extracted from MCU datasheet. Used to validate Nyquist and current-loop bandwidth.' },
      { key: 'nyquist_limit_hz', label: 'Nyquist limit', full: 'Nyquist Frequency (2 × fsw)', unit: 'Hz', dec: 0, explain: 'ADC must sample faster than 2×fsw to avoid aliasing PWM current ripple into the feedback signal.' },
      { key: 'nyquist_ok', label: 'Nyquist OK?', full: 'Nyquist Check (f_adc > 2×fsw)', unit: '', dec: 0, explain: 'true = ADC rate exceeds Nyquist limit. false = aliasing risk.' },
      { key: 'samples_per_pwm_period', label: 'Samples/period', full: 'ADC Samples per PWM Period', unit: '', dec: 1, explain: 'f_adc / fsw. Must be ≥ 2 for Nyquist, ideally ≥ 10 for good current ripple rejection.' },
      { key: 'current_loop_bw_target_hz', label: 'CL BW target', full: 'Current-Loop Bandwidth Target (fsw/10)', unit: 'Hz', dec: 0, explain: 'Standard FOC rule: current-loop bandwidth = fsw/10 for stable control.' },
      { key: 'current_loop_bw_actual_hz', label: 'CL BW actual', full: 'Practical Current-Loop Bandwidth (f_adc/10)', unit: 'Hz', dec: 0, explain: 'f_adc/10 — achievable closed-loop BW limited by ADC update rate.' },
      { key: 'current_loop_bw_ok', label: 'CL BW OK?', full: 'Current-Loop BW ≥ fsw/10?', unit: '', dec: 0, explain: 'true = ADC rate supports target current-loop bandwidth. false = ADC too slow for full-speed FOC.' },
    ],
  },
  {
    key: 'thermal_multipoint', label: 'Thermal Multi-Point', icon: '🌡️',
    rows: [
      { key: 'worst_point', label: 'Worst point', full: 'Worst Thermal Operating Point', unit: '', dec: 0, string: true, explain: 'The operating point (stall/25%/50%/rated/max) with the highest junction temperature.' },
      { key: 'worst_tj_c', label: 'Worst Tj', full: 'Highest Junction Temperature Across All Points', unit: '°C', dec: 1, warn: 125, danger: 150, explain: 'Maximum junction temperature across all 5 operating points. Must be below Tj_max.' },
      { key: 'worst_margin_c', label: 'Worst margin', full: 'Thermal Margin at Worst Point', unit: '°C', dec: 1, warn: 30, danger: 10, explain: 'Tj_max − Tj_worst. Positive = safe. Negative = thermal runaway at that operating point.' },
      { key: 'tj_max_c', label: 'Tj max (rated)', full: 'MOSFET Maximum Rated Junction Temperature', unit: '°C', dec: 0, explain: 'From MOSFET datasheet.' },
      { key: 'rth_total', label: 'Rth total', full: 'Total Thermal Resistance', unit: '°C/W', dec: 3, explain: 'Rjc + Rcs + Rsa thermal stack used for all operating points.' },
    ],
  },
  {
    key: 'derating', label: 'Thermal Derating', icon: '📉',
    rows: [
      { key: 'design_t_amb_c', label: 'Design T_amb', full: 'Design-Point Ambient Temperature', unit: '°C', dec: 0, explain: 'Ambient temperature used for the design point (from Settings → Ambient Temperature).' },
      { key: 'design_i_max_a', label: 'Design I_max', full: 'Design-Point Max Phase Current', unit: 'A', dec: 0, explain: 'Configured max phase current from Settings.' },
      { key: 'rth_total', label: 'Rth total', full: 'Total Thermal Resistance (Rjc + Rcs + Rsa)', unit: '°C/W', dec: 3, explain: 'Junction-to-ambient thermal resistance stack used for derating model.' },
      { key: 'rds_alpha', label: 'Rds α', full: 'Rds(on) Temperature Exponent', unit: '', dec: 2, explain: 'Power-law exponent for Rds(on) vs Tj: Rds_hot = Rds25 × (Tj/298K)^α. Si≈2.1, SiC≈0.4.' },
    ],
  },
]

// Populate SECTION_LABELS from SECTIONS
for (const s of SECTIONS) {
  SECTION_LABELS[s.key] = s.label
}
