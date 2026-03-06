import React from 'react'
import { useProject } from '../context/ProjectContext.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'
import { fmtNum } from '../utils.js'

const OVERRIDE_FIELDS = [
  { key: 'gate_rise_time_ns', label: 'Gate Rise Time Target', unit: 'ns', default: 40, note: 'Affects Rg_on calc' },
  { key: 'delta_v_ripple', label: 'Max Voltage Ripple', unit: 'V', default: 2.0, note: 'For bulk cap size' },
  { key: 'bootstrap_droop_v', label: 'Max Bootstrap Droop', unit: 'V', default: 0.5, note: 'For C_boot size' },
  { key: 'stray_inductance_nh', label: 'PCB Stray Inductance', unit: 'nH', default: 10, note: 'Affects snubber calc' },
]

export default function PassivesPanel({ config }) {
  const { state, dispatch } = useProject()
  const C = state.project.calculations
  const ovr = state.project.blocks.passives.overrides || {}

  function setOvr(k, v) {
    dispatch({ type: 'SET_PASSIVES_OVERRIDE', payload: { key: k, value: parseFloat(v) || undefined } })
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0 }}>
      {/* ─── Left: Passives content ───────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, overflowY: 'auto', paddingRight: 4 }}>

        {/* Header */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${config.color}18`, border: `1px solid ${config.color}35`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>🔧</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>Passive Components</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
              Auto-calculated from MOSFET + Driver + System specs · Override design targets below
            </div>
          </div>
        </div>

        {/* Override inputs */}
        <div className="card">
          <div className="sec-head">⚙ Design Target Overrides</div>
          <div style={{ padding: '12px 14px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            {OVERRIDE_FIELDS.map(f => (
              <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt-2)' }}>
                  {f.label}
                  <span style={{ fontSize: 10, color: 'var(--txt-3)', fontWeight: 400, marginLeft: 4 }}>[{f.unit}]</span>
                </label>
                <input
                  type="number" step="any"
                  className="inp inp-mono inp-sm"
                  value={ovr[f.key] ?? f.default}
                  onChange={e => setOvr(f.key, e.target.value)}
                />
                <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>{f.note}</span>
              </div>
            ))}
          </div>
        </div>

        {C ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {/* ── Gate Resistors ── */}
            <CompCard title="Gate Resistors" icon="⚡" color="#bb86fc">
              <Row label="Rg_on (Turn-ON)" val={`${C.gate_resistors?.rg_on_recommended_ohm} Ω`} note="E24 standard" color="#bb86fc" />
              <Row label="Rg_off (Turn-OFF)" val={`${C.gate_resistors?.rg_off_recommended_ohm} Ω`} note="+ BAT54 antiparallel" color="#bb86fc" />
              <Row label="Rg_boot (Bootstrap)" val={`${C.gate_resistors?.rg_bootstrap_ohm} Ω`} note="10Ω std" color="#bb86fc" />
              <Row label="Gate rise time" val={`${C.gate_resistors?.gate_rise_time_ns} ns`} note="Achieved" color="#bb86fc" />
              <Row label="Gate fall time" val={`${C.gate_resistors?.gate_fall_time_ns} ns`} note="Achieved" color="#bb86fc" />
              <Row label="dV/dt" val={`${C.gate_resistors?.dv_dt_v_per_us} V/µs`} note="" color="#bb86fc" />
              <Row label="Resistor rating" val={C.gate_resistors?.gate_resistor_rating} note="" color="#bb86fc" />
              <Note>{C.gate_resistors?.notes?.rg_off_note}</Note>
            </CompCard>

            {/* ── Bus Capacitors ── */}
            <CompCard title="Input Bus Capacitors" icon="🔋" color="#1e90ff">
              <SectionLabel>Bulk Electrolytic</SectionLabel>
              <Row label="Value" val={`${C.input_capacitors?.c_per_bulk_cap_uf} µF / 100V`} note={`×${C.input_capacitors?.n_bulk_caps}`} color="#1e90ff" />
              <Row label="Total C" val={`${C.input_capacitors?.c_total_uf} µF`} note="" color="#1e90ff" />
              <Row label="Ripple current" val={`${C.input_capacitors?.i_ripple_rms_a} A RMS`} note="Total" color="#1e90ff" />
              <Row label="Per-cap ripple" val={`${C.input_capacitors?.i_ripple_per_cap_a} A`} note="Each cap" color="#1e90ff" />
              <Row label="ESR budget/cap" val={`${C.input_capacitors?.esr_budget_per_cap_mohm} mΩ`} note="Max" color="#1e90ff" />
              <Row label="Voltage ripple" val={`${C.input_capacitors?.v_ripple_actual_v} V`} note="Actual" color="#1e90ff" />
              <SectionLabel>Film + MLCC</SectionLabel>
              <Row label="Film cap" val={`${C.input_capacitors?.c_film_uf} µF / 100V`} note={`×${C.input_capacitors?.c_film_qty}`} color="#1e90ff" />
              <Row label="MLCC decoup." val={`${C.input_capacitors?.c_mlcc_nf} nF / 100V ${C.input_capacitors?.c_mlcc_dielectric}`} note={`×${C.input_capacitors?.c_mlcc_qty}`} color="#1e90ff" />
              <Row label="Recommended" val={C.input_capacitors?.recommended_bulk_part} note="" color="#1e90ff" />
            </CompCard>

            {/* ── Bootstrap ── */}
            <CompCard title="Bootstrap Circuit" icon="🔄" color="#00d4e8">
              <Row label="C_boot required" val={`${C.bootstrap_cap?.c_boot_calculated_nf} nF`} note="Calculated" color="#00d4e8" />
              <Row label="C_boot standard" val={`${C.bootstrap_cap?.c_boot_recommended_nf} nF / ${C.bootstrap_cap?.c_boot_v_rating_v}V`} note={`×${C.bootstrap_cap?.c_boot_qty} ${C.bootstrap_cap?.c_boot_dielectric}`} color="#00d4e8" />
              <Row label="Bootstrap diode" val={C.bootstrap_cap?.bootstrap_diode} note="" color="#00d4e8" />
              <Row label="Series R" val={`${C.bootstrap_cap?.r_boot_series_ohm} Ω`} note="Charge limiter" color="#00d4e8" />
              <Row label="V_bootstrap" val={`${C.bootstrap_cap?.v_bootstrap_v} V`} note="" color="#00d4e8" />
              <Row label="Min HS on-time" val={`${C.bootstrap_cap?.min_hs_on_time_ns} ns`} note="Bootstrap refresh" color="#00d4e8" />
              <Row label="Hold time" val={`${C.bootstrap_cap?.bootstrap_hold_time_ms} ms`} note="Before droop" color="#00d4e8" />
              <Note>{C.bootstrap_cap?.notes?.['100pct_duty']}</Note>
            </CompCard>

            {/* ── Shunt Resistors ── */}
            <CompCard title="Current Shunts" icon="📏" color="#ffab00">
              <SectionLabel>Single Shunt Mode</SectionLabel>
              <Row label="Shunt value" val={`${C.shunt_resistors?.single_shunt?.value_mohm} mΩ`} note={C.shunt_resistors?.single_shunt?.location} color="#ffab00" />
              <Row label="V_shunt @ Imax" val={`${C.shunt_resistors?.single_shunt?.v_shunt_mv} mV`} note="" color="#ffab00" />
              <Row label="V_ADC" val={`${C.shunt_resistors?.single_shunt?.v_adc_v} V`} note={`Gain ×${C.shunt_resistors?.csa_gain}`} color="#ffab00" />
              <Row label="ADC bits used" val={`${C.shunt_resistors?.single_shunt?.adc_bits_used}`} note="of 12" color="#ffab00" />
              <Row label="Power (RMS)" val={`${C.shunt_resistors?.single_shunt?.power_rms_w} W`} note="" color="#ffab00" />
              <SectionLabel>3-Phase Shunt Mode</SectionLabel>
              <Row label="Shunt value" val={`${C.shunt_resistors?.three_shunt?.value_mohm} mΩ × 3`} note={C.shunt_resistors?.three_shunt?.location} color="#ffab00" />
              <Row label="V_shunt @ Imax" val={`${C.shunt_resistors?.three_shunt?.v_shunt_mv} mV`} note="" color="#ffab00" />
              <Row label="Total power" val={`${C.shunt_resistors?.three_shunt?.total_3_shunt_power_w} W`} note="All 3 phases" color="#ffab00" />
              <Row label="Recommended" val={C.shunt_resistors?.single_shunt?.recommended} note="" color="#ffab00" />
              <Note>{C.shunt_resistors?.notes?.kelvin}</Note>
            </CompCard>

            {/* ── RC Snubber ── */}
            <CompCard title="RC Snubbers (D-S)" icon="🌩" color="#ff4444">
              <Row label="PCB stray L" val={`${C.snubber?.stray_inductance_nh} nH`} note="Assumed" color="#ff4444" />
              <Row label="Resonant freq" val={`${C.snubber?.resonant_freq_mhz} MHz`} note="" color="#ff4444" />
              <Row label="V overshoot est" val={`${C.snubber?.voltage_overshoot_v} V`} note="" color="#ff4444" warn={20} />
              <Row label="V_sw peak" val={`${C.snubber?.v_sw_peak_v} V`} note="" color="#ff4444" />
              <Row label="Rs (recommended)" val={`${C.snubber?.rs_recommended_ohm} Ω`} note="0402, 0.1W" color="#ff4444" />
              <Row label="Cs (recommended)" val={C.snubber?.cs_recommended_label} note={`×6 (1 per FET)`} color="#ff4444" />
              <Row label="Snubber power" val={`${C.snubber?.p_total_6_snubbers_w} W`} note="Total 6 snubbers" color="#ff4444" />
              <Note>{C.snubber?.notes?.reduce_stray}</Note>
            </CompCard>

            {/* ── Protection Dividers ── */}
            <CompCard title="Protection Circuits" icon="🛡️" color="#00e676">
              <SectionLabel>OVP — Over Voltage</SectionLabel>
              <Row label="Trip voltage" val={`${C.protection_dividers?.ovp?.trip_voltage_v} V`} note="" color="#00e676" />
              <Row label="R1" val={`${C.protection_dividers?.ovp?.r1_kohm} kΩ`} note="Fixed" color="#00e676" />
              <Row label="R2" val={`${C.protection_dividers?.ovp?.r2_standard_kohm} kΩ`} note="E24 std" color="#00e676" />
              <Row label="Actual trip" val={`${C.protection_dividers?.ovp?.actual_trip_v} V`} note="" color="#00e676" />
              <SectionLabel>UVP — Under Voltage</SectionLabel>
              <Row label="Trip voltage" val={`${C.protection_dividers?.uvp?.trip_voltage_v} V`} note="75% Vnom" color="#00e676" />
              <Row label="Hysteresis" val={`${C.protection_dividers?.uvp?.hysteresis_voltage_v} V`} note="" color="#00e676" />
              <Row label="R2" val={`${C.protection_dividers?.uvp?.r2_standard_kohm} kΩ`} note="" color="#00e676" />
              <SectionLabel>OTP — Over Temperature</SectionLabel>
              <Row label="NTC value" val={`${C.protection_dividers?.otp?.ntc_value_at_25c_kohm} kΩ`} note="@25°C B3950" color="#00e676" />
              <Row label="R_pullup" val={`${C.protection_dividers?.otp?.r_pullup_kohm} kΩ`} note="" color="#00e676" />
              <Row label="V @ 80°C" val={`${C.protection_dividers?.otp?.v_ntc_at_80c_v} V`} note="Warning thresh" color="#00e676" />
              <Row label="V @ 100°C" val={`${C.protection_dividers?.otp?.v_ntc_at_100c_v} V`} note="Shutdown thresh" color="#00e676" />
              <Row label="TVS diode" val={C.protection_dividers?.tvs?.part} note={`${C.protection_dividers?.tvs?.clamping_v}V/${C.protection_dividers?.tvs?.power_rating_w}W ×${C.protection_dividers?.tvs?.qty}`} color="#00e676" />
            </CompCard>

            {/* ── Power Supply Bypassing ── */}
            <CompCard title="Power Supply Bypass" icon="🔌" color="#1e90ff">
              {C.power_supply_bypass && Object.entries(C.power_supply_bypass).filter(([k]) => k !== 'notes').map(([k, v]) => (
                <React.Fragment key={k}>
                  <SectionLabel>{k.replace(/_/g, ' ').toUpperCase()}</SectionLabel>
                  {'bulk_cap_uf' in v && <Row label="Bulk cap" val={`${v.bulk_cap_uf} µF / ${v.bulk_v_rating || 25}V`} note="" color="#1e90ff" />}
                  {'bypass_cap_nf' in v && <Row label="Bypass cap" val={`${v.bypass_cap_nf} nF × ${v.bypass_qty}`} note="" color="#1e90ff" />}
                  {'cap_nf' in v && <Row label="Cap" val={`${v.cap_nf} nF`} note={v.note} color="#1e90ff" />}
                </React.Fragment>
              ))}
            </CompCard>

            {/* ── EMI Filter ── */}
            <CompCard title="EMI Filter" icon="📻" color="#bb86fc">
              <Row label="CM choke" val={`${C.emi_filter?.cm_choke_uh} µH`} note="Common mode" color="#bb86fc" />
              <Row label="Choke current" val={`${C.emi_filter?.cm_choke_current_a} A`} note="Rated" color="#bb86fc" />
              <Row label="Choke R_dc" val={`${C.emi_filter?.cm_choke_r_dc_mohm} mΩ`} note="" color="#bb86fc" />
              <Row label="Choke power" val={`${C.emi_filter?.cm_choke_power_w} W`} note="" color="#bb86fc" />
              <Row label="X capacitor" val={`${C.emi_filter?.x_cap_nf} nF / ${C.emi_filter?.x_cap_v_rating}V`} note="Differential" color="#bb86fc" />
              <Row label="Y capacitor" val={`${C.emi_filter?.y_cap_nf} nF / ${C.emi_filter?.y_cap_v_rating}V`} note="Common mode to GND" color="#bb86fc" />
              <Row label="Recommended" val={C.emi_filter?.cm_choke_part} note="" color="#bb86fc" />
            </CompCard>

            {/* ── PCB Layer Stack ── */}
            <CompCard title="PCB Layer Stack (6L)" icon="🖥️" color="#00d4e8" fullWidth>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginBottom: 8 }}>
                {C.pcb_guidelines?.layer_stack?.map(l => (
                  <div key={l.layer} style={{ background: 'var(--bg-4)', borderRadius: 5, padding: '5px 8px', fontSize: 11 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#00d4e8', fontSize: 10 }}>{l.layer}</div>
                    <div style={{ color: 'var(--txt-3)', fontSize: 10 }}>{l.copper_oz}oz — {l.purpose}</div>
                  </div>
                ))}
              </div>
              <Row label="Power trace width" val={`${C.pcb_guidelines?.power_trace_w_mm} mm`} note="80A, 3oz Cu, 30°C rise" color="#00d4e8" />
              <Row label="Gate trace width" val={`${C.pcb_guidelines?.gate_trace_w_mm} mm`} note="" color="#00d4e8" />
              <Row label="Min clearance" val={`${C.pcb_guidelines?.power_clearance_mm} mm`} note="Power to signal" color="#00d4e8" />
              <Row label="Bridge loop L" val={`< ${C.pcb_guidelines?.half_bridge_loop_nh} nH`} note="Target max" color="#00d4e8" />
            </CompCard>
          </div>
        ) : (
          <div className="card" style={{ padding: '48px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🧮</div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--txt-1)', marginBottom: 6 }}>
              No calculations yet
            </div>
            <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
              Upload the MOSFET datasheet, then click "Run All Calculations"
            </div>
          </div>
        )}
      </div>

      {/* ─── Right: Calculations panel ─── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <CalculationsPanel />
      </div>
    </div>
  )
}

function CompCard({ title, icon, color, children, fullWidth }) {
  return (
    <div className="comp-card" style={fullWidth ? { gridColumn: '1 / -1' } : {}}>
      <div className="comp-card-head" style={{ color }}>
        <span>{icon}</span>
        <span>{title}</span>
      </div>
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {children}
      </div>
    </div>
  )
}

function Row({ label, val, note, color, warn }) {
  const v = val || '—'
  const isWarn = warn && parseFloat(val) >= warn
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border-1)', fontSize: 12 }}>
      <div>
        <span style={{ color: 'var(--txt-2)' }}>{label}</span>
        {note && <span style={{ fontSize: 10, color: 'var(--txt-3)', marginLeft: 5 }}>— {note}</span>}
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11,
        color: isWarn ? 'var(--red)' : color,
        background: isWarn ? 'rgba(255,68,68,.1)' : `${color}12`,
        padding: '1px 7px', borderRadius: 4, whiteSpace: 'nowrap', flexShrink: 0,
      }}>
        {v}
      </span>
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase',
      color: 'var(--txt-3)', marginTop: 6, marginBottom: 2, padding: '2px 0',
      borderBottom: '1px solid var(--border-1)',
    }}>
      {children}
    </div>
  )
}

function Note({ children }) {
  if (!children) return null
  return (
    <div className="note-box blue" style={{ marginTop: 6, fontSize: 10 }}>· {children}</div>
  )
}
