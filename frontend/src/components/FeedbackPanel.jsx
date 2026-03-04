import React from 'react'
import { useProject } from '../context/ProjectContext.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'

export default function FeedbackPanel({ config }) {
  const { state } = useProject()
  const calc = state.project.calculations
  const sys = state.project.system_specs

  const shunts = calc?.shunt_resistors
  const prot = calc?.protection

  return (
    <div className="flex gap-4 h-full">
      <div className="flex flex-col gap-4 flex-1">
        {/* Header */}
        <div className="card p-4 flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
            style={{ background: `${config.color}20`, border: `1px solid ${config.color}40` }}>
            🔄
          </div>
          <div>
            <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
              Feedback Block — Sensing Chain &amp; Protection
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Connects MOSFETs (Block 4) → MCU (Block 1). Current sensing, ADC chain, OCP, OVP, OTP.
            </p>
          </div>
        </div>

        {/* Signal chain diagram */}
        <div className="card p-4">
          <div className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
            📡 Sensing Signal Chain
          </div>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <ChainBlock color="#ef4444" label="Phase Current" sub="MOSFET Source" />
            <Arrow />
            <ChainBlock color="#f59e0b" label="Shunt Resistor"
              sub={shunts ? `${shunts.single_shunt.value_mohm} mΩ` : 'R_shunt'} />
            <Arrow />
            <ChainBlock color="#a855f7" label="CSA Amplifier"
              sub={shunts ? `Gain ×${shunts.csa_gain}` : 'In Driver IC'} />
            <Arrow />
            <ChainBlock color="#3b82f6" label="ADC Input"
              sub={shunts ? `${shunts.single_shunt.v_adc_output_v}V @ Imax` : 'MCU ADC'} />
            <Arrow />
            <ChainBlock color="#22c55e" label="MCU FOC"
              sub="Clarke/Park Transform" />
          </div>
        </div>

        {/* Two-column grid */}
        <div className="grid grid-cols-2 gap-4 flex-1">
          {/* Current Sensing */}
          <div className="card">
            <div className="section-header">
              <span>📏</span>
              <span>Current Sensing</span>
            </div>
            <div className="p-4 flex flex-col gap-3 text-xs">
              <ModeRow
                mode="Single Shunt (Low-Side)"
                items={shunts?.single_shunt ? [
                  `Rshunt = ${shunts.single_shunt.value_mohm} mΩ`,
                  `V_shunt @ Imax = ${shunts.single_shunt.v_shunt_at_max_mv} mV`,
                  `V_ADC = ${shunts.single_shunt.v_adc_output_v} V`,
                  `Location: ${shunts.single_shunt.location}`,
                ] : ['Run calculations first']}
                color="#3b82f6"
              />
              <div style={{ height: 1, background: 'var(--border)' }} />
              <ModeRow
                mode="3-Phase Shunts"
                items={shunts?.three_shunt ? [
                  `Rshunt = ${shunts.three_shunt.value_mohm} mΩ × 3`,
                  `V_shunt @ Imax = ${shunts.three_shunt.v_shunt_at_max_mv} mV`,
                  `V_ADC = ${shunts.three_shunt.v_adc_output_v} V each`,
                  `Location: ${shunts.three_shunt.location}`,
                ] : ['Run calculations first']}
                color="#22c55e"
              />
            </div>
          </div>

          {/* ADC Timing */}
          <div className="card">
            <div className="section-header">
              <span>⏱️</span>
              <span>ADC Sampling Strategy</span>
            </div>
            <div className="p-4 flex flex-col gap-2 text-xs">
              <InfoRow label="Sampling Mode" value="Center-aligned PWM" />
              <InfoRow label="Trigger" value="PWM Timer TRGO at center" />
              <InfoRow label="ADC Resolution" value="12-bit" />
              <InfoRow label="Sampling Window (Single Shunt)" value={`~${((1/sys.pwm_freq_hz)*1e6*0.1).toFixed(1)} µs min`} />
              <InfoRow label="Oversampling (recommended)" value="16× for SNR" />
              <div className="mt-2 p-2 rounded text-[10px]" style={{ background: 'rgba(88,166,255,0.08)', color: 'var(--text-muted)' }}>
                ⚠ Single-shunt requires current reconstruction. ADC must sample during a valid voltage vector window. At modulation index &gt; 0.9, minimum on-time must be enforced.
              </div>
            </div>
          </div>

          {/* Protection */}
          <div className="card">
            <div className="section-header">
              <span>🛡️</span>
              <span>Protection Chain</span>
            </div>
            <div className="p-4 flex flex-col gap-2 text-xs">
              {prot ? <>
                <ProtRow label="OCP (Hardware)" value={`${prot.ocp_threshold_a} A`} color="var(--danger)" note={`< ${prot.ocp_response_time_us} µs via driver IC`} />
                <ProtRow label="OCP (Software)" value={`${sys.max_phase_current} A`} color="var(--warning)" note="MCU comparator, ~10µs latency" />
                <ProtRow label="OVP" value={`${prot.ovp_threshold_v} V`} color="var(--warning)" note="Resistor divider + LM393" />
                <ProtRow label="UVP" value={`${prot.uvp_threshold_v} V`} color="var(--warning)" note={`Hyst: ${prot.uvp_hysteresis_v}V`} />
                <ProtRow label="OTP Warning" value={`${prot.otp_warning_c}°C`} color="#f59e0b" note="NTC → ADC → software" />
                <ProtRow label="OTP Shutdown" value={`${prot.otp_shutdown_c}°C`} color="var(--danger)" note="Hardware comparator direct" />
                <ProtRow label="TVS Clamp" value={`${prot.tvs_clamping_v} V`} color="var(--accent)" note={prot.tvs_part} />
              </> : <span style={{ color: 'var(--text-muted)' }}>Run calculations first</span>}
            </div>
          </div>

          {/* Dead time info */}
          <div className="card">
            <div className="section-header">
              <span>⏳</span>
              <span>Dead Time &amp; FOC Notes</span>
            </div>
            <div className="p-4 flex flex-col gap-2 text-xs">
              {calc?.dead_time ? <>
                <InfoRow label="Minimum Dead Time" value={`${calc.dead_time.dt_minimum_ns} ns`} />
                <InfoRow label="Recommended" value={`${calc.dead_time.dt_recommended_ns} ns`} />
                <InfoRow label="% of Period" value={`${calc.dead_time.dt_percentage_of_period}%`} />
                <div className="mt-2 p-2 rounded text-[10px]" style={{ background: 'rgba(210,153,34,0.08)', color: 'var(--warning)' }}>
                  ⚠ Dead-time compensation is mandatory in FOC firmware. Uncorrected dead-time causes current distortion at low speed and poor efficiency.
                </div>
                <div className="mt-1 p-2 rounded text-[10px]" style={{ background: 'rgba(88,166,255,0.08)', color: 'var(--text-muted)' }}>
                  For 6-step: same dead time applies. Commutation events must also respect minimum gate charge time.
                </div>
              </> : <span style={{ color: 'var(--text-muted)' }}>Run calculations first</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Right: calculations */}
      <div className="w-80 flex-shrink-0">
        <CalculationsPanel />
      </div>
    </div>
  )
}

function ChainBlock({ color, label, sub }) {
  return (
    <div
      className="flex flex-col items-center px-3 py-2 rounded-lg text-center"
      style={{ background: `${color}15`, border: `1px solid ${color}30`, minWidth: 80 }}
    >
      <span className="font-semibold text-xs" style={{ color }}>{label}</span>
      <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</span>
    </div>
  )
}

function Arrow() {
  return <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>→</span>
}

function ModeRow({ mode, items, color }) {
  return (
    <div>
      <div className="font-semibold mb-1" style={{ color }}>{mode}</div>
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color, opacity: 0.5 }}>•</span> {item}
        </div>
      ))}
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between gap-2">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

function ProtRow({ label, value, color, note }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
        {note && <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{note}</div>}
      </div>
      <span className="font-mono font-bold px-2 py-0.5 rounded text-xs flex-shrink-0"
        style={{ background: `${color}18`, color }}>
        {value}
      </span>
    </div>
  )
}
