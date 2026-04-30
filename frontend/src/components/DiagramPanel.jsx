import React, { useState, useCallback, useMemo } from 'react'
import { useProject } from '../context/ProjectContext.jsx'

/* ─────────────────────────────────────────────────────────────────────────────
 * Interactive Block Diagram — 3-Phase PMSM Motor Controller Topology
 *
 * Shows a clickable SVG schematic of the full power stage:
 *   DC Bus → EMI Filter → Input Caps → 3-Phase Bridge (6 MOSFETs)
 *   → Gate Drivers → Bootstrap → MCU → Shunt Resistors → Motor
 *   + Protection dividers, snubber, thermal management
 *
 * Click any block → navigates to its configuration/results panel
 * Color-coded status: green=data loaded, amber=partial, gray=not configured
 * ────────────────────────────────────────────────────────────────────────── */

// Block definitions: position, size, label, navigation target, color
const BLOCKS = {
  dc_bus: {
    x: 30, y: 140, w: 90, h: 60,
    label: 'DC Bus', sublabel: '48V',
    nav: null, color: '#ff4444', group: 'power',
    icon: '⊕⊖',
  },
  emi_filter: {
    x: 155, y: 140, w: 100, h: 60,
    label: 'EMI Filter', sublabel: 'CM + DM',
    nav: 'passives', color: '#ffab00', group: 'passive',
  },
  input_caps: {
    x: 290, y: 140, w: 100, h: 60,
    label: 'DC-Link Caps', sublabel: 'Bulk + Ceramic',
    nav: 'passives', color: '#ffab00', group: 'passive',
  },
  // 3-phase bridge
  hs_a: { x: 440, y: 50, w: 70, h: 48, label: 'Q1', sublabel: 'HS-A', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  hs_b: { x: 440, y: 140, w: 70, h: 48, label: 'Q3', sublabel: 'HS-B', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  hs_c: { x: 440, y: 230, w: 70, h: 48, label: 'Q5', sublabel: 'HS-C', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  ls_a: { x: 560, y: 50, w: 70, h: 48, label: 'Q2', sublabel: 'LS-A', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  ls_b: { x: 560, y: 140, w: 70, h: 48, label: 'Q4', sublabel: 'LS-B', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  ls_c: { x: 560, y: 230, w: 70, h: 48, label: 'Q6', sublabel: 'LS-C', nav: 'mosfet', color: '#ff4444', group: 'mosfet' },
  // Shunts
  shunt_a: { x: 670, y: 56, w: 60, h: 36, label: 'Rs', sublabel: 'Shunt A', nav: 'passives', color: '#ffab00', group: 'passive' },
  shunt_b: { x: 670, y: 146, w: 60, h: 36, label: 'Rs', sublabel: 'Shunt B', nav: 'passives', color: '#ffab00', group: 'passive' },
  shunt_c: { x: 670, y: 236, w: 60, h: 36, label: 'Rs', sublabel: 'Shunt C', nav: 'passives', color: '#ffab00', group: 'passive' },
  // Motor
  motor: {
    x: 780, y: 115, w: 100, h: 100,
    label: 'PMSM', sublabel: 'Motor',
    nav: 'motor', color: '#00e676', group: 'motor', isCircle: true,
  },
  // Gate drivers
  gate_driver: {
    x: 460, y: 330, w: 140, h: 55,
    label: 'Gate Driver IC', sublabel: '3-phase + bootstrap',
    nav: 'driver', color: '#bb86fc', group: 'driver',
  },
  // Bootstrap
  bootstrap: {
    x: 340, y: 340, w: 90, h: 40,
    label: 'Bootstrap', sublabel: 'C_boot × 3',
    nav: 'passives', color: '#ffab00', group: 'passive',
  },
  // Snubber
  snubber: {
    x: 290, y: 60, w: 90, h: 40,
    label: 'Snubber', sublabel: 'RC × 6',
    nav: 'passives', color: '#ffab00', group: 'passive',
  },
  // MCU
  mcu: {
    x: 460, y: 430, w: 140, h: 55,
    label: 'MCU', sublabel: 'PWM + ADC + Control',
    nav: 'mcu', color: '#1e90ff', group: 'mcu',
  },
  // Protection
  protection: {
    x: 650, y: 340, w: 120, h: 55,
    label: 'Protection', sublabel: 'OVP / OCP / OTP',
    nav: 'feedback', color: '#00d4e8', group: 'feedback',
  },
  // Gate resistors
  gate_resistors: {
    x: 340, y: 280, w: 90, h: 40,
    label: 'Gate Rg', sublabel: 'Rg_on / Rg_off',
    nav: 'passives', color: '#ffab00', group: 'passive',
  },
  // Bypass caps
  bypass: {
    x: 650, y: 430, w: 100, h: 45,
    label: 'Bypass Caps', sublabel: 'VCC / VDD rails',
    nav: 'passives', color: '#ffab00', group: 'passive',
  },
}

// Wire connections between blocks
const WIRES = [
  // Power path (thick)
  { from: 'dc_bus', to: 'emi_filter', type: 'power' },
  { from: 'emi_filter', to: 'input_caps', type: 'power' },
  // Input caps to bridge top rail
  { from: 'input_caps', to: 'hs_a', type: 'power', path: 'bus_top' },
  { from: 'input_caps', to: 'hs_b', type: 'power' },
  { from: 'input_caps', to: 'hs_c', type: 'power', path: 'bus_bot' },
  // HS to LS
  { from: 'hs_a', to: 'ls_a', type: 'power' },
  { from: 'hs_b', to: 'ls_b', type: 'power' },
  { from: 'hs_c', to: 'ls_c', type: 'power' },
  // LS to shunts
  { from: 'ls_a', to: 'shunt_a', type: 'power' },
  { from: 'ls_b', to: 'shunt_b', type: 'power' },
  { from: 'ls_c', to: 'shunt_c', type: 'power' },
  // Shunts to motor
  { from: 'shunt_a', to: 'motor', type: 'phase', label: 'A' },
  { from: 'shunt_b', to: 'motor', type: 'phase', label: 'B' },
  { from: 'shunt_c', to: 'motor', type: 'phase', label: 'C' },
  // Control path (thin, dashed)
  { from: 'gate_driver', to: 'hs_a', type: 'gate' },
  { from: 'gate_driver', to: 'hs_b', type: 'gate' },
  { from: 'gate_driver', to: 'hs_c', type: 'gate' },
  { from: 'gate_driver', to: 'ls_a', type: 'gate' },
  { from: 'gate_driver', to: 'ls_b', type: 'gate' },
  { from: 'gate_driver', to: 'ls_c', type: 'gate' },
  { from: 'mcu', to: 'gate_driver', type: 'signal' },
  { from: 'bootstrap', to: 'gate_driver', type: 'signal' },
  { from: 'gate_resistors', to: 'gate_driver', type: 'signal' },
  { from: 'protection', to: 'mcu', type: 'signal' },
  { from: 'protection', to: 'gate_driver', type: 'signal' },
  { from: 'bypass', to: 'mcu', type: 'signal' },
  // Snubber across bridge
  { from: 'snubber', to: 'hs_a', type: 'signal' },
  // Shunt sense back to MCU
  { from: 'shunt_b', to: 'protection', type: 'sense' },
]

function getBlockStatus(state, blockDef) {
  const b = state.project.blocks
  const nav = blockDef.nav
  if (!nav) return 'info' // DC bus — always shown
  if (nav === 'mosfet') return b.mosfet?.status === 'done' ? 'done' : 'idle'
  if (nav === 'driver') return b.driver?.status === 'done' ? 'done' : 'idle'
  if (nav === 'mcu') return b.mcu?.status === 'done' ? 'done' : 'idle'
  if (nav === 'motor') {
    const specs = b.motor?.specs
    return (specs?.max_speed_rpm && (specs?.rph_mohm || specs?.lph_uh)) ? 'done' : 'idle'
  }
  if (nav === 'passives') return state.project.calculations ? 'done' : 'idle'
  if (nav === 'feedback') return state.project.calculations ? 'done' : 'idle'
  return 'idle'
}

function statusColor(status) {
  if (status === 'done') return 'var(--green)'
  if (status === 'info') return 'var(--accent)'
  return 'var(--txt-4)'
}

/* ── Animated power flow dots ── */
function FlowDots({ pathId, type }) {
  if (type !== 'power' && type !== 'phase') return null
  return (
    <g>
      <circle r={type === 'power' ? 3 : 2.5} fill={type === 'power' ? '#ff4444' : '#00e676'} opacity={0.8}>
        <animateMotion dur={type === 'power' ? '3s' : '2.5s'} repeatCount="indefinite" rotate="auto">
          <mpath xlinkHref={`#${pathId}`} />
        </animateMotion>
      </circle>
      <circle r={type === 'power' ? 3 : 2.5} fill={type === 'power' ? '#ff4444' : '#00e676'} opacity={0.8}>
        <animateMotion dur={type === 'power' ? '3s' : '2.5s'} begin="1s" repeatCount="indefinite" rotate="auto">
          <mpath xlinkHref={`#${pathId}`} />
        </animateMotion>
      </circle>
    </g>
  )
}

/* ── Block component (rect or circle) ── */
function Block({ def, id, status, isHovered, onHover, onClick, parallelCount = 1 }) {
  const { x, y, w, h, label, sublabel, color, isCircle } = def
  const sDone = status === 'done'
  const sColor = statusColor(status)
  const fillOpacity = isHovered ? 0.18 : 0.08
  const strokeOpacity = isHovered ? 0.9 : (sDone ? 0.7 : 0.35)
  const cursor = def.nav ? 'pointer' : 'default'

  if (isCircle) {
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2
    return (
      <g
        style={{ cursor }}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
        onClick={() => def.nav && onClick(def.nav)}
      >
        {/* Glow */}
        {sDone && (
          <circle cx={cx} cy={cy} r={r + 4}
            fill="none" stroke={color} strokeWidth={1} opacity={0.3}
            filter="url(#glow)" />
        )}
        <circle cx={cx} cy={cy} r={r}
          fill={color} fillOpacity={fillOpacity}
          stroke={color} strokeWidth={isHovered ? 2 : 1.5} strokeOpacity={strokeOpacity}
        />
        {/* Rotor lines */}
        {[0, 60, 120].map(deg => (
          <line key={deg}
            x1={cx} y1={cy - r * 0.2} x2={cx} y2={cy - r * 0.65}
            stroke={color} strokeWidth={1.5} strokeOpacity={0.5}
            transform={`rotate(${deg}, ${cx}, ${cy})`}
          />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize={13} fontWeight={700}
          fill="var(--txt-1)" fontFamily="var(--font-ui)">{label}</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize={9}
          fill="var(--txt-3)" fontFamily="var(--font-mono)">{sublabel}</text>
        {/* Status dot */}
        <circle cx={x + w - 4} cy={y + 6} r={4} fill={sColor} />
      </g>
    )
  }

  const rx = 6
  return (
    <g
      style={{ cursor }}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => def.nav && onClick(def.nav)}
    >
      {/* Glow effect for done blocks */}
      {sDone && (
        <rect x={x - 2} y={y - 2} width={w + 4} height={h + 4} rx={rx + 2}
          fill="none" stroke={color} strokeWidth={1} opacity={0.25}
          filter="url(#glow)" />
      )}
      {/* Main rect */}
      <rect x={x} y={y} width={w} height={h} rx={rx}
        fill={color} fillOpacity={fillOpacity}
        stroke={color} strokeWidth={isHovered ? 2 : 1.5} strokeOpacity={strokeOpacity}
      />
      {/* Parallel stacks indicator */}
      {parallelCount > 1 && (
        <g opacity={0.6}>
          <rect x={x + 3} y={y - 3} width={w} height={h} rx={rx} fill="none" stroke={color} strokeWidth={1} />
          <rect x={x + 6} y={y - 6} width={w} height={h} rx={rx} fill="none" stroke={color} strokeWidth={1} />
          <text x={x + w - 2} y={y - 8} fontSize={8} fontWeight={800} fill={color} textAnchor="end">x{parallelCount}</text>
        </g>
      )}
      {/* Top accent bar */}
      <rect x={x} y={y} width={w} height={3} rx={1.5}
        fill={color} opacity={sDone ? 0.8 : 0.3} />
      {/* Labels */}
      <text x={x + w / 2} y={y + (h > 45 ? h / 2 - 4 : h / 2 - 2)} textAnchor="middle"
        fontSize={h > 45 ? 11 : 9.5} fontWeight={700}
        fill="var(--txt-1)" fontFamily="var(--font-ui)">{label}</text>
      {sublabel && (
        <text x={x + w / 2} y={y + (h > 45 ? h / 2 + 10 : h / 2 + 10)} textAnchor="middle"
          fontSize={h > 45 ? 9 : 8} fill="var(--txt-3)" fontFamily="var(--font-mono)">{sublabel}</text>
      )}
      {/* Status dot */}
      <circle cx={x + w - 6} cy={y + 8} r={3.5} fill={sColor} />
    </g>
  )
}

/* ── Wire/connection renderer ── */
function renderWire(wire, idx) {
  const from = BLOCKS[wire.from]
  const to = BLOCKS[wire.to]
  if (!from || !to) return null

  // Calculate connection points (right of from → left of to, or smart routing)
  let x1 = from.x + from.w
  let y1 = from.y + from.h / 2
  let x2 = to.x
  let y2 = to.y + to.h / 2

  // For motor (circle), connect to left edge
  if (to.isCircle) {
    x2 = to.x + to.w / 2 - Math.min(to.w, to.h) / 2
    y2 = to.y + to.h / 2
  }

  // Gate connections: from top of gate driver to bottom of MOSFETs
  if (wire.type === 'gate') {
    x1 = from.x + from.w / 2 + (wire.to.includes('_a') ? -30 : wire.to.includes('_c') ? 30 : 0)
    y1 = from.y
    x2 = to.x + to.w / 2
    y2 = to.y + to.h
  }

  // Signal from below
  if (wire.type === 'signal' && wire.from === 'mcu') {
    x1 = from.x + from.w / 2
    y1 = from.y
    x2 = to.x + to.w / 2
    y2 = to.y + to.h
  }
  if (wire.type === 'signal' && wire.from === 'bootstrap') {
    x1 = from.x + from.w
    y1 = from.y + from.h / 2
    x2 = to.x
    y2 = to.y + to.h / 2
  }
  if (wire.type === 'signal' && wire.from === 'gate_resistors') {
    x1 = from.x + from.w
    y1 = from.y + from.h / 2
    x2 = to.x
    y2 = to.y + to.h / 2
  }
  if (wire.type === 'signal' && wire.from === 'protection' && wire.to === 'mcu') {
    x1 = from.x + from.w / 2
    y1 = from.y + from.h
    x2 = to.x + to.w
    y2 = to.y + to.h / 2
  }
  if (wire.type === 'signal' && wire.from === 'protection' && wire.to === 'gate_driver') {
    x1 = from.x
    y1 = from.y + from.h / 2
    x2 = to.x + to.w
    y2 = to.y + to.h / 2
  }
  if (wire.type === 'signal' && wire.from === 'bypass') {
    x1 = from.x
    y1 = from.y + from.h / 2
    x2 = to.x + to.w
    y2 = to.y + to.h / 2
  }
  if (wire.type === 'signal' && wire.from === 'snubber') {
    x1 = from.x + from.w
    y1 = from.y + from.h / 2
    x2 = to.x
    y2 = to.y + to.h / 2
  }
  if (wire.type === 'sense') {
    x1 = from.x + from.w / 2
    y1 = from.y + from.h
    x2 = to.x + to.w / 2
    y2 = to.y
  }

  const strokeW = wire.type === 'power' ? 2.5 : wire.type === 'phase' ? 2 : 1
  const dash = (wire.type === 'signal' || wire.type === 'sense') ? '4,3' : 'none'
  const strokeColor = wire.type === 'power' ? '#ff4444' :
    wire.type === 'phase' ? '#00e676' :
    wire.type === 'gate' ? '#bb86fc' :
    wire.type === 'sense' ? '#00d4e8' :
    'var(--border-3)'

  // Build path with right-angle routing
  let pathD
  const dx = x2 - x1
  const dy = y2 - y1
  const midX = x1 + dx / 2

  if (Math.abs(dy) < 3) {
    pathD = `M${x1},${y1} L${x2},${y2}`
  } else if (wire.type === 'gate') {
    pathD = `M${x1},${y1} L${x1},${y1 - 15} L${x2},${y2 + 15} L${x2},${y2}`
  } else if (wire.type === 'sense') {
    pathD = `M${x1},${y1} L${x1},${y1 + (y2 - y1) / 2} L${x2},${y1 + (y2 - y1) / 2} L${x2},${y2}`
  } else {
    pathD = `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`
  }

  return (
    <g key={idx}>
      <path id={`wire-${idx}`} d={pathD} fill="none" stroke={strokeColor}
        strokeWidth={strokeW} strokeOpacity={0.45}
        strokeDasharray={dash}
        strokeLinecap="round" strokeLinejoin="round" />
      {wire.label && (
        <text x={(x1 + x2) / 2 + 4} y={(y1 + y2) / 2 - 4}
          fontSize={9} fontWeight={700} fill={strokeColor} fontFamily="var(--font-mono)">
          {wire.label}
        </text>
      )}
    </g>
  )
}

/* ── Bus rails (V+ and GND) ── */
function BusRails() {
  // V+ rail across top of bridge
  const railY_top = 38
  const railY_bot = 290
  return (
    <g>
      {/* V+ rail */}
      <line x1={380} y1={railY_top} x2={645} y2={railY_top}
        stroke="#ff4444" strokeWidth={3} strokeOpacity={0.25} />
      <text x={382} y={railY_top - 6} fontSize={9} fill="#ff4444" fontWeight={700}
        fontFamily="var(--font-mono)" opacity={0.7}>V+ (48V)</text>
      {/* Vertical taps from V+ to HS */}
      {[475, 475, 475].map((x, i) => {
        const tapX = 440 + 70 / 2
        const tapY = [50, 140, 230][i]
        return (
          <line key={i} x1={tapX} y1={railY_top} x2={tapX} y2={tapY}
            stroke="#ff4444" strokeWidth={1.5} strokeOpacity={0.3} />
        )
      })}
      {/* GND rail */}
      <line x1={380} y1={railY_bot} x2={740} y2={railY_bot}
        stroke="var(--txt-4)" strokeWidth={3} strokeOpacity={0.25} />
      <text x={382} y={railY_bot + 14} fontSize={9} fill="var(--txt-4)" fontWeight={700}
        fontFamily="var(--font-mono)" opacity={0.7}>GND</text>
      {/* Vertical taps from shunts to GND */}
      {[0, 1, 2].map(i => {
        const tapX = 670 + 30
        const shuntY = [56 + 36, 146 + 36, 236 + 36][i]
        return (
          <line key={i} x1={tapX} y1={shuntY} x2={tapX} y2={railY_bot}
            stroke="var(--txt-4)" strokeWidth={1} strokeOpacity={0.2}
            strokeDasharray="3,3" />
        )
      })}
      {/* Input cap tap to V+ */}
      <line x1={340} y1={140} x2={340} y2={railY_top} stroke="#ff4444" strokeWidth={1.5} strokeOpacity={0.2} />
      <line x1={340} y1={railY_top} x2={380} y2={railY_top} stroke="#ff4444" strokeWidth={1.5} strokeOpacity={0.2} />
    </g>
  )
}

/* ── Legend ── */
function Legend() {
  const items = [
    { color: '#ff4444', label: 'Power path', dash: false, sw: 2.5 },
    { color: '#00e676', label: 'Phase output', dash: false, sw: 2 },
    { color: '#bb86fc', label: 'Gate drive', dash: false, sw: 1 },
    { color: 'var(--border-3)', label: 'Signal / control', dash: true, sw: 1 },
    { color: '#00d4e8', label: 'Current sense', dash: true, sw: 1 },
  ]
  return (
    <g transform="translate(30, 485)">
      <text x={0} y={0} fontSize={10} fontWeight={700} fill="var(--txt-2)"
        fontFamily="var(--font-ui)" letterSpacing="0.05em">
        SIGNAL LEGEND
      </text>
      {items.map((item, i) => (
        <g key={i} transform={`translate(${i * 125}, 16)`}>
          <line x1={0} y1={0} x2={25} y2={0}
            stroke={item.color} strokeWidth={item.sw}
            strokeDasharray={item.dash ? '4,3' : 'none'} strokeOpacity={0.7} />
          <text x={30} y={4} fontSize={9} fill="var(--txt-3)" fontFamily="var(--font-mono)">
            {item.label}
          </text>
        </g>
      ))}
    </g>
  )
}

/* ── Status summary bar ── */
function StatusBar({ blockStatuses }) {
  const groups = {
    'MCU': blockStatuses.mcu || 'idle',
    'Gate Driver': blockStatuses.gate_driver || 'idle',
    'MOSFETs': blockStatuses.hs_a || 'idle',
    'Motor': blockStatuses.motor || 'idle',
    'Passives': blockStatuses.input_caps || 'idle',
    'Feedback': blockStatuses.protection || 'idle',
  }
  const doneCount = Object.values(groups).filter(s => s === 'done').length
  const total = Object.keys(groups).length

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px',
      background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border-1)',
      marginBottom: 12, flexWrap: 'wrap',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-2)', marginRight: 8 }}>
        Block Status
      </div>
      {Object.entries(groups).map(([name, status]) => (
        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: status === 'done' ? 'var(--green)' : 'var(--txt-4)',
            boxShadow: status === 'done' ? '0 0 6px var(--green)' : 'none',
          }} />
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: status === 'done' ? 'var(--txt-1)' : 'var(--txt-3)',
          }}>
            {name}
          </span>
        </div>
      ))}
      <div style={{
        marginLeft: 'auto', fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700,
        color: doneCount === total ? 'var(--green)' : 'var(--amber)',
      }}>
        {doneCount}/{total} configured
      </div>
    </div>
  )
}

/* ── Tooltip ── */
function BlockTooltip({ hoveredBlock, blockStatuses }) {
  if (!hoveredBlock) return null
  const def = BLOCKS[hoveredBlock]
  if (!def) return null
  const status = blockStatuses[hoveredBlock] || 'idle'

  return (
    <div className="diagram-tooltip" style={{
      position: 'absolute', left: def.x + def.w / 2, top: def.y - 10,
      transform: 'translate(-50%, -100%)',
      pointerEvents: 'none',
    }}>
      <div style={{ fontWeight: 700, fontSize: 12, color: def.color, marginBottom: 2 }}>
        {def.label}
      </div>
      <div style={{ fontSize: 10, color: 'var(--txt-3)', marginBottom: 4 }}>
        {def.sublabel}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: statusColor(status),
        }} />
        <span style={{ color: 'var(--txt-2)' }}>
          {status === 'done' ? 'Configured' : status === 'info' ? 'System parameter' : 'Not configured'}
        </span>
      </div>
      {def.nav && (
        <div style={{ fontSize: 9, color: 'var(--txt-4)', marginTop: 3 }}>
          Click to configure →
        </div>
      )}
    </div>
  )
}

/* ─── Main Panel ──────────────────────────────────────────────────────────── */
export default function DiagramPanel({ config }) {
  const { state, dispatch } = useProject()
  const [hoveredBlock, setHoveredBlock] = useState(null)
  const [showFlow, setShowFlow] = useState(true)

  const handleNav = useCallback((blockKey) => {
    dispatch({ type: 'SET_ACTIVE_BLOCK', payload: blockKey })
  }, [dispatch])

  const blockStatuses = useMemo(() => {
    const s = {}
    Object.entries(BLOCKS).forEach(([id, def]) => {
      s[id] = getBlockStatus(state, def)
    })
    return s
  }, [state])

  const sysSpecs = state.project.system_specs

  return (
    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 16px', borderBottom: '1px solid var(--border-1)',
      }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt-1)', margin: 0 }}>
            {config.fullLabel || 'Block Diagram'}
          </h2>
          <p style={{ fontSize: 11, color: 'var(--txt-3)', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>
            3-Phase PMSM Inverter • {sysSpecs.bus_voltage || '—'}V / {sysSpecs.power ? (sysSpecs.power / 1000).toFixed(1) : '—'}kW • Click any block to configure
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 10, padding: '4px 10px' }}
            onClick={() => setShowFlow(!showFlow)}
          >
            {showFlow ? '⏸ Pause Flow' : '▶ Show Flow'}
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div style={{ padding: '12px 16px 0' }}>
        <StatusBar blockStatuses={blockStatuses} />
      </div>

      {/* SVG Diagram */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '0 16px 16px',
        display: 'flex', justifyContent: 'center',
        position: 'relative',
      }}>
        <svg
          viewBox="0 0 920 540"
          style={{
            width: '100%', maxWidth: 1000, height: 'auto',
            minHeight: 400,
          }}
        >
          {/* Defs */}
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            {/* Grid pattern */}
            <pattern id="diag-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="10" cy="10" r="0.5" fill="var(--border-1)" opacity="0.4" />
            </pattern>
          </defs>

          {/* Background grid */}
          <rect width="920" height="540" fill="url(#diag-grid)" />

          {/* Title block area label */}
          <text x={460} y={20} textAnchor="middle" fontSize={10} fontWeight={600}
            fill="var(--txt-4)" fontFamily="var(--font-mono)" letterSpacing="0.15em">
            48V 3-PHASE PMSM MOTOR CONTROLLER — POWER STAGE TOPOLOGY
          </text>

          {/* Bus rails */}
          <BusRails />

          {/* Wires (behind blocks) */}
          {WIRES.map((w, i) => renderWire(w, i))}

          {/* Animated flow dots */}
          {showFlow && WIRES.filter(w => w.type === 'power' || w.type === 'phase').map((wire, idx) => {
            return <FlowDots key={idx} pathId={`wire-${idx}`} type={wire.type} />
          })}

          {/* Half-bridge bracket labels */}
          <text x={510} y={42} textAnchor="middle" fontSize={8} fill="var(--txt-4)"
            fontFamily="var(--font-mono)">HALF-BRIDGE × 3</text>

          {/* Phase labels at motor entry */}
          {['A', 'B', 'C'].map((ph, i) => (
            <text key={ph} x={755} y={[74, 164, 254][i] + 2} textAnchor="middle"
              fontSize={10} fontWeight={700} fill="#00e676" fontFamily="var(--font-mono)"
              opacity={0.7}>
              Φ{ph}
            </text>
          ))}

          {/* All blocks */}
          {Object.entries(BLOCKS).map(([id, def]) => {
            // Determine dynamic parallel count
            let pCount = 1
            if (id.startsWith('hs_') || id.startsWith('ls_')) {
              pCount = state.project.system_specs.parallel_mosfets || 1
            }

            // Determine dynamic labels
            let label = def.label
            let sublabel = def.sublabel
            if (id === 'motor') {
              label = state.project.blocks.motor?.specs?.motor_type === 'bldc' ? 'BLDC' : 'PMSM'
            }

            return (
              <Block
                key={id}
                id={id}
                def={{ ...def, label, sublabel }}
                status={blockStatuses[id]}
                isHovered={hoveredBlock === id}
                onHover={setHoveredBlock}
                onClick={handleNav}
                parallelCount={pCount}
              />
            )
          })}

          {/* Legend */}
          <Legend />
        </svg>

        {/* Floating tooltip (outside SVG for better rendering) */}
        {hoveredBlock && (() => {
          const def = BLOCKS[hoveredBlock]
          if (!def) return null
          const status = blockStatuses[hoveredBlock] || 'idle'
          // Scale tooltip position relative to SVG container
          return (
            <div style={{
              position: 'absolute', top: 60, right: 24,
              background: 'var(--bg-3)', border: '1px solid var(--border-2)',
              borderRadius: 8, padding: '10px 14px', minWidth: 160,
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              zIndex: 10, pointerEvents: 'none',
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: def.color, marginBottom: 3 }}>
                {def.label}
              </div>
              <div style={{ fontSize: 10, color: 'var(--txt-3)', marginBottom: 6, fontFamily: 'var(--font-mono)' }}>
                {def.sublabel}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: '50%', background: statusColor(status),
                  boxShadow: status === 'done' ? `0 0 6px ${statusColor(status)}` : 'none',
                }} />
                <span style={{ color: 'var(--txt-2)' }}>
                  {status === 'done' ? 'Configured ✓' : status === 'info' ? 'System parameter' : 'Not yet configured'}
                </span>
              </div>
              {def.nav && (
                <div style={{
                  fontSize: 9, color: def.color, marginTop: 6,
                  opacity: 0.7, fontFamily: 'var(--font-mono)',
                }}>
                  Click → {def.nav.charAt(0).toUpperCase() + def.nav.slice(1)} panel
                </div>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
