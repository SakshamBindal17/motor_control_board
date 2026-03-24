import React, { useMemo } from 'react'
import { useProject, getSelectedValue } from '../context/ProjectContext.jsx'
import {
  METRIC_DIRS, VERDICT_METRICS, MOSFET_DEPENDENT_SECTIONS,
  pctDiff, getWinner, generateTradeoffs, computeCrossover, computePassivesDiff,
} from './ComparisonCard.jsx'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ResponsiveContainer,
} from 'recharts'
import { fmtNum } from '../utils.js'

/* ═══════════════════════════════════════════════════════════════════════════
   KEY DATASHEET PARAMS for side-by-side table
   ═══════════════════════════════════════════════════════════════════════════ */

const DATASHEET_PARAMS = [
  { id: 'vds_max', label: 'Vds max', unit: 'V', dir: 'higher' },
  { id: 'id_cont', label: 'Id continuous', unit: 'A', dir: 'higher' },
  { id: 'rds_on', label: 'Rds(on)', unit: 'mΩ', dir: 'lower' },
  { id: 'qg', label: 'Qg total', unit: 'nC', dir: 'lower' },
  { id: 'qgd', label: 'Qgd', unit: 'nC', dir: 'lower' },
  { id: 'qgs', label: 'Qgs', unit: 'nC', dir: 'lower' },
  { id: 'ciss', label: 'Ciss', unit: 'pF', dir: 'lower' },
  { id: 'coss', label: 'Coss', unit: 'pF', dir: 'lower' },
  { id: 'crss', label: 'Crss', unit: 'pF', dir: 'lower' },
  { id: 'td_on', label: 'td(on)', unit: 'ns', dir: 'lower' },
  { id: 'tr', label: 'Rise time', unit: 'ns', dir: 'lower' },
  { id: 'td_off', label: 'td(off)', unit: 'ns', dir: 'lower' },
  { id: 'tf', label: 'Fall time', unit: 'ns', dir: 'lower' },
  { id: 'rth_jc', label: 'Rth j-c', unit: '°C/W', dir: 'lower' },
  { id: 'rth_ja', label: 'Rth j-a', unit: '°C/W', dir: 'lower' },
  { id: 'vgs_th', label: 'Vgs(th)', unit: 'V', dir: 'info' },
  { id: 'vgs_max', label: 'Vgs max', unit: 'V', dir: 'info' },
  { id: 'qoss', label: 'Qoss', unit: 'nC', dir: 'lower' },
]

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */

export default function ComparisonPanel() {
  const { state, dispatch } = useProject()
  const { project } = state
  const blocks = project.blocks
  const resultsA = project.calculations
  const resultsB = project.comparison_results

  const mosfetA = blocks.mosfet
  const mosfetB = blocks.mosfet_b

  const nameA = mosfetA?.raw_data?.device_info?.part_number || mosfetA?.filename || 'Primary'
  const nameB = mosfetB?.raw_data?.device_info?.part_number || mosfetB?.filename || 'Compare'

  const iMax = project.system_specs?.max_phase_current || 30

  // Is data ready?
  const hasMosfetB = mosfetB && mosfetB.status === 'done'
  const hasResults = !!(resultsA && resultsB)

  // ── Computed Data ────────────────────────────────────────────────────────

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

  const winsA = verdict.filter(v => v.winner === 'a').length
  const winsB = verdict.filter(v => v.winner === 'b').length
  const ties = verdict.filter(v => v.winner === 'tie').length
  const overallWinner = winsA > winsB ? 'a' : winsB > winsA ? 'b' : 'tie'

  const tradeoffs = useMemo(() => generateTradeoffs(resultsA, resultsB), [resultsA, resultsB])
  const crossover = useMemo(() => computeCrossover(resultsA, resultsB, iMax), [resultsA, resultsB, iMax])

  // Loss breakdown data for grouped bar chart
  const lossBarData = useMemo(() => {
    if (!resultsA?.mosfet_losses || !resultsB?.mosfet_losses) return null
    const la = resultsA.mosfet_losses, lb = resultsB.mosfet_losses
    return [
      { name: 'Conduction', A: +(la.conduction_loss_per_fet_w || 0).toFixed(3), B: +(lb.conduction_loss_per_fet_w || 0).toFixed(3) },
      { name: 'Switching', A: +(la.switching_loss_per_fet_w || 0).toFixed(3), B: +(lb.switching_loss_per_fet_w || 0).toFixed(3) },
      { name: 'Recovery', A: +(la.recovery_loss_per_fet_w || 0).toFixed(3), B: +(lb.recovery_loss_per_fet_w || 0).toFixed(3) },
      { name: 'Gate', A: +(la.gate_charge_loss_per_fet_w || 0).toFixed(3), B: +(lb.gate_charge_loss_per_fet_w || 0).toFixed(3) },
      { name: 'Coss', A: +(la.coss_loss_per_fet_w || 0).toFixed(3), B: +(lb.coss_loss_per_fet_w || 0).toFixed(3) },
      { name: 'Total', A: +(la.total_loss_per_fet_w || 0).toFixed(3), B: +(lb.total_loss_per_fet_w || 0).toFixed(3) },
    ]
  }, [resultsA, resultsB])

  // Radar chart data (normalized 0-100)
  const radarData = useMemo(() => {
    if (!resultsA || !resultsB) return null
    const norm = (val, min, max) => {
      if (val == null) return 0
      return Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100))
    }
    // Inverted norms for "lower is better" metrics
    const invNorm = (val, min, max) => 100 - norm(val, min, max)

    const effA = resultsA.mosfet_losses?.efficiency_mosfet_pct || 90
    const effB = resultsB.mosfet_losses?.efficiency_mosfet_pct || 90
    const tmA = resultsA.thermal?.thermal_margin_c || 0
    const tmB = resultsB.thermal?.thermal_margin_c || 0
    const trA = resultsA.gate_resistors?.gate_rise_time_ns || 100
    const trB = resultsB.gate_resistors?.gate_rise_time_ns || 100
    const dvA = resultsA.gate_resistors?.dv_dt_v_per_us || 1000
    const dvB = resultsB.gate_resistors?.dv_dt_v_per_us || 1000
    const vmA = resultsA.mosfet_rating_check?.voltage_margin_pct || 0
    const vmB = resultsB.mosfet_rating_check?.voltage_margin_pct || 0
    const imA = resultsA.mosfet_rating_check?.current_margin_pct || 0
    const imB = resultsB.mosfet_rating_check?.current_margin_pct || 0

    return [
      { axis: 'Efficiency', A: norm(effA, 90, 100), B: norm(effB, 90, 100) },
      { axis: 'Thermal Margin', A: norm(tmA, 0, 100), B: norm(tmB, 0, 100) },
      { axis: 'Switching Speed', A: invNorm(trA, 0, 200), B: invNorm(trB, 0, 200) },
      { axis: 'Low EMI', A: invNorm(dvA, 0, 5000), B: invNorm(dvB, 0, 5000) },
      { axis: 'V Headroom', A: norm(vmA, 0, 80), B: norm(vmB, 0, 80) },
      { axis: 'I Headroom', A: norm(imA, 0, 100), B: norm(imB, 0, 100) },
    ]
  }, [resultsA, resultsB])

  // Datasheet params side-by-side
  const paramsTable = useMemo(() => {
    if (!mosfetA?.raw_data || !mosfetB?.raw_data) return []
    return DATASHEET_PARAMS.map(p => {
      const valA = getSelectedValue(mosfetA, p.id)
      const valB = getSelectedValue(mosfetB, p.id)
      const winner = (valA != null && valB != null) ? getWinner(valA, valB, p.dir) : 'tie'
      return { ...p, valA, valB, winner }
    }).filter(p => p.valA != null || p.valB != null)
  }, [mosfetA, mosfetB])

  // ── EMPTY STATES ─────────────────────────────────────────────────────────

  if (!hasMosfetB) {
    return (
      <div className="cmp-panel">
        <div className="cmp-empty">
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>⚖️</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e0e4ea', marginBottom: 8 }}>
            No Comparison MOSFET
          </div>
          <div style={{ fontSize: 12, color: '#8090a0', maxWidth: 360, lineHeight: 1.7, marginBottom: 16 }}>
            Go to the <strong>MOSFETs</strong> tab and click <strong>+Compare</strong> to upload
            a second MOSFET datasheet for head-to-head comparison.
          </div>
          <button
            className="btn btn-primary"
            onClick={() => dispatch({ type: 'SET_ACTIVE_BLOCK', payload: 'mosfet' })}
          >
            Go to MOSFETs →
          </button>
        </div>
      </div>
    )
  }

  if (!hasResults) {
    return (
      <div className="cmp-panel">
        <div className="cmp-empty">
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>📊</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e0e4ea', marginBottom: 8 }}>
            Waiting for Calculations
          </div>
          <div style={{ fontSize: 12, color: '#8090a0', maxWidth: 360, lineHeight: 1.7, marginBottom: 16 }}>
            Both MOSFET datasheets are uploaded. Click <strong>Run All Calculations</strong> in
            the <strong>Passives</strong> tab to generate comparison results.
          </div>
          <button
            className="btn btn-primary"
            onClick={() => dispatch({ type: 'SET_ACTIVE_BLOCK', payload: 'passives' })}
          >
            Go to Passives →
          </button>
        </div>
      </div>
    )
  }

  // ── FULL COMPARISON UI ──────────────────────────────────────────────────

  const winnerName = overallWinner === 'a' ? nameA : overallWinner === 'b' ? nameB : 'Tie'
  const recommendation = overallWinner === 'tie'
    ? 'Both MOSFETs perform similarly — choose based on cost, availability, or package preference.'
    : `${winnerName} wins ${Math.max(winsA, winsB)} of ${verdict.length} key metrics.`

  return (
    <div className="cmp-panel">
      {/* ══ Section 1: Header ═══════════════════════════════════════════ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 22 }}>⚖️</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e8eaed' }}>MOSFET Comparison</div>
          <div style={{ fontSize: 11, color: '#8090a0' }}>Head-to-head analysis of extracted datasheet parameters and calculated results</div>
        </div>
      </div>

      <div className="cmp-header">
        <MosfetCard name={nameA} data={mosfetA} color="#ff4444" label="A" />
        <div className="cmp-vs-divider">
          <span className="cmp-vs-text">VS</span>
        </div>
        <MosfetCard name={nameB} data={mosfetB} color="#ff8844" label="B" />
      </div>

      {/* ══ Section 2: Verdict Banner ══════════════════════════════════ */}
      <div className="cmp-verdict">
        <div className="cmp-verdict-bar">
          <div className="cmp-verdict-segment cmp-a" style={{ flex: winsA || 0.5 }}>
            <span className="cmp-verdict-count">{winsA}</span>
            <span className="cmp-verdict-name">{nameA}</span>
          </div>
          <div className="cmp-verdict-segment cmp-tie" style={{ flex: ties || 0.5 }}>
            <span className="cmp-verdict-count">{ties}</span>
            <span className="cmp-verdict-name">Tie</span>
          </div>
          <div className="cmp-verdict-segment cmp-b" style={{ flex: winsB || 0.5 }}>
            <span className="cmp-verdict-count">{winsB}</span>
            <span className="cmp-verdict-name">{nameB}</span>
          </div>
        </div>
        <div className="cmp-verdict-label">
          {overallWinner !== 'tie' && (
            <span className="cmp-verdict-winner" style={{ color: overallWinner === 'a' ? '#ff4444' : '#ff8844' }}>
              🏆 {winnerName}
            </span>
          )}
          <span className="cmp-verdict-rec">{recommendation}</span>
        </div>
        {/* Tradeoff insights */}
        {(tradeoffs.a.length > 0 || tradeoffs.b.length > 0) && (
          <div className="cmp-tradeoff-row">
            {tradeoffs.a.length > 0 && (
              <div className="cmp-tradeoff-col">
                <div className="cmp-tradeoff-title" style={{ color: '#ff4444' }}>✓ {nameA} strengths</div>
                {tradeoffs.a.map((t, i) => <div key={i} className="cmp-tradeoff-item">· {t}</div>)}
              </div>
            )}
            {tradeoffs.b.length > 0 && (
              <div className="cmp-tradeoff-col">
                <div className="cmp-tradeoff-title" style={{ color: '#ff8844' }}>✓ {nameB} strengths</div>
                {tradeoffs.b.map((t, i) => <div key={i} className="cmp-tradeoff-item">· {t}</div>)}
              </div>
            )}
          </div>
        )}
        {crossover?.crossover && (
          <div className="cmp-crossover-badge">
            ⚡ Crossover at <strong>{crossover.crossover}A</strong> —{' '}
            {crossover.points[0].lossA < crossover.points[0].lossB
              ? `${nameA} wins below, ${nameB} wins above`
              : `${nameB} wins below, ${nameA} wins above`}
          </div>
        )}
      </div>

      {/* ══ Section 3: Key Metrics Grid ═══════════════════════════════ */}
      <div className="cmp-section-title">Key Metrics Comparison</div>
      <div className="cmp-grid">
        {verdict.map(v => (
          <div key={v.key} className={`cmp-metric ${v.winner !== 'tie' ? `cmp-metric--${v.winner}` : ''}`}>
            <div className="cmp-metric-label">{v.label}</div>
            <div className="cmp-metric-row">
              <div className={`cmp-metric-val ${v.winner === 'a' ? 'winner' : ''}`}>
                <span className="cmp-metric-tag" style={{ background: '#ff444420', color: '#ff6666' }}>A</span>
                {fmtNum(v.valA, v.dec)} {v.unit}
                {v.winner === 'a' && <span className="cmp-metric-badge">✓</span>}
              </div>
              <div className={`cmp-metric-val ${v.winner === 'b' ? 'winner' : ''}`}>
                <span className="cmp-metric-tag" style={{ background: '#ff884420', color: '#ffaa66' }}>B</span>
                {fmtNum(v.valB, v.dec)} {v.unit}
                {v.winner === 'b' && <span className="cmp-metric-badge">✓</span>}
              </div>
            </div>
            <div className={`cmp-metric-delta ${v.winner === 'tie' ? 'neutral' : ''}`}>
              {v.winner === 'tie' ? '= Tied' : `Δ ${Math.abs(v.delta).toFixed(1)}%`}
            </div>
          </div>
        ))}
      </div>

      {/* ══ Section 4 & 5: Charts ═════════════════════════════════════ */}
      <div className="cmp-charts-row">
        {/* Loss Breakdown Bar Chart */}
        {lossBarData && (
          <div className="cmp-chart">
            <div className="cmp-section-title">Loss Breakdown (per FET)</div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={lossBarData} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#90a0b0' }} />
                <YAxis tick={{ fontSize: 10, fill: '#90a0b0' }} label={{ value: 'W', angle: -90, position: 'insideLeft', offset: 16, fontSize: 10, fill: '#90a0b0' }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 11, color: '#e8eaed' }}
                  itemStyle={{ color: '#e8eaed' }}
                  formatter={(val) => [`${val.toFixed(3)} W`]}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: '#c0c8d0' }} />
                <Bar dataKey="A" name={nameA} fill="#ff4444" radius={[3, 3, 0, 0]} />
                <Bar dataKey="B" name={nameB} fill="#ff8844" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Radar Chart */}
        {radarData && (
          <div className="cmp-chart">
            <div className="cmp-section-title">Performance Profile</div>
            <ResponsiveContainer width="100%" height={240}>
              <RadarChart cx="50%" cy="50%" outerRadius="72%" data={radarData}>
                <PolarGrid stroke="rgba(255,255,255,0.08)" />
                <PolarAngleAxis dataKey="axis" tick={{ fontSize: 9, fill: '#90a0b0' }} />
                <PolarRadiusAxis tick={false} domain={[0, 100]} axisLine={false} />
                <Radar name={nameA} dataKey="A" stroke="#ff4444" fill="#ff4444" fillOpacity={0.20} strokeWidth={2} />
                <Radar name={nameB} dataKey="B" stroke="#ff8844" fill="#ff8844" fillOpacity={0.20} strokeWidth={2} />
                <Legend wrapperStyle={{ fontSize: 10, color: '#c0c8d0' }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 11, color: '#e8eaed' }}
                  itemStyle={{ color: '#e8eaed' }}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ══ Section 6: Datasheet Params Table ═════════════════════════ */}
      {paramsTable.length > 0 && (
        <>
          <div className="cmp-section-title">Datasheet Parameters</div>
          <div className="cmp-params-table">
            <div className="cmp-pt-header">
              <span className="cmp-pt-label">Parameter</span>
              <span className="cmp-pt-val">
                <span className="cmp-pt-dot" style={{ background: '#ff4444' }} /> {nameA}
              </span>
              <span className="cmp-pt-val">
                <span className="cmp-pt-dot" style={{ background: '#ff8844' }} /> {nameB}
              </span>
              <span className="cmp-pt-winner">Winner</span>
            </div>
            {paramsTable.map((p, i) => (
              <div key={p.id} className={`cmp-pt-row ${i % 2 ? 'cmp-pt-row--alt' : ''}`}>
                <span className="cmp-pt-label">{p.label}</span>
                <span className={`cmp-pt-val ${p.winner === 'a' ? 'cmp-pt-winner-cell' : ''}`}>
                  {p.valA != null ? `${fmtNum(p.valA, 2)} ${p.unit}` : '—'}
                </span>
                <span className={`cmp-pt-val ${p.winner === 'b' ? 'cmp-pt-winner-cell' : ''}`}>
                  {p.valB != null ? `${fmtNum(p.valB, 2)} ${p.unit}` : '—'}
                </span>
                <span className="cmp-pt-winner">
                  {p.winner === 'a' ? <span style={{ color: '#ff6666' }}>◀ A</span>
                    : p.winner === 'b' ? <span style={{ color: '#ffaa66' }}>B ▶</span>
                    : <span style={{ color: '#556070' }}>—</span>}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}


/* ═══════════════════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════════════════ */

function MosfetCard({ name, data, color, label }) {
  const info = data?.raw_data?.device_info || {}
  const params = data?.raw_data?.parameters || []

  const getP = (id) => {
    const p = params.find(p => p.id === id)
    if (!p) return null
    const c = p.conditions?.[0]
    return c?.selected ?? c?.typ ?? c?.max ?? null
  }

  return (
    <div className="cmp-name-card" style={{ borderTopColor: color }}>
      <div className="cmp-name-badge" style={{ background: color + '25', color }}>{label}</div>
      <div className="cmp-name-part">{name}</div>
      <div className="cmp-name-mfg">{info.manufacturer || '—'}</div>
      <div className="cmp-name-specs">
        {[
          { l: 'Package', v: info.package },
          { l: 'Vds', v: getP('vds_max'), u: 'V' },
          { l: 'Id', v: getP('id_cont'), u: 'A' },
          { l: 'Rds(on)', v: getP('rds_on'), u: 'mΩ' },
        ].map(s => s.v != null ? (
          <div key={s.l} className="cmp-name-spec-row">
            <span className="cmp-ns-label">{s.l}</span>
            <span className="cmp-ns-value">{typeof s.v === 'number' ? fmtNum(s.v, 1) : s.v}{s.u || ''}</span>
          </div>
        ) : null)}
      </div>
    </div>
  )
}
