import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link2, Unlink, Plus, Copy, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import { useProject } from '../context/ProjectContext.jsx'
import { fmtNum } from '../utils.js'
import {
  solveMultiSection, assessMultiSectionStatus,
  computeMultiSectionRecommendations, normalizeTraceModel,
  TRACE_SAFE_DT, VIA_SAFE_DT, CD_SAFE, DEFAULT_SECTION,
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

// ─── Status Helpers ──────────────────────────────────────────────────
const STATUS_ICON = { safe: '🟢', warn: '🟡', danger: '🔴' }
const STATUS_COLOR = { safe: 'var(--green)', warn: 'var(--amber)', danger: 'var(--red)' }

function StatusBanner({ status }) {
  if (!status) return null
  const bg = status.level === 'danger' ? 'rgba(255,68,68,.08)' :
             status.level === 'warn'   ? 'rgba(255,171,0,.08)' :
                                          'rgba(0,230,118,.06)'
  const border = STATUS_COLOR[status.level] || 'var(--green)'
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

function ResultCard({ label, value, unit, status, explain }) {
  const color = STATUS_COLOR[status] || 'var(--green)'
  return (
    <div data-tip={explain} style={{
      background: 'var(--bg-3)', borderRadius: 10, padding: '12px 14px',
      border: `1px solid ${color}25`, display: 'flex', flexDirection: 'column', gap: 4,
      flex: '1 1 140px', minWidth: 130,
    }}>
      <div style={{ fontSize: 10, color: 'var(--txt-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color }}>
        {value}
        <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 4, color: 'var(--txt-3)' }}>{unit}</span>
      </div>
    </div>
  )
}

function Field({ label, unit, value, onChange, min, max, step, note, disabled, isLinked, onToggleLink, systemValue, tip }) {
  const displayVal = isLinked && value == null ? systemValue : value
  const hasError = min != null && displayVal !== '' && parseFloat(displayVal) < min

  return (
    <div data-tip={tip} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--txt-2)' }}>
          {label}
          {unit && <span style={{ fontSize: 9, color: 'var(--txt-3)', fontWeight: 400, marginLeft: 3 }}>[{unit}]</span>}
        </label>
        {onToggleLink && (
          <button
            className="btn btn-ghost btn-icon"
            style={{ padding: 2, height: 'auto', color: isLinked ? 'var(--green)' : 'var(--txt-3)' }}
            onClick={onToggleLink}
            data-tip={isLinked ? `Linked to Project (${systemValue}${unit})` : "Unlinked (override)"}
          >
            {isLinked ? <Link2 size={11} /> : <Unlink size={11} />}
          </button>
        )}
      </div>
      <input
        type="number"
        className="inp inp-mono inp-sm"
        value={displayVal}
        onKeyDown={e => { if (e.key === '-' || e.key === 'e' || e.key === 'E' || e.key === '+') e.preventDefault() }}
        onChange={e => {
          if (isLinked && onToggleLink) onToggleLink()
          onChange(e.target.value)
        }}
        min={min != null ? min : 0} step={step || 'any'}
        disabled={disabled}
        style={{ width: '100%', fontSize: 11, padding: '4px 6px', borderColor: hasError ? 'var(--red)' : isLinked ? 'var(--green)40' : undefined }}
      />
      {note && <span style={{ fontSize: 9, color: 'var(--txt-3)' }}>{note}</span>}
    </div>
  )
}

function SectionHead({ children, icon }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
      padding: '6px 0 3px', borderBottom: '1px solid var(--border-1)',
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
    <div data-tip={explain} className="layer-chip" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div className="bar-outer" style={{
        width: 26, height: 44, background: 'var(--bg-3)', border: '1px solid var(--border-2)',
        borderRadius: 4, overflow: 'hidden', position: 'relative', display: 'flex', alignItems: 'flex-end',
        transition: 'all 0.2s',
      }}>
        <div style={{
          width: '100%', height: `${pct}%`, background: innerBg,
          transition: 'height .25s, background .25s'
        }} />
      </div>
      <div style={{ fontSize: 8, color: 'var(--txt-3)', textAlign: 'center', lineHeight: 1.3, fontFamily: 'var(--font-mono)' }}>
        {label}
      </div>
      <div style={{ fontSize: 9, color: 'var(--txt-2)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
        {fmtNum(dT, 1)}°
      </div>
    </div>
  )
}


// ─── Section Card Component ───────────────────────────────────────────
function SectionCard({ section, index, sectionCount, sectionResult, dispatch, isBottleneck }) {
  const level = sectionResult?.level || 'safe'
  const borderColor = STATUS_COLOR[level]

  const setS = useCallback((key, val) => {
    let parsed = val
    if (typeof val === 'string') {
      if (val === '') parsed = ''
      else {
        const n = parseFloat(val)
        parsed = Number.isFinite(n) ? n : val
      }
    }
    dispatch({ type: 'SET_PCB_TRACE_SECTION', payload: { sectionId: section.id, [key]: parsed } })
  }, [dispatch, section.id])

  const totalLayers = (section.n_external_layers ?? 2) + (section.n_internal_layers ?? 0)

  return (
    <div style={{
      minWidth: 270, maxWidth: 320, flex: '0 0 280px',
      background: 'var(--bg-2)', borderRadius: 12,
      border: `1.5px solid ${isBottleneck ? borderColor : 'var(--border-1)'}`,
      boxShadow: isBottleneck ? `0 0 12px ${borderColor}30` : 'none',
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
      scrollSnapAlign: 'start', transition: 'border-color .3s, box-shadow .3s',
    }}>
      {/* Header: Name + Status + Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>{STATUS_ICON[level]}</span>
        <input
          type="text" className="inp inp-sm"
          value={section.name || ''}
          onChange={e => setS('name', e.target.value)}
          placeholder={`Section ${index + 1}`}
          style={{ flex: 1, fontSize: 12, fontWeight: 600, background: 'transparent', border: '1px solid transparent', padding: '2px 6px', borderRadius: 4 }}
          onFocus={e => { e.target.style.borderColor = 'var(--border-2)'; e.target.style.background = 'var(--bg-3)' }}
          onBlur={e => { e.target.style.borderColor = 'transparent'; e.target.style.background = 'transparent' }}
        />
        {isBottleneck && (
          <span style={{ fontSize: 8, fontWeight: 800, padding: '2px 5px', borderRadius: 3,
            background: `${borderColor}20`, color: borderColor, letterSpacing: '.04em' }}>
            BOTTLENECK
          </span>
        )}
        <button
          className="btn btn-ghost btn-icon" style={{ padding: 3, height: 'auto' }}
          onClick={() => dispatch({ type: 'ADD_PCB_TRACE_SECTION', payload: { ...section, name: `${section.name} (copy)` } })}
          data-tip="Duplicate this section"
        >
          <Copy size={12} />
        </button>
        <button
          className="btn btn-ghost btn-icon" style={{ padding: 3, height: 'auto', color: sectionCount <= 1 ? 'var(--txt-4)' : 'var(--red)' }}
          onClick={() => dispatch({ type: 'REMOVE_PCB_TRACE_SECTION', payload: section.id })}
          disabled={sectionCount <= 1}
          data-tip={sectionCount <= 1 ? "Can't delete last section" : "Delete section"}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Trace Geometry */}
      <SectionHead icon="📏">Trace</SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <Field label="Width" unit="mm" value={section.trace_width_mm ?? 7}
          onChange={v => setS('trace_width_mm', v)} min={0.1} step={0.5} />
        <Field label="Length" unit="mm" value={section.trace_length_mm ?? 20}
          onChange={v => setS('trace_length_mm', v)} min={0.1} step={1} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--txt-2)' }}>Cu Weight</label>
          <select className="inp inp-sm" value={section.copper_oz ?? 2}
            onChange={e => setS('copper_oz', parseInt(e.target.value))}
            style={{ width: '100%', fontSize: 11, padding: '4px 4px' }}>
            {OZ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--txt-2)' }}>Bus Bar Area</label>
          <input type="number" className="inp inp-mono inp-sm"
            placeholder="auto" value={section.busbar_area_mm2 ?? ''}
            min={0.01} step={0.5}
            onChange={e => setS('busbar_area_mm2', e.target.value === '' ? null : parseFloat(e.target.value))}
            style={{ width: '100%', fontSize: 11, padding: '4px 6px' }}
          />
          <span style={{ fontSize: 8, color: 'var(--txt-4)' }}>mm² · blank = auto</span>
        </div>
      </div>

      {/* Layer Stack */}
      <SectionHead icon="📚">Layers</SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <Field label="External" value={section.n_external_layers ?? 2}
          onChange={v => setS('n_external_layers', Math.min(2, Math.max(0, parseInt(v) || 0)))}
          min={0} max={2} step={1} note="max 2" />
        <Field label="Internal" value={section.n_internal_layers ?? 0}
          onChange={v => setS('n_internal_layers', Math.max(0, parseInt(v) || 0))}
          min={0} step={1} />
      </div>
      <div style={{
        padding: '4px 8px', borderRadius: 5, background: 'var(--bg-4)',
        fontSize: 10, display: 'flex', justifyContent: 'space-between', color: 'var(--txt-2)',
      }}>
        <span>Total layers</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: borderColor }}>{totalLayers}</span>
      </div>

      {/* Via Array */}
      <SectionHead icon="🔩">Vias</SectionHead>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label style={{ fontSize: 10, color: 'var(--txt-2)', fontWeight: 600 }}>Enable</label>
        <input type="checkbox" checked={section.vias_on !== false}
          onChange={e => setS('vias_on', e.target.checked)} />
      </div>
      {section.vias_on !== false && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          <Field label="Count" value={section.n_vias ?? 10}
            onChange={v => setS('n_vias', v)} min={1} step={1} />
          <Field label="Drill" unit="mm" value={section.via_drill_mm ?? 0.3}
            onChange={v => setS('via_drill_mm', v)} min={0.1} step={0.05} />
          <Field label="Plate" unit="µm" value={section.via_plating_um ?? 25}
            onChange={v => setS('via_plating_um', v)} min={10} step={5} />
        </div>
      )}

      {/* Per-section mini result */}
      {sectionResult?.result && (
        <div style={{
          padding: '6px 8px', borderRadius: 6, background: `${borderColor}0a`,
          border: `1px solid ${borderColor}20`, display: 'flex', flexDirection: 'column', gap: 2,
          fontSize: 10, fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--txt-3)' }}>ΔT</span>
            <span style={{ color: borderColor, fontWeight: 700 }}>{fmtNum(sectionResult.result.dT_total, 1)}°C</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--txt-3)' }}>R</span>
            <span style={{ fontWeight: 600 }}>{fmtNum(sectionResult.result.R_total * 1000, 3)} mΩ</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--txt-3)' }}>Vdrop</span>
            <span style={{ fontWeight: 600 }}>{fmtNum(sectionResult.result.Vdrop * 1000, 2)} mV</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--txt-3)' }}>CD</span>
            <span style={{ fontWeight: 600, color: sectionResult.result.CD > CD_SAFE ? 'var(--amber)' : undefined }}>
              {fmtNum(sectionResult.result.CD, 2)} A/mm²
            </span>
          </div>
        </div>
      )}
    </div>
  )
}


// ─── Main Component ───────────────────────────────────────────────────
export default function ThermalTracePanel({ config }) {
  const { state, dispatch } = useProject()

  // Inject layer chip styles
  React.useEffect(() => {
    if (!document.getElementById('layer-chip-style')) {
      const style = document.createElement('style')
      style.id = 'layer-chip-style'
      style.innerHTML = `
        .layer-chip { cursor: help; border-radius: 6px; padding: 3px; transition: all 0.2s ease; }
        .layer-chip:hover { background: rgba(255,255,255,0.03); }
        .layer-chip:hover .bar-outer { border-color: var(--green); box-shadow: 0 0 8px var(--green)40; }
      `
      document.head.appendChild(style)
    }
  }, [])

  const { project } = state
  const ptt = project.pcb_trace_thermal
  const common = ptt?.common || {}
  const sections = ptt?.sections || [{ id: 'sec_1', name: 'Section 1', ...DEFAULT_SECTION }]
  const specs = project.system_specs

  const [showRecos, setShowRecos] = useState(true)
  const [showBreakdown, setShowBreakdown] = useState(true)
  const scrollRef = useRef(null)

  // Update common params
  const setC = useCallback((key, val) => {
    let parsed = val
    if (typeof val === 'string') {
      if (val === '') parsed = ''
      else {
        const n = parseFloat(val)
        parsed = Number.isFinite(n) ? n : val
      }
    }
    dispatch({ type: 'SET_PCB_TRACE_COMMON', payload: { [key]: parsed } })
  }, [dispatch])

  // Sync cooling mode
  const handleSetCooling = (mode) => {
    setC('cooling_mode', mode)
    const sysMapFwd = { natural: 'natural', enhanced: 'custom', forced: 'forced_air', heatsink: 'heatsink' }
    dispatch({ type: 'SET_SYSTEM_SPECS', payload: { cooling: sysMapFwd[mode] } })
  }
  useEffect(() => {
    const sysMapRev = { natural: 'natural', custom: 'enhanced', forced_air: 'forced', heatsink: 'heatsink' }
    const mapped = sysMapRev[specs.cooling] || 'natural'
    if (common.cooling_mode && common.cooling_mode !== mapped) setC('cooling_mode', mapped)
  }, [specs.cooling]) // eslint-disable-line react-hooks/exhaustive-deps

  const normalizedModel = useMemo(() => normalizeTraceModel(common.model), [common.model])

  // ── Run multi-section solver ──
  const multiResult = useMemo(
    () => solveMultiSection(sections, common, specs),
    [sections, common, specs]
  )

  const combined = multiResult?.combined || null
  const perSection = multiResult?.perSection || []
  const bottleneckIdx = multiResult?.bottleneckIdx ?? 0

  // Status assessment
  const status = useMemo(() => assessMultiSectionStatus(combined), [combined])

  // Recommendations
  const recos = useMemo(() => {
    if (!multiResult || status.level === 'safe') return []
    return computeMultiSectionRecommendations(sections, common, specs, multiResult)
  }, [sections, common, specs, multiResult, status.level])

  // Persist combined results for backend coupling
  useEffect(() => {
    if (combined) {
      dispatch({
        type: 'SET_PCB_TRACE_RESULTS',
        payload: {
          worst_dt_c: combined.worstDt,
          max_conductor_temp_c: combined.tmax_abs,
          max_safe_current_a: combined.Imax_safe,
          voltage_drop_v: combined.Vdrop_total,
          voltage_drop_mv: combined.Vdrop_total * 1000,
          power_dissipated_w: combined.Ploss_total,
          current_density_a_mm2: combined.CD_worst,
          thermal_status: status.message,
          thermal_status_level: status.level,
          thermal_margin_c: combined.margin,
          trace_power_loss_w: combined.Ploss_total,
        },
      })
    }
  }, [combined, status, dispatch])

  // Scroll handlers
  const scrollCards = (dir) => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: dir * 300, behavior: 'smooth' })
    }
  }

  const effCurrent = common.current_a ?? specs.max_phase_current ?? 80
  const effAmbient = common.ambient_c ?? specs.ambient_temp_c ?? 30

  // Build result cards from combined
  const cards = combined ? [
    {
      label: 'Worst ΔT (bottleneck)', value: fmtNum(combined.worstDt, 1), unit: '°C',
      explain: `Worst-case temperature rise across all ${combined.sectionCount} sections. The bottleneck section (with fewest layers or narrowest trace) determines this value.`,
      status: combined.dT_worst > 60 ? 'danger' : combined.dT_worst > TRACE_SAFE_DT ? 'warn' : 'safe',
    },
    {
      label: 'Max conductor temp', value: fmtNum(combined.tmax_abs, 1), unit: '°C',
      explain: `Ambient (${combined.Ta}°C) + Worst ΔT. Must not exceed Max Conductor Temp limit.`,
      status: combined.tmax_abs > combined.Tmax_allow ? 'danger' :
              combined.tmax_abs > combined.Tmax_allow * 0.9 ? 'warn' : 'safe',
    },
    {
      label: 'Max safe current', value: fmtNum(combined.Imax_safe, 1), unit: 'A',
      explain: 'Limited by the weakest section. The section with fewest layers or narrowest trace sets this ceiling.',
      status: combined.Imax_safe < effCurrent ? 'danger' :
              combined.Imax_safe < effCurrent * 1.3 ? 'warn' : 'safe',
    },
    {
      label: 'Total voltage drop', value: fmtNum(combined.Vdrop_total * 1000, 2), unit: 'mV',
      explain: `Sum of voltage drops across all ${combined.sectionCount} sections in series. Each section\'s Vdrop = I × R_section.`,
      status: combined.Vdrop_total > 1 ? 'danger' : combined.Vdrop_total > 0.5 ? 'warn' : 'safe',
    },
    {
      label: 'Total power dissipated', value: fmtNum(combined.Ploss_total, 3), unit: 'W',
      explain: `Sum of I²R losses across all sections. Fed back to the system thermal budget.`,
      status: combined.Ploss_total > 5 ? 'danger' : combined.Ploss_total > 2 ? 'warn' : 'safe',
    },
    {
      label: 'Worst current density', value: fmtNum(combined.CD_worst, 2), unit: 'A/mm²',
      explain: 'Current density in the most stressed section. IPC recommends < 8-15 A/mm².',
      status: combined.CD_worst > 15 ? 'danger' : combined.CD_worst > CD_SAFE ? 'warn' : 'safe',
    },
  ] : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>

      {/* ─── Header ─── */}
      <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: `${config.color}18`, border: `1px solid ${config.color}35`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
        }}>🔥</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>PCB Trace Thermal &amp; Bus Bar Analysis</div>
          <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
            IPC-2221B / IPC-2152 · Multi-section bus bar · Series chain thermal model
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {MODEL_OPTIONS.map(m => (
            <button
              key={m.value}
              className={`btn btn-sm ${normalizedModel === m.value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setC('model', m.value)}
              style={{ fontSize: 10, padding: '4px 10px' }}
              data-tip={m.note}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Common Parameters + Cooling ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

        {/* Common Params */}
        <div className="card" style={{ padding: '10px 14px' }}>
          <SectionHead icon="⚙️">Common Parameters</SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <Field label="Current" unit="A" value={common.current_a}
              onChange={v => setC('current_a', v)} min={0.1} step={1}
              isLinked={common.current_a == null}
              onToggleLink={() => setC('current_a', common.current_a == null ? specs.max_phase_current || 80 : null)}
              systemValue={specs.max_phase_current || 80}
            />
            <Field label="Ambient" unit="°C" value={common.ambient_c}
              onChange={v => setC('ambient_c', v)} min={-40} step={1}
              isLinked={common.ambient_c == null}
              onToggleLink={() => setC('ambient_c', common.ambient_c == null ? specs.ambient_temp_c || 30 : null)}
              systemValue={specs.ambient_temp_c || 30}
            />
            <Field label="PCB Thickness" unit="mm" value={common.pcb_thickness_mm ?? 1.6}
              onChange={v => setC('pcb_thickness_mm', v)} min={0.4} step={0.1} />
            <Field label="Max Conductor Temp" unit="°C" value={common.max_conductor_temp_c ?? 105}
              onChange={v => setC('max_conductor_temp_c', v)} min={60} step={5}
              note="FR4 Tg = 130–180°C" />
          </div>

          {/* IPC-2152 Corrections */}
          {normalizedModel === '2152' && (
            <>
              <SectionHead icon="📊">IPC-2152 Corrections</SectionHead>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                <Field label="Plane Distance" unit="mm" value={common.plane_dist_mm ?? 0}
                  onChange={v => setC('plane_dist_mm', v)} min={0} step={0.1} note="0 = no plane" />
                <Field label="Copper Fill" unit="%" value={common.copper_fill_pct ?? 0}
                  onChange={v => setC('copper_fill_pct', v)} min={0} max={100} step={5} />
              </div>
            </>
          )}
        </div>

        {/* Cooling Method */}
        <div className="card" style={{ padding: '10px 14px' }}>
          <SectionHead icon="❄️">Cooling Method</SectionHead>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {COOLING_MODES.map(m => (
              <button key={m.value}
                className={`btn btn-sm ${common.cooling_mode === m.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => handleSetCooling(m.value)}
                style={{ fontSize: 10, padding: '4px 10px' }}
                data-tip={m.tip}
              >
                {m.icon} {m.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            {common.cooling_mode === 'natural' && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['vertical', 'horizontal', 'enclosed'].map(o => (
                  <button key={o}
                    className={`btn btn-sm ${common.orientation === o ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setC('orientation', o)}
                    style={{ fontSize: 10, padding: '3px 8px', textTransform: 'capitalize' }}
                  >{o}</button>
                ))}
              </div>
            )}
            {common.cooling_mode === 'enhanced' && (
              <Field label="Spreading Factor" value={common.spreading_factor ?? 1.5}
                onChange={v => setC('spreading_factor', v)} min={1} max={3} step={0.1}
                note="1.0 = no help, 3.0 = heavy copper pour" />
            )}
            {common.cooling_mode === 'forced' && (
              <Field label="Air Velocity" unit="m/s" value={common.air_velocity_ms ?? 1}
                onChange={v => setC('air_velocity_ms', v)} min={0.1} max={30} step={0.5}
                note="Typical fan = 1–5 m/s" />
            )}
            {common.cooling_mode === 'heatsink' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Field label="θ_sa (Heatsink)" unit="°C/W" value={common.hs_theta_sa ?? 5}
                  onChange={v => setC('hs_theta_sa', v)} min={0.1} step={0.5} />
                <Field label="θ_int (Interface)" unit="°C/W/cm²" value={common.hs_theta_int ?? 0.5}
                  onChange={v => setC('hs_theta_int', v)} min={0.01} step={0.1} />
                <Field label="Contact Area" unit="cm²" value={common.hs_contact_area_cm2 ?? 10}
                  onChange={v => setC('hs_contact_area_cm2', v)} min={0.5} step={1} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Section Cards (Horizontal Scroll) ─── */}
      <div className="card" style={{ padding: '10px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <SectionHead icon="🔗">Bus Bar Sections ({sections.length})</SectionHead>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button className="btn btn-sm btn-ghost" onClick={() => scrollCards(-1)}
              style={{ padding: '3px 6px' }}><ChevronLeft size={14} /></button>
            <button className="btn btn-sm btn-ghost" onClick={() => scrollCards(1)}
              style={{ padding: '3px 6px' }}><ChevronRight size={14} /></button>
            <button className="btn btn-sm btn-primary" onClick={() => dispatch({ type: 'ADD_PCB_TRACE_SECTION' })}
              style={{ fontSize: 10, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Plus size={12} /> Add Section
            </button>
          </div>
        </div>

        <div ref={scrollRef} style={{
          display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 8,
          scrollSnapType: 'x mandatory', scrollBehavior: 'smooth',
        }}>
          {sections.map((sec, i) => (
            <SectionCard
              key={sec.id}
              section={sec}
              index={i}
              sectionCount={sections.length}
              sectionResult={perSection[i] || null}
              dispatch={dispatch}
              isBottleneck={i === bottleneckIdx && sections.length > 1}
            />
          ))}
        </div>

        {/* Section Summary Bar */}
        <div style={{
          marginTop: 6, padding: '6px 10px', borderRadius: 6,
          background: 'var(--bg-4)', fontSize: 11, fontFamily: 'var(--font-mono)',
          display: 'flex', justifyContent: 'space-between', color: 'var(--txt-2)',
        }}>
          <span>Total path: <strong style={{ color: config.color }}>{fmtNum(combined?.totalLength || 0, 1)} mm</strong>
            {sections.length > 1 && (
              <span style={{ color: 'var(--txt-3)' }}>
                {' '}= {sections.map(s => `${s.trace_length_mm ?? 0}`).join(' + ')} mm
              </span>
            )}
          </span>
          <span>{sections.length} section{sections.length > 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* ─── Unified Results ─── */}
      {combined && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {cards.map(c => <ResultCard key={c.label} {...c} />)}
          </div>
          <StatusBanner status={status} />
        </>
      )}

      {/* ─── Per-Section Breakdown Table ─── */}
      {combined && perSection.length > 0 && (
        <div className="card" style={{ padding: '10px 14px' }}>
          <div onClick={() => setShowBreakdown(p => !p)} style={{
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
            padding: '6px 0', borderBottom: '1px solid var(--border-1)',
            textTransform: 'uppercase', letterSpacing: '.05em',
          }}>
            <span>📊</span>
            Per-Section Breakdown
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--txt-3)' }}>
              {showBreakdown ? '▲' : '▼'}
            </span>
          </div>
          {showBreakdown && (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border-2)' }}>
                    {['Section', 'Layers', 'ΔT (°C)', 'R (mΩ)', 'Vdrop (mV)', 'Ploss (W)', 'CD (A/mm²)', 'Status'].map(h => (
                      <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 700, color: 'var(--txt-2)', fontSize: 10, textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {perSection.map((ps, i) => {
                    const r = ps.result
                    if (!r) return null
                    const isBottle = i === bottleneckIdx && sections.length > 1
                    const color = STATUS_COLOR[ps.level]
                    return (
                      <tr key={ps.section.id || i} style={{
                        borderBottom: '1px solid var(--border-1)',
                        background: isBottle ? `${color}08` : undefined,
                      }}>
                        <td style={{ padding: '6px 8px', fontWeight: isBottle ? 700 : 500 }}>
                          {ps.section.name || `Section ${i + 1}`}
                        </td>
                        <td style={{ padding: '6px 8px' }}>{(ps.section.n_external_layers ?? 2) + (ps.section.n_internal_layers ?? 0)}L</td>
                        <td style={{ padding: '6px 8px', color }}>{fmtNum(r.dT_total, 1)}</td>
                        <td style={{ padding: '6px 8px' }}>{fmtNum(r.R_total * 1000, 3)}</td>
                        <td style={{ padding: '6px 8px' }}>{fmtNum(r.Vdrop * 1000, 2)}</td>
                        <td style={{ padding: '6px 8px' }}>{fmtNum(r.Ploss, 3)}</td>
                        <td style={{ padding: '6px 8px', color: r.CD > CD_SAFE ? 'var(--amber)' : undefined }}>{fmtNum(r.CD, 2)}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <span style={{ fontSize: 13 }}>{STATUS_ICON[ps.level]}</span>
                          {isBottle && <span style={{ fontSize: 9, marginLeft: 4, color }}>← bottleneck</span>}
                        </td>
                      </tr>
                    )
                  })}
                  {/* Total row */}
                  <tr style={{ borderTop: '2px solid var(--border-2)', fontWeight: 700 }}>
                    <td style={{ padding: '6px 8px' }}>TOTAL</td>
                    <td style={{ padding: '6px 8px', color: 'var(--txt-3)' }}>—</td>
                    <td style={{ padding: '6px 8px', color: STATUS_COLOR[status.level] }}>{fmtNum(combined.dT_worst, 1)}</td>
                    <td style={{ padding: '6px 8px' }}>{fmtNum(combined.R_total * 1000, 3)}</td>
                    <td style={{ padding: '6px 8px' }}>{fmtNum(combined.Vdrop_total * 1000, 2)}</td>
                    <td style={{ padding: '6px 8px' }}>{fmtNum(combined.Ploss_total, 3)}</td>
                    <td style={{ padding: '6px 8px', color: combined.CD_worst > CD_SAFE ? 'var(--amber)' : undefined }}>{fmtNum(combined.CD_worst, 2)}</td>
                    <td style={{ padding: '6px 8px' }}><span style={{ fontSize: 13 }}>{STATUS_ICON[status.level]}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─── Layer-by-Layer Thermal Distribution ─── */}
      {combined && perSection.length > 0 && (
        <div className="card" style={{ padding: '10px 14px' }}>
          <SectionHead icon="📊">Layer-by-Layer Thermal Distribution</SectionHead>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
            {perSection.map((ps, secIdx) => {
              const r = ps.result
              if (!r) return null
              const sec = ps.section
              const nExt = sec.n_external_layers ?? 2
              const nInt = sec.n_internal_layers ?? 0
              const maxDT = Math.max(combined.dT_worst, combined.dT_via_worst || 0, 1)

              return (
                <div key={sec.id || secIdx} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--txt-2)', whiteSpace: 'nowrap', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {sec.name || `S${secIdx + 1}`}
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end' }}>
                    {Array.from({ length: nExt }, (_, i) => (
                      <VerticalLayerBar key={`e${i}`} label={`E${i+1}`} dT={r.dT_ext}
                        maxDT={maxDT} explain={`External L${i+1} · K=0.048 · ΔT=${fmtNum(r.dT_ext,1)}°C`} />
                    ))}
                    {Array.from({ length: nInt }, (_, i) => (
                      <VerticalLayerBar key={`i${i}`} label={`I${i+1}`} dT={r.dT_int}
                        maxDT={maxDT} explain={`Internal L${i+1} · K=0.024 · ΔT=${fmtNum(r.dT_int,1)}°C`} />
                    ))}
                    {sec.vias_on !== false && r.dT_via > 0 && (
                      <>
                        <div style={{ width: 1, height: 44, background: 'var(--border-2)', margin: '0 2px', alignSelf: 'flex-end', marginBottom: 22 }} />
                        <VerticalLayerBar label={`Via×${sec.n_vias??10}`} dT={r.dT_via}
                          maxDT={maxDT} explain={`Via Array · ΔT=${fmtNum(r.dT_via,1)}°C`} />
                      </>
                    )}
                  </div>
                  {/* Section separator */}
                  {secIdx < perSection.length - 1 && (
                    <div style={{ width: 1, height: '100%', minHeight: 30, background: 'var(--border-2)', margin: '0 4px' }} />
                  )}
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 10, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>
            🟢 safe (ΔT {'<'} 30°C) · 🟡 elevated (30–60°C) · 🔴 critical ({'>'} 60°C) · E=external, I=internal
          </div>
        </div>
      )}

      {/* ─── Recommendations ─── */}
      {recos.length > 0 && (
        <div className="card" style={{ padding: '10px 14px' }}>
          <div onClick={() => setShowRecos(p => !p)} style={{
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
            padding: '6px 0', borderBottom: '1px solid var(--border-1)',
            textTransform: 'uppercase', letterSpacing: '.05em',
          }}>
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
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── PCB Power Loop Impedance ─── */}
      {(() => {
        const C = state.project.calculations
        const pcbg = C?.pcb_guidelines || {}
        const ovr = state.project.blocks.passives?.overrides || {}

        // Compute per-section inductance from all sections
        const perSecL = sections.map(sec => {
          const l_mm = parseFloat(sec.trace_length_mm) || 0
          const w_mm = parseFloat(sec.trace_width_mm) || 0
          const cu_oz = parseFloat(sec.copper_oz ?? 2)
          const name = sec.name || 'Section'
          if (l_mm > 0 && w_mm > 0) {
            const h_mm = cu_oz * 0.035
            const ln_arg = Math.max(4.0 * l_mm / (w_mm + h_mm), 1.01)
            const L_nH = 0.4 * l_mm * (Math.log(ln_arg) + 0.5)
            return { name, l_mm, w_mm, cu_oz, L_nH, valid: true }
          }
          return { name, l_mm, w_mm, cu_oz, L_nH: 0, valid: false }
        })

        const extBusbarNh = parseFloat(ovr.ext_busbar_nh) || 0
        const validSecs = perSecL.filter(s => s.valid)
        let totalLoopNh = validSecs.length > 0 ? validSecs.reduce((sum, s) => sum + s.L_nH, 0) : null
        
        if (totalLoopNh != null) {
          totalLoopNh += extBusbarNh
        } else if (extBusbarNh > 0) {
          totalLoopNh = extBusbarNh
        }

        let loopSt = 'unknown', loopColor = 'var(--txt-4)'
        if (totalLoopNh != null) {
          if (totalLoopNh <= 5.0) { loopSt = 'OK'; loopColor = 'var(--green)' }
          else if (totalLoopNh <= 10.0) { loopSt = 'WARNING'; loopColor = '#ffab40' }
          else { loopSt = 'CRITICAL'; loopColor = 'var(--red)' }
        }

        // Bus bar resistance from combined thermal results (frontend solver uses SI units)
        const busBarR = combined?.R_total != null ? combined.R_total * 1000 : null  // Ω → mΩ
        const busBarVdrop = combined?.Vdrop_total != null ? combined.Vdrop_total * 1000 : null  // V → mV
        const busBarPloss = combined?.Ploss_total ?? null  // W

        function setOvrLocal(k, v) {
          const n = parseFloat(v)
          dispatch({ type: 'SET_PASSIVES_OVERRIDE', payload: { key: k, value: Number.isFinite(n) ? n : undefined } })
        }

        return (
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                background: 'rgba(100,181,246,.12)', border: '1px solid rgba(100,181,246,.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>🖥️</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#64b5f6' }}>PCB Power Loop Impedance</div>
                <div style={{ fontSize: 10, color: 'var(--txt-3)' }}>
                  Half-bridge commutation loop inductance · Bus bar resistance · Layout guidelines
                </div>
              </div>
            </div>

            {/* Unique inputs only: gate trace width + power clearance + external bus bar */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
              {[
                { label: 'Gate Trace Width', unit: 'mm', val: ovr.gate_trace_w_mm ?? '', onChg: v => setOvrLocal('gate_trace_w_mm', v), ph: '0.3',
                  note: 'Gate drive signal trace' },
                { label: 'Power Clearance', unit: 'mm', val: ovr.power_clearance_mm ?? '', onChg: v => setOvrLocal('power_clearance_mm', v), ph: '1.0',
                  note: 'High-voltage spacing' },
                { label: 'Ext. Bus Bar L', unit: 'nH', val: ovr.ext_busbar_nh ?? '', onChg: v => setOvrLocal('ext_busbar_nh', v), ph: 'e.g. 2.0',
                  note: 'External boltable bus bar inductance' },
              ].map(f => (
                <div key={f.label}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--txt-3)', marginBottom: 3 }}>
                    {f.label} <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt-4)' }}>[{f.unit}]</span>
                  </div>
                  <input type="number" className="inp inp-mono"
                    value={f.val} placeholder={f.ph}
                    onChange={e => f.onChg(e.target.value)}
                    style={{ width: '100%', fontSize: 12, padding: '5px 8px' }}
                  />
                  {f.note && <div style={{ fontSize: 9, color: 'var(--txt-4)', marginTop: 2 }}>{f.note}</div>}
                </div>
              ))}
            </div>

            {/* Data source note */}
            <div style={{
              padding: '6px 10px', borderRadius: 6, marginBottom: 12,
              background: 'rgba(100,181,246,.06)', border: '1px solid rgba(100,181,246,.15)',
              fontSize: 10, color: 'var(--txt-3)', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ fontSize: 14 }}>🔗</span>
              <span>Trace geometry, layer stack, and via data are automatically pulled from the <strong style={{ color: '#64b5f6' }}>bus bar sections</strong> above.</span>
            </div>

            {/* Per-section inductance breakdown */}
            {validSecs.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
                  Per-Section Loop Inductance
                </div>
                <div style={{ borderRadius: 7, overflow: 'hidden', border: '1px solid var(--border-1)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-3)' }}>
                        <th style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--txt-3)', fontSize: 10 }}>Section</th>
                        <th style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--txt-3)', fontSize: 10 }}>Length</th>
                        <th style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--txt-3)', fontSize: 10 }}>Width</th>
                        <th style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--txt-3)', fontSize: 10 }}>Cu</th>
                        <th style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--txt-3)', fontSize: 10 }}>L (nH)</th>
                        <th style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--txt-3)', fontSize: 10 }}>Contrib.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validSecs.map((s, i) => {
                        const pct = totalLoopNh > 0 ? (s.L_nH / totalLoopNh * 100) : 0
                        const isWorst = validSecs.length > 1 && s.L_nH === Math.max(...validSecs.map(x => x.L_nH))
                        return (
                          <tr key={i} style={{
                            background: isWorst ? 'rgba(255,171,0,.06)' : 'transparent',
                            borderTop: '1px solid var(--border-1)',
                          }}>
                            <td style={{ padding: '5px 8px', fontWeight: 600, color: isWorst ? 'var(--amber)' : 'var(--txt-1)' }}>
                              {s.name}{isWorst && validSecs.length > 1 ? ' ⚠' : ''}
                            </td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--txt-2)' }}>{fmtNum(s.l_mm, 1)} mm</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--txt-2)' }}>{fmtNum(s.w_mm, 1)} mm</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--txt-2)' }}>{s.cu_oz} oz</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)', color: isWorst ? 'var(--amber)' : 'var(--txt-1)' }}>{fmtNum(s.L_nH, 2)}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--txt-3)' }}>{fmtNum(pct, 0)}%</td>
                          </tr>
                        )
                      })}
                      {extBusbarNh > 0 && (
                        <tr style={{ background: 'rgba(100,181,246,.05)', borderTop: '1px solid var(--border-1)' }}>
                          <td style={{ padding: '5px 8px', fontWeight: 600, color: '#64b5f6' }}>External Bus Bar</td>
                          <td colSpan={3} style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--txt-4)' }}>Manual Override</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#64b5f6' }}>{fmtNum(extBusbarNh, 2)}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--txt-3)' }}>{fmtNum((extBusbarNh / totalLoopNh) * 100, 0)}%</td>
                        </tr>
                      )}
                      {/* Total row */}
                      {(validSecs.length > 1 || extBusbarNh > 0) && (
                        <tr style={{ borderTop: '2px solid var(--border-2)', background: 'var(--bg-3)' }}>
                          <td style={{ padding: '5px 8px', fontWeight: 700, color: loopColor }}>TOTAL</td>
                          <td colSpan={3} />
                          <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 800, fontFamily: 'var(--font-mono)', color: loopColor, fontSize: 13 }}>
                            {fmtNum(totalLoopNh, 2)}
                          </td>
                          <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--txt-3)' }}>100%</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Loop inductance result banner */}
            <div style={{
              padding: '10px 14px', borderRadius: 8,
              background: totalLoopNh != null ? `${loopColor}0e` : 'var(--bg-2)',
              border: `1px solid ${totalLoopNh != null ? loopColor + '55' : 'var(--border-1)'}`,
              marginBottom: 10,
            }}>
              <div style={{ fontSize: 10, color: 'var(--txt-3)', marginBottom: 4 }}>
                Half-Bridge Power Loop Inductance
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-mono)', color: totalLoopNh != null ? loopColor : 'var(--txt-4)' }}>
                  {totalLoopNh != null ? `${+(totalLoopNh).toFixed(2)}` : '—'}
                </span>
                <span style={{ fontSize: 13, color: 'var(--txt-3)' }}>nH</span>
                {totalLoopNh != null && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: loopColor }}>
                    {loopSt === 'OK' ? '✓ GOOD' : loopSt === 'WARNING' ? '⚠ WARNING' : '✗ CRITICAL'}
                  </span>
                )}
              </div>
              {totalLoopNh != null && (
                <div style={{ fontSize: 10, color: 'var(--txt-4)', marginTop: 4 }}>
                  Target &lt; 5.0 nH · L = Σ L_section + L_ext · L_section ≈ 0.4 × l × [ln(4l/(w+t)) + 0.5] nH
                </div>
              )}
              {totalLoopNh == null && (
                <div style={{ fontSize: 10, color: 'var(--txt-4)', marginTop: 4 }}>
                  Enter trace width and length in the bus bar sections above to calculate loop inductance.
                </div>
              )}
            </div>

            {/* Bus bar resistance + impedance metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
              {[
                { label: 'Bus Bar Resistance', val: busBarR != null ? `${fmtNum(busBarR, 3)} mΩ` : '—', note: 'Total series R' },
                { label: 'Bus Bar Vdrop', val: busBarVdrop != null ? `${fmtNum(busBarVdrop, 2)} mV` : '—', note: 'I × R_total' },
                { label: 'Bus Bar Power Loss', val: busBarPloss != null ? `${fmtNum(busBarPloss, 3)} W` : '—', note: 'I² × R' },
                { label: 'Loop Inductance', val: totalLoopNh != null ? `${fmtNum(totalLoopNh, 2)} nH` : '—', note: 'Σ L_section + L_ext' },
              ].map(r => (
                <div key={r.label} style={{ background: 'var(--bg-3)', borderRadius: 7,
                  padding: '8px 10px', border: '1px solid var(--border-1)' }}>
                  <div style={{ fontSize: 9, color: 'var(--txt-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--txt-1)' }}>{r.val}</div>
                  <div style={{ fontSize: 8.5, color: 'var(--txt-4)', marginTop: 2 }}>{r.note}</div>
                </div>
              ))}
            </div>

            {/* Backend guidelines (if available) */}
            {C && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {[
                  { label: 'Power trace (rec.)', val: pcbg.power_trace_w_mm != null ? `${fmtNum(pcbg.power_trace_w_mm, 2)} mm` : '—' },
                  { label: 'Gate trace width', val: ovr.gate_trace_w_mm != null ? `${fmtNum(ovr.gate_trace_w_mm, 2)} mm` : `${fmtNum(pcbg.gate_trace_w_mm, 2)} mm` },
                  { label: 'Power clearance', val: ovr.power_clearance_mm != null ? `${fmtNum(ovr.power_clearance_mm, 1)} mm` : `${fmtNum(pcbg.power_clearance_mm, 1)} mm` },
                ].map(r => (
                  <div key={r.label} style={{ background: 'var(--bg-3)', borderRadius: 7,
                    padding: '8px 10px', border: '1px solid var(--border-1)' }}>
                    <div style={{ fontSize: 9.5, color: 'var(--txt-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{r.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--txt-1)' }}>{r.val}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* ─── No-data placeholder ─── */}
      {!combined && (
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
  )
}
