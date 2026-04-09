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
        padding:'3px 4px', borderBottom:'1px solid rgba(255,255,255,.04)',
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

/* ════════════════════════════════════════════════════════════════ */
export default function PassivesPanel() {
  const { state, dispatch } = useProject()
  const C      = state.project.calculations
  const stale  = !!state.project.calcs_stale
  const ovr    = state.project.blocks.passives.overrides || {}
  const specs  = state.project.system_specs || {}
  const traceP = state.project.pcb_trace_thermal?.params || {}

  // required/recommended open by default; optional sections start collapsed
  const [open, setOpen] = useState({
    gate:true, caps:true, boot:false, shunts:false, prot:false, emi:false, pcb:true
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
  const gateOvrCnt  = [specs.rg_on_override, specs.rg_off_override].filter(v => v != null && v !== '').length
              + cnt(['gate_rise_time_ns','deadtime_override_ns'])
  const capsOvrCnt  = cnt(['delta_v_ripple','bulk_v_rating_v','mlcc_qty','mlcc_size_nf','mlcc_esr_mohm','film_qty','film_size_uf','film_v_rating_v'])
  const bootOvrCnt  = cnt(['bootstrap_droop_v','cboot_v_rating_v','cboot_qty'])
  const shuntOvrCnt = cnt(['shunt_single_mohm','shunt_three_mohm','csa_gain_override','stray_inductance_nh','snubber_rs_ohm','snubber_cs_pf','snubber_v_mult'])
  const protOvrCnt  = cnt(['prot_r1_kohm','ntc_r25_kohm','ntc_b_coeff','ntc_pullup_kohm'])
  const emiOvrCnt   = cnt(['emi_choke_dcr_mohm','emi_x_cap_nf','emi_x_cap_v','emi_y_cap_nf','emi_y_cap_v'])
  const pcbOvrCnt   = (traceP.trace_width_mm != null ? 1 : 0) + (traceP.trace_length_mm != null ? 1 : 0)
                    + cnt(['gate_trace_w_mm','power_clearance_mm'])

  /* Run calculations */
  async function runCalc(silent = false) {
    if (calcInFlight.current) return
    if (state.project.blocks.mosfet.status !== 'done') {
      if (!silent) toast.error('Upload MOSFET datasheet first')
      return 
    }
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
        pcb_trace_thermal_params: state.project.pcb_trace_thermal?.params || {},
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
    if (stale && !calcBusy && state.project.blocks.mosfet?.status === 'done') {
      const timer = setTimeout(() => {
        runCalcRef.current(true) // Run silently after debounce
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [stale, calcBusy, state.project.blocks.mosfet])

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

  const rg_on_ok  = specs.rg_on_override  != null && specs.rg_on_override  !== ''
  const rg_off_ok = specs.rg_off_override != null && specs.rg_off_override !== ''
  const gateReady = rg_on_ok && rg_off_ok

  /* shared col-span helper */
  const fullSpan = { gridColumn:'1/-1' }

  /* ── Render ────────────────────────────────────────────────── */
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10, paddingBottom:80 }}>

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
        {!gateReady && (
          <div style={{ fontSize:11, background:'rgba(255,171,64,.12)',
            border:'1px solid rgba(255,171,64,.45)', borderRadius:7,
            padding:'6px 12px', color:'#ffab40', fontWeight:700 }}>
            ⚠ Enter Rg_on &amp; Rg_off in Gate Drive to enable calculations
          </div>
        )}
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
          <OvrField label="Rg Turn-On" unit="Ω" mandatory
            value={specs.rg_on_override ?? ''}
            onChange={v => setSpec('rg_on_override', v)}
            onReset={() => resetSpec('rg_on_override')}
            note="Sets dV/dt at turn-on" />
          <OvrField label="Rg Turn-Off" unit="Ω" mandatory
            value={specs.rg_off_override ?? ''}
            onChange={v => setSpec('rg_off_override', v)}
            onReset={() => resetSpec('rg_off_override')}
            note="Faster switch-off, lower loss" />
          <OvrField label="Rise Time Target" unit="ns"
            value={ovr.gate_rise_time_ns ?? ''} defaultVal={40}
            onChange={v => setOvr('gate_rise_time_ns', v)}
            onReset={() => resetOvr('gate_rise_time_ns')}
            note="Rg auto-sizing target (if no override)" />
          <OvrField label="Dead Time Override" unit="ns"
            value={ovr.deadtime_override_ns ?? ''}
            onChange={v => setOvr('deadtime_override_ns', v)}
            onReset={() => resetOvr('deadtime_override_ns')}
            note="Blank = auto (td_off + tf + margin)" />
        </>}
        results={<>
          {gate.manual_rg_input && (
            <div style={{ fontSize:10, background:'#bb86fc18', border:'1px solid #bb86fc40',
              borderRadius:5, padding:'3px 8px', color:'#bb86fc', marginBottom:6, fontWeight:700 }}>
              ✓ Manual Rg values active
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Rg_on" value={fmtNum(gate.rg_on_recommended_ohm, 1)} unit="Ω" bold
              src={rg_on_ok ? 'ovr' : 'auto'}
              tip="Rg_on controls turn-on speed → dV/dt and switching loss" />
            <Row label="Rg_off" value={fmtNum(gate.rg_off_recommended_ohm, 1)} unit="Ω" bold
              src={rg_off_ok ? 'ovr' : 'auto'}
              tip="Rg_off controls turn-off speed → body-diode overlap and EMI" />
            <Row label="Rise time" value={fmtNum(gate.gate_rise_time_ns, 1)} unit="ns" src="auto"
              tip="t_rise = Rg_on × (Qgs2 + Qgd) / (Vdrv - Vth)" />
            <Row label="Fall time" value={fmtNum(gate.gate_fall_time_ns, 1)} unit="ns" src="auto"
              tip="t_fall = Rg_off × (Qgs2 + Qgd) / Vth" />
            <Row label="dV/dt" value={fmtNum(gate.dv_dt_v_per_us, 1)} unit="V/µs" src="auto"
              tip="dV/dt = Vbus / t_rise — keep under 10 V/ns to avoid EMI issues" />
            <Row label="Rg power" value={fmtNum(gate.gate_resistor_power_w, 4)} unit="W" src="auto"
              tip="P_Rg = Qg × Vdrv × fsw — power dissipated per gate resistor" />
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
          <OvrField label="Bulk V-Rating" unit="V"
            value={ovr.bulk_v_rating_v ?? ''} defaultVal={100}
            onChange={v => setOvr('bulk_v_rating_v', v)} onReset={() => resetOvr('bulk_v_rating_v')}
            note="e.g. 63V, 100V" />
          <OvrField label="Bulk ESL/cap" unit="nH" min={0.1}
            value={ovr.bulk_esl_nh ?? ''} defaultVal={15}
            onChange={v => setOvr('bulk_esl_nh', v)} onReset={() => resetOvr('bulk_esl_nh')} />
          {/* MLCC sub-header */}
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#1e90ff', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, paddingTop:4,
              borderTop:'1px solid rgba(255,255,255,.06)' }}>MLCC (HF decoupling)</div>
          </div>
          <OvrField label="MLCC Count" unit="pcs" step={1}
            value={ovr.mlcc_qty ?? ''} defaultVal={6}
            onChange={v => setOvr('mlcc_qty', v)} onReset={() => resetOvr('mlcc_qty')} />
          <OvrField label="MLCC Size" unit="nF"
            value={ovr.mlcc_size_nf ?? ''} defaultVal={100}
            onChange={v => setOvr('mlcc_size_nf', v)} onReset={() => resetOvr('mlcc_size_nf')}
            note="X7R recommended" />
          <OvrField label="MLCC ESR/cap" unit="mΩ" min={0.1}
            value={ovr.mlcc_esr_mohm ?? ''} defaultVal={5}
            onChange={v => setOvr('mlcc_esr_mohm', v)} onReset={() => resetOvr('mlcc_esr_mohm')} />
          <OvrField label="MLCC ESL/cap" unit="nH" min={0.1}
            value={ovr.mlcc_esl_nh ?? ''} defaultVal={1}
            onChange={v => setOvr('mlcc_esl_nh', v)} onReset={() => resetOvr('mlcc_esl_nh')} />
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
          <OvrField label="Film ESL/cap" unit="nH" min={0.1}
            value={ovr.film_esl_nh ?? ''} defaultVal={5}
            onChange={v => setOvr('film_esl_nh', v)} onReset={() => resetOvr('film_esl_nh')} />
          <OvrField label="Film V-Rating" unit="V"
            value={ovr.film_v_rating_v ?? ''} defaultVal={100}
            onChange={v => setOvr('film_v_rating_v', v)} onReset={() => resetOvr('film_v_rating_v')} />
        </>}
        results={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Ripple RMS" value={fmtNum(icap.i_ripple_rms_a, 2)} unit="A" src="auto"
              tip="I_ripple = I_max × √(D×(1-D)) — worst case at D=0.5" />
            <Row label="Required C" value={fmtNum(icap.c_bulk_required_uf, 1)} unit="µF" src="auto"
              tip="C_bulk = I_ripple / (8 × fsw × ΔV) — from ripple current and target ΔV" />
            <Row label="Bulk caps" value={`${fv(icap.n_bulk_caps)}×`} bold src="auto" />
            <Row label="Per cap" value={`${fv(icap.c_per_bulk_cap_uf)}µF/${fv(icap.v_rating_bulk_v)}V`} bold
              src={ovr.bulk_v_rating_v != null ? 'ovr' : 'auto'} />
            <Row label="V-ripple actual" value={fmtNum(icap.v_ripple_actual_v, 3)} unit="V" src="auto" />
            <Row label="ESR budget" value={fmtNum(icap.esr_budget_total_mohm, 1)} unit="mΩ" src="auto"
              tip="ESR limit = ΔV / I_ripple — keeps voltage spike in check" />
          </div>
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>MLCC</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Count × Size" value={`${fv(icap.c_mlcc_qty)}× ${fv(icap.c_mlcc_nf)}nF`}
              src={ovr.mlcc_qty != null || ovr.mlcc_size_nf != null ? 'ovr' : 'auto'} />
            <Row label="‖ ESR" value={fmtNum(icap.c_mlcc_parallel_esr_mohm, 2)} unit="mΩ" bold src="auto"
              tip="ESR_parallel = ESR_single / N — N MLCCs in parallel" />
            <Row label="Power loss" value={fmtNum(icap.c_mlcc_power_loss_w, 4)} unit="W" src="auto"
              tip="P = I_ripple² × ESR_parallel" />
          </div>
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>Film</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Count × Size" value={`${fv(icap.c_film_qty)}× ${fv(icap.c_film_uf)}µF`}
              src={ovr.film_qty != null || ovr.film_size_uf != null ? 'ovr' : 'auto'} />
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
            note="Sets minimum C_boot size" />
          <OvrField label="C_boot V-Rating" unit="V"
            value={ovr.cboot_v_rating_v ?? ''} defaultVal={25}
            onChange={v => setOvr('cboot_v_rating_v', v)} onReset={() => resetOvr('cboot_v_rating_v')}
            note="≥ 2× Vdrv for derating" />
          <OvrField label="C_boot Qty" unit="pcs" step={1}
            value={ovr.cboot_qty ?? ''} defaultVal={3}
            onChange={v => setOvr('cboot_qty', v)} onReset={() => resetOvr('cboot_qty')}
            note="1 per HS gate (3-phase = 3)" />
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
                {bootSolve.feasible
                  ? `✓ Solved: ${bootSolve.solved_value} ${bootSolve.solved_unit}`
                  : `✗ ${bootSolve.constraint}`}
              </div>
            )}
          </div>
        </>}
        results={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="C_boot required" value={fmtNum(bcap.c_boot_calculated_nf, 1)} unit="nF" src="auto"
              tip="C_boot = Q_boot / ΔV_droop  where Q_boot = Qgs + I_bias×t_on" />
            <Row label="C_boot chosen" value={fmtNum(bcap.c_boot_recommended_nf, 0)} unit="nF" bold
              src={ovr.bootstrap_droop_v != null ? 'ovr' : 'auto'}
              tip="Rounded to next E12 value above required" />
            <Row label="V-rating" value={fv(bcap.c_boot_v_rating_v)} unit="V"
              src={ovr.cboot_v_rating_v != null ? 'ovr' : 'auto'} />
            <Row label="Quantity" value={fv(bcap.c_boot_qty)} unit="pcs"
              src={ovr.cboot_qty != null ? 'ovr' : 'auto'} />
            <Row label="V_boot" value={fmtNum(bcap.v_bootstrap_v, 2)} unit="V" src="auto"
              tip="V_boot = Vcc - Vd_boot - Vf (diode forward drop)" />
            <Row label="Min HS on-time" value={fmtNum(bcap.min_hs_on_time_ns, 1)} unit="ns" bold src="auto"
              tip="t_on_min = C_boot × ΔV_droop / I_charge_avg" />
            <Row label="Hold time" value={fmtNum(bcap.bootstrap_hold_time_ms, 1)} unit="ms" src="auto" />
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
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#ffab00', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4 }}>Current Shunts</div>
          </div>
          <OvrField label="Single Shunt" unit="mΩ"
            value={ovr.shunt_single_mohm ?? ''}
            onChange={v => setOvr('shunt_single_mohm', v)} onReset={() => resetOvr('shunt_single_mohm')}
            note="Blank = auto from ADC span" />
          <OvrField label="3-phase Shunt" unit="mΩ"
            value={ovr.shunt_three_mohm ?? ''} defaultVal={0.5}
            onChange={v => setOvr('shunt_three_mohm', v)} onReset={() => resetOvr('shunt_three_mohm')} />
          <OvrField label="CSA Gain"
            value={ovr.csa_gain_override ?? ''}
            onChange={v => setOvr('csa_gain_override', v)} onReset={() => resetOvr('csa_gain_override')}
            note="Blank = from driver datasheet" />
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#ffab00', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, paddingTop:4,
              borderTop:'1px solid rgba(255,255,255,.06)' }}>RC Snubber</div>
          </div>
          <OvrField label="Stray L (Loop)" unit="nH" min={0.1}
            value={ovr.stray_inductance_nh ?? ''} defaultVal={10}
            onChange={v => setOvr('stray_inductance_nh', v)} onReset={() => resetOvr('stray_inductance_nh')}
            note="Physical layout parasitic loop inductance" />
          <OvrField label="Rs Override" unit="Ω" min={0.1}
            value={ovr.snubber_rs_ohm ?? ''}
            onChange={v => setOvr('snubber_rs_ohm', v)} onReset={() => resetOvr('snubber_rs_ohm')}
            note="Blank = critical damping calc" />
          <OvrField label="Cs Override" unit="pF" min={1}
            value={ovr.snubber_cs_pf ?? ''}
            onChange={v => setOvr('snubber_cs_pf', v)} onReset={() => resetOvr('snubber_cs_pf')} />
          <OvrField label="Cap V Mult" unit="× Vpeak"
            value={ovr.snubber_v_mult ?? ''} defaultVal={2.0}
            onChange={v => setOvr('snubber_v_mult', v)} onReset={() => resetOvr('snubber_v_mult')} />
        </>}
        results={<>
          <div style={{ fontSize:10, fontWeight:700, color:'var(--txt-3)', letterSpacing:'.5px',
            textTransform:'uppercase', marginBottom:4 }}>Shunts</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="CSA gain" value={fv(shunt.csa_gain)}
              src={ovr.csa_gain_override != null ? 'ovr' : 'auto'}
              tip="Current sense amplifier gain from driver datasheet (or override)" />
            <Row label="Single shunt" value={fmtNum(shunt.single_shunt?.value_mohm, 2)} unit="mΩ" bold
              src={ovr.shunt_single_mohm != null ? 'ovr' : 'auto'}
              tip="R_shunt = V_fullscale / (CSA_gain × I_max)" />
            <Row label="  V_shunt@Imax" value={fmtNum(shunt.single_shunt?.v_shunt_mv, 2)} unit="mV" src="auto" />
            <Row label="  ADC voltage" value={fmtNum(shunt.single_shunt?.v_adc_v, 3)} unit="V" src="auto"
              tip="V_ADC = V_shunt × CSA_gain — should be ≤ ADC reference" />
            <Row label="3-ph shunt" value={fmtNum(shunt.three_shunt?.value_mohm, 2)} unit="mΩ" bold
              src={ovr.shunt_three_mohm != null ? 'ovr' : 'auto'} />
            <Row label="  Total power" value={fmtNum(shunt.three_shunt?.total_3_shunt_power_w, 3)} unit="W" src="auto"
              tip="P = 3 × I_rms² × R_shunt" />
          </div>
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>Snubber</div>
          {snub.manual_snubber_values && (
            <div style={{ fontSize:10, background:'#ffab0015', border:'1px solid #ffab0040',
              borderRadius:4, padding:'3px 8px', color:'#ffab40', marginBottom:4, fontWeight:700 }}>
              ✓ Manual Rs/Cs active
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Stray L" value={fmtNum(snub.stray_inductance_nh, 1)} unit="nH"
              src={ovr.stray_inductance_nh != null ? 'ovr' : 'auto'} />
            <Row label="Overshoot" value={fmtNum(snub.voltage_overshoot_v, 1)} unit="V" src="auto"
              tip="V_over = I_peak × √(L_stray/Cs) — resonant overshoot" />
            <Row label="Rs" value={fv(snub.rs_recommended_ohm)} unit="Ω" bold
              src={ovr.snubber_rs_ohm != null ? 'ovr' : 'auto'}
              tip="Rs = ½√(L/Cs) — critical damping resistor" />
            <Row label="Cs" value={fmtNum(snub.cs_recommended_pf, 0)} unit="pF" bold
              src={ovr.snubber_cs_pf != null ? 'ovr' : 'auto'}
              tip="Cs = L_stray / Rs² — resonant snubber capacitor" />
            <Row label="Cs V-rating" value={fv(snub.snubber_cap_v_rating)} unit="V" src="auto" />
            <Row label="Total power" value={fmtNum(snub.p_total_all_snubbers_w, 3)} unit="W" src="auto"
              tip="P = 6 × ½×Cs×V²×fsw for a 3-phase inverter" />
          </div>
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
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#00e676', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4 }}>Voltage Divider</div>
          </div>
          <OvrField label="OVP/UVP R1" unit="kΩ"
            value={ovr.prot_r1_kohm ?? ''} defaultVal={100}
            onChange={v => setOvr('prot_r1_kohm', v)} onReset={() => resetOvr('prot_r1_kohm')}
            note="Top resistor — drives R2 calc" />
          <div style={fullSpan}>
            <div style={{ fontSize:10, fontWeight:700, color:'#00e676', letterSpacing:'.5px',
              textTransform:'uppercase', marginBottom:4, paddingTop:4,
              borderTop:'1px solid rgba(255,255,255,.06)' }}>NTC Thermistor</div>
          </div>
          <OvrField label="R at 25°C" unit="kΩ"
            value={ovr.ntc_r25_kohm ?? ''} defaultVal={10}
            onChange={v => setOvr('ntc_r25_kohm', v)} onReset={() => resetOvr('ntc_r25_kohm')} />
          <OvrField label="B-Coefficient"
            value={ovr.ntc_b_coeff ?? ''} defaultVal={3950}
            onChange={v => setOvr('ntc_b_coeff', v)} onReset={() => resetOvr('ntc_b_coeff')}
            note="e.g. 3950 (Murata NCP15)" />
          <OvrField label="Pullup" unit="kΩ"
            value={ovr.ntc_pullup_kohm ?? ''} defaultVal={10}
            onChange={v => setOvr('ntc_pullup_kohm', v)} onReset={() => resetOvr('ntc_pullup_kohm')} />
        </>}
        results={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="OVP trip" value={fmtNum(prot.ovp?.trip_voltage_v, 1)} unit="V" bold src="auto"
              tip="V_ovp = Vref × (R1+R2)/R2 — comparator threshold" />
            <Row label="OVP R1/R2" value={`${fv(prot.ovp?.r1_kohm)}k / ${fv(prot.ovp?.r2_standard_kohm)}kΩ`}
              src={ovr.prot_r1_kohm != null ? 'ovr' : 'auto'} />
            <Row label="UVP trip" value={fmtNum(prot.uvp?.trip_voltage_v, 1)} unit="V" bold src="auto" />
            <Row label="OCP hardware" value={fmtNum(prot.ocp?.hw_threshold_a, 0)} unit="A" src="auto"
              tip="I_ocp = V_ref / (R_shunt × CSA_gain)" />
          </div>
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>NTC / OTP</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="NTC R25" value={fmtNum(prot.otp?.ntc_value_at_25c_kohm, 0)} unit="kΩ"
              src={ovr.ntc_r25_kohm != null ? 'ovr' : 'auto'} />
            <Row label="B-coeff" value={fv(prot.otp?.ntc_b_coefficient)}
              src={ovr.ntc_b_coeff != null ? 'ovr' : 'auto'} />
            <Row label="V_NTC @ warn" value={fmtNum(prot.otp?.v_ntc_at_80c_v, 3)} unit="V" bold src="auto"
              tip="Steinhart-Hart: 1/T = 1/T0 + (1/B)×ln(R/R0)" />
            <Row label="V_NTC @ shutdn" value={fmtNum(prot.otp?.v_ntc_at_100c_v, 3)} unit="V" bold src="auto" />
          </div>
          <div style={{ margin:'6px 0 4px', fontSize:10, fontWeight:700, color:'var(--txt-3)',
            letterSpacing:'.5px', textTransform:'uppercase' }}>PSU Bypass</div>
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
        </>}
      />



      {/* ══════════════════════════════════════════════════════ */}
      {/* SECTION 7 — PCB Power Trace                          */}
      {/* ══════════════════════════════════════════════════════ */}
      <Section
        id="pcb" icon="🖥️" title="PCB Power Trace" color="#64b5f6"
        tier="recommended"
        open={open.pcb} onToggle={tog}
        overrideCount={pcbOvrCnt}
        stale={stale} noResults={!C}
        inputs={<>
          <div style={fullSpan}>
            {/* Clickable navigation to PCB Thermal tab */}
            <button
              onClick={() => navigateTo('pcb_thermal')}
              style={{
                width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between',
                fontSize:10.5, color:'#64b5f6', lineHeight:1.5, cursor:'pointer',
                padding:'5px 9px', background:'rgba(100,181,246,.08)', borderRadius:6,
                border:'1px solid rgba(100,181,246,.3)', marginBottom:2,
                fontWeight:500, textAlign:'left',
              }}
            >
              <span>🔗 Fields shared with <strong>PCB Trace Thermal</strong> tab. Changes sync both ways.</span>
              <span style={{ fontSize:10, background:'rgba(100,181,246,.2)', borderRadius:4,
                padding:'2px 7px', fontWeight:700, flexShrink:0, marginLeft:8 }}>
                Open →
              </span>
            </button>
          </div>
          <OvrField label="Power Trace Width" unit="mm" linked
            value={traceP.trace_width_mm ?? ''}
            onChange={v => setTrace('trace_width_mm', v)}
            onReset={() => setTrace('trace_width_mm', undefined)}
            note="Used for IPC-2152 and loop L calc" />
          <OvrField label="Power Trace Length" unit="mm" linked
            value={traceP.trace_length_mm ?? ''}
            onChange={v => setTrace('trace_length_mm', v)}
            onReset={() => setTrace('trace_length_mm', undefined)}
            note="One-way bus→switch node length" />
          <OvrField label="Total PCB Layers" unit="layers" linked step={1}
            value={totalLayers > 0 ? totalLayers : ''}
            onChange={v => setTotalLayers(v)} defaultVal={2}
            onReset={() => setTotalLayers(2)} />
          <OvrField label="Gate Trace Width" unit="mm"
            value={ovr.gate_trace_w_mm ?? ''} defaultVal={0.3}
            onChange={v => setOvr('gate_trace_w_mm', v)} onReset={() => resetOvr('gate_trace_w_mm')} />
          <OvrField label="Power Clearance" unit="mm"
            value={ovr.power_clearance_mm ?? ''} defaultVal={1.0}
            onChange={v => setOvr('power_clearance_mm', v)} onReset={() => resetOvr('power_clearance_mm')} />
        </>}
        results={<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Power trace width" value={fmtNum(pcbg.power_trace_w_mm, 2)} unit="mm" bold />
            <Row label="Gate trace width" value={fmtNum(pcbg.gate_trace_w_mm, 2)} unit="mm" />
            <Row label="Power clearance" value={fmtNum(pcbg.power_clearance_mm, 1)} unit="mm" />
          </div>
          {/* Bridge loop inductance result */}
          <div style={{
            marginTop:8, padding:'8px 10px', borderRadius:7,
            background: loopNh != null ? `${loopColor}0e` : 'var(--bg-2)',
            border:`1px solid ${loopNh != null ? loopColor + '55' : 'var(--border-1)'}`,
          }}>
            <div style={{ fontSize:10, color:'var(--txt-3)', marginBottom:3 }}>
              Half-Bridge Loop Inductance
            </div>
            <div style={{ fontSize:18, fontWeight:800, fontFamily:'var(--font-mono)',
              color: loopNh != null ? loopColor : 'var(--txt-4)' }}>
              {loopNh != null ? `${loopNh} nH` : 'Enter trace dims →'}
            </div>
            {loopNh != null && (
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:4 }}>
                <span style={{ fontSize:10, color:'var(--txt-4)' }}>Target &lt; 5 nH</span>
                <span style={{ fontSize:10.5, fontWeight:700, color: loopColor }}>
                  {loopSt === 'OK' ? '✓ GOOD' : loopSt === 'WARNING' ? '⚠ WARNING' : '✗ CRITICAL'}
                </span>
              </div>
            )}
            {loopNh == null && (
              <div style={{ fontSize:10, color:'var(--txt-4)', marginTop:3 }}>
                Formula: L ≈ 0.4 × l × [ln(4l/(w+h)) + 0.5] nH
              </div>
            )}
          </div>
        </>}
      />



    </div>
  )
}
