import React, { useState, useRef, useMemo } from 'react'
import { Zap, RefreshCw, ChevronDown, AlertTriangle, Maximize2, X, Eye, ArrowUpRight, ArrowDownRight, Scale, Pencil, CornerDownLeft } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'
import { CALC_CRITICAL } from './BlockPanel.jsx'
import { runCalculations, runReverseCalculation } from '../api.js'
import { fmtNum, thresholdClass } from '../utils.js'
import ComparisonCard, { MOSFET_DEPENDENT_SECTIONS } from './ComparisonCard.jsx'

// Directions for inline comparison annotations
const METRIC_DIRS = {
  voltage_margin_pct: 'higher', current_margin_pct: 'higher',
  conduction_loss_per_fet_w: 'lower', switching_loss_per_fet_w: 'lower',
  recovery_loss_per_fet_w: 'lower', total_loss_per_fet_w: 'lower',
  total_all_6_fets_w: 'lower', efficiency_mosfet_pct: 'higher',
  t_junction_est_c: 'lower', thermal_margin_c: 'higher',
  p_per_fet_w: 'lower', copper_area_per_fet_mm2: 'lower',
  system_total_loss_w: 'lower',
  dt_minimum_ns: 'lower', dt_recommended_ns: 'lower',
  dt_actual_ns: 'lower', dt_pct_of_period: 'lower',
  voltage_overshoot_v: 'lower', v_sw_peak_v: 'lower',
  p_total_all_snubbers_w: 'lower', p_total_6_snubbers_w: 'lower', min_hs_on_time_ns: 'lower',
}

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

// Quick verdict score from two result sets
function quickVerdictScore(resA, resB) {
  if (!resA || !resB) return null
  const metrics = [
    { key: 'total_loss_per_fet_w', section: 'mosfet_losses', dir: 'lower' },
    { key: 'efficiency_mosfet_pct', section: 'mosfet_losses', dir: 'higher' },
    { key: 't_junction_est_c', section: 'thermal', dir: 'lower' },
    { key: 'thermal_margin_c', section: 'thermal', dir: 'higher' },
    { key: 'dt_minimum_ns', section: 'dead_time', dir: 'lower' },
    { key: 'voltage_margin_pct', section: 'mosfet_rating_check', dir: 'higher' },
    { key: 'current_margin_pct', section: 'mosfet_rating_check', dir: 'higher' },
    { key: 'voltage_overshoot_v', section: 'snubber', dir: 'lower' },
  ]
  let a = 0, b = 0, t = 0
  for (const m of metrics) {
    const vA = resA?.[m.section]?.[m.key]
    const vB = resB?.[m.section]?.[m.key]
    if (vA == null || vB == null || typeof vA !== 'number' || typeof vB !== 'number') { t++; continue }
    if (Math.abs(vA - vB) < 0.001) { t++; continue }
    const aWins = m.dir === 'lower' ? vA < vB : vA > vB
    if (aWins) a++; else b++
  }
  return { a, b, t }
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
  const [compResults, setCompResults] = useState(null) // MOSFET B calc results
  const [showComparison, setShowComparison] = useState(false)
  const [reverseEditing, setReverseEditing] = useState({}) // { key: value_string }
  const [reverseResults, setReverseResults] = useState({}) // { key: result_object }
  const [reverseLoading, setReverseLoading] = useState({}) // { key: bool }

  function toggle(k) { setOpen(p => ({ ...p, [k]: !p[k] })) }
  function toggleTransMod(k) { setExpandedTransMods(p => ({ ...p, [k]: !p[k] })) }

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
      }

      // Run primary MOSFET calculation
      const result = await runCalculations({
        ...basePayload,
        mosfet_params: buildParamsDict(project.blocks.mosfet),
      })
      dispatch({ type: 'SET_CALCULATIONS', payload: result })

      // Run comparison MOSFET calculation if mosfet_b is uploaded and has valid params
      const mosfetB = project.blocks.mosfet_b
      if (mosfetB?.status === 'done' && mosfetB?.raw_data?.parameters?.length > 0) {
        try {
          const resultB = await runCalculations({
            ...basePayload,
            mosfet_params: buildParamsDict(mosfetB),
          })
          setCompResults(resultB)
          dispatch({ type: 'SET_COMPARISON_RESULTS', payload: resultB })
        } catch (eB) {
          console.warn('MOSFET B calculation failed:', eB.message)
          setCompResults(null)
          dispatch({ type: 'SET_COMPARISON_RESULTS', payload: null })
        }
      } else {
        setCompResults(null)
        dispatch({ type: 'SET_COMPARISON_RESULTS', payload: null })
      }

      if (warnings.length === 0) toast.success('Done!', { id: 'c' })
    } catch (e) {
      toast.error(e.message, { id: 'c' })
    } finally { setLoading(false); calcInFlight.current = false }
  }

  // Quick score for comparison button
  const quickScore = useMemo(() => quickVerdictScore(project.calculations, compResults), [project.calculations, compResults])
  const nameA = project.blocks.mosfet?.raw_data?.component_name || 'Primary'
  const nameB = project.blocks.mosfet_b?.raw_data?.component_name || 'Compare'

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

    return (
      <span className="section-meta-badge" title={`${hc} hardcoded constants, ${fb} fallback values used`}>
        {hc > 0 && <span className="smb-hc">{hc} HC</span>}
        {hc > 0 && fb > 0 && <span className="smb-sep">·</span>}
        {fb > 0 && <span className="smb-fb">{fb} FB</span>}
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

        {/* ── MOSFET Comparison Button (when comparing) ──────────── */}
        {C && compResults && quickScore && (
          <button className="btn comp-results-btn" onClick={() => setShowComparison(true)}>
            <Scale size={13} />
            <span>Compare: {nameA} vs {nameB}</span>
            <span className="comp-results-btn-badge">{quickScore.a}–{quickScore.t}–{quickScore.b}</span>
          </button>
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

                    // Inline comparison annotation
                    const compV = compResults?.[sec.key]?.[r.key]
                    const showComp = compV != null && MOSFET_DEPENDENT_SECTIONS.has(sec.key) && typeof compV === 'number'
                    const compDelta = showComp && v !== 0 ? ((compV - v) / Math.abs(v) * 100) : 0
                    const compDir = METRIC_DIRS[r.key]
                    const compBetter = compDir ? (compDir === 'lower' ? compV < v : compDir === 'higher' ? compV > v : null) : null

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
                                    onClick={() => setReverseEditing(p => ({ ...p, [r.key]: '' }))}
                                    title="Set target value (reverse calculate)"
                                  >
                                    <Pencil size={8} />
                                  </button>
                                )}
                              </>
                            )}
                            {showComp && compV !== v && !isEditing && (
                              <span className={`comp-inline ${compBetter === true ? 'better' : compBetter === false ? 'worse' : 'neutral'}`}
                                    title={`${project.blocks.mosfet_b?.raw_data?.component_name || 'MOSFET B'}: ${fmtNum(compV, r.dec ?? 3)}${r.unit ? ' ' + r.unit : ''}`}>
                                {compDelta > 0 ? <ArrowUpRight size={8} /> : <ArrowDownRight size={8} />}
                                <span>{fmtNum(compV, r.dec ?? 3)}</span>
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Reverse result card */}
                        {revResult && (
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

      {/* ── Grid Viewer Modal ─────────────────────────────────── */}
      {/* ── Comparison Slide-out Panel ───────────────────────── */}
      {showComparison && C && compResults && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex' }}>
          <div style={{ flex: 1, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }} onClick={() => setShowComparison(false)} />
          <div style={{
            width: '85%', maxWidth: 1000, background: 'var(--bg-1)',
            borderLeft: '1px solid var(--border-3)',
            boxShadow: '-10px 0 30px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column',
            animation: 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
          }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Scale size={18} style={{ color: 'var(--cyan)' }} />
                <h2 style={{ margin: 0, fontSize: 18, color: 'var(--txt-1)' }}>MOSFET Comparison</h2>
                <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>{nameA} vs {nameB}</span>
              </div>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowComparison(false)}><X size={20} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
              <ComparisonCard
                resultsA={C}
                resultsB={compResults}
                nameA={nameA}
                nameB={nameB}
                iMax={project.system_specs.max_phase_current}
              />
            </div>
          </div>
        </div>
      )}

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
      { key: 'vds_max_v', label: 'Vds max (rated)', full: 'Maximum Drain-to-Source Voltage', unit: 'V', dec: 1, explain: 'Maximum drain-source voltage from MOSFET datasheet' },
      { key: 'v_peak_v', label: 'V peak (system)', full: 'Peak System Bus Voltage', unit: 'V', dec: 1, explain: 'Peak bus voltage from system specs' },
      { key: 'voltage_margin_pct', label: 'Voltage margin', full: 'MOSFET Voltage Safety Margin', unit: '%', dec: 1, warn: 25, danger: 10, explain: '(Vds_max - V_peak) / Vds_max × 100 — need ≥ 20%' },
      { key: 'id_cont_a', label: 'Id cont (rated)', full: 'Continuous Drain Current', unit: 'A', dec: 1, explain: 'Continuous drain current rating from MOSFET datasheet' },
      { key: 'i_max_a', label: 'I max (system)', full: 'Maximum Phase Current', unit: 'A', dec: 1, explain: 'Maximum phase current from system specs' },
      { key: 'current_margin_pct', label: 'Current margin', full: 'MOSFET Current Safety Margin', unit: '%', dec: 1, warn: 30, danger: 10, explain: '(Id_cont - I_max) / Id_cont × 100' },
    ],
  },
  {
    key: 'driver_compatibility', label: 'Driver Compatibility', icon: '🔗',
    rows: [
      { key: 'vcc_min_v', label: 'VCC min', full: 'Driver Minimum Supply Voltage', unit: 'V', dec: 1, explain: 'Minimum supply voltage for gate driver IC' },
      { key: 'vcc_max_v', label: 'VCC max', full: 'Driver Maximum Supply Voltage', unit: 'V', dec: 1, explain: 'Maximum supply voltage for gate driver IC' },
      { key: 'gate_drive_v', label: 'V_drive (system)', full: 'System Gate Drive Voltage', unit: 'V', dec: 1, explain: 'Gate drive voltage from system specs' },
      { key: 'v_bootstrap_v', label: 'V bootstrap', full: 'Bootstrap Voltage', unit: 'V', dec: 2, explain: 'V_drive - diode Vf drop (0.5V Schottky)' },
      { key: 'vbs_uvlo_v', label: 'VBS UVLO', full: 'Bootstrap UVLO Threshold', unit: 'V', dec: 2, explain: 'Bootstrap under-voltage lockout threshold' },
      { key: 'bootstrap_margin_v', label: 'Boot margin', full: 'Bootstrap Voltage Margin', unit: 'V', dec: 2, warn: 1, danger: 0, explain: 'V_bootstrap - VBS_UVLO — must be positive' },
      { key: 'vih_v', label: 'Driver VIH', full: 'Driver High-Level Input Threshold', unit: 'V', dec: 2, explain: 'High-level input voltage threshold on driver' },
      { key: 'mcu_voh_v', label: 'MCU output high', full: 'MCU Output High Voltage', unit: 'V', dec: 1, explain: 'MCU output voltage (from VDD range or assumed 3.3V)' },
    ],
  },
  {
    key: 'adc_timing', label: 'ADC Timing', icon: '📊',
    rows: [
      { key: 'pwm_period_us', label: 'PWM period', full: 'PWM Switching Period', unit: 'µs', dec: 2, explain: '1 / f_sw' },
      { key: 'sampling_window_us', label: 'Sample window', full: 'Center-Aligned Sampling Window', unit: 'µs', dec: 2, explain: '10% of half-period (center-aligned)' },
      { key: 'adc_rate_msps', label: 'ADC rate', full: 'ADC Sampling Rate', unit: 'MSPS', dec: 2, explain: 'Extracted ADC sample rate from MCU datasheet' },
      { key: 'adc_conversion_us', label: 'Conversion time', full: 'Single ADC Conversion Time', unit: 'µs', dec: 3, explain: '1 / ADC_rate — time for one sample' },
      { key: 't_3_channel_us', label: '3-ch total time', full: '3-Channel Sequential Conversion Time', unit: 'µs', dec: 3, explain: '3 × conversion time (sequential sampling for 3-shunt)' },
      { key: 'adc_channels', label: 'ADC channels', full: 'Available MCU ADC Channels', unit: 'ch', dec: 0, explain: 'Total ADC channels from MCU datasheet' },
      { key: 'channels_needed', label: 'Channels needed', full: 'Required ADC Channels', unit: 'ch', dec: 0, explain: '3 current + bus V + 2 NTC + 1 BEMF = 7 min' },
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
    ],
  },
  {
    key: 'mosfet_losses', label: 'MOSFET Losses', icon: '🔥',
    rows: [
      { key: 'i_rms_switch_a', label: 'I_rms / switch', full: 'RMS Current per Switch (total)', unit: 'A', dec: 2, explain: 'Per-switch RMS (fundamental + ripple if Lph known). SPWM formula: I_pk × √(1/8 + M/3π)' },
      { key: 'i_rms_fundamental_a', label: 'I_rms (fund.)', full: 'Fundamental RMS per Switch', unit: 'A', dec: 2, explain: 'Fundamental-only: I_pk × √(1/8 + M/3π) — no ripple component' },
      { key: 'conduction_loss_per_fet_w', label: 'Cond. Loss / FET', unit: 'W', dec: 3, explain: 'I_rms² × Rds(on) × 1.5 temp derating — NO /2 (I_rms already per-switch)' },
      { key: 'switching_loss_per_fet_w', label: 'SW Loss / FET', unit: 'W', dec: 3, explain: 'Qgd-based Miller model using actual Rg from gate_resistors (driver-current-limited)' },
      { key: 'recovery_loss_per_fet_w', label: 'Recovery Loss / FET', unit: 'W', dec: 3, explain: 'Qrr × V_peak × fsw' },
      { key: 'body_diode_loss_per_fet_w', label: 'Body Diode / FET', unit: 'W', dec: 3, explain: 'Vf × I_avg × dt × fsw × 2 events — dead-time conduction loss' },
      { key: 'total_loss_per_fet_w', label: 'Total / FET', unit: 'W', dec: 3, warn: 8, danger: 15, explain: 'P_cond + P_sw + P_rr + P_gate + P_coss + P_body_diode' },
      { key: 'total_all_6_fets_w', label: 'Total (all FETs)', unit: 'W', dec: 1, warn: 40, danger: 60, explain: 'Total per FET × num_fets', dynamic: d => d?.num_fets ? `Total (×${d.num_fets} FETs)` : 'Total (all FETs)' },
      { key: 'efficiency_mosfet_pct', label: 'Efficiency', unit: '%', dec: 2, explain: '100 × (P_out) / (P_out + Total_Loss)' },
    ],
  },
  {
    key: 'gate_resistors', label: 'Gate Drive', icon: '⚡',
    rows: [
      { key: 'rg_on_recommended_ohm', label: 'Rg ON', full: 'Recommended Turn-On Gate Resistor', unit: 'Ω', dec: 2, explain: 'MAX( (V_drv - V_th)/I_source,  (V_drv - V_th)/(Qg/t_rise_target) ) - R_g_internal' },
      { key: 'rg_off_recommended_ohm', label: 'Rg OFF', full: 'Recommended Turn-Off Gate Resistor', unit: 'Ω', dec: 2, explain: 'MAX( V_drv/I_sink, Rg_on/2 ) - R_g_internal' },
      { key: 'rg_bootstrap_ohm', label: 'Rg Bootstrap', full: 'Bootstrap Charging Resistor', unit: 'Ω', dec: 0, explain: 'Hardcoded standard value (10Ω) to limit peak charging current' },
      { key: 'gate_rise_time_ns', label: 'Rise time', full: 'Actual Gate Rise Time', unit: 'ns', dec: 1, explain: 'Q_g / ( (V_drv - V_th) / Rg_on_total )' },
      { key: 'gate_fall_time_ns', label: 'Fall time', full: 'Actual Gate Fall Time', unit: 'ns', dec: 1, explain: 'Q_g / ( V_drv / Rg_off_total )' },
      { key: 'dv_dt_v_per_us', label: 'dV/dt', full: 'Drain-Source Voltage Slew Rate', unit: 'V/µs', dec: 1, explain: 'V_peak / t_rise_actual' },
    ],
  },
  {
    key: 'thermal', label: 'Thermal', icon: '🌡️',
    rows: [
      { key: 't_junction_est_c', label: 'Tj estimated', full: 'Estimated Junction Temperature', unit: '°C', dec: 1, warn: 130, danger: 155, explain: 'T_ambient + (P_fet × (R_thJC + R_thCS + R_thSA))' },
      { key: 'tj_max_rated_c', label: 'Tj max rated', full: 'Maximum Rated Junction Temperature', unit: '°C', dec: 0, explain: 'Absolute maximum junction temp from MOSFET datasheet' },
      { key: 'thermal_margin_c', label: 'Thermal margin', full: 'Thermal Safety Margin', unit: '°C', dec: 1, warn: 30, danger: 0, explain: 'Tj_max_rated - Tj_estimated' },
      { key: 'p_per_fet_w', label: 'P / FET', full: 'Power Dissipation per Switch', unit: 'W', dec: 3, explain: 'Total power dissipation per individual switch' },
      { key: 'motor_copper_loss_w', label: 'Motor Cu loss', full: 'Motor Copper Stator Loss', unit: 'W', dec: 1, explain: '3 × I_rms² × Rph — motor winding copper loss (requires Rph in Motor tab)' },
      { key: 'system_total_loss_w', label: 'System total', full: 'Total System Power Loss', unit: 'W', dec: 1, explain: 'MOSFET losses (×6) + motor copper loss — full system power budget' },
      { key: 'copper_area_per_fet_mm2', label: 'Cu area / FET', full: 'Required PCB Copper Area per Switch', unit: 'mm²', dec: 0, explain: 'IPC-2152 estimate for required 3oz copper area to maintain steady state' },
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
      { key: 'c_boot_calculated_nf', label: 'C_boot required', full: 'Calculated Minimum Bootstrap Capacitance', unit: 'nF', dec: 1, explain: '(Q_g + I_leakage×t_on) / dV_boot_droop' },
      { key: 'c_boot_recommended_nf', label: 'C_boot standard', full: 'Recommended Standard Bootstrap Capacitor', unit: 'nF', dec: 0, explain: 'Calculated requirement buffered by 2x safety margin and snapped to E12 series' },
      { key: 'v_bootstrap_v', label: 'V_bootstrap', full: 'Expected Bootstrap Bias Voltage', unit: 'V', dec: 2, explain: 'V_drive - V_diode_drop' },
      { key: 'min_hs_on_time_ns', label: 'Min on-time', full: 'Minimum Low-Side On-Time', unit: 'ns', dec: 0, explain: '3 × R_boot × C_boot (time required to recharge bootstrap capacitor to ~95%)' },
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
]

// Populate SECTION_LABELS from SECTIONS
for (const s of SECTIONS) {
  SECTION_LABELS[s.key] = s.label
}
