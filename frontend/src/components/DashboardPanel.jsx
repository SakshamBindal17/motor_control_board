import React, { useMemo } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, Area, AreaChart, ReferenceLine } from 'recharts'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'
import { fmtNum } from '../utils.js'

/* ═══ Design Health Score Calculator ═══════════════════════════════════ */

function computeHealthScore(C, systemSpecs, blocks) {
  if (!C) return null

  const checks = []

  // 1. Thermal margin (25 pts max)
  const tj = C.thermal?.t_junction_est_c
  const tjMax = C.thermal?.tj_max_rated_c
  if (tj != null && tjMax != null) {
    const margin = tjMax - tj
    if (margin >= 40) checks.push({ cat: 'Thermal', label: 'Tj margin', score: 25, max: 25, status: 'pass', detail: `${margin.toFixed(0)}°C margin` })
    else if (margin >= 20) checks.push({ cat: 'Thermal', label: 'Tj margin', score: 18, max: 25, status: 'pass', detail: `${margin.toFixed(0)}°C margin` })
    else if (margin >= 5) checks.push({ cat: 'Thermal', label: 'Tj margin', score: 10, max: 25, status: 'warn', detail: `Only ${margin.toFixed(0)}°C margin` })
    else checks.push({ cat: 'Thermal', label: 'Tj margin', score: 0, max: 25, status: 'fail', detail: `${margin.toFixed(0)}°C — overheating risk` })
  } else {
    checks.push({ cat: 'Thermal', label: 'Tj margin', score: 0, max: 25, status: 'skip', detail: 'No thermal data' })
  }

  // 2. Voltage derating (20 pts max)
  const vMargin = C.mosfet_rating_check?.voltage_margin_pct
  if (vMargin != null) {
    if (vMargin >= 33) checks.push({ cat: 'Voltage', label: 'Vds derating', score: 20, max: 20, status: 'pass', detail: `${vMargin.toFixed(0)}% headroom` })
    else if (vMargin >= 20) checks.push({ cat: 'Voltage', label: 'Vds derating', score: 14, max: 20, status: 'pass', detail: `${vMargin.toFixed(0)}% headroom` })
    else if (vMargin >= 10) checks.push({ cat: 'Voltage', label: 'Vds derating', score: 7, max: 20, status: 'warn', detail: `Only ${vMargin.toFixed(0)}%` })
    else checks.push({ cat: 'Voltage', label: 'Vds derating', score: 0, max: 20, status: 'fail', detail: `${vMargin.toFixed(0)}% — dangerously low` })
  } else {
    checks.push({ cat: 'Voltage', label: 'Vds derating', score: 0, max: 20, status: 'skip', detail: 'No rating data' })
  }

  // 3. Current derating (15 pts max)
  const iMargin = C.mosfet_rating_check?.current_margin_pct
  if (iMargin != null) {
    if (iMargin >= 40) checks.push({ cat: 'Current', label: 'Id derating', score: 15, max: 15, status: 'pass', detail: `${iMargin.toFixed(0)}% headroom` })
    else if (iMargin >= 25) checks.push({ cat: 'Current', label: 'Id derating', score: 10, max: 15, status: 'pass', detail: `${iMargin.toFixed(0)}% headroom` })
    else if (iMargin >= 10) checks.push({ cat: 'Current', label: 'Id derating', score: 5, max: 15, status: 'warn', detail: `Only ${iMargin.toFixed(0)}%` })
    else checks.push({ cat: 'Current', label: 'Id derating', score: 0, max: 15, status: 'fail', detail: `${iMargin.toFixed(0)}% — overloaded` })
  } else {
    checks.push({ cat: 'Current', label: 'Id derating', score: 0, max: 15, status: 'skip', detail: 'No rating data' })
  }

  // 4. Efficiency (15 pts max)
  const eff = C.mosfet_losses?.efficiency_mosfet_pct
  if (eff != null) {
    if (eff >= 98) checks.push({ cat: 'Efficiency', label: 'MOSFET η', score: 15, max: 15, status: 'pass', detail: `${eff.toFixed(1)}%` })
    else if (eff >= 96) checks.push({ cat: 'Efficiency', label: 'MOSFET η', score: 12, max: 15, status: 'pass', detail: `${eff.toFixed(1)}%` })
    else if (eff >= 92) checks.push({ cat: 'Efficiency', label: 'MOSFET η', score: 7, max: 15, status: 'warn', detail: `${eff.toFixed(1)}%` })
    else checks.push({ cat: 'Efficiency', label: 'MOSFET η', score: 2, max: 15, status: 'fail', detail: `${eff.toFixed(1)}% — high losses` })
  } else {
    checks.push({ cat: 'Efficiency', label: 'MOSFET η', score: 0, max: 15, status: 'skip', detail: 'No loss data' })
  }

  // 5. Cross-validation health (15 pts max)
  const cvScore = C.cross_validation?.summary?.health_score
  if (cvScore != null) {
    const pts = Math.round(cvScore * 0.15)
    const st = cvScore >= 80 ? 'pass' : cvScore >= 50 ? 'warn' : 'fail'
    checks.push({ cat: 'Compatibility', label: 'Cross-check', score: pts, max: 15, status: st, detail: `${cvScore}/100` })
  } else {
    checks.push({ cat: 'Compatibility', label: 'Cross-check', score: 0, max: 15, status: 'skip', detail: 'Not enough data' })
  }

  // 6. Data completeness (10 pts max)
  const uploaded = ['mcu', 'driver', 'mosfet'].filter(k => blocks[k]?.status === 'done').length
  const motorOk = !!(blocks.motor?.specs?.max_speed_rpm && (blocks.motor?.specs?.rph_mohm || blocks.motor?.specs?.lph_uh))
  const completePts = Math.round(((uploaded / 3) * 7 + (motorOk ? 3 : 0)))
  const completeSt = completePts >= 8 ? 'pass' : completePts >= 5 ? 'warn' : 'fail'
  checks.push({ cat: 'Completeness', label: 'Data inputs', score: completePts, max: 10, status: completeSt, detail: `${uploaded}/3 datasheets${motorOk ? ' + motor' : ''}` })

  const totalScore = checks.reduce((s, c) => s + c.score, 0)
  const totalMax = checks.reduce((s, c) => s + c.max, 0)
  const pct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0

  return { checks, totalScore, totalMax, pct }
}


/* ═══ Component ═════════════════════════════════════════════════════════ */

export default function DashboardPanel() {
  const { state } = useProject()
  const { project } = state
  const C = project.calculations
  const blocks = project.blocks

  const health = useMemo(() => computeHealthScore(C, project.system_specs, blocks), [C, project.system_specs, blocks])

  // Loss breakdown data for pie chart
  const lossData = useMemo(() => {
    if (!C?.mosfet_losses) return null
    const items = []
    const ml = C.mosfet_losses
    if (ml.conduction_loss_per_fet_w > 0) items.push({ name: 'Conduction', value: +(ml.conduction_loss_per_fet_w * 6).toFixed(2), color: '#1e90ff' })
    if (ml.switching_loss_per_fet_w > 0) items.push({ name: 'Switching', value: +(ml.switching_loss_per_fet_w * 6).toFixed(2), color: '#ff4444' })
    if (ml.recovery_loss_per_fet_w > 0) items.push({ name: 'Recovery', value: +(ml.recovery_loss_per_fet_w * 6).toFixed(2), color: '#ffab00' })
    if (ml.gate_charge_loss_per_fet_w > 0) items.push({ name: 'Gate', value: +(ml.gate_charge_loss_per_fet_w * 6).toFixed(2), color: '#bb86fc' })
    if (ml.coss_loss_per_fet_w > 0) items.push({ name: 'Coss', value: +(ml.coss_loss_per_fet_w * 6).toFixed(2), color: '#00d4e8' })
    const motorCu = C.thermal?.motor_copper_loss_w
    if (motorCu > 0) items.push({ name: 'Motor Cu', value: +motorCu.toFixed(2), color: '#00e676' })
    return items.length > 0 ? items : null
  }, [C])

  // Thermal stack data for bar chart
  const thermalData = useMemo(() => {
    if (!C?.thermal) return null
    const t = C.thermal
    const items = []
    items.push({ name: 'Ambient', value: project.system_specs.ambient_temp_c || 30, fill: '#546a84' })
    if (t.t_case_est_c && t.t_junction_est_c) {
      items.push({ name: 'ΔT case', value: +(t.t_case_est_c - (project.system_specs.ambient_temp_c || 30)).toFixed(1), fill: '#ffab00' })
      items.push({ name: 'ΔT junc', value: +(t.t_junction_est_c - t.t_case_est_c).toFixed(1), fill: '#ff4444' })
    }
    return items
  }, [C, project.system_specs])

  // Protection status summary
  const protectionStatus = useMemo(() => {
    if (!C?.protection_dividers) return null
    const p = C.protection_dividers
    return [
      { label: 'OVP', value: `${p.ovp?.actual_trip_v || p.ovp?.trip_voltage_v || '—'}V`, ok: true },
      { label: 'UVP', value: `${p.uvp?.trip_voltage_v || '—'}V`, ok: true },
      { label: 'OCP (HW)', value: `${p.ocp?.hw_threshold_a || '—'}A`, ok: true },
      { label: 'OCP (SW)', value: `${p.ocp?.sw_threshold_a || '—'}A`, ok: true },
      { label: 'OTP Warn', value: `${p.otp?.warning_temp_c || '—'}°C`, ok: true },
      { label: 'OTP Shut', value: `${p.otp?.shutdown_temp_c || '—'}°C`, ok: true },
    ]
  }, [C])

  const scoreColor = !health ? 'var(--txt-4)' : health.pct >= 80 ? 'var(--green)' : health.pct >= 50 ? 'var(--amber)' : 'var(--red)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>

      {/* ── Header ──────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 22 }}>📊</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt-1)' }}>Design Dashboard</div>
          <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>Overview of your motor controller design health and key metrics</div>
        </div>
      </div>

      {!C ? (
        <div className="dashboard-empty-state">
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.5 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt-2)', marginBottom: 6 }}>No Calculations Yet</div>
          <div style={{ fontSize: 12, color: 'var(--txt-3)', maxWidth: 320, lineHeight: 1.6 }}>
            Upload at least a MOSFET datasheet and run calculations to see your design dashboard with health score, loss breakdown, thermal analysis, and more.
          </div>
        </div>
      ) : (
        <>
          {/* ── Top row: Health Score + Key Metrics ──── */}
          <div className="dashboard-top-row">
            {/* Health Score Ring */}
            <div className="dashboard-card dashboard-health-card">
              <div className="dashboard-card-title">Design Health Score</div>
              <div className="dashboard-health-ring">
                <svg viewBox="0 0 120 120" width="120" height="120">
                  <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border-1)" strokeWidth="8" />
                  <circle
                    cx="60" cy="60" r="52"
                    fill="none"
                    stroke={scoreColor}
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={`${(health?.pct || 0) * 3.267} 326.7`}
                    transform="rotate(-90 60 60)"
                    style={{ transition: 'stroke-dasharray 0.8s ease' }}
                  />
                  <text x="60" y="54" textAnchor="middle" fill={scoreColor}
                    style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                    {health?.pct ?? '—'}
                  </text>
                  <text x="60" y="72" textAnchor="middle" fill="var(--txt-3)"
                    style={{ fontSize: 10, fontWeight: 500 }}>
                    / 100
                  </text>
                </svg>
              </div>
              {/* Score breakdown */}
              <div className="dashboard-health-checks">
                {health?.checks.map((c, i) => (
                  <div key={i} className="dashboard-health-row">
                    <span className={`dashboard-health-dot dashboard-health-dot--${c.status}`} />
                    <span className="dashboard-health-label">{c.label}</span>
                    <span className="dashboard-health-detail">{c.detail}</span>
                    <span className="dashboard-health-pts">{c.score}/{c.max}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Key Metrics Cards */}
            <div className="dashboard-metrics-grid">
              <MetricCard
                label="Total Loss"
                value={C.mosfet_losses?.total_all_6_fets_w}
                unit="W"
                sub="6 MOSFETs"
                color={C.mosfet_losses?.total_all_6_fets_w > 60 ? 'var(--red)' : C.mosfet_losses?.total_all_6_fets_w > 40 ? 'var(--amber)' : 'var(--green)'}
              />
              <MetricCard
                label="Efficiency"
                value={C.mosfet_losses?.efficiency_mosfet_pct}
                unit="%"
                dec={2}
                sub="MOSFET stage"
                color={C.mosfet_losses?.efficiency_mosfet_pct >= 97 ? 'var(--green)' : C.mosfet_losses?.efficiency_mosfet_pct >= 94 ? 'var(--amber)' : 'var(--red)'}
              />
              <MetricCard
                label="Junction Temp"
                value={C.thermal?.t_junction_est_c}
                unit="°C"
                dec={1}
                sub={`Margin: ${C.thermal?.thermal_margin_c != null ? C.thermal.thermal_margin_c.toFixed(0) + '°C' : '—'}`}
                color={C.thermal?.thermal_margin_c > 30 ? 'var(--green)' : C.thermal?.thermal_margin_c > 10 ? 'var(--amber)' : 'var(--red)'}
              />
              <MetricCard
                label="Dead Time"
                value={C.dead_time?.dt_actual_ns}
                unit="ns"
                dec={0}
                sub={`${C.dead_time?.dt_pct_of_period != null ? C.dead_time.dt_pct_of_period.toFixed(2) : '—'}% of period`}
                color="var(--accent)"
              />
              <MetricCard
                label="Bus Ripple"
                value={C.input_capacitors?.v_ripple_actual_v}
                unit="V"
                dec={3}
                sub={`${C.input_capacitors?.n_bulk_caps || '—'} caps`}
                color="var(--cyan)"
              />
              <MetricCard
                label="Rg ON"
                value={C.gate_resistors?.rg_on_recommended_ohm}
                unit="Ω"
                dec={1}
                sub={`dV/dt: ${C.gate_resistors?.dv_dt_v_per_us != null ? C.gate_resistors.dv_dt_v_per_us.toFixed(0) + ' V/µs' : '—'}`}
                color="var(--purple)"
              />
            </div>
          </div>

          {/* ── Middle row: Charts ───────────────────── */}
          <div className="dashboard-charts-row">
            {/* Loss Breakdown Pie */}
            {lossData && (
              <div className="dashboard-card">
                <div className="dashboard-card-title">Inverter Loss Breakdown (3-phase bridge)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie
                        data={lossData}
                        cx="50%"
                        cy="50%"
                        innerRadius={40}
                        outerRadius={70}
                        paddingAngle={2}
                        dataKey="value"
                        stroke="none"
                      >
                        {lossData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, fontSize: 11, color: '#e8eaed', padding: '6px 10px' }}
                        itemStyle={{ color: '#e8eaed' }}
                        labelStyle={{ color: '#e8eaed' }}
                        formatter={(val, name) => [`${val.toFixed(2)} W`, name]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 100 }}>
                    {lossData.map((d, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
                        <span style={{ color: 'var(--txt-2)', flex: 1 }}>{d.name}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt-1)', fontWeight: 600 }}>{d.value}W</span>
                      </div>
                    ))}
                    <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 4, marginTop: 2, display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                      <span style={{ color: 'var(--txt-2)', fontWeight: 700 }}>Total</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt-1)', fontWeight: 700 }}>
                        {lossData.reduce((s, d) => s + d.value, 0).toFixed(1)}W
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Thermal Stack */}
            {C.thermal && (
              <div className="dashboard-card">
                <div className="dashboard-card-title">Thermal Stack</div>
                <div className="dashboard-thermal-visual">
                  <ThermalBar
                    ambient={project.system_specs.ambient_temp_c || 30}
                    tCase={C.thermal?.t_case_est_c}
                    tJunc={C.thermal?.t_junction_est_c}
                    tMax={C.thermal?.tj_max_rated_c}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── Bottom row: Protection + Capacitors + Gate ─── */}
          <div className="dashboard-bottom-row">
            {/* Protection thresholds */}
            {protectionStatus && (
              <div className="dashboard-card">
                <div className="dashboard-card-title">Protection Thresholds</div>
                <div className="dashboard-prot-grid">
                  {protectionStatus.map((p, i) => (
                    <div key={i} className="dashboard-prot-item">
                      <span className="dashboard-prot-label">{p.label}</span>
                      <span className="dashboard-prot-value">{p.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Capacitor Summary */}
            {C.input_capacitors && (
              <div className="dashboard-card">
                <div className="dashboard-card-title">Capacitor Budget</div>
                <div className="dashboard-cap-grid">
                  <CapRow label="Bulk Count" value={C.input_capacitors.n_bulk_caps} unit="pcs" />
                  <CapRow label="Total C" value={C.input_capacitors.c_total_uf} unit="µF" />
                  <CapRow label="Ripple I" value={C.input_capacitors.i_ripple_rms_a} unit="A" dec={1} />
                  <CapRow label="Bootstrap" value={C.bootstrap_cap?.c_boot_recommended_nf} unit="nF" />
                  <CapRow label="Snubber Cs" value={C.snubber?.cs_recommended_pf} unit="pF" />
                  <CapRow label="Snubber Rs" value={C.snubber?.rs_recommended_ohm} unit="Ω" />
                </div>
              </div>
            )}

            {/* Dead Time & Gate Drive */}
            {C.dead_time && (
              <div className="dashboard-card">
                <div className="dashboard-card-title">Timing & Gate Drive</div>
                <div className="dashboard-cap-grid">
                  <CapRow label="DT min" value={C.dead_time.dt_minimum_ns} unit="ns" />
                  <CapRow label="DT actual" value={C.dead_time.dt_actual_ns} unit="ns" />
                  <CapRow label="Rise time" value={C.gate_resistors?.gate_rise_time_ns} unit="ns" dec={1} />
                  <CapRow label="Fall time" value={C.gate_resistors?.gate_fall_time_ns} unit="ns" dec={1} />
                  <CapRow label="dV/dt" value={C.gate_resistors?.dv_dt_v_per_us} unit="V/µs" dec={0} />
                  <CapRow label="DT %" value={C.dead_time.dt_pct_of_period} unit="%" dec={2} />
                </div>
              </div>
            )}
          </div>

          {/* ── Cross-validation summary (compact) ─── */}
          {C.cross_validation && (
            <div className="dashboard-card">
              <div className="dashboard-card-title">Cross-Datasheet Validation</div>
              <div className="dashboard-cv-grid">
                {C.cross_validation.checks?.map((ck, i) => (
                  <div key={i} className={`dashboard-cv-item dashboard-cv-item--${ck.status}`}>
                    <span className="dashboard-cv-icon">
                      {ck.status === 'pass' ? '✓' : ck.status === 'warn' ? '!' : ck.status === 'fail' ? '✗' : '–'}
                    </span>
                    <span className="dashboard-cv-title">{ck.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}


/* ═══ Sub-components ════════════════════════════════════════════════════ */

function MetricCard({ label, value, unit, sub, color, dec = 1 }) {
  return (
    <div className="dashboard-metric">
      <div className="dashboard-metric-label">{label}</div>
      <div className="dashboard-metric-value" style={{ color }}>
        {value != null ? fmtNum(value, dec) : '—'}
        {value != null && <span className="dashboard-metric-unit">{unit}</span>}
      </div>
      {sub && <div className="dashboard-metric-sub">{sub}</div>}
    </div>
  )
}

function ThermalBar({ ambient, tCase, tJunc, tMax }) {
  // Use actual Tj_max (handles GaN ~150C, SiC ~200C, Si ~175C) with some visual headroom
  const maxTemp = Math.max(tMax || 175, (tJunc || 0) + 20)
  const pct = (v) => Math.min(95, Math.max(0, (v / maxTemp) * 100))

  return (
    <div className="dashboard-thermal-bar-wrapper">
      {/* Temperature bar */}
      <div className="dashboard-thermal-bar">
        <div className="dashboard-thermal-segment" style={{ width: `${pct(ambient)}%`, background: 'var(--accent)' }} />
        {tCase != null && (
          <div className="dashboard-thermal-segment" style={{ width: `${pct(tCase) - pct(ambient)}%`, background: 'var(--amber)' }} />
        )}
        {tJunc != null && (
          <div className="dashboard-thermal-segment" style={{ width: `${pct(tJunc) - pct(tCase || ambient)}%`, background: 'var(--red)' }} />
        )}
      </div>
      {/* Labels */}
      <div className="dashboard-thermal-labels">
        <span style={{ color: 'var(--accent)' }}>T_amb {ambient}°C</span>
        {tCase != null && <span style={{ color: 'var(--amber)' }}>T_case {tCase.toFixed(0)}°C</span>}
        {tJunc != null && <span style={{ color: 'var(--red)' }}>T_j {tJunc.toFixed(0)}°C</span>}
        {tMax != null && <span style={{ color: 'var(--txt-3)' }}>T_max {tMax}°C</span>}
      </div>
      {/* Tj max marker */}
      {tMax != null && (
        <div className="dashboard-thermal-marker" style={{ left: `${pct(tMax)}%` }}>
          <div className="dashboard-thermal-marker-line" />
        </div>
      )}
    </div>
  )
}

function CapRow({ label, value, unit, dec = 0 }) {
  return (
    <div className="dashboard-cap-row">
      <span className="dashboard-cap-label">{label}</span>
      <span className="dashboard-cap-value">
        {value != null ? fmtNum(value, dec) : '—'}
        {value != null && unit && <span className="dashboard-cap-unit"> {unit}</span>}
      </span>
    </div>
  )
}
