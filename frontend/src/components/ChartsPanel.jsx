import React, { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, AreaChart, Area, ReferenceLine, BarChart, Bar, Cell
} from 'recharts'
import { useProject, buildParamsDict, getSelectedValue } from '../context/ProjectContext.jsx'
import { fmtNum } from '../utils.js'

/* ═══ Analytical calculations for chart data ══════════════════════════ */

function computeLossVsFreq(mosfetParams, systemSpecs) {
  if (!mosfetParams) return null

  const rds = mosfetParams.rds_on_si || 1.5e-3
  const qg = mosfetParams.qg_si || 92e-9
  const tr = mosfetParams.tr_si || 30e-9
  const tf = mosfetParams.tf_si || 20e-9
  const qrr = mosfetParams.qrr_si || 44e-9
  const qoss = mosfetParams.qoss_si || 0   // Coss charge (nC → C)
  const bodyVf = mosfetParams.body_diode_vf_si || 0.7 // Body diode Vf
  const vBus = systemSpecs.bus_voltage || 48
  const iMax = systemSpecs.max_phase_current || 80
  const vDrv = systemSpecs.gate_drive_voltage || 12
  const numFets = systemSpecs.num_fets || 6
  const dtNs = systemSpecs.dead_time_ns || 200 // dead time for body diode conduction
  const rdsHot = rds * Math.pow((125 + 273.15) / 300, 2.1) // power-law derating at ~125°C

  // 3-phase SPWM per-switch RMS (Mohan textbook): I_peak × sqrt(1/8 + M/(3π))
  // M = modulation index ≈ 0.9 for typical SPWM
  const M = 0.9
  const iRms = iMax * Math.sqrt(1/8 + M / (3 * Math.PI))

  const points = []
  for (let f = 5000; f <= 100000; f += 2500) {
    const pCond = iRms * iRms * rdsHot
    // Sinusoidally-averaged switching loss: P_sw = V × I_peak × (tr+tf) × f / π
    const pSw = vBus * iMax * (tr + tf) * f / Math.PI
    const pGate = qg * vDrv * f
    const pRr = qrr * vBus * f
    // Coss energy loss: P_coss = 0.5 × Qoss × Vbus × fsw
    const pCoss = 0.5 * qoss * vBus * f
    // Body diode conduction during dead time (2 occurrences per PWM cycle): P_body = Vf × I_avg_diode × 2 × dt × fsw
    const pBody = bodyVf * iMax * (2 / Math.PI) * (2 * dtNs * 1e-9) * f
    const pTotal = pCond + pSw + pGate + pRr + pCoss + pBody
    points.push({
      freq: f / 1000,
      conduction: +(pCond).toFixed(3),
      switching: +(pSw).toFixed(3),
      gate: +(pGate).toFixed(3),
      recovery: +(pRr).toFixed(3),
      coss: +(pCoss).toFixed(3),
      bodyDiode: +(pBody).toFixed(3),
      total: +(pTotal).toFixed(3),
      totalAll: +(pTotal * numFets).toFixed(1),
    })
  }
  return points
}

function computeThermalDerating(mosfetParams, systemSpecs, calcResults) {
  if (!mosfetParams) return null

  const rds = mosfetParams.rds_on_si || 1.5e-3
  const tjMax = mosfetParams.tj_max_si || 175
  const rthJC = mosfetParams.rth_jc_si || 0.5

  // Use thermal resistances from calculation results (backend design constants)
  // or fall back to realistic PCB defaults (natural convection, NO heatsink)
  const thermal = calcResults?.thermal || {}
  const rthCS = thermal.rth_cs_c_per_w || 0.5       // TIM: case-to-PCB
  const rthSA = thermal.rth_sa_pcb_c_per_w || 20.0  // PCB-to-ambient (natural convection)
  const rthTotal = rthJC + rthCS + rthSA

  const vBus = systemSpecs.bus_voltage || 48
  const qg = mosfetParams.qg_si || 92e-9
  const tr = mosfetParams.tr_si || 30e-9
  const tf = mosfetParams.tf_si || 20e-9
  const qrr = mosfetParams.qrr_si || 44e-9
  const vDrv = systemSpecs.gate_drive_voltage || 12
  const fsw = systemSpecs.pwm_freq_hz || 20000

  // 3-phase SPWM per-switch RMS (Mohan textbook): sqrt(1/8 + M/(3π))
  const M = 0.9
  const kRms = Math.sqrt(1/8 + M / (3 * Math.PI))
  
  const designIMax = systemSpecs.max_phase_current || 80

  const points = []
  for (let tAmb = -20; tAmb <= 105; tAmb += 5) {
    // Sinusoidally-averaged switching loss per amp: V × (tr+tf) × f / π
    const pSwPerAmp = vBus * (tr + tf) * fsw / Math.PI
    const pGateFixed = qg * vDrv * fsw
    const pRrFixed = qrr * vBus * fsw
    // Coss and body diode losses (fixed per cycle, not current-dependent)
    const qoss = mosfetParams.qoss_si || 0
    const bodyVf = mosfetParams.body_diode_vf_si || 0.7
    const dtNs = systemSpecs.dead_time_ns || 200
    const pCossFixed = 0.5 * qoss * vBus * fsw
    const pBodyFixed = bodyVf * designIMax * (2 / Math.PI) * (2 * dtNs * 1e-9) * fsw

    // Available thermal budget
    const tBudget = tjMax - tAmb - (pGateFixed + pRrFixed + pCossFixed + pBodyFixed) * rthTotal
    if (tBudget <= 0) {
      points.push({ ambient: tAmb, maxCurrent: 0 })
      continue
    }

    // Iterative solve with Tj-dependent Rds_on
    // Rds(Tj) ≈ Rds(25°C) × (Tj/300)^2.2 (better fit for modern MOSFETs)
    let currentAllowed = designIMax // start from design current
    let tj = tAmb + 50 // initial Tj guess
    for (let iter = 0; iter < 50; iter++) {
      const iRms = currentAllowed * kRms
      // Rds(Tj) model: polynomial fit more accurate than linear 0.004/°C
      const rdsHot = rds * Math.pow((tj + 273.15) / 300, 2.1)
      const pCond = iRms * iRms * rdsHot
      const pSw = pSwPerAmp * currentAllowed
      const pTotal = pCond + pSw + pGateFixed + pRrFixed + pCossFixed + pBodyFixed
      const tjNew = tAmb + pTotal * rthTotal

      // Update Tj estimate (moving average for stability)
      tj = 0.5 * tj + 0.5 * tjNew

      if (tjNew > tjMax) {
        currentAllowed *= 0.95
      } else if (tjNew < tjMax - 1) {
        currentAllowed *= 1.01
      } else {
        break
      }
    }

    points.push({
      ambient: tAmb,
      maxCurrent: +Math.max(0, currentAllowed).toFixed(1),
    })
  }
  return points
}

function computeEfficiencyVsLoad(mosfetParams, systemSpecs) {
  if (!mosfetParams) return null

  const rds = mosfetParams.rds_on_si || 1.5e-3
  const qg = mosfetParams.qg_si || 92e-9
  const tr = mosfetParams.tr_si || 30e-9
  const tf = mosfetParams.tf_si || 20e-9
  const qrr = mosfetParams.qrr_si || 44e-9
  const qoss = mosfetParams.qoss_si || 0
  const bodyVf = mosfetParams.body_diode_vf_si || 0.7
  const dtNs = systemSpecs.dead_time_ns || 200

  const vBus = systemSpecs.bus_voltage || 48
  const pRated = systemSpecs.power || 3000
  const vDrv = systemSpecs.gate_drive_voltage || 12
  const fsw = systemSpecs.pwm_freq_hz || 20000
  const numFets = systemSpecs.num_fets || 6
  const rdsHot = rds * Math.pow((125 + 273.15) / 300, 2.1) // power-law derating at ~125°C

  // 3-phase SPWM per-switch RMS (Mohan textbook)
  const M = 0.9
  const kRms = Math.sqrt(1/8 + M / (3 * Math.PI))
  const points = []
  for (let loadPct = 5; loadPct <= 100; loadPct += 5) {
    const pOut = pRated * loadPct / 100
    // Scale peak current linearly from rated (DC-fed inverter, not AC mains)
    const iPeak = (systemSpecs.max_phase_current || 80) * loadPct / 100

    // Per-FET RMS from SPWM modulation
    const iFetRms = iPeak * kRms
    const pCond = iFetRms * iFetRms * rdsHot * numFets
    // Sinusoidally-averaged switching loss: V × I_peak × (tr+tf) × f / π, per FET
    const pSw = vBus * iPeak * (tr + tf) * fsw / Math.PI * numFets
    const pGate = qg * vDrv * fsw * numFets
    const pRr = qrr * vBus * fsw * numFets
    const pCoss = 0.5 * qoss * vBus * fsw * numFets
    const pBody = bodyVf * iPeak * (2 / Math.PI) * (2 * dtNs * 1e-9) * fsw * numFets
    const pLoss = pCond + pSw + pGate + pRr + pCoss + pBody

    const eff = pOut / (pOut + pLoss) * 100

    points.push({
      load: loadPct,
      efficiency: +eff.toFixed(2),
      loss: +pLoss.toFixed(1),
    })
  }
  return points
}

function computeGateTimingVsRg(mosfetParams, systemSpecs) {
  if (!mosfetParams) return null

  const qgd = mosfetParams.qgd_si || 20e-9
  const vDrv = systemSpecs.gate_drive_voltage || 12
  const vPlateau = mosfetParams.vgs_plateau_si || 5
  const vPeak = systemSpecs.peak_voltage || (systemSpecs.bus_voltage || 48)
  const rgInt = mosfetParams.rg_int_si || 1

  const points = []
  for (let rg = 1; rg <= 47; rg += 1) {
    const rgTotal = rg + rgInt
    
    // Switching transit times driven primarily by Miller charge
    const iGateOn = (vDrv - vPlateau) / rgTotal
    const tRise = qgd / iGateOn
    
    // Discharge driven by plateau bias alone
    const iGateOff = vPlateau / rgTotal
    const tFall = qgd / iGateOff
    
    // dV/dt estimated from bus voltage switching speed
    const dvdt = vPeak / (tRise * 1e9) * 1000 // V/µs

    points.push({
      rg: rg,
      riseTime: +(tRise * 1e9).toFixed(1),
      fallTime: +(tFall * 1e9).toFixed(1),
      dvdt: +dvdt.toFixed(0),
    })
  }
  return points
}


/* ═══ Extract SI params from state ════════════════════════════════════ */

function extractSIParams(blockState) {
  if (!blockState || blockState.status !== 'done') return null
  const dict = buildParamsDict(blockState)
  const result = {}

  const conversions = {
    rds_on: { unit: dict.rds_on__unit, mult: { 'mΩ': 1e-3, 'Ω': 1, 'ohm': 1 } },
    qg: { unit: dict.qg__unit, mult: { 'nC': 1e-9, 'µC': 1e-6, 'C': 1 } },
    qgd: { unit: dict.qgd__unit, mult: { 'nC': 1e-9, 'µC': 1e-6, 'C': 1 } },
    qrr: { unit: dict.qrr__unit, mult: { 'nC': 1e-9, 'µC': 1e-6, 'C': 1 } },
    tr: { unit: dict.tr__unit, mult: { 'ns': 1e-9, 'µs': 1e-6, 'ms': 1e-3, 's': 1 } },
    tf: { unit: dict.tf__unit, mult: { 'ns': 1e-9, 'µs': 1e-6, 'ms': 1e-3, 's': 1 } },
    td_on: { unit: dict.td_on__unit, mult: { 'ns': 1e-9, 'µs': 1e-6, 'ms': 1e-3, 's': 1 } },
    td_off: { unit: dict.td_off__unit, mult: { 'ns': 1e-9, 'µs': 1e-6, 'ms': 1e-3, 's': 1 } },
    vds_max: { unit: dict.vds_max__unit, mult: { 'V': 1 } },
    id_cont: { unit: dict.id_cont__unit, mult: { 'A': 1 } },
    coss: { unit: dict.coss__unit, mult: { 'pF': 1e-12, 'nF': 1e-9, 'F': 1 } },
    qoss: { unit: dict.qoss__unit, mult: { 'nC': 1e-9, 'µC': 1e-6, 'C': 1 } },
    rth_jc: { unit: dict.rth_jc__unit, mult: { '°C/W': 1, 'C/W': 1 } },
    tj_max: { unit: dict.tj_max__unit, mult: { '°C': 1, 'C': 1 } },
    vgs_th: { unit: dict.vgs_th__unit, mult: { 'V': 1 } },
    vgs_plateau: { unit: dict.vgs_plateau__unit, mult: { 'V': 1 } },
    rg_int: { unit: dict.rg_int__unit, mult: { 'Ω': 1, 'ohm': 1 } },
    body_diode_vf: { unit: dict.body_diode_vf__unit, mult: { 'V': 1 } },
  }

  for (const [key, info] of Object.entries(conversions)) {
    const raw = dict[key]
    if (raw == null) continue
    const u = (info.unit || '').trim()
    const m = info.mult[u] || Object.values(info.mult)[0] || 1
    result[key + '_si'] = parseFloat(raw) * m
  }

  return Object.keys(result).length > 0 ? result : null
}


/* ═══ Chart Component ══════════════════════════════════════════════════ */

const CHART_TABS = [
  { id: 'loss_vs_freq', label: 'Loss vs Frequency', icon: '📈' },
  { id: 'thermal_derating', label: 'Thermal Derating', icon: '🌡️' },
  { id: 'efficiency_vs_load', label: 'Efficiency vs Load', icon: '⚡' },
  { id: 'gate_timing', label: 'Gate Timing vs Rg', icon: '🔧' },
]

const tooltipStyle = {
  background: 'var(--bg-3)',
  border: '1px solid var(--border-2)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 11,
  color: 'var(--txt-1)',
}

export default function ChartsPanel() {
  const { state } = useProject()
  const { project } = state
  const [activeChart, setActiveChart] = useState('loss_vs_freq')

  const mosfetParams = useMemo(() => extractSIParams(project.blocks.mosfet), [project.blocks.mosfet])
  const systemSpecs = project.system_specs
  const calcResults = project.calculations

  const lossData = useMemo(() => computeLossVsFreq(mosfetParams, systemSpecs), [mosfetParams, systemSpecs])
  const thermalData = useMemo(() => computeThermalDerating(mosfetParams, systemSpecs, calcResults), [mosfetParams, systemSpecs, calcResults])
  const effData = useMemo(() => computeEfficiencyVsLoad(mosfetParams, systemSpecs), [mosfetParams, systemSpecs])
  const gateData = useMemo(() => computeGateTimingVsRg(mosfetParams, systemSpecs), [mosfetParams, systemSpecs])

  const hasData = mosfetParams != null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 960 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 22 }}>📉</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt-1)' }}>Interactive Charts</div>
          <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>Parametric analysis using your MOSFET datasheet and system specs</div>
        </div>
      </div>

      {!hasData ? (
        <div className="dashboard-empty-state">
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.5 }}>📉</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt-2)', marginBottom: 6 }}>No MOSFET Data</div>
          <div style={{ fontSize: 12, color: 'var(--txt-3)', maxWidth: 320, lineHeight: 1.6 }}>
            Upload a MOSFET datasheet to generate parametric analysis charts.
            Charts use your extracted parameters and system specs for analytical calculations.
          </div>
        </div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="charts-tab-bar">
            {CHART_TABS.map(tab => (
              <button
                key={tab.id}
                className={`charts-tab ${activeChart === tab.id ? 'active' : ''}`}
                onClick={() => setActiveChart(tab.id)}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Chart content */}
          <div className="dashboard-card" style={{ padding: '16px 12px' }}>
            {activeChart === 'loss_vs_freq' && lossData && (
              <LossVsFreqChart data={lossData} fsw={systemSpecs.pwm_freq_hz / 1000} />
            )}
            {activeChart === 'thermal_derating' && thermalData && (
              <ThermalDeratingChart data={thermalData} tAmb={systemSpecs.ambient_temp_c || 30} iMax={systemSpecs.max_phase_current} />
            )}
            {activeChart === 'efficiency_vs_load' && effData && (
              <EfficiencyVsLoadChart data={effData} />
            )}
            {activeChart === 'gate_timing' && gateData && (
              <GateTimingChart data={gateData} currentRg={project.calculations?.gate_resistors?.rg_on_recommended_ohm} />
            )}
          </div>

          {/* Chart description */}
          <div style={{
            padding: '10px 14px',
            background: 'var(--bg-2)',
            borderRadius: 8,
            border: '1px solid var(--border-1)',
            fontSize: 11,
            color: 'var(--txt-3)',
            lineHeight: 1.6,
          }}>
            {activeChart === 'loss_vs_freq' && (
              <>
                <strong style={{ color: 'var(--txt-2)' }}>Loss vs Switching Frequency: </strong>
                Shows how MOSFET losses scale with PWM frequency. Conduction loss stays constant while switching and gate losses increase linearly.
                The orange marker shows your current operating point ({systemSpecs.pwm_freq_hz / 1000} kHz).
                <em style={{ display: 'block', marginTop: 4, color: 'var(--txt-4)' }}>Note: Charts use simplified overlap switching model — see Calculations tab for Qgd-based results.</em>
              </>
            )}
            {activeChart === 'thermal_derating' && (
              <>
                <strong style={{ color: 'var(--txt-2)' }}>Thermal Derating: </strong>
                Maximum continuous phase current vs ambient temperature, limited by Tj_max.
                Above a certain ambient temperature, you must reduce current to stay within safe operating area.
              </>
            )}
            {activeChart === 'efficiency_vs_load' && (
              <>
                <strong style={{ color: 'var(--txt-2)' }}>Efficiency vs Load: </strong>
                MOSFET stage efficiency from 5% to 100% load. At light loads, fixed losses (gate charge, recovery) dominate.
                At heavy loads, conduction loss (I&sup2;R) takes over.
              </>
            )}
            {activeChart === 'gate_timing' && (
              <>
                <strong style={{ color: 'var(--txt-2)' }}>Gate Timing vs Rg: </strong>
                Turn-on/off times and dV/dt as a function of external gate resistance. Lower Rg means faster switching but higher EMI (dV/dt).
                Find the sweet spot between switching loss and EMI.
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}


/* ═══ Individual Chart Renderers ══════════════════════════════════════ */

function LossVsFreqChart({ data, fsw }) {
  return (
    <div>
      <div className="dashboard-card-title">Per-MOSFET Loss vs Switching Frequency</div>
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={data} margin={{ top: 10, right: 30, left: 55, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-1)" />
          <XAxis dataKey="freq" label={{ value: 'Frequency (kHz)', position: 'bottom', offset: -2, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <YAxis label={{ value: 'Loss (W)', angle: -90, position: 'insideLeft', offset: 10, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <Tooltip contentStyle={tooltipStyle} formatter={(val, name) => [`${val} W`, name]} />
          <Legend wrapperStyle={{ fontSize: 10, color: 'var(--txt-2)' }} />
          <Area type="monotone" dataKey="conduction" stackId="1" fill="#1e90ff" stroke="#1e90ff" fillOpacity={0.6} name="Conduction" />
          <Area type="monotone" dataKey="switching" stackId="1" fill="#ff4444" stroke="#ff4444" fillOpacity={0.6} name="Switching" />
          <Area type="monotone" dataKey="gate" stackId="1" fill="#bb86fc" stroke="#bb86fc" fillOpacity={0.6} name="Gate" />
          <Area type="monotone" dataKey="recovery" stackId="1" fill="#ffab00" stroke="#ffab00" fillOpacity={0.6} name="Recovery" />
          <Area type="monotone" dataKey="coss" stackId="1" fill="#00bcd4" stroke="#00bcd4" fillOpacity={0.6} name="Coss" />
          <Area type="monotone" dataKey="bodyDiode" stackId="1" fill="#e91e63" stroke="#e91e63" fillOpacity={0.6} name="Body Diode" />
          {fsw && <ReferenceLine x={fsw} stroke="var(--amber)" strokeDasharray="5 5" label={{ value: `${fsw}kHz`, position: 'top', fill: 'var(--amber)', fontSize: 10 }} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ThermalDeratingChart({ data, tAmb, iMax }) {
  return (
    <div>
      <div className="dashboard-card-title">Max Continuous Current vs Ambient Temperature</div>
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={data} margin={{ top: 10, right: 30, left: 55, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-1)" />
          <XAxis dataKey="ambient" label={{ value: 'Ambient Temp (°C)', position: 'bottom', offset: -2, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <YAxis label={{ value: 'Max Current (A)', angle: -90, position: 'insideLeft', offset: 10, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <Tooltip contentStyle={tooltipStyle} formatter={(val) => [`${val} A`, 'Max Current']} />
          <Area type="monotone" dataKey="maxCurrent" fill="#00e676" stroke="#00e676" fillOpacity={0.2} strokeWidth={2} name="Max Current" />
          {tAmb != null && <ReferenceLine x={tAmb} stroke="var(--amber)" strokeDasharray="5 5" label={{ value: `${tAmb}°C`, position: 'top', fill: 'var(--amber)', fontSize: 10 }} />}
          {iMax != null && <ReferenceLine y={iMax} stroke="var(--red)" strokeDasharray="5 5" label={{ value: `${iMax}A (design)`, position: 'right', fill: 'var(--red)', fontSize: 10 }} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function EfficiencyVsLoadChart({ data }) {
  return (
    <div>
      <div className="dashboard-card-title">MOSFET Stage Efficiency vs Load</div>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 10, right: 30, left: 55, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-1)" />
          <XAxis dataKey="load" label={{ value: 'Load (%)', position: 'bottom', offset: -2, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <YAxis yAxisId="eff" domain={[dataMin => Math.floor(dataMin / 5) * 5, 100]} label={{ value: 'Efficiency (%)', angle: -90, position: 'insideLeft', offset: 10, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <YAxis yAxisId="loss" orientation="right" label={{ value: 'Loss (W)', angle: 90, position: 'insideRight', offset: 10, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 10, color: 'var(--txt-2)' }} />
          <Line yAxisId="eff" type="monotone" dataKey="efficiency" stroke="#00e676" strokeWidth={2} dot={false} name="Efficiency (%)" />
          <Line yAxisId="loss" type="monotone" dataKey="loss" stroke="#ff4444" strokeWidth={2} dot={false} name="Total Loss (W)" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function GateTimingChart({ data, currentRg }) {
  return (
    <div>
      <div className="dashboard-card-title">Switching Times & dV/dt vs Gate Resistance</div>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 10, right: 50, left: 55, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-1)" />
          <XAxis dataKey="rg" label={{ value: 'Rg external (Ω)', position: 'bottom', offset: -2, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <YAxis yAxisId="time" label={{ value: 'Time (ns)', angle: -90, position: 'insideLeft', offset: 10, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <YAxis yAxisId="dvdt" orientation="right" label={{ value: 'dV/dt (V/µs)', angle: 90, position: 'insideRight', offset: 10, style: { fill: 'var(--txt-3)', fontSize: 10 } }} stroke="var(--txt-4)" tick={{ fill: 'var(--txt-3)', fontSize: 10 }} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 10, color: 'var(--txt-2)' }} />
          <Line yAxisId="time" type="monotone" dataKey="riseTime" stroke="#1e90ff" strokeWidth={2} dot={false} name="Rise Time (ns)" />
          <Line yAxisId="time" type="monotone" dataKey="fallTime" stroke="#bb86fc" strokeWidth={2} dot={false} name="Fall Time (ns)" />
          <Line yAxisId="dvdt" type="monotone" dataKey="dvdt" stroke="#ffab00" strokeWidth={2} dot={false} name="dV/dt (V/µs)" />
          {currentRg != null && (
            <ReferenceLine
              x={Math.round(currentRg)}
              yAxisId="time"
              stroke="var(--green)"
              strokeDasharray="5 5"
              ifOverflow="extendDomain"
              label={{ value: `Rg=${Math.round(currentRg)}Ω`, position: 'top', fill: 'var(--green)', fontSize: 10 }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
