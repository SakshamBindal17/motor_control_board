import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Link2, Unlink } from 'lucide-react'
import { useProject } from '../context/ProjectContext.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'
import { fmtNum } from '../utils.js'
import {
  iterativeSolve, buildSolverParams, assessStatus,
  computeRecommendations, getCoolingParams, OZ2MM,
  TRACE_SAFE_DT, VIA_SAFE_DT, CD_SAFE, normalizeTraceModel,
} from '../utils/thermalTraceCalc.js'

// ─── Field Config ─────────────────────────────────────────────────────
const OZ_OPTIONS = [
  { value: 1, label: '1 oz (35µm)' },
  { value: 2, label: '2 oz (70µm)' },
  { value: 3, label: '3 oz (105µm)' },
  { value: 4, label: '4 oz (140µm)' },
  { value: 6, label: '6 oz (210µm)' },
]

const COOLING_MODES = [
  { value: 'natural', label: 'Natural Convection', icon: '🌡️', tip: 'Default still air. Uses standard convection cooling approximations.' },
  { value: 'enhanced', label: 'Enhanced PCB', icon: '📐', tip: 'Solid copper planes adjacent to the trace that rapidly spread heat away horizontally.' },
  { value: 'forced', label: 'Forced Air', icon: '💨', tip: 'Active fan cooling or extreme draft. Dramatically strips away thermal boundary layers.' },
  { value: 'heatsink', label: 'Bolted Heatsink', icon: '🧊', tip: 'Aluminum heatsink directly bolted to the PCB using a thermal pad or paste interface.' },
]

const MODEL_OPTIONS = [
  { value: '2221', label: 'IPC-2221B', note: 'Conservative, widely used' },
  { value: '2152', label: 'IPC-2152', note: 'Newer, with correction factors' },
]

// ─── Helpers ──────────────────────────────────────────────────────────
function StatusBanner({ status }) {
  if (!status) return null
  const bg = status.level === 'danger' ? 'rgba(255,68,68,.08)' :
             status.level === 'warn'   ? 'rgba(255,171,0,.08)' :
                                         'rgba(0,230,118,.06)'
  const border = status.level === 'danger' ? 'var(--red)' :
                 status.level === 'warn'   ? 'var(--amber)' : 'var(--green)'
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8,
      background: bg, border: `1px solid ${border}30`,
      display: 'flex', alignItems: 'center', gap: 10,
      fontSize: 12, color: border, fontWeight: 500,
    }}>
      <span style={{ fontSize: 18 }}>{status.icon}</span>
      <span>{status.message}</span>
    </div>
  )
}

function ResultCard({ label, value, unit, icon, status, explain }) {
  const color = status === 'danger' ? 'var(--red)' :
                status === 'warn'   ? 'var(--amber)' : 'var(--green)'
  return (
    <div data-tip={explain} style={{
      background: 'var(--bg-3)', borderRadius: 10, padding: '12px 14px',
      border: `1px solid ${color}25`, display: 'flex', flexDirection: 'column', gap: 4,
      flex: '1 1 140px', minWidth: 130,
    }}>
      <div style={{ fontSize: 10, color: 'var(--txt-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {icon && <span style={{ marginRight: 4 }}>{icon}</span>}{label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color }}>
        {value}
        <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 4, color: 'var(--txt-3)' }}>{unit}</span>
      </div>
    </div>
  )
}

function BreakdownRow({ label, val, tip }) {
  return (
    <div data-tip={tip} className="brow" style={{ cursor: tip ? 'help' : 'default', display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--border-1)', fontSize: 13, gap: 12 }}>
      <span className="brow-k" style={{ color: 'var(--txt-2)' }}>{label}</span>
      <span className="brow-v" style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt-1)', fontWeight: 500, textAlign: 'right' }}>{val}</span>
    </div>
  )
}

function Field({ label, unit, value, onChange, min, max, step, type, note, disabled, isLinked, onToggleLink, systemValue, tip }) {
  const displayVal = isLinked && value == null ? systemValue : value;
  const hasError = min != null && displayVal !== '' && parseFloat(displayVal) < min;

  return (
    <div data-tip={tip} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt-2)' }}>
          {label}
          {unit && <span style={{ fontSize: 10, color: 'var(--txt-3)', fontWeight: 400, marginLeft: 4 }}>[{unit}]</span>}
        </label>
        {onToggleLink && (
          <button
            className={`btn btn-ghost btn-icon`}
            style={{ padding: 2, height: 'auto', color: isLinked ? 'var(--green)' : 'var(--txt-3)' }}
            onClick={onToggleLink}
            data-tip={isLinked ? `Linked to Project Spec (${systemValue}${unit})` : "Unlinked (User override)"}
          >
            {isLinked ? <Link2 size={12} /> : <Unlink size={12} />}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="number"
          className="inp inp-mono inp-sm"
          value={displayVal}
          onKeyDown={e => {
            if (e.key === '-' || e.key === 'e' || e.key === 'E' || e.key === '+') {
              e.preventDefault();
            }
          }}
          onChange={e => {
            if (isLinked && onToggleLink) onToggleLink()
            onChange(e.target.value)
          }}
          min={min != null ? min : 0} step={step || 'any'}
          disabled={disabled}
          style={{ width: '100%', borderColor: hasError ? 'var(--red)' : isLinked ? 'var(--green)40' : undefined, color: hasError ? 'var(--red)' : undefined }}
        />
        {hasError && <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700, whiteSpace: 'nowrap' }}>&lt; {min}</span>}
      </div>
      {note && <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>{note}</span>}
    </div>
  )
}

function SectionHead({ children, icon }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
      padding: '8px 0 4px', borderBottom: '1px solid var(--border-1)',
      display: 'flex', alignItems: 'center', gap: 6,
      textTransform: 'uppercase', letterSpacing: '.05em',
    }}>
      {icon && <span>{icon}</span>}
      {children}
    </div>
  )
}

function VerticalLayerBar({ label, dT, maxDT, explain }) {
  const pct = maxDT > 0 ? Math.min(100, (dT / maxDT) * 100) : 0
  const isDanger = dT > 60
  const isWarn = dT > TRACE_SAFE_DT
  const innerBg = isDanger ? 'var(--red)' : isWarn ? 'var(--amber)' : 'var(--green)'
  return (
    <div data-tip={explain} className="layer-chip" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <div className="bar-outer" style={{
        width: 32, height: 56, background: 'var(--bg-3)', border: '1px solid var(--border-2)',
        borderRadius: 4, overflow: 'hidden', position: 'relative', display: 'flex', alignItems: 'flex-end',
        transition: 'all 0.2s',
      }}>
        <div style={{
          width: '100%', height: `${pct}%`, background: innerBg,
          transition: 'height .25s, background .25s'
        }} />
      </div>
      <div style={{ fontSize: 9, color: 'var(--txt-3)', textAlign: 'center', lineHeight: 1.4, fontFamily: 'var(--font-mono)' }}>
        {label}
      </div>
      <div style={{ fontSize: 10, color: 'var(--txt-2)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
        {fmtNum(dT, 1)}°
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────
export default function ThermalTracePanel({ config }) {
  const { state, dispatch } = useProject()

  // Inject layer chip styles dynamically to guarantee glow effect
  React.useEffect(() => {
    if (!document.getElementById('layer-chip-style')) {
      const style = document.createElement('style')
      style.id = 'layer-chip-style'
      style.innerHTML = `
        .layer-chip { cursor: help; border-radius: 6px; padding: 4px; transition: all 0.2s ease; }
        .layer-chip:hover { background: rgba(255,255,255,0.03); }
        .layer-chip:hover .bar-outer { border-color: var(--green); box-shadow: 0 0 8px var(--green)40; }
      `
      document.head.appendChild(style)
    }
  }, [])
  const { project } = state
  const P = project.pcb_trace_thermal?.params || {}
  const specs = project.system_specs
  // eslint-disable-next-line no-unused-vars
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [showRecos, setShowRecos] = useState(true)

  // Update a param
  const setP = useCallback((key, val) => {
    let parsed = val
    if (typeof val === 'string') {
      if (val === '') parsed = ''
      else {
        const n = parseFloat(val)
        parsed = Number.isFinite(n) ? n : val
      }
    }
    dispatch({ type: 'SET_PCB_TRACE_PARAMS', payload: { [key]: parsed } })
  }, [dispatch])

  // Sync cooling mode bidirectional with system specs
  useEffect(() => {
    const sysMapFwd = { natural: 'natural', enhanced: 'custom', forced: 'forced_air', heatsink: 'heatsink' }
    const sysMapRev = { natural: 'natural', custom: 'enhanced', forced_air: 'forced', heatsink: 'heatsink' }
    
    const specCool = specs.cooling || 'natural'
    const pcbCool = P.cooling_mode || 'natural'

    if (sysMapFwd[pcbCool] !== specCool) {
      // Out of sync. Decide who wins. If this component just mounted/updated P, maybe we push to spec.
      // Easiest robust way: if P.cooling_mode recently changed by user, push to spec.
      // If specs.cooling was passed down and differs, assume it changed outside and pull it in.
      // Let's rely on standard unidirectional dispatch + an inverse watcher.
    }
  }, [P.cooling_mode, specs.cooling]) // eslint-disable-line react-hooks/exhaustive-deps

  // Let's do a strict bidirectional hook:
  const handleSetCooling = (mode) => {
    setP('cooling_mode', mode)
    const sysMapFwd = { natural: 'natural', enhanced: 'custom', forced: 'forced_air', heatsink: 'heatsink' }
    dispatch({ type: 'SET_SYSTEM_SPECS', payload: { cooling: sysMapFwd[mode] } })
  }

  // Watch for external system spec changes to cooling
  useEffect(() => {
    const sysMapRev = { natural: 'natural', custom: 'enhanced', forced_air: 'forced', heatsink: 'heatsink' }
    const mapped = sysMapRev[specs.cooling] || 'natural'
    if (P.cooling_mode && P.cooling_mode !== mapped) {
       setP('cooling_mode', mapped)
    }
  }, [specs.cooling]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build solver params with system spec fallbacks
  const solverParams = useMemo(() => buildSolverParams(P, specs), [P, specs])
  const normalizedModel = useMemo(() => normalizeTraceModel(P.model), [P.model])

  // Run calculation
  const result = useMemo(() => iterativeSolve(solverParams), [solverParams])

  // Status assessment
  const status = useMemo(() => assessStatus(result, solverParams), [result, solverParams])

  // Recommendations
  const recos = useMemo(() => {
    if (!result || status.level === 'safe') return []
    return computeRecommendations(solverParams, result)
  }, [solverParams, result, status.level])

  // Persist results to project state for backend coupling
  useEffect(() => {
    if (result) {
      const dT = result.dT_total
      const tmax = solverParams.Ta + dT
      const margin = solverParams.Tmax_allow - tmax
      dispatch({
        type: 'SET_PCB_TRACE_RESULTS',
        payload: {
          worst_dt_c: Math.max(dT, result.dT_via || 0),
          max_conductor_temp_c: tmax,
          max_safe_current_a: result.Imax_total,
          voltage_drop_v: result.Vdrop,
          voltage_drop_mv: result.Vdrop * 1000,
          power_dissipated_w: result.Ploss,
          current_density_a_mm2: result.CD,
          thermal_status: status.message,
          thermal_status_level: status.level,
          thermal_margin_c: margin,
        },
      })
    }
  }, [result, status, solverParams.Ta, solverParams.Tmax_allow, dispatch])

  // Helper: effective current/ambient
  const effCurrent = P.current_a ?? specs.max_phase_current ?? 80
  const effAmbient = P.ambient_c ?? specs.ambient_temp_c ?? 30
  const totalLayers = (P.n_external_layers ?? 2) + (P.n_internal_layers ?? 0)

  // ─── Result cards ─────────────────────────────────────────────
  const cards = result ? [
    {
      label: 'Worst ΔT (trace or via)', value: fmtNum(Math.max(result.dT_total, result.dT_via || 0), 1), unit: '°C above ambient',
      explain: 'Worst-case temperature rise across all layers and vias. IPC formulas calculate this empirically.',
      status: result.dT_total > 60 ? 'danger' : result.dT_total > TRACE_SAFE_DT ? 'warn' : 'safe',
    },
    {
      label: 'Max conductor temp', value: fmtNum(solverParams.Ta + result.dT_total, 1), unit: '°C absolute',
      explain: `Calculated as Ambient (${solverParams.Ta}°C) + Worst ΔT. Must not exceed user-defined Max Conductor Temp margin, otherwise PCB damage can occur.`,
      status: (solverParams.Ta + result.dT_total) > solverParams.Tmax_allow ? 'danger' :
              (solverParams.Ta + result.dT_total) > solverParams.Tmax_allow * 0.9 ? 'warn' : 'safe',
    },
    {
      label: 'Max safe current', value: fmtNum(result.Imax_total, 1), unit: 'A at your ΔT limit',
      explain: 'Automatically reverse-calculated maximum safe current that this trace can carry without exceeding the specified max conductor temperature limit.',
      status: result.Imax_total < effCurrent ? 'danger' :
              result.Imax_total < effCurrent * 1.3 ? 'warn' : 'safe',
    },
    {
      label: 'Total voltage drop', value: fmtNum(result.Vdrop * 1000, 2), unit: 'mV (trace + via)',
      explain: 'Ohmic voltage loss: I × R_total. Resistance is dynamically calculated using ρ(T) (temperature-corrected copper resistivity) at peak temperature.',
      status: result.Vdrop > 1 ? 'danger' : result.Vdrop > 0.5 ? 'warn' : 'safe',
    },
    {
      label: 'Power dissipated', value: fmtNum(result.Ploss, 3), unit: 'W',
      explain: 'Ohmic power loss/heat: I² × R_total. This trace loss is automatically fed back to the main system thermal budget.',
      status: result.Ploss > 5 ? 'danger' : result.Ploss > 2 ? 'warn' : 'safe',
    },
    {
      label: 'Current density', value: fmtNum(result.CD, 2), unit: 'A/mm²',
      explain: 'Current per unit cross-sectional area. IPC typically recommends values below 8-15 A/mm², depending on acceptable ΔT.',
      status: result.CD > 15 ? 'danger' : result.CD > CD_SAFE ? 'warn' : 'safe',
    },
  ] : []

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0 }}>
      {/* ─── Left: Thermal Trace content ─────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, overflowY: 'auto', paddingRight: 4 }}>

        {/* Header */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${config.color}18`, border: `1px solid ${config.color}35`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>🔥</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>PCB Trace Thermal &amp; Power Loop Impedance</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
              IPC-2221B / IPC-2152 · Current capacity, ΔT, voltage drop, via thermal · Bus bar support · Loop inductance
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {MODEL_OPTIONS.map(m => (
              <button
                key={m.value}
                className={`btn btn-sm ${normalizedModel === m.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setP('model', m.value)}
                style={{ fontSize: 10, padding: '4px 10px' }}
                data-tip={m.note}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Input Panels */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

          {/* ── Trace Parameters ── */}
          <div className="card" style={{ padding: '10px 14px' }}>
            <SectionHead icon="📏">Trace Geometry</SectionHead>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
              <Field
                type="range" label="Current" unit="A" value={P.current_a}
                onChange={v => setP('current_a', v)}
                min={0.1} max={200} step={1}
                isLinked={P.current_a == null}
                onToggleLink={() => setP('current_a', P.current_a == null ? specs.max_phase_current || 80 : null)}
                systemValue={specs.max_phase_current || 80}
              />
              <Field
                type="range" label="Ambient" unit="°C" value={P.ambient_c}
                onChange={v => setP('ambient_c', v)}
                min={-40} max={125} step={1}
                isLinked={P.ambient_c == null}
                onToggleLink={() => setP('ambient_c', P.ambient_c == null ? specs.ambient_temp_c || 30 : null)}
                systemValue={specs.ambient_temp_c || 30}
              />
              <Field
                type="range" label="Trace Width" unit="mm" value={P.trace_width_mm ?? 7}
                onChange={v => setP('trace_width_mm', v)} min={0.1} max={50} step={0.5}
              />
              <Field
                type="range" label="Trace Length" unit="mm" value={P.trace_length_mm ?? 20}
                onChange={v => setP('trace_length_mm', v)} min={0.1} max={200} step={1}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt-2)' }}>Copper Weight</label>
                <select
                  className="inp inp-sm"
                  value={P.copper_oz ?? 2}
                  onChange={e => setP('copper_oz', parseInt(e.target.value))}
                  style={{ width: '100%' }}
                >
                  {OZ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <Field
                type="range" label="PCB Thickness" unit="mm" value={P.pcb_thickness_mm ?? 1.6}
                onChange={v => setP('pcb_thickness_mm', v)} min={0.4} max={4} step={0.1}
              />
              <Field
                type="range" label="Max Conductor Temp" unit="°C" value={P.max_conductor_temp_c ?? 105}
                onChange={v => setP('max_conductor_temp_c', v)} min={60} max={250} step={5}
                note="FR4 Tg = 130–180°C"
              />
              {/* Bus Bar Area — overrides IPC trace width × copper weight area */}
              <div style={{ gridColumn:'1/-1' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                  <span style={{ fontSize:11, fontWeight:600, color:'var(--txt-2)' }}>Bus Bar Area</span>
                  <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:4,
                    background:'rgba(100,181,246,.15)', border:'1px solid rgba(100,181,246,.35)',
                    color:'#64b5f6', letterSpacing:'.03em' }}>OPTIONAL</span>
                  <span style={{ fontSize:9, color:'var(--txt-4)' }}>
                    — overrides IPC trace area (width × Cu weight)
                  </span>
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <input
                    type="number" className="inp inp-mono"
                    placeholder="blank = use trace width × Cu weight"
                    value={P.busbar_area_mm2 ?? ''}
                    min={0.01} step={0.5}
                    onChange={e => setP('busbar_area_mm2', e.target.value === '' ? null : parseFloat(e.target.value))}
                    style={{ flex:1 }}
                  />
                  <span style={{ fontSize:11, color:'var(--txt-3)', fontFamily:'var(--font-mono)', flexShrink:0 }}>mm²</span>
                  {P.busbar_area_mm2 != null && (
                    <button
                      onClick={() => setP('busbar_area_mm2', null)}
                      style={{ fontSize:10, padding:'3px 8px', borderRadius:4, cursor:'pointer',
                        background:'rgba(255,68,68,.1)', border:'1px solid rgba(255,68,68,.3)', color:'var(--red)' }}>
                      × Clear
                    </button>
                  )}
                </div>
                {P.busbar_area_mm2 != null && P.busbar_area_mm2 > 0 && (
                  <div style={{ fontSize:10, color:'#64b5f6', marginTop:3 }}>
                    ⚡ Bus bar mode: cross-section = {P.busbar_area_mm2} mm² — e.g. a {(P.busbar_area_mm2 / 3).toFixed(1)}mm × 3mm copper strap
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Cooling Method ── */}
          <div className="card" style={{ padding: '10px 14px' }}>
            <SectionHead icon="❄️">Cooling Method</SectionHead>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {COOLING_MODES.map(m => (
                <button
                  key={m.value}
                  className={`btn btn-sm ${P.cooling_mode === m.value ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => handleSetCooling(m.value)}
                  style={{ fontSize: 10, padding: '4px 10px' }}
                  data-tip={m.tip}
                >
                  {m.icon} {m.label}
                </button>
              ))}
            </div>

            <div style={{ marginTop: 8 }}>
              {P.cooling_mode === 'natural' && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {['vertical', 'horizontal', 'enclosed'].map(o => (
                    <button
                      key={o}
                      className={`btn btn-sm ${P.orientation === o ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setP('orientation', o)}
                      style={{ fontSize: 10, padding: '3px 8px', textTransform: 'capitalize' }}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              {P.cooling_mode === 'enhanced' && (
                <Field
                  label="Spreading Factor" value={P.spreading_factor ?? 1.5}
                  onChange={v => setP('spreading_factor', v)} min={1} max={3} step={0.1}
                  note="1.0 = no help, 3.0 = heavy copper pour"
                  tip="Multiplier for heat spreading capability due to solid internal planes."
                />
              )}
              {P.cooling_mode === 'forced' && (
                <Field
                  label="Air Velocity" unit="m/s" value={P.air_velocity_ms ?? 1}
                  onChange={v => setP('air_velocity_ms', v)} min={0.1} max={30} step={0.5}
                  note="Typical fan = 1–5 m/s"
                  tip="LFM = m/s × 196.85. Exponentially increases the heat transfer coefficient 'h'."
                />
              )}
              {P.cooling_mode === 'heatsink' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <Field
                    label="θ_sa (Heatsink)" unit="°C/W" value={P.hs_theta_sa ?? 5}
                    onChange={v => setP('hs_theta_sa', v)} min={0.1} step={0.5}
                    tip="Thermal Resistance of the heatsink to ambient air."
                  />
                  <Field
                    label="θ_int (Interface)" unit="°C/W/cm²" value={P.hs_theta_int ?? 0.5}
                    onChange={v => setP('hs_theta_int', v)} min={0.01} step={0.1}
                    tip="Thermal Resistance of the thermal pad/paste per cm²."
                  />
                  <Field
                    label="Contact Area" unit="cm²" value={P.hs_contact_area_cm2 ?? 10}
                    onChange={v => setP('hs_contact_area_cm2', v)} min={0.5} step={1}
                    tip="Total physical area of contact between the PCB and Heatsink."
                  />
                </div>
              )}
            </div>

            {/* Effective h display */}
            {result && (
              <div data-tip="Absolute heat transfer coefficient empirically calculated radially around the trace based on chosen cooling method." style={{
                marginTop: 8, padding: '6px 10px', borderRadius: 6,
                background: 'var(--bg-4)', fontSize: 11, color: 'var(--txt-2)',
                display: 'flex', justifyContent: 'space-between', cursor: 'help',
              }}>
                <span>Effective h</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: config.color }}>
                  {fmtNum(solverParams.cooling.h, 1)} W/m²K
                </span>
              </div>
            )}
          </div>

          {/* ── Layer Stack ── */}
          <div className="card" style={{ padding: '10px 14px' }}>
            <SectionHead icon="📚">Layer Stack</SectionHead>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
              <Field
                label="External Layers" value={P.n_external_layers ?? 2}
                onChange={v => setP('n_external_layers', Math.min(2, Math.max(0, parseInt(v) || 0)))}
                min={0} max={2} step={1}
                note="Carrying current (max 2)"
                tip="Number of outermost trace layers carrying current. Excellent thermal shedding."
              />
              <Field
                label="Internal Layers" value={P.n_internal_layers ?? 0}
                onChange={v => setP('n_internal_layers', Math.max(0, parseInt(v) || 0))}
                min={0} max={20} step={1}
                note="Half the ΔT of external"
                tip="Number of internal plane layers packed inside the board. Heat becomes trapped easily."
              />
              <div style={{
                gridColumn: '1 / -1', padding: '8px 10px', borderRadius: 6,
                background: 'var(--bg-4)', fontSize: 11, color: 'var(--txt-2)',
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>Total copper layers</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: config.color }}>
                  {totalLayers}
                </span>
              </div>
            </div>

            {/* IPC-2152 Corrections (only visible in 2152 mode) */}
            {normalizedModel === '2152' && (
              <>
                <SectionHead icon="📊">IPC-2152 Correction Factors</SectionHead>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                  <Field
                    label="Plane Distance" unit="mm" value={P.plane_dist_mm ?? 0}
                    onChange={v => setP('plane_dist_mm', v)} min={0} step={0.1}
                    note="0 = no adjacent plane"
                  />
                  <Field
                    label="Copper Fill" unit="%" value={P.copper_fill_pct ?? 0}
                    onChange={v => setP('copper_fill_pct', v)} min={0} max={100} step={5}
                    note="Adjacent layer fill %"
                  />
                </div>
                {result?.corr && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    {[
                      ['Board', result.corr.Cf_board],
                      ['Plane', result.corr.Cf_plane],
                      ['Pour', result.corr.Cf_pour],
                      ['Total', result.corr.total],
                    ].map(([label, val]) => (
                      <div key={label} style={{
                        padding: '3px 8px', borderRadius: 4, background: 'var(--bg-4)',
                        fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--txt-2)',
                      }}>
                        {label}: <strong style={{ color: val < 0.9 ? 'var(--green)' : 'var(--txt-1)' }}>{fmtNum(val, 3)}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Via Array ── */}
          <div className="card" style={{ padding: '10px 14px' }}>
            <SectionHead icon="🔩">Via Array</SectionHead>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <label style={{ fontSize: 11, color: 'var(--txt-2)', fontWeight: 600 }}>Enable vias</label>
              <input
                type="checkbox"
                checked={P.vias_on !== false}
                onChange={e => setP('vias_on', e.target.checked)}
              />
            </div>
            {P.vias_on !== false && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
                <Field
                  label="Count" value={P.n_vias ?? 10}
                  onChange={v => setP('n_vias', v)} min={1} max={500} step={1}
                />
                <Field
                  label="Drill Ø" unit="mm" value={P.via_drill_mm ?? 0.3}
                  onChange={v => setP('via_drill_mm', v)} min={0.1} max={1.5} step={0.05}
                />
                <Field
                  label="Plating" unit="µm" value={P.via_plating_um ?? 25}
                  onChange={v => setP('via_plating_um', v)} min={10} max={75} step={5}
                />
              </div>
            )}
            {result && P.vias_on !== false && result.dT_via > 0 && (
              <div style={{
                marginTop: 8, padding: '6px 10px', borderRadius: 6,
                background: 'var(--bg-4)', fontSize: 11,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span style={{ color: 'var(--txt-3)' }}>Via ΔT</span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontWeight: 700,
                  color: result.dT_via > 60 ? 'var(--red)' : result.dT_via > VIA_SAFE_DT ? 'var(--amber)' : 'var(--green)',
                }}>
                  {fmtNum(result.dT_via, 1)}°C
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Results Section Reordered */}
        {result && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {cards.map(c => <ResultCard key={c.label} {...c} />)}
            </div>
            <StatusBanner status={status} />
          </>
        )}

        {/* ── Layer Stack Thermal Distribution ── */}
        {result && (
          <div className="card" style={{ padding: '10px 14px' }}>
            <SectionHead icon="📊">Layer-by-Layer Thermal Distribution</SectionHead>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
              {(() => {
                const maxDT = Math.max(result.dT_ext, result.dT_int, result.dT_via || 0, 1)
                const bars = []
                const nExt = P.n_external_layers ?? 2
                const nInt = P.n_internal_layers ?? 0
                for (let i = 0; i < nExt; i++) bars.push(<VerticalLayerBar key={`ext${i}`} label={`Ext L${i + 1}`} dT={result.dT_ext} maxDT={maxDT} explain={`External Layer ${i+1}\nK-factor = 0.048 (Better cooling exposure)\nΔT = ${fmtNum(result.dT_ext, 1)}°C`} />)
                for (let i = 0; i < nInt; i++) bars.push(<VerticalLayerBar key={`int${i}`} label={`Int L${i + 1}`} dT={result.dT_int} maxDT={maxDT} explain={`Internal Layer ${i+1}\nK-factor = 0.024 (Reduced convection cooling)\nΔT = ${fmtNum(result.dT_int, 1)}°C`} />)
                if (P.vias_on !== false && result.dT_via > 0) {
                  bars.push(<div key="sep" style={{ width: 1, height: 56, background: 'var(--border-2)', margin: '0 4px', alignSelf: 'flex-end', marginBottom: 28 }} />)
                  bars.push(<VerticalLayerBar key="via" label={<span>Via Array <span style={{fontSize:8,color:'var(--txt-3)'}}>×{P.n_vias??10}</span></span>} dT={result.dT_via} maxDT={maxDT} explain={`Via Array Thermal Resistance\nTotal array carries full total current\nΔT = ${fmtNum(result.dT_via, 1)}°C`} />)
                }
                return bars
              })()}
            </div>
            <div style={{ marginTop: 16, fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>
              Teal = safe (ΔT {'<'} 30°C) · Orange = elevated (30–60°C) · Red = critical ({'>'} 60°C) · E = external, I = internal
            </div>
          </div>
        )}

        {/* ── Recommendations ── */}
        {recos.length > 0 && (
          <div className="card" style={{ padding: '10px 14px' }}>
            <div
              onClick={() => setShowRecos(p => !p)}
              style={{
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
                padding: '8px 0 4px', borderBottom: '1px solid var(--border-1)',
                textTransform: 'uppercase', letterSpacing: '.05em',
              }}
            >
              <span>💡</span>
              Design Recommendations ({recos.length})
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--txt-3)' }}>
                {showRecos ? '▲' : '▼'}
              </span>
            </div>
            {showRecos && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {recos.map((rec, i) => (
                  <div key={i} style={{
                    padding: '8px 10px', borderRadius: 6,
                    background: rec.solves ? 'rgba(0,230,118,.05)' : 'rgba(255,171,0,.05)',
                    border: `1px solid ${rec.solves ? 'var(--green)' : 'var(--amber)'}20`,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                        background: rec.solves ? 'var(--green)' : 'var(--amber)',
                        color: '#000', flexShrink: 0
                      }}>
                        {rec.solves ? 'SOLVES' : 'PARTIAL'}
                      </span>
                      <div style={{ fontSize: 12, color: 'var(--txt-1)', fontWeight: 500 }}>{rec.action}</div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', fontWeight: 600, textAlign: 'right' }}>
                      <span style={{ color: 'var(--green)' }}>-{fmtNum(rec.deltaDT, 1)}°C</span>
                      <span style={{ marginLeft: 6, color: 'var(--txt-2)' }}>-{fmtNum(rec.deltaCD, 1)} A/mm²</span>
                      {rec.deltaVia > 0.1 && <span style={{ marginLeft: 6, color: 'var(--amber)' }}>-{fmtNum(rec.deltaVia, 1)}°C(via)</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Full Parameter Breakdown ── */}
        {result && (
          <div className="card" style={{ padding: '10px 14px' }}>
            <SectionHead icon="⚡">Full Parameter Breakdown</SectionHead>
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
              {/* Breakdown Replaced Layout */}
              <BreakdownRow label="Copper thickness" val={`${Math.round((solverParams.oz ?? 2) * 35)} µm  (${(solverParams.oz ?? 2)} oz/ft²)`} tip="Base raw thickness of the selected weight copper." />
              <BreakdownRow label="Trace cross-section (per layer)" val={`${fmtNum(result.Amm2, 4)} mm²  (${fmtNum(result.Wmil, 1)} × ${fmtNum(result.Hmil, 2)} mil)`} tip="Geometric Cross Section Area = W × Thickness" />
              <BreakdownRow label="Total cross-section (all layers)" val={`${fmtNum(result.Amm2_tot, 4)} mm²`} tip="Total Area spreading the current across all defined PCB layers." />
              <BreakdownRow label="Current per layer" val={`${fmtNum(result.Iper, 2)} A`} tip="Assuming uniform current division among layers." />
              <BreakdownRow label="Current density per layer" val={<span>{fmtNum(result.CD, 2)} A/mm² {result.CD > 15 ? <span style={{color:'var(--red)'}}>⚠ HIGH</span> : result.CD > 8 ? <span style={{color:'var(--amber)'}}>(elevated)</span> : ''}</span>} tip="Amperage packed into 1 square millimeter. Above 8 requires caution." />
              <BreakdownRow label="ρ(T) at operating temp" val={`${fmtNum(result.rho_T * 1e5, 3)} × 10⁻⁵ Ω·mm  (temp-corrected)`} tip="Copper resistivity linearly scales worse as it gets hotter (+0.393% per °C)." />
              <BreakdownRow label="Trace R per layer" val={`${fmtNum(result.R_par * (solverParams.nExt + solverParams.nInt) * 1000, 4)} mΩ`} tip="Resistance of a single trace layer based on length and area and heat." />
              <BreakdownRow label="Parallel trace R" val={`${fmtNum(result.R_par * 1000, 4)} mΩ`} tip="Combined parallel resistance of all trace layers." />

              {result.vRes && (
                <>
                  <BreakdownRow label="Via barrel area (each)" val={`${fmtNum(result.vRes.A_barrel, 5)} mm²`} tip="Cross-section area of a single via's copper plating." />
                  <BreakdownRow label="Via R_th effective (each)" val={`${fmtNum(result.vRes.R_th_via, 1)} °C/W  (R_barrel/2)`} tip="Thermal resistance of a single via spreading heat into the board." />
                  <BreakdownRow label="Via R_el (each, at T)" val={`${fmtNum((result.vRes.R_el_via * (result.rho_T / 1.72e-5)) * 1000, 4)} mΩ`} tip="Electrical resistance of a single via at peak operating temperature." />
                  <BreakdownRow label="Via array R" val={`${fmtNum(result.R_via_par * 1000, 4)} mΩ`} tip="Total resistance of the entire via farm." />
                </>
              )}
              
              <BreakdownRow label="Total equivalent R" val={`${fmtNum(result.R_total * 1000, 4)} mΩ`} tip="Total trace resistance + Total via array resistance." />
              <BreakdownRow label="Voltage drop" val={`${fmtNum(result.Vdrop * 1000, 2)} mV`} tip="Ohm's law: I_total × R_equivalent." />
              <BreakdownRow label="Power dissipated" val={`${fmtNum(result.Ploss, 3)} W`} tip="Ohm's law: I² × R_equivalent." />
            </div>
            {solverParams.model === '2221' ? (
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', padding: '10px 14px', background: 'var(--bg-1)', borderRadius: 6, border: '1px solid var(--border-2)', wordBreak: 'break-all' }}>
                I = K · ΔT^0.44 · A^0.725 (IPC-2221)
              </div>
            ) : (
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', padding: '10px 14px', background: 'var(--bg-1)', borderRadius: 6, border: '1px solid var(--border-2)', wordBreak: 'break-all' }}>
                I = [K · ΔT^0.44 · A^0.725] · {fmtNum(result.corr?.total || 1, 3)} (IPC-2152 modified)
              </div>
            )}
          </div>
        )}


        {/* ── PCB Power Loop Impedance (moved from Passives tab) ── */}
        {(() => {
          const C        = state.project.calculations
          const pcbg     = C?.pcb_guidelines || {}
          const traceP   = state.project.pcb_trace_thermal?.params || {}
          const ovr      = state.project.blocks.passives?.overrides || {}
          const loopNh   = pcbg?.half_bridge_loop_calculated_nh
          const loopSt   = pcbg?.half_bridge_loop_status || 'unknown'
          const loopColor = loopSt === 'OK' ? 'var(--green)' : loopSt === 'WARNING' ? '#ffab40' : loopSt === 'CRITICAL' ? 'var(--red)' : 'var(--txt-4)'
          const tLayers  = (traceP.n_external_layers || 2) + (traceP.n_internal_layers || 0)

          function setTrace(k, v) {
            const n = parseFloat(v)
            dispatch({ type:'SET_PCB_TRACE_PARAMS', payload:{ [k]: Number.isFinite(n) ? n : undefined } })
          }
          function setOvrLocal(k, v) {
            const n = parseFloat(v)
            dispatch({ type:'SET_PASSIVES_OVERRIDE', payload:{ key:k, value: Number.isFinite(n) ? n : undefined } })
          }

          return (
            <div className="card" style={{ padding:'14px 16px' }}>
              {/* Header */}
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                <div style={{ width:34, height:34, borderRadius:9, flexShrink:0,
                  background:'rgba(100,181,246,.12)', border:'1px solid rgba(100,181,246,.3)',
                  display:'flex', alignItems:'center', justifyContent:'center', fontSize:17 }}>🖥️</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:13, color:'#64b5f6' }}>PCB Power Loop Impedance</div>
                  <div style={{ fontSize:10, color:'var(--txt-3)' }}>
                    Half-bridge commutation loop inductance · PCB layout guidelines
                  </div>
                </div>
              </div>

              {/* Inputs grid */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:12 }}>
                {[
                  { label:'Power Trace Width', unit:'mm', val: traceP.trace_width_mm ?? '', onChg: v => setTrace('trace_width_mm', v), ph:'e.g. 7' },
                  { label:'Power Trace Length', unit:'mm', val: traceP.trace_length_mm ?? '', onChg: v => setTrace('trace_length_mm', v), ph:'one-way, mm' },
                  { label:'PCB Layers', unit:'layers', val: tLayers > 0 ? tLayers : '', onChg: v => {
                    const n = Math.max(1, Math.round(parseFloat(v) || 2))
                    dispatch({ type:'SET_PCB_TRACE_PARAMS', payload:{ n_external_layers: Math.min(n,2), n_internal_layers: Math.max(0, n-2) } })
                  }, ph:'2' },
                  { label:'Gate Trace Width', unit:'mm', val: ovr.gate_trace_w_mm ?? '', onChg: v => setOvrLocal('gate_trace_w_mm', v), ph:'0.3' },
                  { label:'Power Clearance', unit:'mm', val: ovr.power_clearance_mm ?? '', onChg: v => setOvrLocal('power_clearance_mm', v), ph:'1.0' },
                ].map(f => (
                  <div key={f.label}>
                    <div style={{ fontSize:10, fontWeight:600, color:'var(--txt-3)', marginBottom:3 }}>
                      {f.label} <span style={{ fontFamily:'var(--font-mono)', color:'var(--txt-4)' }}>[{f.unit}]</span>
                    </div>
                    <input
                      type="number" className="inp inp-mono"
                      value={f.val} placeholder={f.ph}
                      onChange={e => f.onChg(e.target.value)}
                      style={{ width:'100%', fontSize:12, padding:'5px 8px' }}
                    />
                  </div>
                ))}
              </div>

              {/* Loop inductance result */}
              <div style={{
                padding:'10px 14px', borderRadius:8,
                background: loopNh != null ? `${loopColor}0e` : 'var(--bg-2)',
                border:`1px solid ${loopNh != null ? loopColor + '55' : 'var(--border-1)'}`,
                marginBottom:10,
              }}>
                <div style={{ fontSize:10, color:'var(--txt-3)', marginBottom:4 }}>
                  Half-Bridge Power Loop Inductance
                </div>
                <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                  <span style={{ fontSize:22, fontWeight:800, fontFamily:'var(--font-mono)', color: loopNh != null ? loopColor : 'var(--txt-4)' }}>
                    {loopNh != null ? `${+(loopNh / 1000).toFixed(4)}` : '—'}
                  </span>
                  <span style={{ fontSize:13, color:'var(--txt-3)' }}>µH</span>
                  {loopNh != null && (
                    <span style={{ marginLeft:'auto', fontSize:11, fontWeight:700, color: loopColor }}>
                      {loopSt === 'OK' ? '✓ GOOD' : loopSt === 'WARNING' ? '⚠ WARNING' : '✗ CRITICAL'}
                    </span>
                  )}
                </div>
                {loopNh != null && (
                  <div style={{ fontSize:10, color:'var(--txt-4)', marginTop:4 }}>
                    Target &lt; 0.005 µH · Current: {fmtNum(loopNh/1000, 4)} µH · Formula: L ≈ 0.4 × l × [ln(4l/(w+t)) + 0.5] nH
                  </div>
                )}
                {loopNh == null && (
                  <div style={{ fontSize:10, color:'var(--txt-4)', marginTop:4 }}>
                    Enter trace width and length above to calculate loop inductance.
                  </div>
                )}
              </div>

              {/* Guidelines grid */}
              {C && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
                  {[
                    { label:'Power trace width', val: pcbg.power_trace_w_mm != null ? `${fmtNum(pcbg.power_trace_w_mm,2)} mm` : '—' },
                    { label:'Gate trace width',  val: pcbg.gate_trace_w_mm  != null ? `${fmtNum(pcbg.gate_trace_w_mm,2)} mm`  : '—' },
                    { label:'Power clearance',   val: pcbg.power_clearance_mm != null ? `${fmtNum(pcbg.power_clearance_mm,1)} mm` : '—' },
                  ].map(r => (
                    <div key={r.label} style={{ background:'var(--bg-3)', borderRadius:7,
                      padding:'8px 10px', border:'1px solid var(--border-1)' }}>
                      <div style={{ fontSize:9.5, color:'var(--txt-3)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em', marginBottom:3 }}>{r.label}</div>
                      <div style={{ fontSize:14, fontWeight:700, fontFamily:'var(--font-mono)', color:'var(--txt-1)' }}>{r.val}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })()}

        {/* ── No-data placeholder ── */}
        {!result && (
          <div className="card" style={{ padding: '48px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔥</div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--txt-1)', marginBottom: 6 }}>
              PCB Trace Thermal Calculator
            </div>
            <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
              Enter trace parameters to calculate thermal performance using IPC-2221B/2152 standards.
            </div>
          </div>
        )}
      </div>

      {/* ─── Right: Calculations panel ─── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <CalculationsPanel />
      </div>
    </div>
  )
}
