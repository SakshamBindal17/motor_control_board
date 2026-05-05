import React from 'react'
import { useProject } from '../context/ProjectContext.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'

export default function FeedbackPanel({ config }) {
  const { state } = useProject()
  const calc = state.project.calculations
  const sys  = state.project.system_specs

  const shunts = calc?.shunt_resistors
  const prot   = calc?.protection_dividers

  const secHead = {
    fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
    textTransform: 'uppercase', letterSpacing: '.06em',
    padding: '9px 14px 7px',
    borderBottom: '1px solid var(--border-1)',
    display: 'flex', alignItems: 'center', gap: 6,
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0 }}>

      {/* ── Left: content ─────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

        {/* Header card */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${config.color}18`, border: `1px solid ${config.color}35`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>🔄</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>
              Feedback Block — Sensing Chain &amp; Protection
            </div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>
              Connects MOSFETs → MCU. Current sensing, ADC chain, OCP/OVP/OTP protection.
            </div>
          </div>
        </div>

        {/* Signal chain */}
        <div className="card" style={{ padding: '12px 14px' }}>
          <div style={{ ...secHead, padding: '0 0 8px', border: 'none', marginBottom: 8 }}>
            📡 Sensing Signal Chain
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <ChainBlock color="#ef4444" label="Phase Current"  sub="MOSFET Source" />
            <Arrow />
            <ChainBlock color="#f59e0b" label="Shunt Resistor" sub={shunts ? `${shunts.single_shunt.value_mohm} mΩ` : 'R_shunt'} />
            <Arrow />
            <ChainBlock color="#a855f7" label="CSA Amplifier"  sub={shunts ? `Gain ×${shunts.csa_gain}` : 'In Driver IC'} />
            <Arrow />
            <ChainBlock color="#3b82f6" label="ADC Input"      sub={shunts ? `${shunts.single_shunt.v_adc_v}V @ Imax` : 'MCU ADC'} />
            <Arrow />
            <ChainBlock color="#22c55e" label="MCU FOC"        sub="Clarke/Park Transform" />
          </div>
        </div>

        {/* 2×2 grid */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, minHeight: 0 }}>

          {/* Current Sensing */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={secHead}><span>📏</span> Current Sensing</div>
            <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 11 }}>
              <ModeRow mode="Single Shunt (Low-Side)" color="#3b82f6"
                items={shunts?.topology_mode === 'single' ? [
                  `Rshunt = ${shunts.single_shunt.value_mohm} mΩ`,
                  `V_shunt @ Imax = ${shunts.single_shunt.v_shunt_mv} mV`,
                  `V_ADC = ${shunts.single_shunt.v_adc_v} V`,
                  `Location: ${shunts.single_shunt.location}`,
                ] : ['Waiting for system parameters...']}
              />
              <div style={{ height: 1, background: 'var(--border-1)' }} />
              <ModeRow mode="3-Phase Shunts" color="#22c55e"
                items={shunts?.topology_mode === 'three_phase' ? [
                  `Rshunt = ${shunts.three_shunt.value_mohm} mΩ × 3`,
                  `V_shunt @ Imax = ${shunts.three_shunt.v_shunt_mv} mV`,
                  `V_ADC = ${shunts.three_shunt.v_adc_v} V each`,
                  `Location: ${shunts.three_shunt.location}`,
                ] : ['Waiting for system parameters...']}
              />
            </div>
          </div>

          {/* ADC Timing */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={secHead}><span>⏱️</span> ADC Sampling Strategy</div>
            <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11 }}>
              <InfoRow label="Sampling Mode"     value="Center-aligned PWM" />
              <InfoRow label="Trigger"           value="PWM Timer TRGO at center" />
              <InfoRow label="ADC Resolution"    value={`${state.project.blocks.mcu?.raw_data?.parameters?.find(p => p.id === 'adc_resolution')?.conditions?.[0]?.selected ?? '12'}-bit`} />
              <InfoRow label="Sample Window"     value={`~${((1/sys.pwm_freq_hz)*1e6*0.1).toFixed(1)} µs min`} />
              <InfoRow label="Oversampling"      value="16× recommended" />
              <div style={{ marginTop: 4, padding: '5px 8px', borderRadius: 5, fontSize: 10, lineHeight: 1.5,
                background: 'rgba(30,144,255,.06)', color: 'var(--txt-3)', border: '1px solid rgba(30,144,255,.1)' }}>
                ⚠ Single-shunt requires current reconstruction. ADC must sample during a valid voltage vector window.
              </div>
            </div>
          </div>

          {/* Protection */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={secHead}><span>🛡️</span> Protection Chain</div>
            <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
              {prot ? <>
                <ProtRow label="OCP (Hardware)" value={`${prot.ocp?.hw_threshold_a ?? '—'} A`}     color="var(--red)"   note="Via driver IC direct shutdown" />
                <ProtRow label="OCP (Software)" value={`${prot.ocp?.sw_threshold_a ?? sys.max_phase_current} A`} color="var(--amber)" note="MCU comparator, ~10µs latency" />
                <ProtRow label="OVP"            value={`${prot.ovp?.trip_voltage_v ?? '—'} V`} color="var(--amber)" note="Resistor divider + comparator" />
                <ProtRow label="UVP"            value={`${prot.uvp?.trip_voltage_v ?? '—'} V`} color="var(--amber)" note={`Hyst: ${prot.uvp?.hysteresis_voltage_v ?? '—'}V`} />
                <ProtRow label={`OTP (NTC ${prot.otp?.warning_temp_c ?? 80}°C)`} value={`${prot.otp?.warning_temp_c ?? 80} °C`} color="#f59e0b" note="NTC → ADC → software" />
              </> : (
                <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>Run calculations first</span>
              )}
            </div>
          </div>

          {/* Dead Time */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={secHead}><span>⏳</span> Dead Time &amp; FOC Notes</div>
            <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11 }}>
              {calc?.dead_time ? <>
                <InfoRow label="Minimum Dead Time" value={`${calc.dead_time.dt_minimum_ns} ns`} />
                <InfoRow label="Recommended"       value={`${calc.dead_time.dt_recommended_ns} ns`} />
                <InfoRow label="% of Period"        value={`${calc.dead_time.dt_pct_of_period}%`} />
                <div style={{ marginTop: 4, padding: '5px 8px', borderRadius: 5, fontSize: 10, lineHeight: 1.5,
                  background: 'rgba(255,171,0,.06)', color: 'var(--amber)', border: '1px solid rgba(255,171,0,.15)' }}>
                  ⚠ Dead-time compensation is mandatory in FOC firmware. Uncorrected dead-time causes current distortion at low speed.
                </div>
              </> : (
                <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>Run calculations first</span>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ── Right: calculations ─────────────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <CalculationsPanel />
      </div>
    </div>
  )
}

function ChainBlock({ color, label, sub }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '6px 10px', borderRadius: 8, textAlign: 'center', minWidth: 72,
      background: `${color}15`, border: `1px solid ${color}30`,
    }}>
      <span style={{ fontWeight: 600, fontSize: 11, color }}>{label}</span>
      <span style={{ fontSize: 9, color: 'var(--txt-3)', marginTop: 2 }}>{sub}</span>
    </div>
  )
}

function Arrow() {
  return <span style={{ color: 'var(--txt-3)', fontSize: 14 }}>→</span>
}

function ModeRow({ mode, items, color }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 11, color, marginBottom: 4 }}>{mode}</div>
      {items.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--txt-2)', fontSize: 11, lineHeight: 1.6 }}>
          <span style={{ color, opacity: 0.5 }}>•</span> {item}
        </div>
      ))}
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--txt-3)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--txt-1)', fontSize: 11 }}>{value}</span>
    </div>
  )
}

function ProtRow({ label, value, color, note }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
      <div>
        <div style={{ color: 'var(--txt-2)' }}>{label}</div>
        {note && <div style={{ color: 'var(--txt-3)', fontSize: 10 }}>{note}</div>}
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)', fontWeight: 700, flexShrink: 0,
        padding: '1px 7px', borderRadius: 4, fontSize: 11,
        background: `${color}18`, color,
      }}>{value}</span>
    </div>
  )
}
