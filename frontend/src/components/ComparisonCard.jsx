import React, { useState, useMemo } from 'react'
import { ChevronDown, ArrowUpRight, ArrowDownRight, Minus, BarChart3, Layers, Wrench, Scale } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from 'recharts'
import { fmtNum } from '../utils.js'

// ── Which direction is "better" for each metric ─────────────────────────────
// lower = smaller is better, higher = bigger is better, info = no winner (trade-off)
const METRIC_DIRS = {
  // mosfet_rating_check
  voltage_margin_pct: 'higher', current_margin_pct: 'higher',
  // mosfet_losses
  conduction_loss_per_fet_w: 'lower', switching_loss_per_fet_w: 'lower',
  recovery_loss_per_fet_w: 'lower', total_loss_per_fet_w: 'lower',
  total_all_6_fets_w: 'lower', efficiency_mosfet_pct: 'higher',
  // thermal
  t_junction_est_c: 'lower', thermal_margin_c: 'higher',
  p_per_fet_w: 'lower', copper_area_per_fet_mm2: 'lower',
  system_total_loss_w: 'lower',
  // gate_resistors
  rg_on_recommended_ohm: 'info', rg_off_recommended_ohm: 'info',
  gate_rise_time_ns: 'info', gate_fall_time_ns: 'info', dv_dt_v_per_us: 'info',
  // dead_time
  dt_minimum_ns: 'lower', dt_recommended_ns: 'lower',
  dt_actual_ns: 'lower', dt_pct_of_period: 'lower',
  // snubber
  voltage_overshoot_v: 'lower', v_sw_peak_v: 'lower',
  rs_recommended_ohm: 'info', cs_recommended_pf: 'info',
  p_total_6_snubbers_w: 'lower',
  // bootstrap
  c_boot_calculated_nf: 'info', c_boot_recommended_nf: 'info',
  min_hs_on_time_ns: 'lower',
}

// Sections that change with different MOSFETs
export const MOSFET_DEPENDENT_SECTIONS = new Set([
  'mosfet_rating_check', 'mosfet_losses', 'gate_resistors',
  'bootstrap_cap', 'thermal', 'dead_time', 'snubber',
])

// Key metrics for the verdict summary (subset of most important ones)
const VERDICT_METRICS = [
  { key: 'total_loss_per_fet_w', section: 'mosfet_losses', label: 'Total loss/FET', unit: 'W', dec: 2 },
  { key: 'efficiency_mosfet_pct', section: 'mosfet_losses', label: 'Efficiency', unit: '%', dec: 2 },
  { key: 't_junction_est_c', section: 'thermal', label: 'Tj estimated', unit: '°C', dec: 1 },
  { key: 'thermal_margin_c', section: 'thermal', label: 'Thermal margin', unit: '°C', dec: 1 },
  { key: 'dt_minimum_ns', section: 'dead_time', label: 'Min dead time', unit: 'ns', dec: 0 },
  { key: 'voltage_margin_pct', section: 'mosfet_rating_check', label: 'Voltage margin', unit: '%', dec: 1 },
  { key: 'current_margin_pct', section: 'mosfet_rating_check', label: 'Current margin', unit: '%', dec: 1 },
  { key: 'voltage_overshoot_v', section: 'snubber', label: 'V overshoot', unit: 'V', dec: 1 },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function pctDiff(a, b) {
  if (!a || a === 0) return 0
  return ((b - a) / Math.abs(a)) * 100
}

function getWinner(valA, valB, dir) {
  if (dir === 'info' || valA === valB) return 'tie'
  if (dir === 'lower') return valA < valB ? 'a' : 'b'
  if (dir === 'higher') return valA > valB ? 'a' : 'b'
  return 'tie'
}

// ── Trade-off analysis ──────────────────────────────────────────────────────

function generateTradeoffs(a, b) {
  const insights = { a: [], b: [] }
  if (!a || !b) return insights

  const lossA = a.mosfet_losses, lossB = b.mosfet_losses
  const thermA = a.thermal, thermB = b.thermal
  const gateA = a.gate_resistors, gateB = b.gate_resistors
  const dtA = a.dead_time, dtB = b.dead_time
  const snubA = a.snubber, snubB = b.snubber
  const rateA = a.mosfet_rating_check, rateB = b.mosfet_rating_check

  // Total loss
  if (lossA?.total_all_6_fets_w && lossB?.total_all_6_fets_w) {
    const d = pctDiff(lossA.total_all_6_fets_w, lossB.total_all_6_fets_w)
    if (Math.abs(d) > 3) {
      const w = d > 0 ? 'a' : 'b'
      insights[w].push(`${Math.abs(d).toFixed(0)}% lower total MOSFET loss`)
    }
  }

  // Conduction vs switching trade-off
  if (lossA?.conduction_loss_per_fet_w && lossB?.conduction_loss_per_fet_w) {
    const condD = pctDiff(lossA.conduction_loss_per_fet_w, lossB.conduction_loss_per_fet_w)
    const swD = pctDiff(lossA.switching_loss_per_fet_w, lossB.switching_loss_per_fet_w)
    if (condD > 5 && swD < -5) {
      insights.b.push('Lower Rds(on) — better conduction efficiency')
      insights.a.push('Faster switching — lower switching loss')
    } else if (condD < -5 && swD > 5) {
      insights.a.push('Lower Rds(on) — better conduction efficiency')
      insights.b.push('Faster switching — lower switching loss')
    }
  }

  // Thermal margin
  if (thermA?.thermal_margin_c != null && thermB?.thermal_margin_c != null) {
    const diff = thermA.thermal_margin_c - thermB.thermal_margin_c
    if (Math.abs(diff) > 5) {
      const w = diff > 0 ? 'a' : 'b'
      insights[w].push(`${Math.abs(diff).toFixed(0)}°C more thermal margin`)
    }
  }

  // dV/dt (EMI)
  if (gateA?.dv_dt_v_per_us && gateB?.dv_dt_v_per_us) {
    const d = pctDiff(gateA.dv_dt_v_per_us, gateB.dv_dt_v_per_us)
    if (Math.abs(d) > 15) {
      const w = d > 0 ? 'a' : 'b'
      insights[w].push(`${Math.abs(d).toFixed(0)}% lower dV/dt (less EMI)`)
    }
  }

  // Dead time
  if (dtA?.dt_minimum_ns != null && dtB?.dt_minimum_ns != null) {
    const diff = dtA.dt_minimum_ns - dtB.dt_minimum_ns
    if (Math.abs(diff) > 10) {
      const w = diff > 0 ? 'b' : 'a'
      insights[w].push(`${Math.abs(diff).toFixed(0)}ns lower minimum dead time`)
    }
  }

  // Voltage margin
  if (rateA?.voltage_margin_pct != null && rateB?.voltage_margin_pct != null) {
    const diff = rateA.voltage_margin_pct - rateB.voltage_margin_pct
    if (Math.abs(diff) > 5) {
      const w = diff > 0 ? 'a' : 'b'
      insights[w].push(`${Math.abs(diff).toFixed(0)}% more voltage headroom`)
    }
  }

  // Snubber / overshoot
  if (snubA?.voltage_overshoot_v != null && snubB?.voltage_overshoot_v != null) {
    const diff = snubA.voltage_overshoot_v - snubB.voltage_overshoot_v
    if (Math.abs(diff) > 2) {
      const w = diff > 0 ? 'b' : 'a'
      insights[w].push(`${Math.abs(diff).toFixed(1)}V less voltage overshoot`)
    }
  }

  return insights
}

// ── Crossover chart data ────────────────────────────────────────────────────

function computeCrossover(a, b, iMax) {
  if (!a?.mosfet_losses || !b?.mosfet_losses || !iMax) return null

  const la = a.mosfet_losses, lb = b.mosfet_losses
  // Separate conduction (I²) from rest (approximately linear with I)
  const condA = la.conduction_loss_per_fet_w || 0
  const restA = (la.total_loss_per_fet_w || 0) - condA
  const condB = lb.conduction_loss_per_fet_w || 0
  const restB = (lb.total_loss_per_fet_w || 0) - condB

  const steps = 50
  const points = []
  for (let k = 0; k <= steps; k++) {
    const r = k / steps
    const current = +(r * iMax).toFixed(1)
    // P_cond ∝ I², rest ∝ I (approximation: gate charge is constant but small)
    const lossA = condA * r * r + restA * r
    const lossB = condB * r * r + restB * r
    points.push({ current, lossA: +lossA.toFixed(4), lossB: +lossB.toFixed(4) })
  }

  // Find crossover point via linear interpolation
  let crossover = null
  for (let j = 1; j < points.length; j++) {
    const dPrev = points[j - 1].lossA - points[j - 1].lossB
    const dCurr = points[j].lossA - points[j].lossB
    if (dPrev * dCurr < 0) {
      const denom = Math.abs(dPrev) + Math.abs(dCurr)
      if (denom === 0) continue  // prevent division by zero
      const t = Math.abs(dPrev) / denom
      crossover = +(points[j - 1].current + t * (points[j].current - points[j - 1].current)).toFixed(1)
      break
    }
  }

  return { points, crossover }
}

// ── Passives impact diff ────────────────────────────────────────────────────

function computePassivesDiff(a, b) {
  if (!a || !b) return []

  const pairs = [
    { key: 'rg_on_recommended_ohm', section: 'gate_resistors', label: 'Rg ON', unit: 'Ω', dec: 1 },
    { key: 'rg_off_recommended_ohm', section: 'gate_resistors', label: 'Rg OFF', unit: 'Ω', dec: 1 },
    { key: 'c_boot_recommended_nf', section: 'bootstrap_cap', label: 'C_boot', unit: 'nF', dec: 0 },
    { key: 'rs_recommended_ohm', section: 'snubber', label: 'Rs snubber', unit: 'Ω', dec: 0 },
    { key: 'cs_recommended_pf', section: 'snubber', label: 'Cs snubber', unit: 'pF', dec: 0 },
    { key: 'dt_recommended_ns', section: 'dead_time', label: 'Dead time (MCU)', unit: 'ns', dec: 0 },
  ]

  const diffs = []
  for (const { key, section, label, unit, dec } of pairs) {
    const valA = a[section]?.[key]
    const valB = b[section]?.[key]
    if (valA == null && valB == null) continue

    const changed = valA !== valB
    const delta = (valB != null && valA != null && valA !== 0)
      ? ((valB - valA) / Math.abs(valA) * 100)
      : null

    diffs.push({ label, unit, dec, valA, valB, changed, delta })
  }

  return diffs
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Component
// ═════════════════════════════════════════════════════════════════════════════

export default function ComparisonCard({ resultsA, resultsB, nameA, nameB, iMax }) {
  const [chartOpen, setChartOpen] = useState(false)
  const [verdictOpen, setVerdictOpen] = useState(true)
  const [tradeoffOpen, setTradeoffOpen] = useState(true)
  const [passivesOpen, setPassivesOpen] = useState(true)

  // Compute all analysis data
  const verdict = useMemo(() => {
    if (!resultsA || !resultsB) return []
    const items = []
    for (const m of VERDICT_METRICS) {
      if (!resultsA[m.section] || !resultsB[m.section]) continue
      const valA = resultsA[m.section][m.key]
      const valB = resultsB[m.section][m.key]
      if (valA == null || valB == null) continue
      const dir = METRIC_DIRS[m.key] || 'info'
      const winner = getWinner(valA, valB, dir)
      const delta = pctDiff(valA, valB)
      items.push({ ...m, valA, valB, winner, delta, dir })
    }
    return items
  }, [resultsA, resultsB])

  const tradeoffs = useMemo(() => generateTradeoffs(resultsA, resultsB), [resultsA, resultsB])
  const crossover = useMemo(() => computeCrossover(resultsA, resultsB, iMax), [resultsA, resultsB, iMax])
  const passivesDiff = useMemo(() => computePassivesDiff(resultsA, resultsB), [resultsA, resultsB])

  // Score: count wins
  const winsA = verdict.filter(v => v.winner === 'a').length
  const winsB = verdict.filter(v => v.winner === 'b').length
  const ties = verdict.filter(v => v.winner === 'tie').length

  return (
    <div className="comparison-card">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="comp-header">
        <Scale size={13} style={{ color: 'var(--cyan)' }} />
        <span className="comp-title">MOSFET Comparison</span>
        <div className="comp-names">
          <span className="comp-name-a">{nameA || 'Primary'}</span>
          <span className="comp-vs">vs</span>
          <span className="comp-name-b">{nameB || 'Compare'}</span>
        </div>
      </div>

      {/* ── Score summary ───────────────────────────────────── */}
      <div className="comp-score-bar">
        <div className="comp-score-item">
          <span className="comp-score-dot a" />
          <span className="comp-score-label">{nameA || 'A'}</span>
          <span className="comp-score-num a">{winsA}</span>
        </div>
        <div className="comp-score-item">
          <span className="comp-score-dot tie" />
          <span className="comp-score-label">Tie</span>
          <span className="comp-score-num tie">{ties}</span>
        </div>
        <div className="comp-score-item">
          <span className="comp-score-dot b" />
          <span className="comp-score-label">{nameB || 'B'}</span>
          <span className="comp-score-num b">{winsB}</span>
        </div>
      </div>

      {/* ── Verdict table ───────────────────────────────────── */}
      <div className="comp-section">
        <button className={`comp-section-trigger ${verdictOpen ? 'open' : ''}`} onClick={() => setVerdictOpen(!verdictOpen)}>
          <BarChart3 size={11} />
          <span>Head-to-Head</span>
          <span className="chevron"><ChevronDown size={10} /></span>
        </button>
        {verdictOpen && (
          <div className="comp-section-body">
            <div className="comp-verdict-header">
              <span className="comp-vh-metric">Metric</span>
              <span className="comp-vh-val">{nameA || 'A'}</span>
              <span className="comp-vh-val">{nameB || 'B'}</span>
              <span className="comp-vh-delta">Delta</span>
            </div>
            {verdict.map(v => (
              <div key={v.key} className={`comp-verdict-row ${v.winner !== 'tie' ? `winner-${v.winner}` : ''}`}>
                <span className="comp-vr-metric">{v.label}</span>
                <span className={`comp-vr-val ${v.winner === 'a' ? 'is-winner' : ''}`}>
                  {fmtNum(v.valA, v.dec)}{v.unit ? ` ${v.unit}` : ''}
                  {v.winner === 'a' && <span className="winner-badge">✓</span>}
                </span>
                <span className={`comp-vr-val ${v.winner === 'b' ? 'is-winner' : ''}`}>
                  {fmtNum(v.valB, v.dec)}{v.unit ? ` ${v.unit}` : ''}
                  {v.winner === 'b' && <span className="winner-badge">✓</span>}
                </span>
                <span className={`comp-vr-delta ${v.dir === 'info' ? 'neutral' : v.winner === 'tie' ? 'neutral' : ''}`}>
                  {v.winner === 'tie' ? '=' : (
                    <>
                      {v.delta > 0 ? <ArrowUpRight size={9} /> : <ArrowDownRight size={9} />}
                      {Math.abs(v.delta).toFixed(0)}%
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Trade-off summary ───────────────────────────────── */}
      {(tradeoffs.a.length > 0 || tradeoffs.b.length > 0) && (
        <div className="comp-section">
          <button className={`comp-section-trigger ${tradeoffOpen ? 'open' : ''}`} onClick={() => setTradeoffOpen(!tradeoffOpen)}>
            <Layers size={11} />
            <span>Trade-Off Analysis</span>
            <span className="chevron"><ChevronDown size={10} /></span>
          </button>
          {tradeoffOpen && (
            <div className="comp-section-body">
              {tradeoffs.a.length > 0 && (
                <div className="comp-tradeoff-group">
                  <div className="comp-tg-header a">
                    <span className="comp-tg-dot a" />
                    <span>{nameA || 'Primary'} strengths:</span>
                  </div>
                  {tradeoffs.a.map((t, i) => (
                    <div key={i} className="comp-tg-item">· {t}</div>
                  ))}
                </div>
              )}
              {tradeoffs.b.length > 0 && (
                <div className="comp-tradeoff-group">
                  <div className="comp-tg-header b">
                    <span className="comp-tg-dot b" />
                    <span>{nameB || 'Compare'} strengths:</span>
                  </div>
                  {tradeoffs.b.map((t, i) => (
                    <div key={i} className="comp-tg-item">· {t}</div>
                  ))}
                </div>
              )}
              {/* Crossover insight */}
              {crossover?.crossover && (
                <div className="comp-crossover-insight">
                  <span className="comp-ci-icon">⚡</span>
                  <span>
                    Crossover at <strong>{crossover.crossover}A</strong> —{' '}
                    {crossover.points[0].lossA < crossover.points[0].lossB
                      ? `${nameA || 'A'} wins below, ${nameB || 'B'} wins above`
                      : `${nameB || 'B'} wins below, ${nameA || 'A'} wins above`
                    }
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Crossover chart ─────────────────────────────────── */}
      {crossover && (
        <div className="comp-section">
          <button className={`comp-section-trigger ${chartOpen ? 'open' : ''}`} onClick={() => setChartOpen(!chartOpen)}>
            <BarChart3 size={11} />
            <span>Loss vs Current</span>
            <span className="chevron"><ChevronDown size={10} /></span>
          </button>
          {chartOpen && (
            <div className="comp-chart-body">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={crossover.points} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-1)" />
                  <XAxis
                    dataKey="current"
                    tick={{ fontSize: 9, fill: 'var(--txt-3)' }}
                    label={{ value: 'Phase Current (A)', position: 'insideBottom', offset: -2, fontSize: 9, fill: 'var(--txt-3)' }}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: 'var(--txt-3)' }}
                    label={{ value: 'Loss/FET (W)', angle: -90, position: 'insideLeft', offset: 20, fontSize: 9, fill: 'var(--txt-3)' }}
                  />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-0)', border: '1px solid var(--border-2)', borderRadius: 6, fontSize: 10 }}
                    labelStyle={{ color: 'var(--txt-2)', fontSize: 10 }}
                    formatter={(val, name) => [`${val.toFixed(3)} W`, name]}
                    labelFormatter={l => `${l} A`}
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line
                    type="monotone"
                    dataKey="lossA"
                    name={nameA || 'Primary'}
                    stroke="#ff4444"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="lossB"
                    name={nameB || 'Compare'}
                    stroke="#ff8844"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                  {crossover.crossover && (
                    <ReferenceLine
                      x={crossover.crossover}
                      stroke="var(--cyan)"
                      strokeDasharray="4 4"
                      strokeWidth={1}
                      label={{
                        value: `${crossover.crossover}A`,
                        position: 'top',
                        fill: 'var(--cyan)',
                        fontSize: 9,
                      }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* ── Passives impact diff ────────────────────────────── */}
      {passivesDiff.some(d => d.changed) && (
        <div className="comp-section">
          <button className={`comp-section-trigger ${passivesOpen ? 'open' : ''}`} onClick={() => setPassivesOpen(!passivesOpen)}>
            <Wrench size={11} />
            <span>Passive Component Impact</span>
            <span className="chevron"><ChevronDown size={10} /></span>
          </button>
          {passivesOpen && (
            <div className="comp-section-body">
              <div className="comp-passives-header">
                <span className="comp-ph-label">Component</span>
                <span className="comp-ph-val">{nameA || 'A'}</span>
                <span className="comp-ph-val">{nameB || 'B'}</span>
                <span className="comp-ph-delta">Change</span>
              </div>
              {passivesDiff.map(d => (
                <div key={d.label} className={`comp-passives-row ${d.changed ? 'changed' : ''}`}>
                  <span className="comp-pr-label">{d.label}</span>
                  <span className="comp-pr-val">
                    {d.valA != null ? `${fmtNum(d.valA, d.dec)} ${d.unit}` : '—'}
                  </span>
                  <span className="comp-pr-val">
                    {d.valB != null ? `${fmtNum(d.valB, d.dec)} ${d.unit}` : '—'}
                  </span>
                  <span className={`comp-pr-delta ${!d.changed ? 'same' : ''}`}>
                    {!d.changed ? (
                      <><Minus size={9} /> same</>
                    ) : d.delta != null ? (
                      <>
                        {d.delta > 0 ? <ArrowUpRight size={9} /> : <ArrowDownRight size={9} />}
                        {Math.abs(d.delta).toFixed(0)}%
                      </>
                    ) : 'new'}
                  </span>
                </div>
              ))}
              {/* BOM summary */}
              {(() => {
                const changedCount = passivesDiff.filter(d => d.changed).length
                return changedCount > 0 ? (
                  <div className="comp-bom-note">
                    {changedCount} component{changedCount > 1 ? 's' : ''} differ{changedCount === 1 ? 's' : ''} between MOSFETs — review BOM accordingly
                  </div>
                ) : null
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
