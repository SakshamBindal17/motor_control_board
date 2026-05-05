import React, { useState, useRef, useEffect } from 'react'
import toast from 'react-hot-toast'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'
import { runCalculations, runReverseCalculation } from '../api.js'
import { fmtNum } from '../utils.js'

/* ─── helpers ─────────────────────────────────────────────────── */
function fv(v, d = '—') { return (v == null || v === '') ? d : v }

/* Result row  src='ovr'→amber dot  src='auto'→green dot  src=undefined→no dot */
const SRC_COLOR = { ovr:'#ffab40', auto:'rgba(0,230,118,.85)' }
function Row({ label, value, unit, bold, color, src, tip }) {
  const dotColor = src ? SRC_COLOR[src] : null
  const prevVal = useRef(value)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (prevVal.current !== value && prevVal.current !== undefined) {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 800)
      prevVal.current = value
      return () => clearTimeout(t)
    }
    prevVal.current = value
  }, [value])

  return (
    <div
      data-tip={tip}
      style={{
        display:'flex', justifyContent:'space-between', alignItems:'baseline',
        padding:'3px 4px', borderBottom:'1px solid var(--border-1)',
        cursor: tip ? 'help' : 'default',
        background: flash ? 'rgba(0,230,118,0.15)' : 'transparent',
        transition: flash ? 'none' : 'background 1s ease-out',
        borderRadius: 4,
      }}
    >
      <span style={{ fontSize:11, color:'var(--txt-3)', flex:1, display:'flex', alignItems:'center', gap:4 }}>
        {dotColor && (
          <span style={{
            width:5, height:5, borderRadius:'50%', flexShrink:0,
            background: dotColor, display:'inline-block',
            boxShadow:`0 0 4px ${dotColor}`,
          }} title={src === 'ovr' ? 'Value from your override' : 'Auto-calculated'} />
        )}
        {label}
      </span>
      <span style={{
        fontSize:11, fontFamily:'var(--font-mono)',
        fontWeight: bold ? 700 : 500,
        color: color || (bold ? 'var(--txt-1)' : 'var(--txt-2)'),
      }}>
        {value ?? '—'}{unit
          ? <span style={{ color:'var(--txt-4)', marginLeft:3, fontWeight:400 }}>{unit}</span>
          : null}
      </span>
    </div>
  )
}

/* Override input with reset button */
function OvrField({ label, unit, value, onChange, onReset, defaultVal, mandatory, linked, note, step, min }) {
  const isEmpty  = value === '' || value == null
  const isMiss   = mandatory && isEmpty
  const hasValue = !isEmpty
  const isErr    = hasValue && min != null && parseFloat(value) < min

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
      <div style={{ display:'flex', alignItems:'center', gap:3 }}>
        <span style={{ fontSize:10.5, fontWeight:600, color:'var(--txt-3)', flex:1, lineHeight:1.3 }}>
          {label}
          {mandatory && <span style={{ color:'#ffab40', marginLeft:2 }}>*</span>}
          {linked   && <span title="Synced with PCB Trace Thermal tab" style={{ marginLeft:3 }}>🔗</span>}
        </span>
        {isMiss && (
          <span style={{ fontSize:9, background:'#ffab40', color:'#000',
            padding:'1px 5px', borderRadius:3, fontWeight:800, letterSpacing:'.4px' }}>REQUIRED</span>
        )}
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:4 }}>
        <div style={{ flex:1, position:'relative', minWidth:0 }}>
          <input
            type="number" step={step ?? 'any'} min={min != null ? min : 0}
            value={value ?? ''}
            placeholder={defaultVal != null ? `${defaultVal}` : '—'}
            onKeyDown={e => {
              if (e.key === '-' || e.key === 'e' || e.key === 'E' || e.key === '+') {
                e.preventDefault();
              }
            }}
            onChange={e => onChange(e.target.value)}
            style={{
              width:'100%', boxSizing:'border-box',
              padding: hasValue ? '4px 24px 4px 7px' : '4px 7px',
              fontSize:12, borderRadius:6, fontFamily:'var(--font-mono)',
              background: hasValue ? (isErr ? 'rgba(255,68,68,.05)' : 'rgba(0,230,118,.07)') : 'var(--bg-2)',
              border:`1px solid ${isErr ? 'var(--red)' : isMiss ? '#ffab40' : hasValue ? 'rgba(0,230,118,.5)' : 'var(--border-1)'}`,
              color: isErr ? 'var(--red)' : 'var(--txt-1)', outline:'none', transition:'border .15s, background .15s',
            }}
          />
          {isErr && (
            <div style={{ position:'absolute', right: hasValue && onReset ? 30 : 6, top: 2, bottom: 2, display:'flex', alignItems:'center' }}>
              <span style={{ fontSize:10, color:'var(--red)', fontWeight:700, padding:'0 4px', background:'rgba(255,68,68,.1)', borderRadius:4 }}>&lt; {min}</span>
            </div>
          )}
          {hasValue && onReset && (
            <button
              onClick={onReset}
              title="Reset to auto"
              style={{
                position:'absolute', right:5, top:'50%', transform:'translateY(-50%)',
                background:'none', border:'none', cursor:'pointer',
                color:'var(--txt-3)', fontSize:11, padding:0, lineHeight:1,
                display:'flex', alignItems:'center',
              }}
            >✕</button>
          )}
        </div>
        {unit && (
          <span style={{ fontSize:10.5, color:'var(--txt-3)', flexShrink:0,
            fontFamily:'var(--font-mono)', minWidth:22, textAlign:'left' }}>{unit}</span>
        )}
      </div>
      {note && <span style={{ fontSize:9.5, color:'var(--txt-4)', lineHeight:1.3 }}>{note}</span>}
    </div>
  )
}



/* Section card — split left/right
   tier: 'required' | 'recommended' | 'optional'
   optional sections have a muted header and collapsed hint */
const TIER_LABEL = { required:'REQUIRED', recommended:'SUGGESTED', optional:'OPTIONAL' }
const TIER_LABEL_STYLE = {
  required:  { color:'#ffab40', background:'rgba(255,171,64,.15)', border:'1px solid rgba(255,171,64,.35)' },
  recommended:{ color:'var(--txt-3)', background:'rgba(255,255,255,.05)', border:'1px solid transparent' },
  optional:  { color:'var(--txt-4)', background:'transparent', border:'1px solid transparent' },
}
function Section({ id, icon, title, tier='optional', color, open, onToggle, overrideCount, stale, inputs, results, noResults }) {
  const ts = TIER_LABEL_STYLE[tier]
  const headerOpacity = !open && tier === 'optional' ? 0.7 : 1
  return (
    <div style={{
      border:`1px solid ${overrideCount > 0 ? color + '55' : tier === 'required' ? 'rgba(255,171,64,.25)' : 'var(--border-1)'}`,
      borderRadius:10, overflow:'hidden',
      boxShadow: overrideCount > 0 ? `0 0 0 1px ${color}22` : tier === 'required' && !overrideCount ? '0 0 0 1px rgba(255,171,64,.08)' : 'none',
      opacity: headerOpacity,
      transition:'box-shadow .2s, opacity .2s',
    }}>
      {/* Header */}
      <div
        onClick={() => { onToggle(id) }}
        style={{
          display:'flex', alignItems:'center', gap:9, padding:'9px 14px',
          cursor:'pointer',
          background: open ? `${color}0c` : 'var(--bg-2)',
          borderLeft:`3px solid ${overrideCount > 0 ? color : open ? color + '66' : tier === 'required' ? 'rgba(255,171,64,.5)' : 'transparent'}`,
          transition:'background .15s',
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.parentElement.style.opacity = '1' }}
        onMouseLeave={e => { if (!open && tier === 'optional') e.currentTarget.parentElement.style.opacity = '0.7' }}
      >
        <span style={{ fontSize:15 }}>{icon}</span>
        <span style={{ flex:1, fontSize:12.5, fontWeight:700, color: open ? 'var(--txt-1)' : 'var(--txt-2)' }}>
          {title}
        </span>
        {/* Tier badge */}
        <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:4, letterSpacing:'.5px', ...ts }}>
          {TIER_LABEL[tier]}
        </span>
        {overrideCount > 0 && (
          <span style={{ fontSize:10, background:color, color:'#000',
            padding:'1px 7px', borderRadius:10, fontWeight:700, flexShrink:0 }}>
            {overrideCount} ovr
          </span>
        )}
        <span style={{ color:'var(--txt-3)', fontSize:13,
          transform: open ? 'rotate(180deg)' : '', transition:'transform .2s' }}>▾</span>
      </div>

      {/* Body */}
      {open && (
        <div style={{ display:'flex', borderTop:'1px solid rgba(255,255,255,.05)' }}>
          {/* Inputs */}
          <div style={{
            width:360, flexShrink:0, padding:'12px 14px',
            background:'var(--bg-1)',
            display:'grid', gridTemplateColumns:'1fr 1fr', gap:'9px 12px',
            borderRight:'1px solid rgba(255,255,255,.05)',
          }}>
            {inputs}
          </div>
          {/* Results */}
          <div style={{ flex:1, padding:'10px 14px', background:'var(--bg-0)', position:'relative', minWidth:0 }}>
            {noResults ? (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
                height:'100%', minHeight:60, flexDirection:'column', gap:4 }}>
                <span style={{ fontSize:18 }}>⚡</span>
                <span style={{ fontSize:11, color:'var(--txt-4)' }}>Waiting for system parameters...</span>
              </div>
            ) : (
              <>

                {/* Dot legend */}
                <div style={{ display:'flex', gap:10, marginBottom:6, alignItems:'center' }}>
                  <span style={{ fontSize:9.5, color:'var(--txt-4)' }}>Result source:</span>
                  <span style={{ display:'flex', alignItems:'center', gap:3, fontSize:9.5, color:'#ffab40' }}>
                    <span style={{ width:5,height:5,borderRadius:'50%',background:'#ffab40',display:'inline-block' }}/> override
                  </span>
                  <span style={{ display:'flex', alignItems:'center', gap:3, fontSize:9.5, color:'rgba(0,230,118,.85)' }}>
                    <span style={{ width:5,height:5,borderRadius:'50%',background:'rgba(0,230,118,.85)',display:'inline-block' }}/> calculated
                  </span>
                </div>
                {results}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Design Health Summary ─── */
function DesignHealthSummary({ C, specs, ovr }) {
  if (!C) return null
  const caps = C.input_capacitors || {}
  const snub = C.snubber || {}
  const prot = C.protection_dividers || {}
  const shunt = C.shunt_resistors || {}

  const Card = ({ label, value, unit, status, trend }) => (
    <div style={{
      flex:1, background:'var(--bg-2)', borderRadius:10, padding:'10px 14px',
      border:'1px solid var(--border-1)', display:'flex', flexDirection:'column', gap:4
    }}>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', textTransform:'uppercase', letterSpacing:'.5px' }}>{label}</div>
      <div style={{ display:'flex', alignItems:'baseline', gap:4 }}>
        <span style={{ fontSize:18, fontWeight:800, color: status === 'err' ? 'var(--red)' : status === 'warn' ? '#ffab40' : 'var(--txt-1)' }}>{value}</span>
        <span style={{ fontSize:11, color:'var(--txt-3)', fontWeight:500 }}>{unit}</span>
      </div>
    </div>
  )

  return (
    <div style={{ display:'flex', gap:12, marginBottom:16 }}>
      <Card label="Total Bus Cap" value={fmtNum(caps.c_total_uf, 0)} unit="µF" />
      <Card label="MLCC Ripple" value={fmtNum(caps.i_mlcc_rms_a, 2)} unit="A rms"
        status={caps.i_mlcc_rms_a > 15 ? 'err' : caps.i_mlcc_rms_a > 8 ? 'warn' : 'ok'} />
      <Card label="Overshoot" value={fmtNum(snub.voltage_overshoot_v, 1)} unit="V" status={snub.voltage_overshoot_v > specs.bus_voltage * 0.5 ? 'err' : 'ok'} />
      <Card label="OCP Trip" value={fmtNum(prot.ocp?.hw_threshold_a, 1)} unit="A" />
      <Card label="Shunt ADC" value={fmtNum(shunt.active?.adc_utilisation_pct, 1)} unit="%" status={shunt.active?.adc_utilisation_pct > 90 ? 'err' : shunt.active?.adc_utilisation_pct > 75 ? 'warn' : 'ok'} />
    </div>
  )
}

/* ─── Dynamic Divider Diagram ─── */
function DividerDiagram({ r1, r2, vbus, vout, color }) {
  const R1 = parseFloat(r1) || 10
  const R2 = parseFloat(r2) || 1
  const ratio = R2 / (R1 + R2)
  const v_bus_val = parseFloat(vbus) || 0
  const v_out_calc = vout && vout !== '—' ? vout : fmtNum(v_bus_val * ratio, 2)

  return (
    <div style={{
      margin:'12px 0', padding:10, background:'rgba(255,255,255,.03)', borderRadius:8,
      border:'1px dashed rgba(255,255,255,.1)', display:'flex', alignItems:'center', gap:20
    }}>
      <div style={{ position:'relative', width:60, height:110 }}>
        <div style={{ position:'absolute', top:0, left:25, width:10, height:10, borderRadius:'50%', background:color }} />
        <div style={{ position:'absolute', top:10, left:29, width:2, height:10, background:color }} />
        <div style={{ position:'absolute', top:20, left:20, width:20, height:20, border:`2px solid ${color}`, borderRadius:3, display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, fontWeight:800 }}>R1</div>
        <div style={{ position:'absolute', top:40, left:29, width:2, height:15, background:color }} />
        <div style={{ position:'absolute', top:55, left:25, width:10, height:10, borderRadius:'50%', background:color }} />
        <div style={{ position:'absolute', top:59, left:35, width:20, height:2, background:color }} />
        <div style={{ position:'absolute', top:65, left:29, width:2, height:10, background:color }} />
        <div style={{ position:'absolute', top:75, left:20, width:20, height:20, border:`2px solid ${color}`, borderRadius:3, display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, fontWeight:800 }}>R2</div>
        <div style={{ position:'absolute', top:95, left:29, width:2, height:10, background:color }} />
        <div style={{ position:'absolute', top:105, left:15, width:30, height:2, background:color }} />
      </div>
      <div style={{ flex:1, display:'flex', flexDirection:'column', gap:4 }}>
        <div style={{ fontSize:10, color:'var(--txt-3)' }}>Voltage Divider Physics:</div>
        <div style={{ fontSize:11, fontWeight:700 }}>V_bus = {vbus}V → V_adc = {v_out_calc}V</div>
        <div style={{ fontSize:9, color:'var(--txt-4)', fontFamily:'var(--font-mono)' }}>Ratio = R2 / (R1 + R2) = {fmtNum(ratio, 4)}</div>
        <div style={{ fontSize:9, color:'var(--txt-4)', fontFamily:'var(--font-mono)' }}>{R1}kΩ / {R2}kΩ</div>
      </div>
    </div>
  )
}

/* ─── Shunt Kelvin Diagram ─── */
function ShuntDiagram({ topology, r_shunt, gain, color }) {
  const isSingle = topology === 'single'
  return (
    <div style={{
      margin:'12px 0', padding:10, background:'rgba(255,255,255,.03)', borderRadius:8,
      border:'1px dashed rgba(255,255,255,.1)', display:'flex', alignItems:'center', gap:20
    }}>
      <div style={{ position:'relative', width:110, height:60 }}>
        {/* Main current path */}
        <div style={{ position:'absolute', top:25, left:0, width:25, height:2, background:'rgba(255,255,255,.3)' }} />
        <div style={{ position:'absolute', top:18, left:25, width:50, height:16, background:'var(--bg-1)', border:`2px solid ${color}`, borderRadius:2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, fontWeight:800 }}>{r_shunt}mΩ</div>
        <div style={{ position:'absolute', top:25, left:75, width:25, height:2, background:'rgba(255,255,255,.3)' }} />
        
        {/* Kelvin tap lines */}
        <div style={{ position:'absolute', top:22, left:32, width:2, height:20, background:color }} />
        <div style={{ position:'absolute', top:22, left:66, width:2, height:20, background:color }} />
        
        {/* Routing to CSA */}
        <div style={{ position:'absolute', top:40, left:32, width:48, height:2, background:color }} />
        
        {/* CSA Box */}
        <div style={{ position:'absolute', top:35, left:80, width:24, height:14, background:'var(--bg-1)', border:`2px solid ${color}`, borderRadius:2, fontSize:6, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800 }}>CSA</div>
      </div>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:10, color:'var(--txt-3)' }}>{isSingle ? 'DC- Return Shunt' : 'Low-Side Phase Shunt'}</div>
        <div style={{ fontSize:11, fontWeight:700 }}>Kelvin Connection → {gain}× Gain</div>
        <div style={{ fontSize:9, color:'var(--txt-4)', marginTop:2 }}>Minimizes PCB trace resistance error</div>
      </div>
    </div>
  )
}

/* ─── Snubber RC Diagram ─── */
function SnubberDiagram({ rs, cs, v_over, color }) {
  return (
    <div style={{
      margin:'12px 0', padding:10, background:'rgba(255,255,255,.03)', borderRadius:8,
      border:'1px dashed rgba(255,255,255,.1)', display:'flex', alignItems:'center', gap:20
    }}>
      <div style={{ position:'relative', width:100, height:60 }}>
        {/* FET Switch (simplified) */}
        <div style={{ position:'absolute', top:10, left:20, width:2, height:12, background:'#64b5f6' }} />
        <div style={{ position:'absolute', top:22, left:20, width:20, height:2, background:'#64b5f6', transform:'rotate(-30deg)', transformOrigin:'left' }} />
        <div style={{ position:'absolute', top:38, left:20, width:2, height:12, background:'#64b5f6' }} />
        
        {/* Top/Bottom Wires to Snubber */}
        <div style={{ position:'absolute', top:10, left:20, width:40, height:2, background:color }} />
        <div style={{ position:'absolute', top:50, left:20, width:40, height:2, background:color }} />
        
        {/* Snubber Branch Vertical Wires */}
        <div style={{ position:'absolute', top:10, left:60, width:2, height:8, background:color }} />
        <div style={{ position:'absolute', top:42, left:60, width:2, height:8, background:color }} />
        
        {/* Capacitor Cs */}
        <div style={{ position:'absolute', top:18, left:54, width:14, height:2, background:color }} />
        <div style={{ position:'absolute', top:22, left:54, width:14, height:2, background:color }} />
        
        {/* Connecting wire Cs to Rs */}
        <div style={{ position:'absolute', top:24, left:60, width:2, height:6, background:color }} />
        
        {/* Resistor Rs */}
        <div style={{ position:'absolute', top:30, left:50, width:22, height:12, background:'var(--bg-1)', border:`2px solid ${color}`, borderRadius:2, fontSize:7, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800 }}>Rs</div>
      </div>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:10, color:'var(--txt-3)' }}>RC Snubber Network</div>
        <div style={{ fontSize:11, fontWeight:700 }}>{cs}pF + {rs}Ω</div>
        <div style={{ fontSize:9, color:'var(--txt-4)', marginTop:2 }}>Absorbs {v_over}V ringing spike</div>
      </div>
    </div>
  )
}

/* ─── EMI Pi-Filter Diagram ─── */
function EMIDiagram({ choke, xcap, ycap, color }) {
  const lineStyle = { position:'absolute', height:2, background:'rgba(255,255,255,.3)' }
  const lColor = color || '#ff5252'
  const hasYCap = ycap && parseFloat(ycap) > 0
  
  return (
    <div style={{
      margin:'12px 0', padding:10, background:'rgba(255,255,255,.03)', borderRadius:8,
      border:'1px dashed rgba(255,255,255,.1)', display:'flex', alignItems:'center', gap:20
    }}>
      <div style={{ position:'relative', width:120, height:60 }}>
        {/* Main Lines */}
        <div style={{ ...lineStyle, top:15, left:0, width:120 }} />
        <div style={{ ...lineStyle, top:45, left:0, width:120 }} />
        
        {/* CM Choke Coils */}
        <div style={{ position:'absolute', top:10, left:20, width:24, height:12, background:'var(--bg-1)', border:`2px solid ${lColor}`, borderRadius:4 }} />
        <div style={{ position:'absolute', top:40, left:20, width:24, height:12, background:'var(--bg-1)', border:`2px solid ${lColor}`, borderRadius:4 }} />
        
        {/* CM Choke Core (Dashed Line) */}
        <div style={{ position:'absolute', top:24, left:31, width:2, height:14, borderLeft:`2px dashed ${lColor}` }} />
        
        {/* X-Capacitor */}
        <div style={{ position:'absolute', top:15, left:65, width:2, height:10, background:lColor }} />
        <div style={{ position:'absolute', top:35, left:65, width:2, height:10, background:lColor }} />
        <div style={{ position:'absolute', top:25, left:58, width:16, height:2, background:lColor }} />
        <div style={{ position:'absolute', top:33, left:58, width:16, height:2, background:lColor }} />
        
        {/* Optional Y-Capacitors */}
        {hasYCap && (
          <>
            <div style={{ position:'absolute', top:15, left:95, width:2, height:6, background:lColor }} />
            <div style={{ position:'absolute', top:21, left:90, width:12, height:2, background:lColor }} />
            <div style={{ position:'absolute', top:25, left:90, width:12, height:2, background:lColor }} />
            <div style={{ position:'absolute', top:27, left:95, width:2, height:3, background:lColor }} />
            
            <div style={{ position:'absolute', top:39, left:95, width:2, height:6, background:lColor }} />
            <div style={{ position:'absolute', top:37, left:90, width:12, height:2, background:lColor }} />
            <div style={{ position:'absolute', top:33, left:90, width:12, height:2, background:lColor }} />
            <div style={{ position:'absolute', top:30, left:95, width:2, height:3, background:lColor }} />
            
            {/* Ground symbol for Y-caps */}
            <div style={{ position:'absolute', top:30, left:92, width:8, height:2, background:lColor }} />
          </>
        )}
      </div>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:10, color:'var(--txt-3)' }}>EMI Pi-Filter Topology</div>
        <div style={{ fontSize:11, fontWeight:700 }}>{choke}µH Choke + {xcap}nF X-Cap</div>
        <div style={{ fontSize:9, color:'var(--txt-4)', marginTop:2 }}>Suppresses PWM switching noise</div>
      </div>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════ */
export default function PassivesPanel() {
  const { state, dispatch } = useProject()
  const C      = state.project.calculations
  const stale  = !!state.project.calcs_stale
  const ovr    = state.project.blocks.passives.overrides || {}
  const specs  = state.project.system_specs || {}
  const ptt_common = state.project.pcb_trace_thermal?.common || {}
  const ptt_sections = state.project.pcb_trace_thermal?.sections || []
  const traceP = { ...ptt_common, ...(ptt_sections[0] || {}) }  // merged: backward compat view

  // required/recommended open by default; optional sections start collapsed
  const [open, setOpen] = useState({
    gate:true, caps:true, boot:false, psu:false, shunts:false, prot:false, emi:false, pcb:true
  })
  const [bootTargetNs, setBootTargetNs] = useState('')
  const [bootSolve, setBootSolve]       = useState(null)
  const [bootBusy, setBootBusy]         = useState(false)
  const [calcBusy, setCalcBusy]         = useState(false)
  const calcInFlight = useRef(false)

  function tog(id) { setOpen(p => ({ ...p, [id]: !p[id] })) }
  function navigateTo(tab) { dispatch({ type:'SET_ACTIVE_BLOCK', payload: tab }) }

  /* dispatch helpers */
  function setOvr(k, v) {
    const n = parseFloat(v)
    dispatch({ type:'SET_PASSIVES_OVERRIDE', payload:{ key:k, value: Number.isFinite(n) ? n : undefined } })
  }
  function setOvrStr(k, v) {
    // For string-valued overrides (e.g. shunt_topology) — no numeric conversion
    dispatch({ type:'SET_PASSIVES_OVERRIDE', payload:{ key:k, value: v } })
  }
  function resetOvr(k) {
    dispatch({ type:'SET_PASSIVES_OVERRIDE', payload:{ key:k, value: undefined } })
  }
  function setSpec(k, v) { dispatch({ type:'SET_SYSTEM_SPECS', payload:{ [k]: v } }) }
  function resetSpec(k)  { dispatch({ type:'SET_SYSTEM_SPECS', payload:{ [k]: '' } }) }
  function setTrace(k, v) {
    const n = parseFloat(v)
    dispatch({ type:'SET_PCB_TRACE_PARAMS', payload:{ [k]: Number.isFinite(n) ? n : undefined } })
  }
  function setTotalLayers(v) {
    const n = Math.max(1, Math.round(parseFloat(v) || 2))
    dispatch({ type:'SET_PCB_TRACE_PARAMS', payload:{ n_external_layers: Math.min(2,n), n_internal_layers: Math.max(0,n-2) } })
  }
  const totalLayers = (traceP.n_external_layers || 2) + (traceP.n_internal_layers || 0)

  /* override counts */
  function cnt(keys) { return keys.filter(k => ovr[k] != null && ovr[k] !== '').length }
  const gateOvrCnt  = [specs.hs_rg_on_override, specs.hs_rg_off_override, specs.ls_rg_on_override, specs.ls_rg_off_override].filter(v => v != null && v !== '').length
              + cnt(['gate_rise_time_ns', 'gate_fall_time_ns', 'deadtime_override_ns'])
  const capsOvrCnt  = cnt(['delta_v_ripple','bulk_v_rating_v','mlcc_qty','mlcc_size_nf','mlcc_esr_mohm','film_qty','film_size_uf','film_v_rating_v'])
  const bootOvrCnt  = cnt(['bootstrap_droop_v','cboot_v_rating_v'])
  const shuntOvrCnt = cnt(['shunt_topology','csa_gain_override','shunt_single_mohm','shunt_three_mohm','stray_inductance_nh','snubber_rs_ohm','snubber_cs_pf','snubber_v_mult'])
  const protOvrCnt  = cnt(['prot_r1_kohm','prot_r2_kohm','ntc_r25_kohm','ntc_b_coeff','ntc_pullup_kohm'])
  const emiOvrCnt   = cnt(['emi_choke_dcr_mohm','emi_x_cap_nf','emi_x_cap_v','emi_y_cap_nf','emi_y_cap_v'])
  const pcbOvrCnt   = (traceP.trace_width_mm != null ? 1 : 0) + (traceP.trace_length_mm != null ? 1 : 0)
                    + cnt(['gate_trace_w_mm','power_clearance_mm'])

  /* Run calculations */
  async function runCalc(silent = false) {
    if (calcInFlight.current) return
    // Allow calculation even without Mosfet (backend uses fallbacks)
    setCalcBusy(true); calcInFlight.current = true
    if (!silent) toast.loading('Calculating…', { id:'pc' })
    try {
      const r = await runCalculations({
        system_specs: state.project.system_specs,
        mosfet_params: buildParamsDict(state.project.blocks.mosfet),
        driver_params: buildParamsDict(state.project.blocks.driver),
        mcu_params: buildParamsDict(state.project.blocks.mcu),
        motor_specs: state.project.blocks.motor.specs || {},
        passives_overrides: state.project.blocks.passives.overrides || {},
        design_constants: state.project.design_constants || {},
        pcb_trace_thermal_params: {
          common: state.project.pcb_trace_thermal?.common || {},
          sections: state.project.pcb_trace_thermal?.sections || [],
        },
      })
      dispatch({ type:'SET_CALCULATIONS', payload: r })
      if (!silent) toast.success('Done!', { id:'pc' })
    } catch(e) { 
      if (!silent) toast.error(e.message, { id:'pc' })
    } finally { setCalcBusy(false); calcInFlight.current = false }
  }

  const runCalcRef = useRef(runCalc)
  useEffect(() => { runCalcRef.current = runCalc }, [runCalc])

  useEffect(() => {
    if (stale && !calcBusy) {
      const timer = setTimeout(() => {
        runCalcRef.current(true) // Run silently after debounce
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [stale, calcBusy,
    state.project.blocks.mosfet, state.project.blocks.mosfet?.selected_params,
    state.project.blocks.driver, state.project.blocks.driver?.selected_params,
    state.project.blocks.mcu, state.project.blocks.mcu?.selected_params,
    state.project.blocks.passives.overrides,
    state.project.system_specs, state.project.design_constants])

  /* Bootstrap reverse */
  async function solveBootstrap() {
    const tNs = parseFloat(bootTargetNs)
    if (!Number.isFinite(tNs) || tNs <= 0) { toast.error('Enter a valid on-time (ns)'); return }
    if (state.project.blocks.mosfet.status !== 'done') { toast.error('Upload MOSFET datasheet first'); return }
    setBootBusy(true)
    try {
      const r = await runReverseCalculation({
        system_specs: state.project.system_specs,
        mosfet_params: buildParamsDict(state.project.blocks.mosfet),
        driver_params: buildParamsDict(state.project.blocks.driver),
        mcu_params: buildParamsDict(state.project.blocks.mcu),
        motor_specs: state.project.blocks.motor.specs || {},
        passives_overrides: state.project.blocks.passives.overrides || {},
        design_constants: state.project.design_constants || {},
        targets: { min_hs_on_time_ns: tNs },
      })
      const solved = r?.min_hs_on_time_ns || null
      setBootSolve(solved)
      if (!solved?.feasible) toast.error(solved?.constraint || 'No feasible solution')
      else toast.success('Bootstrap solved — apply or adjust the droop override')
    } catch { toast.error('Reverse calculation failed')
    } finally { setBootBusy(false) }
  }

  /* Result shortcuts */
  const gate  = C?.gate_resistors       || {}
  const bcap  = C?.bootstrap_cap        || {}
  const icap  = C?.input_capacitors     || {}
  const shunt = C?.shunt_resistors      || {}
  const snub  = C?.snubber              || {}
  const pcbg  = C?.pcb_guidelines       || {}
  const prot  = C?.protection_dividers  || {}
  const psby  = C?.power_supply_bypass  || {}
  const emi   = C?.emi_filter           || {}
  const dt    = C?.dead_time            || {}

  const loopNh    = pcbg?.half_bridge_loop_calculated_nh
  const loopSt    = pcbg?.half_bridge_loop_status || 'unknown'
  const loopColor = loopSt === 'OK' ? 'var(--green)' : loopSt === 'WARNING' ? '#ffab40' : loopSt === 'CRITICAL' ? 'var(--red)' : 'var(--txt-4)'

  const hs_rg_on_ok  = specs.hs_rg_on_override  != null && specs.hs_rg_on_override  !== ''
  const hs_rg_off_ok = specs.hs_rg_off_override != null && specs.hs_rg_off_override !== ''
  const ls_rg_on_ok  = specs.ls_rg_on_override  != null && specs.ls_rg_on_override  !== ''
  const ls_rg_off_ok = specs.ls_rg_off_override != null && specs.ls_rg_off_override !== ''
  const gateReady = hs_rg_on_ok && hs_rg_off_ok && ls_rg_on_ok && ls_rg_off_ok

  /* shared col-span helper */
  const fullSpan = { gridColumn:'1/-1' }

  /* ── Render ────────────────────────────────────────────────── */
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10, paddingBottom:80 }}>

      {/* Design Health Summary Banner */}
      <DesignHealthSummary C={C} specs={specs} ovr={ovr} />

      {/* ── Page header ──────────────────────────────────────── */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'10px 16px', borderRadius:10,
        background:'linear-gradient(135deg,var(--bg-2),var(--bg-3))',
        border:'1px solid var(--border-1)', flexShrink:0,
      }}>
        <div>
          <div style={{ fontSize:14, fontWeight:800, color:'var(--txt-1)' }}>⚙️ Passives Design</div>
          <div style={{ fontSize:11, color:'var(--txt-3)', marginTop:2 }}>
            Edit overrides → results update inline after Run
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 1 — Gate Drive                               */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="gate" icon="⚡" title="Gate Drive" color="#bb86fc"
        tier="required"
        open={open.gate} onToggle={tog}
        overrideCount={gateOvrCnt}
        stale={stale} noResults={!C}
        inputs={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 15px', gridColumn:'1/-1', marginBottom:10 }}>
            <div style={{ background:'rgba(187,134,252,0.05)', padding:'8px', borderRadius:'6px', border:'1px solid rgba(187,134,252,0.2)' }}>
              <div style={{ fontSize:10, fontWeight:800, color:'#bb86fc', marginBottom:6, textTransform:'uppercase', letterSpacing:0.5 }}>High-Side (HS)</div>
              <OvrField label="HS Turn-On" unit="Ω"
                value={specs.hs_rg_on_override ?? ''}
                onChange={v => setSpec('hs_rg_on_override', v)}
                onReset={() => resetSpec('hs_rg_on_override')} />
              <OvrField label="HS Turn-Off" unit="Ω"
                value={specs.hs_rg_off_override ?? ''}
                onChange={v => setSpec('hs_rg_off_override', v)}
                onReset={() => resetSpec('hs_rg_off_override')} />
            </div>
            <div style={{ background:'rgba(30,144,255,0.05)', padding:'8px', borderRadius:'6px', border:'1px solid rgba(30,144,255,0.2)' }}>
               <div style={{ fontSize:10, fontWeight:800, color:'#1e90ff', marginBottom:6, textTransform:'uppercase', letterSpacing:0.5 }}>Low-Side (LS)</div>
               <OvrField label="LS Turn-On" unit="Ω"
                value={specs.ls_rg_on_override ?? ''}
                onChange={v => setSpec('ls_rg_on_override', v)}
                onReset={() => resetSpec('ls_rg_on_override')} />
              <OvrField label="LS Turn-Off" unit="Ω"
                value={specs.ls_rg_off_override ?? ''}
                onChange={v => setSpec('ls_rg_off_override', v)}
                onReset={() => resetSpec('ls_rg_off_override')} />
            </div>
          </div>
          {/* Rise/Fall target fields — visually muted when manual Rg is active */}
          <div style={{ opacity: gateReady ? 0.4 : 1, pointerEvents: gateReady ? 'none' : 'auto', transition: 'opacity .2s' }}>
            <OvrField label="Rise Time Target" unit="ns"
              value={ovr.gate_rise_time_ns ?? ''} defaultVal={40}
              onChange={v => setOvr('gate_rise_time_ns', v)}
              onReset={() => resetOvr('gate_rise_time_ns')}
              note={gateReady ? '⚠ Ignored — manual Rg values are active above' : 'Blank = use design constant default (40ns). Engine sizes the closest E-series Rg to hit this target.'} />
          </div>
          <div style={{ opacity: gateReady ? 0.4 : 1, pointerEvents: gateReady ? 'none' : 'auto', transition: 'opacity .2s' }}>
            <OvrField label="Fall Time Target" unit="ns"
              value={ovr.gate_fall_time_ns ?? ''} defaultVal={40}
              onChange={v => setOvr('gate_fall_time_ns', v)}
              onReset={() => resetOvr('gate_fall_time_ns')}
              note={gateReady ? '⚠ Ignored — manual Rg values are active above' : 'Blank = use design constant default (40ns). Engine sizes the closest E-series Rg to hit this target.'} />
          </div>
          <OvrField label="Gate Voltage (Vdrv)" unit="V"
            value={specs.gate_drive_voltage ?? ''} defaultVal={12}
            onChange={v => setSpec('gate_drive_voltage', v)}
            onReset={() => resetSpec('gate_drive_voltage')}
            note="Sets driver strength and plateau capability limit" />
          <OvrField label="Dead Time Override" unit="ns"
            value={ovr.deadtime_override_ns ?? ''}
            onChange={v => setOvr('deadtime_override_ns', v)}
            onReset={() => resetOvr('deadtime_override_ns')} />
        </>}
        results={<>
          {gate.manual_rg_input ? (
            <div style={{ fontSize:10, background:'#bb86fc18', border:'1px solid #bb86fc40',
              borderRadius:5, padding:'4px 10px', color:'#bb86fc', marginBottom:6, fontWeight:700, gridColumn:'1/-1',
              display:'flex', alignItems:'center', gap:8 }}>
              <span>✓ Manual Override Active</span>
              <span style={{ fontWeight:400, color:'#bb86fc99' }}>— Rise/Fall targets are ignored. Results show actual times from your Rg values.</span>
            </div>
          ) : (
            <div style={{ fontSize:10, background:'#00e67618', border:'1px solid #00e67640',
              borderRadius:5, padding:'4px 10px', color:'#00e676', marginBottom:6, fontWeight:700, gridColumn:'1/-1',
              display:'flex', alignItems:'center', gap:8 }}>
              <span>⚡ Auto-Target Mode Active</span>
              <span style={{ fontWeight:400, color:'#00e67699' }}>
                — Rise: {ovr.gate_rise_time_ns ?? 40}ns target · Fall: {ovr.gate_fall_time_ns ?? 40}ns target
              </span>
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px 20px', gridColumn:'1/-1' }}>
            {/* HS Column */}
            <div>
              <div style={{ borderBottom:'1px solid var(--border-1)', paddingBottom:4, marginBottom:6, fontSize:10, fontWeight:700, color:'var(--txt-3)' }}>HIGH SIDE</div>
              <Row label="Rg_on / off" value={`${fmtNum(gate.hs_rg_on_ohm,1)} / ${fmtNum(gate.hs_rg_off_ohm,1)}`} unit="Ω" bold src={hs_rg_on_ok?'ovr':'auto'} 
                tip="Standard E-series resistor value calculated to most closely match your target switching speeds." />
              <Row label="Rise / Fall" value={`${fmtNum(gate.hs_gate_rise_time_ns,1)} / ${fmtNum(gate.hs_gate_fall_time_ns,1)}`} unit="ns" src="auto" 
                tip="Actual physical times given the real E-series resistor. t_rise = Rg_on_total × Qgd / (Vdrv−Vplateau)  |  t_fall = Rg_off_total × Qgd / Vplateau" />
              <Row label="dV/dt Bus" value={fmtNum(gate.hs_dv_dt_bus,1)} unit="V/μs" src="auto" color={gate.hs_dv_dt_bus > 10000 ? '#ff5252' : gate.hs_dv_dt_bus > 5000 ? '#ffab40' : '#4caf50'}
                tip="dV/dt = Vbus / t_rise. Nominal operating stress. Keep < 5000 V/μs (5 V/ns) for low EMI footprint." />
              <Row label="dV/dt Peak" value={fmtNum(gate.hs_dv_dt_peak,1)} unit="V/μs" src="auto" color={gate.hs_dv_dt_peak > 10000 ? '#ff5252' : gate.hs_dv_dt_peak > 5000 ? '#ffab40' : '#4caf50'}
                tip="dV/dt = Vpeak / t_rise. Worst-case transient stress. Keep < 10000 V/μs (10 V/ns) to prevent motor phase insulation breakdown." />
              <Row label="I_peak On/Off" value={`${fmtNum(gate.hs_i_peak_on_a,1)} / ${fmtNum(gate.hs_i_peak_off_a,1)}`} unit="A" src="auto" 
                tip="I_peak_on = (Vdrv−Vplateau)/Rg_on_total | I_peak_off = Vplateau/Rg_off_total. Used to validate High Side Gate Driver IC capability." />
              <Row label="Sw Loss (Psw)" value={fmtNum(gate.hs_p_sw_w,2)} unit="W" src="auto" 
                tip="P_sw = 0.5 × Vbus × I_load × (t_rise + t_fall) × fsw. High side hard-switching power loss." />
            </div>
            {/* LS Column */}
            <div>
              <div style={{ borderBottom:'1px solid var(--border-1)', paddingBottom:4, marginBottom:6, fontSize:10, fontWeight:700, color:'var(--txt-3)' }}>LOW SIDE</div>
              <Row label="Rg_on / off" value={`${fmtNum(gate.ls_rg_on_ohm,1)} / ${fmtNum(gate.ls_rg_off_ohm,1)}`} unit="Ω" bold src={ls_rg_on_ok?'ovr':'auto'} 
                tip="Standard E-series resistor value calculated to most closely match your target switching speeds." />
              <Row label="Rise / Fall" value={`${fmtNum(gate.ls_gate_rise_time_ns,1)} / ${fmtNum(gate.ls_gate_fall_time_ns,1)}`} unit="ns" src="auto" 
                tip="Actual physical times given the real E-series resistor. Differs slightly from target because resistors are discrete values." />
              <Row label="dV/dt Bus" value={fmtNum(gate.ls_dv_dt_bus,1)} unit="V/μs" src="auto" color={gate.ls_dv_dt_bus > 10000 ? '#ff5252' : gate.ls_dv_dt_bus > 5000 ? '#ffab40' : '#4caf50'}
                tip="dV/dt = Vbus / t_rise. Keep < 5000 V/μs (5 V/ns)." />
              <Row label="dV/dt Peak" value={fmtNum(gate.ls_dv_dt_peak,1)} unit="V/μs" src="auto" color={gate.ls_dv_dt_peak > 10000 ? '#ff5252' : gate.ls_dv_dt_peak > 5000 ? '#ffab40' : '#4caf50'}
                tip="dV/dt = Vpeak / t_rise. Keep < 10000 V/μs (10 V/ns)." />
              <Row label="I_peak On/Off" value={`${fmtNum(gate.ls_i_peak_on_a,1)} / ${fmtNum(gate.ls_i_peak_off_a,1)}`} unit="A" src="auto" 
                tip="Validates your Low Side Driver IC source/sink limits." />
              <Row label="Sw Loss (Psw)" value={fmtNum(gate.ls_p_sw_w,2)} unit="W" src="auto" 
                tip="Low side primarily exhibits conduction and body diode loss. Switching loss here is usually minimal compared to High Side." />
            </div>
          </div>
          <div style={{ marginTop: 8, display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px', gridColumn:'1/-1', borderTop:'1px solid #ffffff10', paddingTop:8 }}>
            <Row label="HS Sizing Basis" value={gate.sizing_basis_hs} unit="" src="auto" />
            <Row label="LS Sizing Basis" value={gate.sizing_basis_ls} unit="" src="auto" />
            <Row label="Rg Internal" value={fmtNum(gate.rg_internal_ohm,1)} unit="Ω" src="auto" tip="Subtracted from external calculation" />
            <Row label="Rg Power (HS+LS)"
              value={fmtNum((gate.hs_rg_power_w ?? 0) + (gate.ls_rg_power_w ?? 0), 4)}
              unit="W" src="auto"
              color={((gate.hs_rg_power_w ?? 0) + (gate.ls_rg_power_w ?? 0)) > 0.1 ? '#ff5252' : ((gate.hs_rg_power_w ?? 0) + (gate.ls_rg_power_w ?? 0)) > 0.05 ? '#ffab40' : undefined}
              tip="Total power burned in all gate resistors. 0402 parts are rated 0.1W. If red, upgrade to 0603 (0.1W) or parallel resistors." />
            {dt.trr_warning && <div style={{gridColumn:'1/-1', color:'#ff5252', fontSize:10, marginTop:4}}>⚠ {dt.trr_warning}</div>}
          </div>
          {dt.dt_recommended_ns != null && (
            <>
              <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
                letterSpacing:'.5px', textTransform:'uppercase' }}>Dead Time</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
                <Row label="DT minimum" value={fmtNum(dt.dt_minimum_ns, 1)} unit="ns" src="auto"
                  tip="DT_min = td_off + tf + prop_delay — minimum safe dead time" />
                <Row label="DT recommended" value={fmtNum(dt.dt_recommended_ns, 1)} unit="ns" bold
                  src={ovr.deadtime_override_ns != null ? 'ovr' : 'auto'}
                  tip="DT_rec = DT_min × safety_margin (1.25×) or your override" />
                <Row label="DT actual" value={fmtNum(dt.dt_actual_ns, 1)} unit="ns" src="auto"
                  tip="Quantized to MCU timer resolution" />
                <Row label="Period loss" value={fmtNum(dt.dt_pct_of_period, 3)} unit="%" src="auto"
                  tip="2 × DT / Tsw — effective duty cycle reduction per switching cycle" />
                <Row label="Body Diode Loss" value={fmtNum(dt.body_diode_loss_total_w, 2)} unit="W" src="auto" 
                  tip="Total power dissipated by body diodes during dead time commutation" />
                <Row label="Diode Time/Cyc" value={dt.dt_actual_ns != null ? fmtNum(dt.dt_actual_ns * 2, 1) : null} unit="ns" src="auto"
                  tip="2 × DT_actual — total dead-band per PWM cycle (one at rising edge, one at falling edge)" />
              </div>
            </>
          )}
        </>}
      />

      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 2 — Bus Capacitors                           */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="caps" icon="🔋" title="Bus Capacitors" color="#1e90ff"
        tier="recommended"
        open={open.caps} onToggle={tog}
        overrideCount={capsOvrCnt}
        stale={stale} noResults={!C}
        inputs={<>
          <OvrField label="Ripple ΔV" unit="V"
            value={ovr.delta_v_ripple ?? ''} defaultVal={2.0}
            onChange={v => setOvr('delta_v_ripple', v)} onReset={() => resetOvr('delta_v_ripple')} />
          {/* MLCC sub-header */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#1e90ff', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, paddingTop:4,
              borderTop:'1px solid rgba(255,255,255,.06)' }}>MLCC (HF decoupling)</div>
          </div>
          <OvrField label="MLCC Count" unit="pcs" step={1}
            value={ovr.mlcc_qty ?? ''} defaultVal={6}
            onChange={v => setOvr('mlcc_qty', v)} onReset={() => resetOvr('mlcc_qty')} />
          <OvrField label="MLCC Size" unit="µF" step={0.001}
            value={ovr.mlcc_size_nf != null ? +(ovr.mlcc_size_nf / 1000).toFixed(4) : ''} defaultVal={0.1}
            onChange={v => setOvr('mlcc_size_nf', v !== '' ? +(parseFloat(v) * 1000).toFixed(2) : '')} onReset={() => resetOvr('mlcc_size_nf')}
            note="Enter in µF (X7R recommended). e.g. 0.1 = 100nF. Stored internally in nF." />
          <OvrField label="MLCC ESR (Series Req)" unit="mΩ" min={0.1}
            value={ovr.mlcc_z_mohm ?? ''} defaultVal={2}
            onChange={v => setOvr('mlcc_z_mohm', v)} onReset={() => resetOvr('mlcc_z_mohm')}
            note="Pure resistive Equivalent Series Resistance (ESR). The backend physics engine will analytically handle the huge capacitive reactance (Xc) for you!" />
          <OvrField label="MLCC V-Rating" unit="V"
            value={ovr.mlcc_v_rating_v ?? ''} defaultVal={50}
            onChange={v => setOvr('mlcc_v_rating_v', v)} onReset={() => resetOvr('mlcc_v_rating_v')}
            note="Critical for calculating violent DC-Bias capacitance droop effect." />
          {/* Film sub-header */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#1e90ff', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, paddingTop:4,
              borderTop:'1px solid rgba(255,255,255,.06)' }}>Film capacitor (mid-freq)</div>
          </div>
          <OvrField label="Film Count" unit="pcs" step={1}
            value={ovr.film_qty ?? ''} defaultVal={2}
            onChange={v => setOvr('film_qty', v)} onReset={() => resetOvr('film_qty')} />
          <OvrField label="Film Size" unit="µF" min={0.1}
            value={ovr.film_size_uf ?? ''} defaultVal={4.7}
            onChange={v => setOvr('film_size_uf', v)} onReset={() => resetOvr('film_size_uf')} />
          <OvrField label="Film ESR" unit="mΩ" min={0.1}
            value={ovr.film_z_mohm ?? ''} defaultVal={5.0}
            onChange={v => setOvr('film_z_mohm', v)} onReset={() => resetOvr('film_z_mohm')}
            note="Resistive ESR only. True Admittance (Y) splitting automatically accounts for capacitance." />
          <OvrField label="Film V-Rating" unit="V"
            value={ovr.film_v_rating_v ?? ''} defaultVal={100}
            onChange={v => setOvr('film_v_rating_v', v)} onReset={() => resetOvr('film_v_rating_v')} />
        </> /* end inputs */}
        results={<>
          {/* UX-B: Total C prominently at top */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px', padding:'6px 8px', marginBottom:6,
            background:'rgba(30,144,255,0.06)', borderRadius:6, border:'1px solid rgba(30,144,255,0.2)' }}>
            <Row label="Total Bus Cap" value={fmtNum(icap.c_total_uf, 1)} unit="µF" bold src="auto"
              tip="Total = (N_mlcc × C_mlcc) + (N_film × C_film). This is the actual installed capacitance the DC bus sees." />
            <Row label="Required C" value={fmtNum(icap.c_bulk_required_uf, 1)} unit="µF" src="auto"
              tip="C = I_max / (4 × fsw × ΔV_target). Minimum capacitance required to limit ripple to your target." />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Ripple RMS" value={fmtNum(icap.i_ripple_rms_a, 2)} unit="A" src="auto" bold color="#ffab00"
              tip={icap.ripple_method?.includes('Analytic') ? "Exact 3-phase SVPWM mathematical integral. Represents the true bulk chopped AC phase currents the DC-link must survive." : "Calculated ripple current entering the DC bus."} />
            <Row label="Bulk caps" value={`${fv(icap.n_bulk_caps)}×`} bold src="auto" />
            <Row label="Per cap" value={`${fv(icap.c_per_bulk_cap_uf)}µF`} bold src="auto" />
            <Row label="V-ripple actual" value={fmtNum(icap.v_ripple_actual_v, 3)} unit="V" src="auto" />
            <Row label="ESR budget" value={fmtNum(icap.esr_budget_total_mohm, 1)} unit="mΩ" src="auto"
              tip="ESR limit = ΔV_allowable / I_max. Strict upper limit to ensure the instantaneous I×R voltage drop from phase switching does not exceed your target." />
          </div>
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>MLCC</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Count × Size" value={`${fv(icap.c_mlcc_qty)}× ${fv(icap.c_mlcc_nf != null ? +(icap.c_mlcc_nf / 1000).toFixed(4) : null)}µF`}
              src={ovr.mlcc_qty != null || ovr.mlcc_size_nf != null ? 'ovr' : 'auto'} />
            <Row label="‖ Impedance" value={fmtNum(icap.c_mlcc_parallel_z_mohm, 2)} unit="mΩ" bold src="auto"
              tip="True Vector Impedance Z = √(ESR² + Xc²). High-frequency AC current strictly splits via vector admittance, not just ESR." />
            <Row label="Power loss" value={fmtNum(icap.c_mlcc_power_loss_w, 4)} unit="W" src="auto" bold color={icap.c_mlcc_power_loss_w > 0.1 ? '#ff4444' : '#ffab00'}
              tip="P_loss = I_mlcc² × ESR_mlcc. Heat physically burned into the ceramics. If high, your MLCCs are sinking too much AC ripple!" />
            <Row label="Ripple Share" value={fmtNum(icap.i_mlcc_rms_a, 2)} unit="A rms" src="auto" color="#00e676" />
            <Row label="DC Bias Limit" value={fv(icap.c_mlcc_v_rating)} unit="V" 
              src={ovr.mlcc_v_rating_v != null ? 'ovr' : 'auto'} />
          </div>
          {icap.c_mlcc_safety_warning === "DANGER: Severe DC-Bias Derating" && (
            <div style={{ marginTop:6, fontSize:11, padding:'5px 8px', borderRadius:5, background:'rgba(255,68,68,.1)', border:'1px solid rgba(255,68,68,.3)', color:'var(--red)' }}>
              ⚠ DANGER: V_bus exceeds 60% of MLCC V-Rating. Capacitance will plummet due to DC-Bias squeezing!
            </div>
          )}

          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>Film</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Count × Size" value={`${fv(icap.c_film_qty)}× ${fv(icap.c_film_uf)}µF`}
              src={ovr.film_qty != null || ovr.film_size_uf != null ? 'ovr' : 'auto'} />
            <Row label="‖ Impedance" value={fmtNum(icap.c_film_z_mohm / (icap.c_film_qty || 1), 2)} unit="mΩ" src="auto"
              tip="|Z_parallel| = |Z_single| / N. Bulk AC current steering resistance." />
            <Row label="Ripple Share" value={fmtNum(icap.i_film_rms_a, 2)} unit="A rms" src="auto" color="#00e676" />
            <Row label="V-rating" value={fv(icap.c_film_v_rating)} unit="V"
              src={ovr.film_v_rating_v != null ? 'ovr' : 'auto'} />
          </div>
        </>}
      />

      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 3 — Bootstrap                                */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="boot" icon="🔄" title="Bootstrap Circuit" color="#00d4e8"
        tier="optional"
        open={open.boot} onToggle={tog}
        overrideCount={bootOvrCnt}
        stale={stale} noResults={!C}

        inputs={<>
          <OvrField label="Max Droop" unit="V"
            value={ovr.bootstrap_droop_v ?? ''} defaultVal={0.5}
            onChange={v => setOvr('bootstrap_droop_v', v)} onReset={() => resetOvr('bootstrap_droop_v')}
            note="Target per-cycle gate voltage sag budget (ΔV). C_min = Q_total / ΔV. Smaller droop → larger required C_boot." />
          <OvrField label="C_boot V-Rating" unit="V"
            value={ovr.cboot_v_rating_v ?? ''} defaultVal={25}
            onChange={v => setOvr('cboot_v_rating_v', v)} onReset={() => resetOvr('cboot_v_rating_v')}
            note="Overrides safety rule. ≥ 2× V_boot recommended to combat MLCC DC-bias derating (X7R caps lose 50–70% C at rated voltage)." />
          <OvrField label="Rg_bootstrap" unit="Ω"
            value={ovr.rg_bootstrap_ohm ?? ''} defaultVal={10}
            onChange={v => setOvr('rg_bootstrap_ohm', v)} onReset={() => resetOvr('rg_bootstrap_ohm')}
            note="Series resistor for bootstrap charging. τ = Rg × C_boot. Increasing Rg extends t_refresh = 3τ — read Min Refresh row to see impact." />
          {/* Reverse calculator */}
          <div style={{ ...fullSpan, paddingTop:4, borderTop:'1px solid rgba(255,255,255,.06)' }}>
            <div style={{ fontSize:10, fontWeight:700, color:'#00d4e8', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:6 }}>Reverse: Solve C_boot from Min On-Time</div>
            <div style={{ display:'flex', gap:6 }}>
              <input type="number" placeholder="Target on-time (ns)" value={bootTargetNs}
                onChange={e => setBootTargetNs(e.target.value)}
                style={{ flex:1, padding:'5px 8px', fontSize:11, borderRadius:6,
                  background:'var(--bg-3)', border:'1px solid var(--border-1)',
                  color:'var(--txt-1)', outline:'none', fontFamily:'var(--font-mono)' }} />
              <button onClick={solveBootstrap} disabled={bootBusy} style={{
                padding:'5px 12px', fontSize:11, fontWeight:700, borderRadius:6,
                background:'#00d4e8', color:'#000', border:'none', cursor:'pointer',
                opacity: bootBusy ? .6 : 1 }}>
                {bootBusy ? '…' : '⟳ Solve'}
              </button>
            </div>
            {bootSolve && (
              <div style={{ marginTop:6, fontSize:11, padding:'5px 8px', borderRadius:5,
                background: bootSolve.feasible ? 'rgba(0,230,118,.1)' : 'rgba(255,68,68,.1)',
                border: `1px solid ${bootSolve.feasible ? 'rgba(0,230,118,.3)' : 'rgba(255,68,68,.3)'}`,
                color: bootSolve.feasible ? 'var(--green)' : 'var(--red)' }}>
                <div style={{ marginBottom: bootSolve.feasible ? 4 : 0 }}>
                  {bootSolve.feasible
                    ? `✓ Solved: ${bootSolve.solved_value} ${bootSolve.solved_unit}`
                    : `✗ ${bootSolve.constraint}`}
                </div>
                {bootSolve.feasible && (
                  <button
                    onClick={() => setOvr('bootstrap_droop_v', bootSolve.solved_value)}
                    style={{
                      padding:'3px 10px', fontSize:10, fontWeight:700, borderRadius:4,
                      background:'rgba(0,230,118,.25)', border:'1px solid rgba(0,230,118,.5)',
                      color:'var(--green)', cursor:'pointer'
                    }}
                  >
                    → Apply as Max Droop override
                  </button>
                )}
              </div>
            )}
          </div>
        </>}
        results={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Rg_bootstrap" value={fmtNum(bcap.r_boot_series_ohm, 1)} unit="Ω" bold src={ovr.rg_bootstrap_ohm != null ? 'ovr': 'auto'}
              tip={`Resistor in series with bootstrap diode. Limits peak inrush current I_peak = V_drv / Rg_boot. τ = Rg_boot × C_boot — directly sets t_precharge and t_refresh.`} />
            <Row label="C_boot min (per phase)" value={fmtNum(bcap.c_boot_calculated_nf, 1)} unit="nF" src="auto"
              tip={`C_min = Q_total / ΔV_droop_target. Q_total = Qg + I_leak/fsw = ${bcap.q_total_nc != null ? bcap.q_total_nc.toFixed(3) : '?'}nC. Absolute minimum charge-budget capacitance.`} />
            <Row label={`C_boot ×${bcap.safety_margin_x ?? 2} (with margin)`} value={fmtNum(bcap.c_boot_calculated_nf != null && bcap.safety_margin_x != null ? bcap.c_boot_calculated_nf * bcap.safety_margin_x : null, 0)} unit="nF" bold src="auto"
              tip={`Applied ${bcap.safety_margin_x ?? 2}× safety margin (Design Constant: boot.safety_margin) before E12 snap to combat MLCC DC-bias droop and temperature derating.`} />
            <Row label="C_boot chosen (E12, per phase)" value={fmtNum(bcap.c_boot_recommended_nf, 0)} unit="nF" bold
              src={ovr.bootstrap_droop_v != null ? 'ovr' : 'auto'}
              tip={`Standard E12 component value → actual droop on this cap = Q_total / C_chosen = ${bcap.droop_actual_v != null ? bcap.droop_actual_v.toFixed(3) : '?'}V (lower than target droop — good!)`} />
            <Row label="Droop (actual)" value={fmtNum(bcap.droop_actual_v, 3)} unit="V" src="auto"
              tip={`droop_actual = Q_total / C_std = ${bcap.q_total_nc != null ? bcap.q_total_nc.toFixed(3) : '?'}nC / ${bcap.c_boot_recommended_nf != null ? bcap.c_boot_recommended_nf : '?'}nF. Must be < droop_target AND keep V_gate_min > UVLO threshold.`} />
            <Row label="V-rating" value={fv(bcap.c_boot_v_rating_v)} unit="V"
              src={ovr.cboot_v_rating_v != null ? 'ovr' : 'auto'}
              tip={`Rule: Use ≥ 2× V_drive for MLCC DC-bias reliability. At ${bcap.v_bootstrap_v || 11}V, minimum rating = ${bcap.v_bootstrap_v != null ? (bcap.v_bootstrap_v * 2).toFixed(0) : 22}V.`} />
            <Row label="V_boot" value={fmtNum(bcap.v_bootstrap_v, 2)} unit="V" src="auto"
              tip="V_boot = Vcc − Vf_diode. Maximum achievable bootstrap voltage as the cap charges through the diode. High-side FET must turn on fully at this voltage." />
            <Row label="V_boot min (after droop)" value={fmtNum(bcap.v_boot_min_v, 2)} unit="V" src="auto"
              tip={`V_boot − droop_actual = ${bcap.v_bootstrap_v != null && bcap.droop_actual_v != null ? (bcap.v_bootstrap_v - bcap.droop_actual_v).toFixed(3) : '?'}V. Worst-case gate voltage at the end of HS on-time. Must exceed Driver VBS_UVLO threshold.`} />
            <Row label="Quantity" value={fv(bcap.c_boot_qty)} unit="pcs (1 per HS switch)" src="auto"
              tip="Topology constraint: exactly 1 bootstrap capacitor per high-side switch (one per phase limb). Total = num_fets / 2." />
            <Row label="Initial Pre-Charge" value={fmtNum(bcap.boot_precharge_us, 1)} unit="µs" bold src="auto"
              tip={`t_precharge = 3τ = 3 × Rg_boot × C_boot = 3 × ${bcap.r_boot_series_ohm || 10}Ω × ${bcap.c_boot_recommended_nf || '?'}nF = ${bcap.tau_us != null ? (bcap.tau_us * 3).toFixed(1) : '?'}µs. This is the minimum low-side on-time at startup (charging from 0V to 95% of V_boot).`} />
            <Row label="Min Refresh (per cycle)" value={fmtNum(bcap.min_refresh_us, 2)} unit="µs" bold src="auto"
              tip={`t_refresh = 3τ = −τ × ln(0.05) ≈ 3 × ${bcap.tau_us != null ? bcap.tau_us.toFixed(2) : '?'}µs. Exponential RC derivation: during LS on-time, Q_restored = C × droop_actual × (1 − e^(−t/τ)). Solving for 95% recovery gives exactly 3τ, independent of capacitor size. This is the minimum LS duty-cycle constraint.`} />
            <Row label="Hold time" value={fmtNum(bcap.bootstrap_hold_time_ms, 1)} unit="ms" src="auto"
              tip={`t_hold = C_boot × droop_actual / I_leakage = ${bcap.c_boot_recommended_nf || '?'}nF × ${bcap.droop_actual_v != null ? bcap.droop_actual_v.toFixed(3) : '?'}V / ${bcap.i_leakage_ua != null ? bcap.i_leakage_ua.toFixed(1) : '?'}µA. Max safe HS-ON duration before gate voltage droops below UVLO.`} />
          </div>
        </>}
      />

      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 4 — Decoupling & PSU                         */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="psu" icon="🔌" title="Decoupling & PSU" color="#4caf50"
        tier="recommended"
        open={open.psu} onToggle={tog}
        overrideCount={cnt(['bypass_qty','bypass_size_uf'])}
        stale={stale} noResults={!C}
        inputs={<>
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#4caf50', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4 }}>Logic Bypass (VDD Isolation)</div>
          </div>
          <OvrField label="Bypass Count" unit="pcs" step={1}
            value={ovr.bypass_qty ?? ''} defaultVal={2}
            onChange={v => setOvr('bypass_qty', v)} onReset={() => resetOvr('bypass_qty')}
            note="Total tiny caps immediately next to Gate Driver chips." />
          <OvrField label="Bypass Size" unit="µF" step={0.1}
            value={ovr.bypass_size_uf ?? ''} defaultVal={4.7}
            onChange={v => setOvr('bypass_size_uf', v)} onReset={() => resetOvr('bypass_size_uf')} />
        </>}
        results={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Lg Bypass" value={`${fv(icap.c_bypass_qty)}× ${fv(icap.c_bypass_size_uf)}µF`} src="auto"
              tip="Tiny capacitors placed strictly on driver/MCU logic VDD pins to stabilize." />
            <Row label="IC P_loss" value={fmtNum(icap.c_bypass_power_w, 4)} unit="W" src="auto" bold color="#ffab00"
              tip="P_loss = N_fets × (½ × Qg² / C_bypass) × fsw. Thermal energy wasted charging Logic bypass caps." />
          </div>
        </>}
      />



      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 4 — Shunts & Snubber                        */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="shunts" icon="📏" title="Shunts & Snubber" color="#ffab00"
        tier="optional"
        open={open.shunts} onToggle={tog}
        overrideCount={shuntOvrCnt}
        stale={stale} noResults={!C}
        inputs={<>
          {/* ── Topology selector ── */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#ffab00', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:6 }}>Sensing Topology</div>
            <div style={{ display:'flex', gap:6 }}>
              {[
                { key:'three_phase', label:'3-Phase Shunt', icon:'⚡',
                  tip:'One shunt per phase (U/V/W). Best for FOC. Unidirectional sensing per phase.' },
                { key:'single',      label:'Single Shunt',  icon:'📍',
                  tip:'One shunt on DC bus return. Bidirectional sensing. Requires precise ADC timing.' },
              ].map(t => {
                const isActive = (ovr.shunt_topology ?? 'three_phase') === t.key
                return (
                  <button key={t.key}
                    onClick={() => setOvrStr('shunt_topology', t.key)}
                    title={t.tip}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      fontSize: 11,
                      fontWeight: 700,
                      borderRadius: 6,
                      border: `1px solid ${isActive ? '#ffab00' : 'var(--border-1)'}`,
                      background: isActive ? '#ffab0022' : 'var(--bg-3)',
                      color: isActive ? '#ffab00' : 'var(--txt-3)',
                      cursor: 'pointer',
                      boxShadow: isActive ? '0 0 8px #ffab0040' : 'none',
                      transition: 'all .15s',
                      outline: 'none',
                    }}>
                    {t.icon} {t.label}
                  </button>
                )
              })}
            </div>
            {/* topology info chip */}
            <div style={{ marginTop:6, fontSize:10, color:'var(--txt-3)', lineHeight:1.5 }}>
              {(ovr.shunt_topology ?? 'three_phase') === 'three_phase'
                ? '3 × shunt resistors (one per phase). ADC target = 80 % of Vref (unidirectional).'
                : '1 × shunt on DC bus return. ADC target = 50 % of Vref (bidirectional, mid-rail = 0 A).'}
            </div>
          </div>

          {/* ── Common: CSA Gain ── */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#ffab00', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, borderTop:'1px solid rgba(255,255,255,.06)',
              paddingTop:6 }}>Current Sense Amplifier</div>
          </div>
          <OvrField label="CSA Gain Override"
            value={ovr.csa_gain_override ?? ''}
            onChange={v => setOvr('csa_gain_override', v)} onReset={() => resetOvr('csa_gain_override')}
            note={(() => {
              const driverGain = (() => {
                try {
                  const driverBlock = state.project.blocks.driver
                  if (!driverBlock?.raw_data?.parameters) return null
                  for (const p of driverBlock.raw_data.parameters) {
                    if (p.id === 'current_sense_gain') {
                      const sel = driverBlock.selected_params?.[p.id]
                      if (!sel) return null
                      const cond = p.conditions?.[sel.condition_index]
                      if (!cond) return null
                      return sel.override ?? cond.selected
                    }
                  }
                  return null
                } catch { return null }
              })()
              return driverGain != null
                ? `← Gate Driver block: ${driverGain}× (blank = use this automatically)`
                : 'Blank = use value from Gate Driver block'
            })()} />

          {/* ── Topology-specific shunt override ── */}
          {(ovr.shunt_topology ?? 'three_phase') === 'single' ? (
            <OvrField label="Single Shunt" unit="mΩ"
              value={ovr.shunt_single_mohm ?? ''}
              onChange={v => setOvr('shunt_single_mohm', v)} onReset={() => resetOvr('shunt_single_mohm')}
              note="Blank = auto from ADC span @ Imax" />
          ) : (
            <OvrField label="3-phase Shunt" unit="mΩ"
              value={ovr.shunt_three_mohm ?? ''} defaultVal={0.5}
              onChange={v => setOvr('shunt_three_mohm', v)} onReset={() => resetOvr('shunt_three_mohm')} />
          )}

          {/* ── RC Snubber inputs ── */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#ffab00', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, paddingTop:4,
              borderTop:'1px solid rgba(255,255,255,.06)' }}>RC Snubber</div>
          </div>
          <OvrField label="Stray L (Loop)" unit="µH" min={0.0001} step={0.001}
            value={ovr.stray_inductance_nh != null ? +(ovr.stray_inductance_nh / 1000).toFixed(4) : ''} defaultVal={0.010}
            onChange={v => setOvr('stray_inductance_nh', v !== '' ? +(parseFloat(v) * 1000).toFixed(4) : '')} onReset={() => resetOvr('stray_inductance_nh')}
            note="Enter in µH (e.g. 0.010 = 10nH). Stored internally in nH. PCB power-loop parasitics are typically 5–50nH — root cause of voltage overshoot ringing." />
          <OvrField label="Rs Override" unit="Ω" min={0.1}
            value={ovr.snubber_rs_ohm ?? ''}
            onChange={v => setOvr('snubber_rs_ohm', v)} onReset={() => resetOvr('snubber_rs_ohm')}
            note="Overrides damping resistor (Rs). Blank = auto calculate for Critical Damping." />
          <OvrField label="Cs Override" unit="pF" min={1}
            value={ovr.snubber_cs_pf ?? ''}
            onChange={v => setOvr('snubber_cs_pf', v)} onReset={() => resetOvr('snubber_cs_pf')} 
            note="RC Snubber Capacitor. Auto = 3×C_oss (e.g. if Coss=200pF → Cs=600pF). Larger Cs collapses ringing frequency but increases heat: P_loss = ½Cs×V²×fsw. Blank = physics auto-sizes it." />
          <OvrField label="Cap V Mult" unit="× Vpeak"
            value={ovr.snubber_v_mult ?? ''} defaultVal={2.0}
            onChange={v => setOvr('snubber_v_mult', v)} onReset={() => resetOvr('snubber_v_mult')} 
            note="Voltage Rating Safety Multiplier. V_cap_min = (V_bus + V_overshoot) × Mult. Default 2.0× = 2× safety headroom above worst-case peak. Increase if your PCB has poor layout or long power traces." />
        </>}
        results={<>
          {/* ── Topology badge ── */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
            <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', letterSpacing:'.5px',
              textTransform:'uppercase' }}>Sensing</div>
            <div style={{
              fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4,
              background: shunt.topology_mode === 'single' ? '#ffab0020' : '#1e90ff20',
              border: `1px solid ${shunt.topology_mode === 'single' ? '#ffab0050' : '#1e90ff50'}`,
              color: shunt.topology_mode === 'single' ? '#ffab00' : '#1e90ff',
            }}>
              {shunt.topology_mode === 'single' ? '📍 Single Shunt' : '⚡ 3-Phase Shunt'}
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="CSA gain" value={fv(shunt.csa_gain)}
              src={ovr.csa_gain_override != null ? 'ovr' : 'auto'}
              tip="Definition: Current Sense Amplifier voltage gain (V/V). Source: Gate Driver datasheet or manual override. Formula: V_adc = I_shunt × R_shunt × Gain." />
            <Row label="ADC reference" value={fmtNum(shunt.adc_reference_v, 1)} unit="V" src="auto"
              tip="Definition: MCU ADC full-scale reference voltage. Source: MCU datasheet (adc_ref parameter). All current sensing calculations are bounded by this voltage." />
            <Row label="ADC limit" value={fmtNum(shunt.active?.v_adc_max_limit, 2)} unit="V" src="auto"
              tip="Formula: 50% × V_adc_ref. Meaning: Maximum allowable CSA output voltage. Bidirectional sensing maps ±I_peak to 0…V_ref, so the usable swing per polarity is half the reference." />
            <Row label="Ideal R_shunt" value={fmtNum(shunt.ideal_r_mohm, 3)} unit="mΩ" src="auto"
              tip="Formula: R_ideal = V_ADC_limit / (CSA_gain × I_max). Meaning: The exact resistor value that would use the full ADC swing at max current." />
          </div>

          {/* ── Active topology specific ── */}
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>
            {shunt.topology_mode === 'single' ? 'Single Shunt (×1)' : '3-Phase Shunts (×3)'}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Value" value={fmtNum(shunt.active?.value_mohm, 2)} unit="mΩ" bold
              src={(shunt.topology_mode === 'single' ? ovr.shunt_single_mohm : ovr.shunt_three_mohm) != null ? 'ovr' : 'auto'}
              tip="Formula: R_shunt = V_ADC_limit / (CSA_gain × I_max), snapped to 0.5 or 1.0 mΩ standard value." />
            <Row label="Qty" value={fv(shunt.active?.quantity)} unit="pcs" src="auto"
              tip={shunt.topology_mode === 'single' ? '1 shunt on DC bus return' : '1 per phase (U, V, W)'} />
            <Row label="V_shunt @ Imax" value={fmtNum(shunt.active?.v_shunt_mv, 2)} unit="mV" src="auto"
              tip="Formula: V_shunt = I_max × R_shunt. Meaning: The raw millivolt drop across the physical shunt resistor before CSA amplification." />
            <Row label="V_AC @ I_peak" value={fmtNum(shunt.active?.v_adc_swing_peak, 3)} unit="V" src="auto" bold
              color={shunt.active?.v_adc_swing_peak > shunt.active?.v_adc_max_limit ? '#ff4444' : '#00e676'}
              tip="V_swing = (I_max × √2) × R_shunt × Gain. The absolute highest sinusoidal peak voltage expected." />
            <Row label="AC Swing Limit" value={fmtNum(shunt.active?.v_adc_max_limit, 3)} unit="V" src="auto"
              tip="Hard limit: V_ADC / 2. Current sensing output must remain below this to prevent clipping!" />
            <Row label="ADC utilisation" value={fmtNum(shunt.active?.adc_utilisation_pct, 1)} unit="%" src="auto"
              tip="% of ADC full-scale used. Target < 90% for headroom." />
            <Row label="ADC bits used" value={fmtNum(shunt.active?.adc_bits_used, 1)} unit="bits" src="auto"
              tip="Effective resolution used by shunt + CSA signal" />
            {shunt.topology_mode === 'single' ? (
              <Row label="Power (DC)" value={fmtNum(shunt.active?.power_dc_w, 3)} unit="W" src="auto"
                tip="P = I²·R at DC Imax" />
            ) : (
              <Row label="Total power" value={fmtNum(shunt.active?.total_power_w, 3)} unit="W" src="auto"
                tip="P = 3 × I_rms² × R_shunt" />
            )}
            <Row label="Location" value={shunt.active?.location} src="auto"
              tip={shunt.topology_mode === 'single'
                ? 'Single shunt on the DC bus low-side return path, between GND and the bottom FET sources.'
                : 'One shunt per phase leg, between each low-side MOSFET source pin and the star-point GND.'} />
          </div>

          <ShuntDiagram 
            topology={ovr.shunt_topology || 'three_phase'} 
            r_shunt={fmtNum(shunt.active?.value_mohm, 2)}
            gain={fv(shunt.csa_gain)}
            color="#ffab00"
          />

          {/* ── Snubber ── */}
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>Snubber</div>
          {snub.manual_snubber_values && (
            <div style={{ fontSize:10, background:'#ffab0015', border:'1px solid #ffab0040',
              borderRadius:4, padding:'3px 8px', color:'#ffab40', marginBottom:4, fontWeight:700 }}>
              ✓ Manual Rs/Cs active
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Stray L" value={fmtNum(snub.stray_inductance_nh != null ? snub.stray_inductance_nh / 1000 : null, 4)} unit="µH"
              src={ovr.stray_inductance_nh != null ? 'ovr' : 'auto'} 
              tip="Parasitic Loop Inductance. The core geometric cause of all voltage ringing and EMI." />
            <Row label="Overshoot" value={fmtNum(snub.voltage_overshoot_v, 1)} unit="V" src="auto"
              tip="V_over = I_peak × √(L_stray / Coss). The deadly transient voltage spike threatening your MOSFET." />
            <Row label="Rs" value={fv(snub.rs_recommended_ohm)} unit="Ω" bold
              src={ovr.snubber_rs_ohm != null ? 'ovr' : 'auto'}
              tip="Formula: Rs = √(L_stray / Cs_snub). Meaning: Damping resistor sized to critically damp the Cs–L_stray loop. Because Cs > Coss, this gives an overdamped response for the natural Coss–L resonance, which is the correct engineering choice for suppressing ringing." />
            <Row label="Cs" value={fmtNum(snub.cs_recommended_pf, 0)} unit="pF" bold
              src={ovr.snubber_cs_pf != null ? 'ovr' : 'auto'}
              tip={`Formula: Cs = ${fv(snub.coss_pf != null ? Math.round(snub.coss_pf) : '?')}pF (Coss) × N, snapped to nearest E12. Meaning: Snubber cap sized significantly larger than MOSFET Coss so it can fully absorb the Coss discharge energy each switching cycle.`} />
            <Row label="Cs V-rating" value={fv(snub.snubber_cap_v_rating)} unit="V" src="auto" 
              tip="Formula: V_rating = (V_peak + V_overshoot) × Safety_Multiplier. Meaning: The capacitor must withstand the absolute worst-case switch-node voltage, including the inductive overshoot transient." />
            <Row label="Total power" value={fmtNum(snub.p_total_all_snubbers_w, 3)} unit="W" src="auto"
              tip="Formula: P_total = N_fets × ½ × Cs × V_sw_peak² × fsw. Meaning: Each cycle the snubber cap charges to V_peak+V_overshoot, then dumps all that energy as heat into Rs." />
          </div>

          <SnubberDiagram 
            rs={fv(snub.rs_recommended_ohm)} 
            cs={fmtNum(snub.cs_recommended_pf, 0)} 
            v_over={fmtNum(snub.voltage_overshoot_v, 1)}
            color="#ffab00"
          />
        </>}
      />



      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 5 — Protection & OTP                         */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="prot" icon="🛡️" title="Protection & OTP" color="#00e676"
        tier="optional"
        open={open.prot} onToggle={tog}
        overrideCount={protOvrCnt}
        stale={stale} noResults={!C}
        inputs={<>
          {/* ── Voltage Divider ── */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#00e676', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4 }}>Bus Voltage Monitor Divider</div>
          </div>
          <OvrField label="Divider R1 (Top)" unit="kΩ"
            value={ovr.prot_r1_kohm ?? ''} defaultVal={100}
            onChange={v => setOvr('prot_r1_kohm', v)} onReset={() => resetOvr('prot_r1_kohm')}
            note="Top resistor of the voltage divider. R2 auto-calculated unless you override it below." />
          <OvrField label="Divider R2 (Bottom)" unit="kΩ"
            value={ovr.prot_r2_kohm ?? ''}
            onChange={v => setOvr('prot_r2_kohm', v)} onReset={() => resetOvr('prot_r2_kohm')}
            note="Blank = auto-select E24 standard value. Enter your physical board R2 to back-calculate actual trip voltage via: V_trip = V_ref × (R1+R2)/R2." />

          <div style={fullSpan}>
            <DividerDiagram 
              r1={ovr.prot_r1_kohm || 100}
              r2={fmtNum(prot.ovp?.r2_standard_kohm, 2)}
              vbus={specs.bus_voltage || 48}
              vout={fmtNum(
                prot.v_adc_bus_at_vbus ?? (() => {
                  const r2v = prot.ovp?.r2_standard_kohm ?? (ovr.prot_r2_kohm ? parseFloat(ovr.prot_r2_kohm) : null)
                  const r1v = ovr.prot_r1_kohm ? parseFloat(ovr.prot_r1_kohm) : 100
                  const vb  = specs.bus_voltage || 48
                  return r2v != null ? vb * r2v / (r1v + r2v) : null
                })(),
                2
              )}
              color="#00e676"
            />
          </div>

          {/* ── NTC Thermistor ── */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#00e676', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, paddingTop:4,
              borderTop:'1px solid rgba(255,255,255,.06)' }}>NTC Thermistor (OTP Sensor)</div>
          </div>
          <OvrField label="R at 25°C" unit="kΩ"
            value={ovr.ntc_r25_kohm ?? ''} defaultVal={10}
            onChange={v => setOvr('ntc_r25_kohm', v)} onReset={() => resetOvr('ntc_r25_kohm')} />
          <OvrField label="B-Coefficient"
            value={ovr.ntc_b_coeff ?? ''} defaultVal={3950}
            onChange={v => setOvr('ntc_b_coeff', v)} onReset={() => resetOvr('ntc_b_coeff')}
            note="e.g. 3950 (Murata NCP15)" />
          <OvrField label="Pullup Resistor" unit="kΩ"
            value={ovr.ntc_pullup_kohm ?? ''} defaultVal={10}
            onChange={v => setOvr('ntc_pullup_kohm', v)} onReset={() => resetOvr('ntc_pullup_kohm')} />
        </>}
        results={<>
          {/* ── Bus → ADC Scaling ── */}
          <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', letterSpacing:'.5px',
            textTransform:'uppercase', marginBottom:4 }}>Bus → ADC Scaling</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px', marginBottom:6 }}>
            <Row label="Bus nominal (V_bus)" value={fmtNum(specs.bus_voltage, 1)} unit="V" src="auto"
              tip="Nominal DC bus voltage from system specs" />
            <Row label="Bus peak (V_peak)" value={fmtNum(prot.ovp?.v_bus_monitored, 1)} unit="V" src="auto"
              tip="Peak bus voltage used for OVP trip sizing — includes regen overshoot margin" />
            <Row label="ADC reference (V_ref)" value={fmtNum(prot.ovp?.v_adc_ref, 2)} unit="V" src="auto"
              tip="MCU ADC full-scale reference from datasheet (or fallback). Divider output must not exceed this." />
            <Row label="Divider ratio" value={fmtNum(prot.ovp?.divider_ratio, 2)} unit=":1" bold src="auto"
              tip="V_peak ÷ V_ADC_ref — the resistor divider must attenuate by this factor" />
          </div>

          {/* Ratio visual bar */}
          {prot.ovp?.divider_ratio != null && (
            <div style={{ marginBottom:8, padding:'6px 10px', borderRadius:6,
              background:'rgba(0,230,118,0.06)', border:'1px solid rgba(0,230,118,0.2)' }}>
              <div style={{ fontSize:10, color:'var(--txt-3)', marginBottom:4 }}>
                Divider attenuation: <strong style={{color:'#00e676'}}>
                  V_peak {fmtNum(prot.ovp?.v_bus_monitored,1)}V ÷ V_ADC_ref {fmtNum(prot.ovp?.v_adc_ref,2)}V = {fmtNum(prot.ovp?.divider_ratio,2)}:1
                </strong>
              </div>
              <div style={{ fontSize:10, color:'var(--txt-4)' }}>
                R2 = R1 × V_ADC / (V_trip − V_ADC) — R1 set by you, R2 auto-calculated
              </div>
            </div>
          )}

          {/* ── OVP ── */}
          <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', letterSpacing:'.5px',
            textTransform:'uppercase', marginBottom:4 }}>Over-Voltage Protection (OVP)</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px', marginBottom:6 }}>
            <Row label="Trip voltage" value={fmtNum(prot.ovp?.trip_voltage_v, 1)} unit="V" bold src="auto"
              tip="Definition: The absolute maximum threshold. If bus voltage reaches this, the protection circuit immediately disables the inverter to prevent MOSFET avalanche failure." />
            <Row label="Actual trip" value={fmtNum(prot.ovp?.actual_trip_v, 2)} unit="V" 
              src={prot.ovp?.r2_is_override ? 'ovr' : 'auto'}
              bold={!!prot.ovp?.r2_is_override}
              color={prot.ovp?.r2_is_override ? '#ffab00' : undefined}
              tip={prot.ovp?.r2_is_override
                ? `Formula: V_trip = V_ref × (R1+R2)/R2 = ${fmtNum(prot.ovp?.actual_trip_v,2)}V. Meaning: The exact trip voltage computed from your physical board components.`
                : 'Meaning: The exact trip voltage given the standard E24 resistors. May differ slightly from the ideal target due to resistor value snapping.'} />
            <Row label="R1 (top)" value={fmtNum(prot.ovp?.r1_kohm, 0)} unit="kΩ" src={ovr.prot_r1_kohm != null ? 'ovr' : 'auto'}
              tip="Definition: Top resistor of the voltage divider network. Connects directly to the high voltage bus." />
            <Row label="R2 (bottom)" value={fmtNum(prot.ovp?.r2_standard_kohm, 2)} unit="kΩ" bold
              src={prot.ovp?.r2_is_override ? 'ovr' : 'auto'}
              tip={prot.ovp?.r2_is_override
                ? `Meaning: You have manually completely defined the divider circuit.`
                : 'Formula: R2 = R1 × V_ref / (V_trip - V_ref). Meaning: Auto-selected bottom resistor, snapped to nearest E24 standard value.'} />
            <Row label="Filter capacitor (C_f)" value={fmtNum(prot.ovp?.c_filter_nf, 1)} unit="nF" src="auto"
              tip={`Formula: C_f = 1 / (2π × R_eq × F_c).\nMeaning: Standard E12 capacitor that forms an RC low-pass filter with R1||R2. Targets ~2kHz cutoff to reject 20kHz PWM noise without delaying the OVP trip response.`} />
            <Row label="RC cutoff freq" value={fmtNum(prot.ovp?.f_cutoff_hz, 0)} unit="Hz" src="auto"
              tip={`Meaning: The actual low-pass edge frequency achieved using the snapped ${fmtNum(prot.ovp?.c_filter_nf, 1)}nF capacitor.`} />
            <Row label="TVS stand-off (V_RWM)" value={fmtNum(prot.ovp?.tvs_v_rwm_suggested, 1)} unit="V" bold src="auto"
              tip="Formula: 1.05 × V_ovp_trip. Meaning: Recommended Working Peak Reverse Voltage for a bus clamping TVS diode. Sized exactly 5% above the OVP threshold so it never conducts during normal operation." />
            <Row label="TVS clamp (V_c)" value={fmtNum(prot.ovp?.tvs_v_clamp_typ, 1)} unit="V" src="auto"
              tip="Formula: ~1.6 × V_RWM. Meaning: The typical maximum voltage the bus will spike to during a severe overvoltage transient before the TVS fully absorbs the energy." />
            <Row label="Divider current" value={fmtNum(prot.ovp?.divider_current_ua, 1)} unit="µA" src="auto"
              tip="Definition: Quiescent leakage current constantly flowing through R1+R2. Should be kept < 100µA to prevent unnecessary standby power dissipation." />
          </div>

          {/* ── UVP ── */}
          <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', letterSpacing:'.5px',
            textTransform:'uppercase', marginBottom:4 }}>Under-Voltage Protection (UVP)</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px', marginBottom:6 }}>
            <Row label="Trip voltage" value={fmtNum(prot.uvp?.trip_voltage_v, 1)} unit="V" bold src="auto"
              tip="Definition: Under-voltage lockout threshold. Below this voltage, the inverter shuts down to prevent control logic and gate drive misbehavior." />
            <Row label="Actual trip" value={fmtNum(prot.uvp?.actual_trip_v, 2)} unit="V"
              src={prot.uvp?.r2_is_override ? 'ovr' : 'auto'}
              bold={!!prot.uvp?.r2_is_override}
              color={prot.uvp?.r2_is_override ? '#ffab00' : undefined}
              tip={prot.uvp?.r2_is_override
                ? `Formula: V_trip = V_ref × (R1+R2)/R2 = ${fmtNum(prot.uvp?.actual_trip_v,2)}V. Meaning: The exact trip voltage computed from your physical board components.`
                : 'Meaning: The exact trip voltage given the standard E24 resistors. May differ slightly from the ideal target due to resistor value snapping.'} />
            <Row label="Hysteresis" value={fmtNum(prot.uvp?.hysteresis_voltage_v, 1)} unit="V" src="auto"
              tip="Definition: The voltage the bus must recover to before the system is re-enabled. Prevents rapid on/off oscillation at the trip edge boundary." />
            <Row label="R1 (top, shared)" value={fmtNum(prot.uvp?.r1_kohm, 0)} unit="kΩ" src={ovr.prot_r1_kohm != null ? 'ovr' : 'auto'}
              tip="Definition: Uses the exact same physical R1 value as the OVP divider. The difference in trip threshold is achieved entirely by using a different R2 value." />
            <Row label="R2 (bottom)" value={fmtNum(prot.uvp?.r2_standard_kohm, 2)} unit="kΩ" bold
              src={prot.uvp?.r2_is_override ? 'ovr' : 'auto'}
              tip={prot.uvp?.r2_is_override
                ? 'Meaning: You have manually completely defined the divider circuit.'
                : 'Formula: R2_uvp = R1 × V_ref / (V_trip - V_ref). Meaning: Auto-selected bottom resistor, snapped to nearest E24 standard value.'} />
            <Row label="Filter capacitor (C_f)" value={fmtNum(prot.uvp?.c_filter_nf, 1)} unit="nF" src="auto"
              tip={`Formula: C_f = 1 / (2π × R_eq × F_c).\nMeaning: Standard E12 capacitor that forms a ~2kHz RC low-pass filter with R1||R2.`} />
            <Row label="RC cutoff freq" value={fmtNum(prot.uvp?.f_cutoff_hz, 0)} unit="Hz" src="auto"
              tip={`Meaning: The actual low-pass edge frequency achieved using the snapped ${fmtNum(prot.uvp?.c_filter_nf, 1)}nF capacitor.`} />
          </div>

          {/* ── OCP ── */}
          <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', letterSpacing:'.5px',
            textTransform:'uppercase', marginBottom:4 }}>Over-Current Protection (OCP)</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px', marginBottom:6 }}>
            <Row label="Hardware trip" value={fmtNum(prot.ocp?.hw_threshold_a, 0)} unit="A" bold src="auto"
              tip="Formula: I_ocp_hw = 1.5 × I_max. Definition: Absolute max limit. The driver IC latches off within ~1µs when the analog current sense pin crosses this threshold." />
            <Row label="Software trip" value={fmtNum(prot.ocp?.sw_threshold_a, 0)} unit="A" src="auto"
              tip="Formula: I_ocp_sw = 1.25 × I_max. Definition: Soft limit handled via MCU firmware interrupt. Used to safely disable PWM linearly (~10µs response) before hitting hardware protection limits." />
          </div>

          {/* ── NTC / OTP ── */}
          <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', letterSpacing:'.5px',
            textTransform:'uppercase', marginBottom:4 }}>NTC Thermistor / Over-Temp Protection</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Warning threshold" value={fmtNum(prot.otp?.warning_temp_c, 0)} unit="°C" src="auto" />
            <Row label="Shutdown threshold" value={fmtNum(prot.otp?.shutdown_temp_c, 0)} unit="°C" src="auto" />
            <Row label={`V_NTC @ ${fv(prot.otp?.warning_temp_c)}°C (warn)`} value={fmtNum(prot.otp?.v_ntc_at_80c_v, 3)} unit="V" bold src="auto"
              tip="Steinhart-Hart: 1/T = 1/T₀ + (1/B)×ln(R/R₀) — NTC voltage at warning temp" />
            <Row label={`V_NTC @ ${fv(prot.otp?.shutdown_temp_c)}°C (shut)`} value={fmtNum(prot.otp?.v_ntc_at_100c_v, 3)} unit="V" bold src="auto"
              tip="MCU ADC reads this voltage — firmware shuts down gate drive when crossed" />
            <Row label="NTC R₂₅" value={fmtNum(prot.otp?.ntc_value_at_25c_kohm, 0)} unit="kΩ"
              src={ovr.ntc_r25_kohm != null ? 'ovr' : 'auto'} />
            <Row label="B-coeff" value={fv(prot.otp?.ntc_b_coefficient)}
              src={ovr.ntc_b_coeff != null ? 'ovr' : 'auto'} />
          </div>

          {/* ── PSU Bypass (moved here, clearly labelled) ── */}
          <div style={{ margin:'8px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>PSU Bypass Caps</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Gate drv bulk" value={`${fv(psby.vcc_gate_driver?.bulk_cap_uf)}µF/${fv(psby.vcc_gate_driver?.bulk_v_rating)}V`} src="auto" />
            <Row label="Gate drv bypass" value={`${fv(psby.vcc_gate_driver?.bypass_cap_nf)}nF ×2`} src="auto" />
            <Row label="MCU bypass" value={`${fv(psby.vdd_mcu?.bypass_qty)}× ${fv(psby.vdd_mcu?.bypass_cap_nf)}nF`} src="auto" />
          </div>
        </>}
      />



      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 6 — EMI Filter                               */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="emi" icon="📻" title="EMI Filter" color="#cf6679"
        tier="optional"
        open={open.emi} onToggle={tog}
        overrideCount={emiOvrCnt}
        stale={stale} noResults={!C}
        inputs={<>
          <OvrField label="CM Choke DCR" unit="mΩ"
            value={ovr.emi_choke_dcr_mohm ?? ''} defaultVal={5}
            onChange={v => setOvr('emi_choke_dcr_mohm', v)} onReset={() => resetOvr('emi_choke_dcr_mohm')}
            note="Affects choke power loss" />
          <OvrField label="X-Cap Size" unit="nF"
            value={ovr.emi_x_cap_nf ?? ''} defaultVal={100}
            onChange={v => setOvr('emi_x_cap_nf', v)} onReset={() => resetOvr('emi_x_cap_nf')} />
          <OvrField label="X-Cap V-Rating" unit="V"
            value={ovr.emi_x_cap_v ?? ''} defaultVal={100}
            onChange={v => setOvr('emi_x_cap_v', v)} onReset={() => resetOvr('emi_x_cap_v')} />
          <OvrField label="Y-Cap Size" unit="nF"
            value={ovr.emi_y_cap_nf ?? ''} defaultVal={4.7}
            onChange={v => setOvr('emi_y_cap_nf', v)} onReset={() => resetOvr('emi_y_cap_nf')}
            note="Max 4.7nF (safety limit)" />
          <OvrField label="Y-Cap V-Rating" unit="V"
            value={ovr.emi_y_cap_v ?? ''} defaultVal={100}
            onChange={v => setOvr('emi_y_cap_v', v)} onReset={() => resetOvr('emi_y_cap_v')} />
        </>}
        results={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="CM choke" value={fmtNum(emi.cm_choke_uh, 0)} unit="µH" bold src="auto"
              tip="L_cm = 1/(4π²×f_sw²×C_x) — CM filter corner below f_sw" />
            <Row label="Choke current" value={fmtNum(emi.cm_choke_current_a, 1)} unit="A" src="auto" />
            <Row label="Choke DCR" value={fmtNum(emi.cm_choke_r_dc_mohm, 1)} unit="mΩ"
              src={ovr.emi_choke_dcr_mohm != null ? 'ovr' : 'auto'} />
            <Row label="Choke power" value={fmtNum(emi.cm_choke_power_w, 2)} unit="W" src="auto"
              tip="P = I_rms² × DCR" />
            <Row label="X-cap" value={`${fv(emi.x_cap_nf)}nF / ${fv(emi.x_cap_v_rating)}V`}
              src={ovr.emi_x_cap_nf != null ? 'ovr' : 'auto'} />
            <Row label="Y-cap" value={`${fv(emi.y_cap_nf)}nF / ${fv(emi.y_cap_v_rating)}V`}
              src={ovr.emi_y_cap_nf != null ? 'ovr' : 'auto'} />
          </div>

          <EMIDiagram 
            choke={fmtNum(emi.cm_choke_uh, 0)}
            xcap={fv(emi.x_cap_nf)}
            ycap={fv(emi.y_cap_nf)}
            color="#cf6679"
          />
        </>}
      />



      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 7 — PCB Power Trace (moved to PCB Thermal)   */}
      {/* ══════════════════════════════════════════════════════ */}
      <div style={{
        margin:'12px 0 4px',
        border:'1px solid rgba(100,181,246,.25)',
        borderRadius:10,
        background:'rgba(100,181,246,.04)',
        padding:'16px 18px',
        display:'flex', alignItems:'flex-start', gap:14,
      }}>
        <span style={{ fontSize:28, flexShrink:0 }}>🖥️</span>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'#64b5f6', marginBottom:4 }}>
            PCB Power Trace &amp; Loop Impedance
          </div>
          <div style={{ fontSize:11, color:'var(--txt-3)', lineHeight:1.6, marginBottom:10 }}>
            This section has been moved to the <strong style={{color:'#f0a04a'}}>PCB Thermal &amp; Impedance</strong> tab
            for a cleaner organisation. You can configure trace width, trace length, layer count,
            gate trace width, power clearance, and view the half-bridge loop inductance calculation there.
          </div>
          <button
            onClick={() => navigateTo('pcb_thermal')}
            style={{
              display:'inline-flex', alignItems:'center', gap:7,
              padding:'7px 14px', borderRadius:6, cursor:'pointer',
              fontSize:11, fontWeight:700,
              background:'rgba(240,160,74,.15)',
              border:'1px solid rgba(240,160,74,.4)',
              color:'#f0a04a',
              transition:'all .15s',
            }}
          >
            🔥 Open PCB Thermal &amp; Impedance tab →
          </button>
        </div>
      </div>



    </div>
  )
}
