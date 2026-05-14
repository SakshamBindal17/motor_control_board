import React, { useState, useCallback, useMemo } from 'react'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'

/* ─── Layout constants ─────────────────────────────────────────────────────────
 *
 *  Row/y layout (top→bottom):
 *    y=15   : Title
 *    y=46   : V+ DC BUS rail
 *    y=68   : HS row top  (Q1, Q3, Q5)     → bottom = 124
 *    y=136  : DC power chain (left side)   → center = 166, between HS-bot(124) and LS-top(208)
 *    y=208  : LS row top  (Q2, Q4, Q6)     → bottom = 264
 *    y=294  : Shunt row top                → bottom = 334
 *    y=418  : GND RAIL
 *    y=450  : Control section (Bootstrap, Gate Driver, Protection …)
 *
 *  Column/x layout (left→right):
 *    x≈20   : DC Bus
 *    x≈136  : EMI Filter
 *    x≈270  : DC-Link Caps
 *    x≈405  : Col A (Q1/Q2/Rs_A)
 *    x≈520  : Col B (Q3/Q4/Rs_B)
 *    x≈635  : Col C (Q5/Q6/Rs_C)
 *    x≈810  : Motor left edge
 * ─────────────────────────────────────────────────────────────────────────── */
const COLS   = [405, 520, 635]   // left-x of MOSFET blocks
const COL_CX = [451, 566, 681]   // center-x of each column (switch-node wire)
const COL_RX = [497, 612, 727]   // right-x of each column MOSFET
const PH_TX  = [507, 622, 737]   // phase tap-out x (COL_RX + 10, after MOSFET block)

const MOW = 92, MOH = 56         // MOSFET block w / h

const HS_Y    = 68               // HS row top
const LS_Y    = 208              // LS row top
const SH_Y    = 294              // shunt row top
const SH_W    = 66, SH_H = 40

const VPLUS_Y = 46               // V+ rail y
const GND_Y   = 418              // GND rail y
const PHASE_Y = Math.round((HS_Y + MOH + LS_Y) / 2)  // = 166  (switch-node midpoint)

const DC_Y    = 136              // DC-chain blocks top-y (center = 166 = PHASE_Y ✓)

const CTRL_Y  = 452              // control section top-y

const MOTOR_CX = 878, MOTOR_CY = 210, MOTOR_R = 70
// motor attachment points on circle surface (~20° spread)
const MOTOR_ATT = [
  { x: MOTOR_CX - MOTOR_R + 4, y: MOTOR_CY - 24 },   // Phase A  ≈20° above horizontal
  { x: MOTOR_CX - MOTOR_R,     y: MOTOR_CY      },    // Phase B  horizontal (leftmost)
  { x: MOTOR_CX - MOTOR_R + 4, y: MOTOR_CY + 24 },   // Phase C  ≈20° below horizontal
]

// Staggered phase tap Y on switch-node wire (HS_bot=124 … LS_top=208)
// Chosen so A < B < C at every x → no line crossings
const PH_TAP_Y = [PHASE_Y - 18, PHASE_Y, PHASE_Y + 29]  // [148, 166, 195]

const VB_W = 980, VB_H = 605

/* ─── Block definitions ───────────────────────────────────────────────────── */
const BLOCKS = {
  // Power chain (left, centered at y = PHASE_Y = 166)
  dc_bus:         { x: 20,        y: DC_Y,    w: 90,  h: 60, label: 'DC Bus',         sublabel: '48V Input',           nav: null,       color: '#ff4444', group: 'power'    },
  emi_filter:     { x: 136,       y: DC_Y,    w: 108, h: 60, label: 'EMI Filter',     sublabel: 'CM + DM',             nav: 'passives', color: '#ffab00', group: 'passive'  },
  input_caps:     { x: 270,       y: DC_Y,    w: 112, h: 60, label: 'DC-Link',        sublabel: 'Bulk + HF',           nav: 'passives', color: '#ffab00', group: 'passive'  },
  // Bridge — column A/B/C, HS top row, LS bottom row
  hs_a:           { x: COLS[0],   y: HS_Y,    w: MOW, h: MOH, label: 'Q1', sublabel: 'HS-A', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  hs_b:           { x: COLS[1],   y: HS_Y,    w: MOW, h: MOH, label: 'Q3', sublabel: 'HS-B', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  hs_c:           { x: COLS[2],   y: HS_Y,    w: MOW, h: MOH, label: 'Q5', sublabel: 'HS-C', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  ls_a:           { x: COLS[0],   y: LS_Y,    w: MOW, h: MOH, label: 'Q2', sublabel: 'LS-A', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  ls_b:           { x: COLS[1],   y: LS_Y,    w: MOW, h: MOH, label: 'Q4', sublabel: 'LS-B', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  ls_c:           { x: COLS[2],   y: LS_Y,    w: MOW, h: MOH, label: 'Q6', sublabel: 'LS-C', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  // Shunts (centered under each column)
  shunt_a:        { x: COLS[0]+13, y: SH_Y,   w: SH_W, h: SH_H, label: 'Rs_A', sublabel: 'Sense A', nav: 'passives', color: '#ffab00', group: 'passive' },
  shunt_b:        { x: COLS[1]+13, y: SH_Y,   w: SH_W, h: SH_H, label: 'Rs_B', sublabel: 'Sense B', nav: 'passives', color: '#ffab00', group: 'passive' },
  shunt_c:        { x: COLS[2]+13, y: SH_Y,   w: SH_W, h: SH_H, label: 'Rs_C', sublabel: 'Sense C', nav: 'passives', color: '#ffab00', group: 'passive' },
  // Motor
  motor:          { x: MOTOR_CX-MOTOR_R, y: MOTOR_CY-MOTOR_R, w: MOTOR_R*2, h: MOTOR_R*2,
                    label: 'PMSM', sublabel: 'Motor', nav: 'motor', color: '#00e676', group: 'motor', isCircle: true },
  // Snubber (top-right, above V+ rail)
  snubber:        { x: 748,  y: 28,       w: 92,  h: 44,  label: 'Snubbers',       sublabel: 'RC Damping',       nav: 'passives', color: '#ffab00', group: 'passive' },
  // Control section (below GND rail)
  bootstrap:      { x: 270,  y: CTRL_Y,   w: 105, h: 44,  label: 'Bootstrap',      sublabel: 'HS Supplies',      nav: 'passives', color: '#ffab00', group: 'passive' },
  gate_resistors: { x: 270,  y: CTRL_Y+55,w: 105, h: 44,  label: 'Gate Rg',        sublabel: 'Rise/Fall Control',nav: 'passives', color: '#ffab00', group: 'passive' },
  gate_driver:    { x: 407,  y: CTRL_Y,   w: 150, h: 62,  label: 'Gate Driver IC', sublabel: '6-Ch Integrated',  nav: 'driver',   color: '#bb86fc', group: 'driver'  },
  mcu:            { x: 407,  y: CTRL_Y+82,w: 150, h: 56,  label: 'MCU',            sublabel: 'PWM + Sense',      nav: 'mcu',      color: '#1e90ff', group: 'mcu'     },
  protection:     { x: 616,  y: CTRL_Y,   w: 128, h: 56,  label: 'Protection',     sublabel: 'OVP / OCP',        nav: 'feedback', color: '#00d4e8', group: 'feedback'},
  bypass:         { x: 616,  y: CTRL_Y+75,w: 118, h: 45,  label: 'Bypass Caps',    sublabel: 'VCC / VDD Rails',  nav: 'passives', color: '#ffab00', group: 'passive' },
}

/* ─── Status helpers ──────────────────────────────────────────────────────── */
function getBlockStatus(state, def) {
  const b = state.project.blocks
  if (!def.nav) return 'info'
  if (def.nav === 'mosfet')   return b.mosfet?.status === 'done' ? 'done' : 'idle'
  if (def.nav === 'driver')   return b.driver?.status === 'done' ? 'done' : 'idle'
  if (def.nav === 'mcu')      return b.mcu?.status    === 'done' ? 'done' : 'idle'
  if (def.nav === 'motor') {
    const sp = b.motor?.specs
    return (sp?.max_speed_rpm && (sp?.rph_mohm || sp?.lph_uh)) ? 'done' : 'idle'
  }
  if (def.nav === 'passives' || def.nav === 'feedback')
    return state.project.calculations ? 'done' : 'idle'
  return 'idle'
}

function statusColor(s) {
  return s === 'done' ? 'var(--green)' : s === 'info' ? 'var(--accent)' : 'var(--txt-4)'
}

/* ─── Thermal / loss data ─────────────────────────────────────────────────── */
function mosfetThermalColor(calc) {
  const tj    = calc?.thermal?.t_junction_est_c
  const tjMax = calc?.thermal?.tj_max_rated_c
  if (tj == null || tjMax == null) return null
  const margin = tjMax - tj
  if (margin < 10)  return '#ff4444'
  if (margin < 30)  return '#ffab00'
  return '#00e676'
}

function mosfetLossData(calc) {
  const w = calc?.mosfet_losses?.total_loss_per_fet_w
  if (w == null) return null
  return { w, color: w > 15 ? '#ff4444' : w > 5 ? '#ffab00' : '#00e676' }
}

/* ─── Dynamic sublabels ───────────────────────────────────────────────────── */
function dynSublabel(id, calc, def) {
  if (!calc) return def.sublabel
  if (id === 'gate_resistors') {
    const on  = calc.gate_resistors?.hs_rg_on_ohm
    const off = calc.gate_resistors?.hs_rg_off_ohm
    if (on != null && off != null) return `${on}Ω on / ${off}Ω off`
  }
  if (id === 'bootstrap') {
    const c = calc.bootstrap_cap?.c_boot_recommended_nf
    if (c != null) return `C_boot = ${c} nF`
  }
  if (id === 'snubber') {
    const r = calc.snubber?.rs_recommended_ohm
    const c = calc.snubber?.cs_recommended_pf
    if (r != null && c != null) return `${r}Ω / ${c}pF`
  }
  return def.sublabel
}

/* ─── Tooltip extras ──────────────────────────────────────────────────────── */
function tooltipExtras(id, state, calc) {
  const rows = []
  if ((id.startsWith('hs_') || id.startsWith('ls_')) && state.project.blocks.mosfet?.status === 'done') {
    const d = buildParamsDict(state.project.blocks.mosfet)
    const add = (label, key) => { if (d[key] != null) rows.push({ label, value: `${d[key]} ${d[key+'__unit'] || ''}`.trim() }) }
    add('Vds_max', 'vds_max'); add('Rds_on', 'rds_on'); add('Qg', 'qg'); add('Tj_max', 'tj_max')
    const loss = calc?.mosfet_losses?.total_loss_per_fet_w
    if (loss != null) rows.push({ label: 'Loss/FET', value: `${loss} W` })
    const tj = calc?.thermal?.t_junction_est_c, tjMax = calc?.thermal?.tj_max_rated_c
    if (tj != null) rows.push({ label: 'Tj est.', value: `${tj}°C / ${tjMax}°C max` })
  }
  if (id === 'gate_driver' && state.project.blocks.driver?.status === 'done') {
    const d = buildParamsDict(state.project.blocks.driver)
    const add = (label, key) => { if (d[key] != null) rows.push({ label, value: `${d[key]} ${d[key+'__unit'] || ''}`.trim() }) }
    add('Io_src', 'io_source'); add('Io_sink', 'io_sink'); add('Prop dly on', 'prop_delay_on')
  }
  if (id === 'mcu' && state.project.blocks.mcu?.status === 'done') {
    const d = buildParamsDict(state.project.blocks.mcu)
    const add = (label, key) => { if (d[key] != null) rows.push({ label, value: `${d[key]} ${d[key+'__unit'] || ''}`.trim() }) }
    add('CPU freq', 'cpu_freq_max'); add('PWM res', 'pwm_resolution'); add('Dead-time res', 'pwm_deadtime_res')
  }
  if (id === 'gate_resistors' && calc?.gate_resistors) {
    const gr = calc.gate_resistors
    if (gr.hs_rg_on_ohm  != null) rows.push({ label: 'Rg_on (HS)',  value: `${gr.hs_rg_on_ohm} Ω` })
    if (gr.hs_rg_off_ohm != null) rows.push({ label: 'Rg_off (HS)', value: `${gr.hs_rg_off_ohm} Ω` })
  }
  if (id === 'bootstrap' && calc?.bootstrap_cap) {
    const b = calc.bootstrap_cap
    if (b.c_boot_recommended_nf != null) rows.push({ label: 'C_boot',     value: `${b.c_boot_recommended_nf} nF` })
    if (b.min_hs_on_time_ns     != null) rows.push({ label: 'Min on-time',value: `${b.min_hs_on_time_ns} ns` })
  }
  if (id === 'snubber' && calc?.snubber) {
    const s = calc.snubber
    if (s.rs_recommended_ohm != null) rows.push({ label: 'Rs', value: `${s.rs_recommended_ohm} Ω` })
    if (s.cs_recommended_pf  != null) rows.push({ label: 'Cs', value: `${s.cs_recommended_pf} pF` })
  }
  return rows
}

/* ─── Flow dot ────────────────────────────────────────────────────────────── */
function Dot({ pathId, color, r = 3, dur = '2.8s', begin = '0s' }) {
  return (
    <circle r={r} fill={color} opacity={0.88}>
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite" rotate="auto">
        <mpath xlinkHref={`#${pathId}`} />
      </animateMotion>
    </circle>
  )
}

/* ─── Block ───────────────────────────────────────────────────────────────── */
function Block({ id, def, status, isHovered, onHover, onClick, parallelCount = 1, thermalColor, lossBadge }) {
  const { x, y, w, h, label, sublabel, color, isCircle } = def
  const isMos   = def.group === 'mosfet'
  const bColor  = isMos && thermalColor ? thermalColor : color
  const sColor  = statusColor(status)
  const fillOp  = isHovered ? 0.2 : 0.09
  const sw      = isHovered ? 2.2 : 1.5
  const sOp     = isHovered ? 0.92 : status === 'done' ? 0.75 : 0.4
  const cursor  = def.nav ? 'pointer' : 'default'

  const ev = {
    onMouseEnter: () => onHover(id),
    onMouseLeave: () => onHover(null),
    onClick:      () => def.nav && onClick(def.nav),
    style:        { cursor },
  }

  if (isCircle) {
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2
    return (
      <g {...ev}>
        {status === 'done' && (
          <circle cx={cx} cy={cy} r={r+6} fill="none" stroke={bColor} strokeWidth={1} opacity={0.18} filter="url(#glow)" />
        )}
        <circle cx={cx} cy={cy} r={r} fill={bColor} fillOpacity={fillOp}
          stroke={bColor} strokeWidth={sw} strokeOpacity={sOp} />
        {[0, 60, 120].map(deg => (
          <line key={deg} x1={cx} y1={cy - r*0.18} x2={cx} y2={cy - r*0.62}
            stroke={bColor} strokeWidth={1.5} strokeOpacity={0.5}
            transform={`rotate(${deg},${cx},${cy})`} />
        ))}
        <text x={cx} y={cy-7}  textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--txt-1)" fontFamily="var(--font-ui)">{label}</text>
        <text x={cx} y={cy+9}  textAnchor="middle" fontSize={9}  fill="var(--txt-3)" fontFamily="var(--font-mono)">{sublabel}</text>
        <circle cx={x+w-5} cy={y+7} r={4} fill={sColor} />
      </g>
    )
  }

  const rx = 6
  return (
    <g {...ev}>
      {/* Done glow */}
      {status === 'done' && (
        <rect x={x-2} y={y-2} width={w+4} height={h+4} rx={rx+2}
          fill="none" stroke={bColor} strokeWidth={1} opacity={0.22} filter="url(#glow)" />
      )}
      {/* Parallel stack — visible shadow rects behind main block */}
      {parallelCount > 1 && [1, ...(parallelCount >= 4 ? [2,3] : [])].map(n => (
        <rect key={n} x={x+n*6} y={y-n*6} width={w} height={h} rx={rx}
          fill={bColor} fillOpacity={0.07}
          stroke={bColor} strokeWidth={1.5} strokeOpacity={0.6} />
      ))}
      {/* Body */}
      <rect x={x} y={y} width={w} height={h} rx={rx}
        fill={bColor} fillOpacity={fillOp}
        stroke={bColor} strokeWidth={sw} strokeOpacity={sOp} />
      {/* Top accent */}
      <rect x={x} y={y} width={w} height={3} rx={1.5}
        fill={bColor} opacity={status === 'done' ? 0.82 : 0.28} />
      {/* Text */}
      <text x={x+w/2} y={y + (h > 44 ? h/2-5 : h/2-2)} textAnchor="middle"
        fontSize={h > 44 ? 11 : 9.5} fontWeight={700} fill="var(--txt-1)" fontFamily="var(--font-ui)">{label}</text>
      {sublabel && (
        <text x={x+w/2} y={y + (h > 44 ? h/2+9 : h/2+9)} textAnchor="middle"
          fontSize={h > 44 ? 8.5 : 8} fill="var(--txt-3)" fontFamily="var(--font-mono)">{sublabel}</text>
      )}
      {/* Parallel badge — prominent chip at top-right */}
      {parallelCount > 1 && (
        <g>
          <rect x={x+w-34} y={y+3} width={32} height={15} rx={5} fill={bColor} opacity={0.3} />
          <text x={x+w-18} y={y+13.5} textAnchor="middle" fontSize={9} fontWeight={900}
            fill={bColor} fontFamily="var(--font-mono)">×{parallelCount} FET</text>
        </g>
      )}
      {/* Loss badge (MOSFET only) */}
      {lossBadge && isMos && (
        <g>
          <rect x={x+w/2-20} y={y+h-15} width={40} height={13} rx={3} fill={lossBadge.color} opacity={0.2} />
          <text x={x+w/2} y={y+h-5} textAnchor="middle" fontSize={8} fontWeight={700}
            fill={lossBadge.color} fontFamily="var(--font-mono)">{lossBadge.w.toFixed(1)}W</text>
        </g>
      )}
      {/* Status dot */}
      <circle cx={x+w-6} cy={y+8} r={3.5} fill={sColor} />
    </g>
  )
}

/* ─── Bridge wiring ───────────────────────────────────────────────────────── */
function BridgeWires({ showFlow }) {
  const PH = ['A','B','C']
  const shCX = [COLS[0]+13+SH_W/2, COLS[1]+13+SH_W/2, COLS[2]+13+SH_W/2]  // shunt centers

  return (
    <g>
      {/* V+ DC BUS rail */}
      <line x1={392} y1={VPLUS_Y} x2={742} y2={VPLUS_Y}
        stroke="#ff4444" strokeWidth={3.5} strokeOpacity={0.3} strokeLinecap="round" />
      <text x={394} y={VPLUS_Y-8} fontSize={9} fontWeight={800} fill="#ff4444"
        fontFamily="var(--font-mono)" opacity={0.85}>V+ DC BUS</text>

      {/* GND RAIL */}
      <line x1={392} y1={GND_Y} x2={742} y2={GND_Y}
        stroke="var(--txt-4)" strokeWidth={3} strokeOpacity={0.22} strokeLinecap="round" />
      <text x={394} y={GND_Y+14} fontSize={9} fontWeight={700} fill="var(--txt-4)"
        fontFamily="var(--font-mono)" opacity={0.65}>GND RAIL</text>

      {/* DC-Link → V+ routing wire */}
      <path d={`M${270+112},${DC_Y+30} L395,${DC_Y+30} L395,${VPLUS_Y}`}
        fill="none" stroke="#ff4444" strokeWidth={2} strokeOpacity={0.38}
        strokeLinecap="round" strokeLinejoin="round" />

      {/* Per-column: V+ tap, switch node (HS↔LS), staggered phase tap, LS→shunt, shunt→GND */}
      {[0,1,2].map(i => (
        <g key={i}>
          {/* V+ rail tap → HS drain (top) */}
          <path id={`pw-vp-${PH[i]}`}
            d={`M${COL_CX[i]},${VPLUS_Y} L${COL_CX[i]},${HS_Y}`}
            fill="none" stroke="#ff4444" strokeWidth={2} strokeOpacity={0.4} />
          {/* Switch node vertical: HS source (bottom) → LS drain (top) */}
          <path id={`pw-sw-${PH[i]}`}
            d={`M${COL_CX[i]},${HS_Y+MOH} L${COL_CX[i]},${LS_Y}`}
            fill="none" stroke="#ff4444" strokeWidth={2.2} strokeOpacity={0.5} />
          {/* Phase tap: horizontal GREEN from staggered tap Y → right of block */}
          <line x1={COL_CX[i]} y1={PH_TAP_Y[i]} x2={PH_TX[i]} y2={PH_TAP_Y[i]}
            stroke="#00e676" strokeWidth={2} strokeOpacity={0.65} />
          {/* T-junction dot on switch-node wire */}
          <circle cx={COL_CX[i]} cy={PH_TAP_Y[i]} r={3} fill="#ff4444" opacity={0.75} />
          {/* Phase output junction dot at right end of tap */}
          <circle cx={PH_TX[i]} cy={PH_TAP_Y[i]} r={3.5} fill="#00e676" opacity={0.88} />
          {/* Phase output → bus column (x=758) → motor: L-shape avoids diagonal clutter */}
          <path id={`ph-out-${PH[i]}`}
            d={`M${PH_TX[i]},${PH_TAP_Y[i]} L758,${PH_TAP_Y[i]} L${MOTOR_ATT[i].x},${MOTOR_ATT[i].y}`}
            fill="none" stroke="#00e676" strokeWidth={2.2} strokeOpacity={0.72}
            strokeLinecap="round" strokeLinejoin="round" />
          {/* LS source (bottom) → shunt top */}
          <line x1={COL_CX[i]} y1={LS_Y+MOH} x2={shCX[i]} y2={SH_Y}
            stroke="var(--txt-4)" strokeWidth={1.5} strokeOpacity={0.32} />
          {/* Shunt bottom → GND rail */}
          <line x1={shCX[i]} y1={SH_Y+SH_H} x2={shCX[i]} y2={GND_Y}
            stroke="var(--txt-4)" strokeWidth={1.5} strokeOpacity={0.22} strokeDasharray="3,3" />
        </g>
      ))}

      {/* Animated flow dots */}
      {showFlow && (
        <g>
          {[0,1,2].map(i => (
            <g key={i}>
              <Dot pathId={`pw-vp-${PH[i]}`}  color="#ff4444" r={3}   dur="2s"   begin={`${i*0.4}s`}   />
              <Dot pathId={`pw-sw-${PH[i]}`}  color="#ff4444" r={3}   dur="1.5s" begin={`${i*0.3}s`}   />
              <Dot pathId={`ph-out-${PH[i]}`} color="#00e676" r={3}   dur="2.0s" begin={`${i*0.5}s`}   />
              <Dot pathId={`ph-out-${PH[i]}`} color="#00e676" r={3}   dur="2.0s" begin={`${i*0.5+1.0}s`} />
            </g>
          ))}
        </g>
      )}
    </g>
  )
}

/* ─── Left power chain wires ──────────────────────────────────────────────── */
function ChainWires({ showFlow }) {
  const cy = DC_Y + 30   // center-y of chain blocks = 166
  return (
    <g>
      <path id="pw-dc-emi"  d={`M110,${cy} L136,${cy}`}
        fill="none" stroke="#ff4444" strokeWidth={2.5} strokeOpacity={0.55} strokeLinecap="round" />
      <path id="pw-emi-cap" d={`M244,${cy} L270,${cy}`}
        fill="none" stroke="#ff4444" strokeWidth={2.5} strokeOpacity={0.55} strokeLinecap="round" />
      {showFlow && (
        <g>
          <Dot pathId="pw-dc-emi"  color="#ff4444" r={3} dur="1.8s" begin="0s"   />
          <Dot pathId="pw-emi-cap" color="#ff4444" r={3} dur="1.8s" begin="0.5s" />
        </g>
      )}
    </g>
  )
}

/* ─── Control section wires ───────────────────────────────────────────────── */
function CtrlWires() {
  const GDcx = 407 + 75       // gate driver center-x
  const GDtop = CTRL_Y         // gate driver top-y
  const MCUcx = 407 + 75
  const MCUtop = CTRL_Y + 82
  const shCX = [COLS[0]+13+SH_W/2, COLS[1]+13+SH_W/2, COLS[2]+13+SH_W/2]

  return (
    <g>
      {/* Gate drive wires: GD → each MOSFET (bezier curves) */}
      {([
        [COL_CX[0], HS_Y+MOH, 'hs_a'], [COL_CX[1], HS_Y+MOH, 'hs_b'], [COL_CX[2], HS_Y+MOH, 'hs_c'],
        [COL_CX[0], LS_Y+MOH, 'ls_a'], [COL_CX[1], LS_Y+MOH, 'ls_b'], [COL_CX[2], LS_Y+MOH, 'ls_c'],
      ]).map(([tx, ty, k]) => (
        <path key={k}
          d={`M${GDcx},${GDtop} Q${GDcx},${(GDtop+ty)/2} ${tx},${ty}`}
          fill="none" stroke="#bb86fc" strokeWidth={1} strokeOpacity={0.28} strokeDasharray="4,3" />
      ))}
      {/* MCU → Gate Driver */}
      <line x1={MCUcx} y1={MCUtop} x2={GDcx} y2={GDtop+62}
        stroke="var(--border-3)" strokeWidth={1.2} strokeOpacity={0.45} strokeDasharray="4,3" />
      {/* Bootstrap → Gate Driver */}
      <line x1={375} y1={CTRL_Y+22} x2={407} y2={CTRL_Y+22}
        stroke="var(--border-3)" strokeWidth={1.2} strokeOpacity={0.45} />
      {/* Gate Rg → Gate Driver */}
      <path d={`M375,${CTRL_Y+77} L395,${CTRL_Y+77} L395,${CTRL_Y+44} L407,${CTRL_Y+44}`}
        fill="none" stroke="var(--border-3)" strokeWidth={1.2} strokeOpacity={0.4} strokeDasharray="4,3" strokeLinejoin="round" />
      {/* Protection → Gate Driver */}
      <line x1={616} y1={CTRL_Y+28} x2={557} y2={CTRL_Y+28}
        stroke="#00d4e8" strokeWidth={1} strokeOpacity={0.35} strokeDasharray="4,3" />
      {/* Protection → MCU */}
      <path d={`M${616+64},${CTRL_Y+56} L${616+64},${CTRL_Y+82+28} L557,${CTRL_Y+82+28}`}
        fill="none" stroke="#00d4e8" strokeWidth={1} strokeOpacity={0.32} strokeDasharray="3,3" strokeLinejoin="round" />
      {/* Bypass → MCU */}
      <line x1={616} y1={CTRL_Y+75+22} x2={557} y2={CTRL_Y+82+22}
        stroke="var(--border-3)" strokeWidth={1} strokeOpacity={0.32} strokeDasharray="3,3" />
      {/* Shunt sense: short stubs → horizontal bus → single line down to MCU */}
      {[0,1,2].map(i => (
        <line key={i} x1={shCX[i]} y1={SH_Y+SH_H} x2={shCX[i]} y2={SH_Y+SH_H+16}
          stroke="#00d4e8" strokeWidth={1} strokeOpacity={0.5} strokeDasharray="3,3" />
      ))}
      <line x1={shCX[0]} y1={SH_Y+SH_H+16} x2={shCX[2]} y2={SH_Y+SH_H+16}
        stroke="#00d4e8" strokeWidth={1} strokeOpacity={0.38} strokeDasharray="3,3" />
      <line x1={MCUcx} y1={SH_Y+SH_H+16} x2={MCUcx} y2={MCUtop}
        stroke="#00d4e8" strokeWidth={1} strokeOpacity={0.28} strokeDasharray="3,3" />
      {/* Snubber → HS area */}
      <path d={`M748,${28+44} L${COLS[2]+MOW/2},${HS_Y}`}
        fill="none" stroke="var(--border-3)" strokeWidth={1} strokeOpacity={0.28} strokeDasharray="4,3" />
    </g>
  )
}

/* ─── Column headers ──────────────────────────────────────────────────────── */
function ColHeaders() {
  return (
    <g>
      {/* Per-column: Phase label + underline */}
      {['A','B','C'].map((ph, i) => (
        <g key={ph}>
          <text x={COL_CX[i]} y={HS_Y - 10} textAnchor="middle"
            fontSize={11} fontWeight={800} fill="#00e676" fontFamily="var(--font-mono)" opacity={0.82}>
            {ph}
          </text>
          <line x1={COLS[i]+8} y1={HS_Y-4} x2={COLS[i]+MOW-8} y2={HS_Y-4}
            stroke="#00e676" strokeWidth={1} strokeOpacity={0.35} />
        </g>
      ))}
      {/* Phase labels — right of each junction dot, above tap wire */}
      {['A','B','C'].map((ph, i) => (
        <text key={ph}
          x={PH_TX[i] + 8} y={PH_TAP_Y[i] - 5}
          textAnchor="start" fontSize={10} fontWeight={900}
          fill="#00e676" fontFamily="var(--font-mono)" opacity={0.92}>
          {ph}
        </text>
      ))}
    </g>
  )
}

/* ─── Legend ──────────────────────────────────────────────────────────────── */
function Legend() {
  const items = [
    { color: '#ff4444',         label: 'DC Power',      dash: false, sw: 2.5 },
    { color: '#00e676',         label: 'Phase Out',     dash: false, sw: 2   },
    { color: '#bb86fc',         label: 'Gate Drive',    dash: true,  sw: 1   },
    { color: 'var(--border-3)', label: 'Logic / PWM',  dash: true,  sw: 1   },
    { color: '#00d4e8',         label: 'Sense Lines',   dash: true,  sw: 1   },
    { color: 'var(--txt-4)',    label: 'GND Rail',      dash: false, sw: 2   },
  ]
  return (
    <g transform={`translate(18,${VB_H-36})`}>
      <text fontSize={9} fontWeight={700} fill="var(--txt-2)" fontFamily="var(--font-ui)" letterSpacing="0.06em">
        LEGEND
      </text>
      {items.map((it, i) => (
        <g key={i} transform={`translate(${i*112+2},14)`}>
          <line x1={0} y1={0} x2={24} y2={0} stroke={it.color} strokeWidth={it.sw}
            strokeDasharray={it.dash ? '4,3' : 'none'} strokeOpacity={0.75} />
          <text x={29} y={4} fontSize={9} fill="var(--txt-3)" fontFamily="var(--font-mono)">{it.label}</text>
        </g>
      ))}
    </g>
  )
}

/* ─── Status bar ──────────────────────────────────────────────────────────── */
function StatusBar({ bs }) {
  const G = { 'MCU': bs.mcu, 'Gate Driver': bs.gate_driver, 'MOSFETs': bs.hs_a,
              'Motor': bs.motor, 'Passives': bs.input_caps, 'Feedback': bs.protection }
  const done = Object.values(G).filter(s => s === 'done').length
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '8px 14px', flexWrap: 'wrap',
      background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border-1)', marginBottom: 10,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-2)' }}>Block Status</span>
      {Object.entries(G).map(([name, s]) => (
        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: s === 'done' ? 'var(--green)' : 'var(--txt-4)',
            boxShadow: s === 'done' ? '0 0 6px var(--green)' : 'none',
          }} />
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: s === 'done' ? 'var(--txt-1)' : 'var(--txt-3)' }}>
            {name}
          </span>
        </div>
      ))}
      <div style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700,
                    color: done === 6 ? 'var(--green)' : 'var(--amber)' }}>
        {done}/6 configured
      </div>
    </div>
  )
}

/* ─── Floating tooltip ────────────────────────────────────────────────────── */
function Tip({ id, state, bs, calc }) {
  if (!id) return null
  const def = BLOCKS[id]; if (!def) return null
  const status = bs[id] || 'idle'
  const extras = tooltipExtras(id, state, calc)
  return (
    <div style={{
      position: 'absolute', top: 50, right: 16,
      background: 'var(--bg-3)', border: `1px solid ${def.color}55`,
      borderRadius: 8, padding: '10px 14px', minWidth: 175, maxWidth: 225,
      boxShadow: '0 4px 22px rgba(0,0,0,0.38)', zIndex: 10, pointerEvents: 'none',
    }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: def.color, marginBottom: 2 }}>{def.label}</div>
      <div style={{ fontSize: 10, color: 'var(--txt-3)', marginBottom: 6, fontFamily: 'var(--font-mono)' }}>{def.sublabel}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, marginBottom: 4 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor(status),
                      boxShadow: status === 'done' ? `0 0 5px ${statusColor(status)}` : 'none' }} />
        <span style={{ color: 'var(--txt-2)' }}>
          {status === 'done' ? 'Configured ✓' : status === 'info' ? 'System param' : 'Not configured'}
        </span>
      </div>
      {extras.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-1)', marginTop: 6, paddingTop: 6,
                      display: 'flex', flexDirection: 'column', gap: 3 }}>
          {extras.map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10 }}>
              <span style={{ color: 'var(--txt-4)', fontFamily: 'var(--font-mono)' }}>{label}</span>
              <span style={{ color: 'var(--txt-1)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      )}
      {def.nav && (
        <div style={{ fontSize: 9, color: def.color, marginTop: 6, opacity: 0.75, fontFamily: 'var(--font-mono)' }}>
          Click → {def.nav.charAt(0).toUpperCase() + def.nav.slice(1)} panel
        </div>
      )}
    </div>
  )
}

/* ─── Symbol side box ─────────────────────────────────────────────────────── */
function SymbolBox({ calc, sysSpecs }) {
  const S = { fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--txt-2)', lineHeight: 1.45 }
  const HDR = { fontSize: 9, fontWeight: 800, color: 'var(--txt-4)', letterSpacing: '0.07em', marginBottom: 6, marginTop: 4 }

  // Live calc values
  const totalW   = calc?.mosfet_losses?.total_loss_per_fet_w != null
    ? `${(calc.mosfet_losses.total_loss_per_fet_w * 6).toFixed(1)} W` : null
  const tj       = calc?.thermal?.t_junction_est_c
  const tjMax    = calc?.thermal?.tj_max_rated_c
  const rgOn     = calc?.gate_resistors?.hs_rg_on_ohm
  const cBoot    = calc?.bootstrap_cap?.c_boot_recommended_nf
  const liveRows = [
    ['Bus voltage',  sysSpecs?.bus_voltage ? `${sysSpecs.bus_voltage} V`                 : '—'],
    ['Power',        sysSpecs?.power       ? `${(sysSpecs.power/1000).toFixed(1)} kW`    : '—'],
    ['PWM freq',     sysSpecs?.pwm_freq_hz ? `${(sysSpecs.pwm_freq_hz/1000).toFixed(0)} kHz` : '—'],
    ['FET losses',   totalW                 ?? '—'],
    ['Tj estimate',  tj != null             ? `${tj}°C / ${tjMax}°C` : '—'],
    ['Rg_on (HS)',   rgOn  != null          ? `${rgOn} Ω`            : '—'],
    ['C_boot',       cBoot != null          ? `${cBoot} nF`          : '—'],
  ]
  const tjColor = tj == null ? 'var(--txt-3)'
    : (tjMax - tj) < 10 ? '#ff4444' : (tjMax - tj) < 30 ? '#ffab00' : '#00e676'

  const blocks = [
    { color: '#ff4444', label: 'DC Bus / MOSFET',  circle: false },
    { color: '#ffab00', label: 'Passives',           circle: false },
    { color: '#bb86fc', label: 'Gate Driver IC',     circle: false },
    { color: '#1e90ff', label: 'MCU',                circle: false },
    { color: '#00d4e8', label: 'Protection / ADC',   circle: false },
    { color: '#00e676', label: 'PMSM Motor',         circle: true  },
  ]
  const wires = [
    { color: '#ff4444', dash: false, sw: 2,   label: 'DC Power' },
    { color: '#00e676', dash: false, sw: 2,   label: 'Phase Out' },
    { color: '#bb86fc', dash: true,  sw: 1.2, label: 'Gate Drive' },
    { color: '#00d4e8', dash: true,  sw: 1,   label: 'Sense / ADC' },
    { color: '#aaa',    dash: true,  sw: 1,   label: 'Logic / PWM' },
    { color: '#555',    dash: false, sw: 2,   label: 'GND Rail' },
  ]
  const topo = [
    'Q1 Q3 Q5 → High-Side',
    'Q2 Q4 Q6 → Low-Side',
    'Rs_A/B/C → Shunt Sense',
    'Switch node = HS⊥LS',
    'Phase out = switch node',
  ]

  return (
    <div style={{
      width: 152, minWidth: 152, flexShrink: 0,
      background: 'var(--bg-2)', border: '1px solid var(--border-1)',
      borderRadius: 8, padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 2,
      overflowY: 'auto', alignSelf: 'flex-start',
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--txt-1)', letterSpacing: '0.08em', marginBottom: 6 }}>SYMBOLS</div>

      {/* Live design data */}
      <div style={HDR}>LIVE DATA</div>
      {liveRows.map(([k, v], idx) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 4, marginBottom: 4 }}>
          <span style={{ ...S, color: 'var(--txt-4)', fontSize: 9 }}>{k}</span>
          <span style={{ ...S, fontSize: 9, fontWeight: 700,
            color: k === 'Tj estimate' ? tjColor : v === '—' ? 'var(--txt-4)' : 'var(--txt-1)' }}>
            {v}
          </span>
        </div>
      ))}

      {/* Block colors */}
      <div style={HDR}>BLOCKS</div>
      {blocks.map(({ color, label, circle }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
          <div style={{
            width: circle ? 12 : 16, height: circle ? 12 : 10,
            borderRadius: circle ? '50%' : 3,
            border: `2px solid ${color}`, background: `${color}22`,
            flexShrink: 0,
          }} />
          <span style={S}>{label}</span>
        </div>
      ))}

      {/* Wire types */}
      <div style={{ ...HDR, marginTop: 10 }}>WIRES</div>
      {wires.map(({ color, dash, sw, label }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
          <svg width={26} height={10} style={{ flexShrink: 0 }}>
            <line x1={0} y1={5} x2={26} y2={5} stroke={color} strokeWidth={sw}
              strokeDasharray={dash ? '4,3' : 'none'} />
          </svg>
          <span style={S}>{label}</span>
        </div>
      ))}

      {/* MOSFET loss scale */}
      <div style={{ ...HDR, marginTop: 10 }}>LOSS / FET</div>
      {[['#00e676','< 5 W'],['#ffab00','5 – 15 W'],['#ff4444','> 15 W']].map(([c, l]) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: c, opacity: 0.85, flexShrink: 0 }} />
          <span style={S}>{l}</span>
        </div>
      ))}

      {/* Topology ref */}
      <div style={{ ...HDR, marginTop: 10 }}>TOPOLOGY</div>
      {topo.map(t => (
        <div key={t} style={{ ...S, color: 'var(--txt-3)', marginBottom: 3 }}>{t}</div>
      ))}

      {/* Status dots */}
      <div style={{ ...HDR, marginTop: 10 }}>STATUS DOT</div>
      {[['var(--green)','Configured'],['var(--txt-4)','Pending']].map(([c, l]) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0,
                        boxShadow: c === 'var(--green)' ? '0 0 4px var(--green)' : 'none' }} />
          <span style={S}>{l}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── Main ────────────────────────────────────────────────────────────────── */
export default function DiagramPanel({ config }) {
  const { state, dispatch } = useProject()
  const [hovered,      setHovered]      = useState(null)
  const [showFlow,     setShowFlow]     = useState(true)
  const [parallelFets, setParallelFets] = useState(1)

  const handleNav = useCallback(k => dispatch({ type: 'SET_ACTIVE_BLOCK', payload: k }), [dispatch])

  const calc     = state.project.calculations
  const sysSpecs = state.project.system_specs

  const bs = useMemo(() => {
    const s = {}
    Object.entries(BLOCKS).forEach(([id, def]) => { s[id] = getBlockStatus(state, def) })
    return s
  }, [state])

  const thermalColor = useMemo(() => mosfetThermalColor(calc), [calc])
  const lossBadge    = useMemo(() => mosfetLossData(calc),     [calc])

  return (
    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '12px 16px', borderBottom: '1px solid var(--border-1)' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt-1)', margin: 0 }}>
            {config?.fullLabel || 'Interactive Block Diagram'}
          </h2>
          <p style={{ fontSize: 11, color: 'var(--txt-3)', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>
            3-Phase PMSM Inverter • {sysSpecs.bus_voltage || '—'}V / {sysSpecs.power ? (sysSpecs.power/1000).toFixed(1) : '—'}kW
            {' '}• Click any block to configure
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Parallel FET selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>FETs/switch:</span>
            {[1,2,4].map(n => (
              <button key={n}
                className="btn btn-ghost"
                style={{ fontSize: 10, padding: '3px 9px',
                         background: parallelFets === n ? 'var(--accent)' : undefined,
                         color:      parallelFets === n ? '#fff'          : undefined,
                         borderColor: parallelFets === n ? 'var(--accent)' : undefined }}
                onClick={() => setParallelFets(n)}>×{n}</button>
            ))}
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 10, padding: '4px 10px' }}
            onClick={() => setShowFlow(f => !f)}>
            {showFlow ? '⏸ Pause Flow' : '▶ Show Flow'}
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div style={{ padding: '10px 16px 0' }}>
        <StatusBar bs={bs} />
      </div>

      {/* Thermal + loss key strip */}
      {(thermalColor || lossBadge) && (
        <div style={{ display: 'flex', gap: 18, padding: '4px 16px 6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {thermalColor && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: thermalColor, boxShadow: `0 0 5px ${thermalColor}` }} />
              <span style={{ color: 'var(--txt-3)' }}>
                MOSFET border = thermal margin
                {calc?.thermal?.t_junction_est_c != null
                  ? ` (Tj≈${calc.thermal.t_junction_est_c}°C / ${calc.thermal.tj_max_rated_c}°C max)` : ''}
              </span>
            </div>
          )}
          {lossBadge && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
              <span style={{ color: 'var(--green)', fontWeight: 700 }}>▪</span><span style={{ color: 'var(--txt-4)' }}>&lt;5W</span>
              <span style={{ color: 'var(--amber)', fontWeight: 700 }}>▪</span><span style={{ color: 'var(--txt-4)' }}>5–15W</span>
              <span style={{ color: 'var(--red)',   fontWeight: 700 }}>▪</span><span style={{ color: 'var(--txt-4)' }}>&gt;15W</span>
              <span style={{ color: 'var(--txt-4)' }}>per FET</span>
            </div>
          )}
        </div>
      )}

      {/* SVG + Symbol box */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px',
                    display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* SVG wrapper (positioned for tooltip) */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`}
          style={{ width: '100%', maxWidth: 1040, height: 'auto', minHeight: 440 }}>
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="10" cy="10" r="0.5" fill="var(--border-1)" opacity="0.4"/>
            </pattern>
          </defs>

          {/* Background */}
          <rect width={VB_W} height={VB_H} fill="url(#dots)" />

          {/* Top title */}
          <text x={VB_W/2} y={15} textAnchor="middle" fontSize={9.5} fontWeight={600}
            fill="var(--txt-4)" fontFamily="var(--font-mono)" letterSpacing="0.14em" opacity={0.65}>
            48V 3-PHASE PMSM MOTOR CONTROLLER — POWER STAGE TOPOLOGY
          </text>

          {/* Power chain wires */}
          <ChainWires showFlow={showFlow} />

          {/* Bridge wires (rails + column connections + phase outputs + flow) */}
          <BridgeWires showFlow={showFlow} />

          {/* Control section wires */}
          <CtrlWires />

          {/* Column A/B/C headers + motor phase labels */}
          <ColHeaders />

          {/* All blocks */}
          {Object.entries(BLOCKS).map(([id, def]) => {
            const isMos = def.group === 'mosfet'
            return (
              <Block
                key={id}
                id={id}
                def={{ ...def, sublabel: dynSublabel(id, calc, def) }}
                status={bs[id]}
                isHovered={hovered === id}
                onHover={setHovered}
                onClick={handleNav}
                parallelCount={isMos ? parallelFets : 1}
                thermalColor={isMos ? thermalColor : null}
                lossBadge={isMos ? lossBadge : null}
              />
            )
          })}

          {/* Legend removed — see SymbolBox panel on the right */}
        </svg>

        {/* Floating tooltip */}
        <Tip id={hovered} state={state} bs={bs} calc={calc} />
        </div>{/* end SVG wrapper */}

        {/* Symbol legend box — shows static symbols + live calc data */}
        <SymbolBox calc={calc} sysSpecs={sysSpecs} />
      </div>
    </div>
  )
}
