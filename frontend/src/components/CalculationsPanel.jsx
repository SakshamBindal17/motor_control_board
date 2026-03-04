import React, { useState } from 'react'
import { Zap, RefreshCw, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'
import { runCalculations } from '../api.js'
import { fmtNum, thresholdClass } from '../utils.js'

export default function CalculationsPanel() {
  const { state, dispatch } = useProject()
  const { project } = state
  const [loading, setLoading] = useState(false)
  const [open, setOpen]  = useState({ mosfet_losses: true, gate_resistors: true, thermal: true })

  function toggle(k) { setOpen(p => ({ ...p, [k]: !p[k] })) }

  async function calc() {
    if (project.blocks.mosfet.status !== 'done') {
      toast.error('Upload MOSFET datasheet first'); return
    }
    setLoading(true)
    toast.loading('Calculating…', { id: 'c' })
    try {
      const result = await runCalculations({
        system_specs:       project.system_specs,
        mosfet_params:      buildParamsDict(project.blocks.mosfet),
        driver_params:      buildParamsDict(project.blocks.driver),
        mcu_params:         buildParamsDict(project.blocks.mcu),
        motor_specs:        project.blocks.motor.specs || {},
        passives_overrides: project.blocks.passives.overrides || {},
      })
      dispatch({ type: 'SET_CALCULATIONS', payload: result })
      toast.success('Done!', { id: 'c' })
    } catch (e) {
      toast.error(e.message, { id: 'c' })
    } finally { setLoading(false) }
  }

  const C = project.calculations

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="sec-head">
        <Zap size={13} style={{ color: 'var(--amber)' }} />
        Calculations
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* System specs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 10px', background: 'var(--bg-3)', borderRadius: 7 }}>
          {[
            ['Bus', `${project.system_specs.bus_voltage}V / ${project.system_specs.peak_voltage}V pk`],
            ['Power', `${project.system_specs.power}W`],
            ['I_max', `${project.system_specs.max_phase_current}A`],
            ['fsw', `${project.system_specs.pwm_freq_hz/1000}kHz`],
          ].map(([l,v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: 'var(--txt-3)' }}>{l}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--txt-2)' }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Run button */}
        <button className="btn btn-primary" onClick={calc} disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
          {loading ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={13}/>}
          {loading ? 'Calculating…' : 'Run All Calculations'}
        </button>

        {/* Results sections */}
        {C && SECTIONS.map(sec => {
          const d = C[sec.key]
          if (!d) return null
          const isOpen = open[sec.key] !== false
          return (
            <div key={sec.key} style={{ border: '1px solid var(--border-1)', borderRadius: 7, overflow: 'hidden' }}>
              <button
                className={`collapsible-trigger ${isOpen ? 'open' : ''}`}
                onClick={() => toggle(sec.key)}
                style={{ borderRadius: 0 }}
              >
                <span>{sec.icon}</span>
                <span>{sec.label}</span>
                <span className="chevron"><ChevronDown size={11}/></span>
              </button>
              {isOpen && (
                <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {sec.rows.map(r => {
                    const v = d[r.key]
                    if (v === undefined || v === null) return null
                    const tc = r.warn ? thresholdClass(v, r.warn, r.danger) : ''
                    return (
                      <div key={r.key} className="calc-row">
                        <span className="label">{r.label}</span>
                        <span className={`value ${tc}`}>
                          {fmtNum(v, r.dec ?? 3)}{r.unit ? ` ${r.unit}` : ''}
                          {tc === 'danger' && <AlertTriangle size={9} style={{ marginLeft: 3 }}/>}
                        </span>
                      </div>
                    )
                  })}
                  {/* Notes */}
                  {d.notes && (
                    <div className="note-box blue" style={{ marginTop: 6 }}>
                      {Object.values(d.notes).slice(0, 3).map((n, i) => <div key={i}>· {n}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {!C && (
          <div style={{ textAlign: 'center', padding: '20px 10px', color: 'var(--txt-3)', fontSize: 12 }}>
            Upload MOSFET datasheet then click Run to see results
          </div>
        )}
      </div>
    </div>
  )
}

const SECTIONS = [
  {
    key: 'mosfet_losses', label: 'MOSFET Losses', icon: '🔥',
    rows: [
      { key: 'conduction_loss_per_fet_w',   label: 'Cond. Loss / FET',   unit: 'W',  dec: 3 },
      { key: 'switching_loss_per_fet_w',    label: 'SW Loss / FET',      unit: 'W',  dec: 3 },
      { key: 'recovery_loss_per_fet_w',     label: 'Recovery Loss / FET',unit: 'W',  dec: 3 },
      { key: 'total_loss_per_fet_w',        label: 'Total / FET',        unit: 'W',  dec: 3, warn: 8, danger: 15 },
      { key: 'total_all_6_fets_w',          label: 'Total (×6 FETs)',    unit: 'W',  dec: 1, warn: 40, danger: 60 },
      { key: 'efficiency_mosfet_pct',       label: 'Efficiency',         unit: '%',  dec: 2 },
    ],
  },
  {
    key: 'gate_resistors', label: 'Gate Drive', icon: '⚡',
    rows: [
      { key: 'rg_on_recommended_ohm',   label: 'Rg ON',       unit: 'Ω', dec: 2 },
      { key: 'rg_off_recommended_ohm',  label: 'Rg OFF',      unit: 'Ω', dec: 2 },
      { key: 'rg_bootstrap_ohm',        label: 'Rg Bootstrap',unit: 'Ω', dec: 0 },
      { key: 'gate_rise_time_ns',       label: 'Rise time',   unit: 'ns',dec: 1 },
      { key: 'gate_fall_time_ns',       label: 'Fall time',   unit: 'ns',dec: 1 },
      { key: 'dv_dt_v_per_us',          label: 'dV/dt',       unit: 'V/µs', dec: 1 },
    ],
  },
  {
    key: 'thermal', label: 'Thermal', icon: '🌡️',
    rows: [
      { key: 't_junction_est_c',    label: 'Tj estimated',  unit: '°C', dec: 1, warn: 130, danger: 155 },
      { key: 'tj_max_rated_c',      label: 'Tj max rated',  unit: '°C', dec: 0 },
      { key: 'thermal_margin_c',    label: 'Thermal margin',unit: '°C', dec: 1, warn: 30, danger: 0 },
      { key: 'p_per_fet_w',         label: 'P / FET',       unit: 'W',  dec: 3 },
      { key: 'copper_area_per_fet_mm2', label: 'Cu area / FET', unit: 'mm²', dec: 0 },
    ],
  },
  {
    key: 'input_capacitors', label: 'Bus Capacitors', icon: '🔋',
    rows: [
      { key: 'i_ripple_rms_a',         label: 'Ripple current', unit: 'A',  dec: 2 },
      { key: 'c_bulk_required_uf',      label: 'C required',     unit: 'µF', dec: 1 },
      { key: 'n_bulk_caps',             label: 'Cap count',      unit: 'pcs',dec: 0 },
      { key: 'c_total_uf',              label: 'C total',        unit: 'µF', dec: 0 },
      { key: 'v_ripple_actual_v',       label: 'Actual ripple',  unit: 'V',  dec: 3 },
      { key: 'esr_budget_per_cap_mohm', label: 'ESR/cap budget', unit: 'mΩ', dec: 1 },
    ],
  },
  {
    key: 'bootstrap_cap', label: 'Bootstrap', icon: '🔄',
    rows: [
      { key: 'c_boot_calculated_nf',   label: 'C_boot required', unit: 'nF', dec: 1 },
      { key: 'c_boot_recommended_nf',  label: 'C_boot standard', unit: 'nF', dec: 0 },
      { key: 'v_bootstrap_v',          label: 'V_bootstrap',     unit: 'V',  dec: 2 },
      { key: 'min_hs_on_time_ns',      label: 'Min on-time',     unit: 'ns', dec: 0 },
    ],
  },
  {
    key: 'dead_time', label: 'Dead Time', icon: '⏱️',
    rows: [
      { key: 'dt_minimum_ns',      label: 'Minimum DT',    unit: 'ns', dec: 0 },
      { key: 'dt_recommended_ns',  label: 'Recommended DT',unit: 'ns', dec: 0 },
      { key: 'dt_actual_ns',       label: 'Actual (MCU)',  unit: 'ns', dec: 0 },
      { key: 'dt_pct_of_period',   label: 'DT %',          unit: '%',  dec: 3 },
    ],
  },
  {
    key: 'snubber', label: 'RC Snubber', icon: '📡',
    rows: [
      { key: 'voltage_overshoot_v',   label: 'V overshoot',   unit: 'V',  dec: 1, warn: 10, danger: 20 },
      { key: 'v_sw_peak_v',           label: 'V_sw peak',     unit: 'V',  dec: 1, warn: this?.v_peak, danger: 80 },
      { key: 'rs_recommended_ohm',    label: 'Rs snubber',    unit: 'Ω',  dec: 0 },
      { key: 'cs_recommended_pf',     label: 'Cs snubber',    unit: 'pF', dec: 0 },
      { key: 'p_total_6_snubbers_w',  label: 'Snubber power', unit: 'W',  dec: 3 },
    ],
  },
]
