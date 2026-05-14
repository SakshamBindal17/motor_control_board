import React from 'react'
import { useProject } from '../context/ProjectContext.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'

// Hex colours — var() strings can't have opacity suffix appended
const C = { red: '#ef4444', amber: '#f59e0b', cyan: '#00d4e8', green: '#22c55e', gray: '#888' }

// Spread onto any element — handles both plain string and structured object tips
function tipProps(tip) {
  if (!tip) return {}
  if (typeof tip === 'object') return { 'data-tip-json': JSON.stringify(tip) }
  return { 'data-tip': tip }
}

export default function FeedbackPanel({ config }) {
  const { state } = useProject()
  const calc = state.project.calculations
  const sys  = state.project.system_specs

  const shunts = calc?.shunt_resistors
  const prot   = calc?.protection_dividers
  const dt     = calc?.dead_time
  const active = shunts?.active

  // ── MCU block data ────────────────────────────────────────────
  const mcuBlock  = state.project.blocks?.mcu?.raw_data
  const mcuParams = mcuBlock?.parameters
  const getP      = (params, id) => params?.find(p => p.id === id)?.conditions?.[0]

  const adcResParam = getP(mcuParams, 'adc_resolution')
  const adcBits     = parseInt(adcResParam?.selected ?? adcResParam?.typ ?? 12)
  const adcRateKsps = getP(mcuParams, 'adc_sample_rate')?.selected
  const compOutputs = getP(mcuParams, 'complementary_outputs')?.selected
  const ramRaw      = getP(mcuParams, 'ram_size')
  const flashRaw    = getP(mcuParams, 'flash_size')

  const ramBytes   = ramRaw   ? (ramRaw.unit   === 'kB' || ramRaw.unit   === 'KB' ? ramRaw.selected   * 1024 : ramRaw.selected)   : null
  const flashKB    = flashRaw ? (flashRaw.unit === 'bytes'                         ? flashRaw.selected / 1024 : flashRaw.selected) : null

  const hasCompPWM = (compOutputs == null) ? null : Number(compOutputs) > 0
  const focRamOk   = ramBytes  == null ? null : ramBytes  > 2000
  const focFlashOk = flashKB   == null ? null : flashKB   > 16

  // ── Driver block data ─────────────────────────────────────────
  const driverParams = state.project.blocks?.driver?.raw_data?.parameters
  const driverHasOCP = Boolean(driverParams?.some(p => p.id === 'ocp_threshold'))

  // ── MOSFET block data ─────────────────────────────────────────
  const mosfetParams = state.project.blocks?.mosfet?.raw_data?.parameters
  const vdsMax       = getP(mosfetParams, 'vds_max')?.selected
                    ?? getP(mosfetParams, 'vds_max')?.min

  // ── Derived values ────────────────────────────────────────────
  const adcUtilBipolar = active
    ? (active.v_adc_v / active.v_adc_max_limit * 100).toFixed(1)
    : null
  const peakClips    = active != null && active.v_adc_swing_peak > active.v_adc_max_limit
  const tvsExceedsVds = prot != null && vdsMax != null && prot.tvs.clamping_v > vdsMax
  const uvpErrPct    = prot
    ? ((prot.uvp.actual_trip_v - prot.uvp.trip_voltage_v) / prot.uvp.trip_voltage_v * 100).toFixed(1)
    : null
  const uvpErrBad    = uvpErrPct != null && Math.abs(parseFloat(uvpErrPct)) > 5
  const pullupMismatch = prot != null
    && (prot.otp.r_pullup_recommended_kohm > 0)
    && (prot.otp.r_pullup_kohm / prot.otp.r_pullup_recommended_kohm > 3)
  const lsbV = (shunts && adcBits) ? shunts.adc_reference_v / Math.pow(2, adcBits) : null
  const currentLsbMa = (lsbV && active && active.value_mohm > 0)
    ? (lsbV / (shunts.csa_gain * active.value_mohm * 1e-3) * 1000).toFixed(0)
    : null
  const ocpCounts = (lsbV && active && active.value_mohm > 0 && prot)
    ? Math.floor(prot.ocp.sw_threshold_a / (lsbV / (shunts.csa_gain * active.value_mohm * 1e-3)))
    : null
  const ntcCounts = (lsbV && prot && prot.otp.v_ntc_at_80c_v != null && prot.otp.v_ntc_at_100c_v != null)
    ? Math.round(Math.abs(prot.otp.v_ntc_at_80c_v - prot.otp.v_ntc_at_100c_v) / lsbV)
    : null
  const sampleWindowUs = sys?.pwm_freq_hz ? (1e6 / sys.pwm_freq_hz * 0.1) : null
  const sampleTimeUs   = adcRateKsps      ? (1000 / adcRateKsps)           : null
  const numChannels    = shunts?.topology_mode === 'single' ? 1 : 3
  const maxOversamp    = (sampleWindowUs && sampleTimeUs)
    ? Math.max(1, Math.floor(sampleWindowUs / sampleTimeUs / numChannels))
    : null
  const halfPeriodUs = sys?.pwm_freq_hz ? (1e6 / sys.pwm_freq_hz / 2) : null
  const dtOffsetUs   = dt?.dt_actual_ns  ? dt.dt_actual_ns / 1000      : 0
  const realWindowUs = halfPeriodUs != null ? (halfPeriodUs - dtOffsetUs).toFixed(1) : null
  const pwmPeriodNs  = sys?.pwm_freq_hz ? (1e9 / sys.pwm_freq_hz).toFixed(0) : null

  const mcuSub = hasCompPWM === false ? 'No HW dead-time ⚠'
    : focRamOk  === false             ? 'Insufficient RAM ⚠'
    : focFlashOk === false            ? 'Low flash ⚠'
    : sys?.control_mode === 'FOC'     ? 'Clarke/Park'
    : 'PWM Control'
  const mcuWarn  = hasCompPWM === false || focRamOk === false || focFlashOk === false
  const anyAlert = tvsExceedsVds || peakClips

  // ── Structured tooltips (data-tip-json → RichTooltip) ────────
  const tipAdcUtil = active ? {
    title: 'Bipolar ADC Utilisation',
    detail: `${active.v_adc_v} V ÷ ${active.v_adc_max_limit} V = ${adcUtilBipolar}%  ${parseFloat(adcUtilBipolar) > 85 ? '⚠ Too high' : parseFloat(adcUtilBipolar) < 40 ? '⚠ Too low' : '✓ Good'}`,
    theory: 'Phase currents are always AC (bidirectional). ADC is biased at Vref/2, so true range = Vref/2, not Vref. Ideal 50–85%.',
    formula: 'V_ADC / (Vref / 2)',
    advice: parseFloat(adcUtilBipolar) > 85 ? 'Reduce R_shunt or CSA gain to lower V_ADC and avoid peak clipping.'
          : parseFloat(adcUtilBipolar) < 40  ? 'Increase R_shunt or CSA gain for better current resolution.'
          : null,
  } : null

  const tipVadc = (active && shunts) ? {
    title: 'V_ADC at Imax',
    detail: `${sys?.max_phase_current ?? '—'} A × ${active.value_mohm} mΩ × ${shunts.csa_gain} = ${active.v_adc_v} V`,
    theory: 'DC steady-state voltage at the ADC pin when maximum phase current flows. Sinusoidal peak will be ×√2 higher.',
    formula: 'Imax × R_shunt × CSA_gain',
    advice: `Peak sinusoidal swing = ${active.v_adc_swing_peak} V — check against half-scale limit (${active.v_adc_max_limit} V)`,
  } : null

  const tipHalfScale = (active && shunts) ? {
    title: 'Half-Scale Limit (Bidirectional)',
    detail: `${shunts.adc_reference_v} V ÷ 2 = ${active.v_adc_max_limit} V`,
    theory: 'Phase current reverses each half-cycle, so ADC is biased at Vref/2 via CSA offset output. Maximum usable swing from centre = Vref/2.',
    formula: 'Vref / 2',
    advice: `Peak swing (${active.v_adc_swing_peak} V) must stay below this — exceeding saturates the ADC and corrupts current samples`,
  } : null

  const tipPeakSwing = (active && shunts) ? {
    title: 'ADC Peak Swing (Sinusoidal)',
    detail: peakClips
      ? `${active.v_adc_swing_peak} V > ${active.v_adc_max_limit} V — CLIPPING ⚠`
      : `${active.v_adc_swing_peak} V < ${active.v_adc_max_limit} V ✓`,
    theory: `Instantaneous ADC voltage at sinusoidal current peak = Imax × √2 × R_shunt × CSA.`,
    formula: `${sys?.max_phase_current ?? '—'} A × √2 × ${active.value_mohm} mΩ × ${shunts.csa_gain}`,
    advice: peakClips
      ? 'ADC saturates on every current peak → FOC current vector wrong → torque error + speed instability. Reduce R_shunt or CSA gain.'
      : null,
  } : null

  const tipCurrentLsb = (lsbV && active && shunts) ? {
    title: 'Current Resolution (1 LSB)',
    detail: `${(lsbV * 1000).toFixed(2)} mV ÷ ${shunts.csa_gain} ÷ ${active.value_mohm} mΩ = ${currentLsbMa} mA / count`,
    theory: 'Minimum detectable current step — one ADC count reflected back through CSA gain and shunt resistance.',
    formula: 'Vref / 2^N / CSA_gain / R_shunt',
    advice: null,
  } : null

  const tipOcpCounts = (prot && ocpCounts != null) ? {
    title: 'OCP Software ADC Resolution',
    detail: `${prot.ocp.sw_threshold_a} A ÷ ${currentLsbMa} mA/count = ${ocpCounts} counts to trip`,
    theory: 'Number of ADC counts from zero current to the SW OCP threshold. Low count = ADC noise can cause false trips.',
    formula: 'SW_OCP_A / current_LSB_A',
    advice: ocpCounts < 100 ? 'Very low resolution — increase CSA gain or shunt value for reliable overcurrent detection.' : null,
  } : null

  const tipMaxOversamp = (sampleWindowUs && sampleTimeUs) ? {
    title: 'Max Hardware Oversampling',
    detail: `floor(${sampleWindowUs.toFixed(1)} µs ÷ ${sampleTimeUs.toFixed(1)} µs ÷ ${numChannels} ch) = ${maxOversamp}×`,
    theory: `Valid ADC window = 10% of PWM period (sample at triangle-wave peak where I = I_avg). Window = ${sampleWindowUs.toFixed(1)} µs. Each sample = ${sampleTimeUs.toFixed(1)} µs @ ${adcRateKsps} ksps. Channels = ${numChannels} (${shunts?.topology_mode ?? '—'} shunt).`,
    formula: 'floor(window_µs / t_sample_µs / N_channels)',
    advice: maxOversamp != null && maxOversamp < 4 ? 'Very limited oversampling. Use faster ADC, lower PWM frequency, or accept 1× (no averaging).' : null,
  } : { title: 'Max Oversampling', detail: 'Upload MCU datasheet to compute.', theory: 'Requires ADC sample rate and PWM frequency.' }

  const tipOcpHw = prot ? {
    title: 'OCP Hardware Threshold',
    detail: `${prot.ocp.hw_threshold_a} A → ${driverHasOCP ? 'Driver IC built-in OCP ✓' : 'External comparator required ⚠'}`,
    theory: `Hardware OCP shuts gate signals before MCU can respond. Response: ${prot.ocp.hw_response_us} µs.`,
    formula: null,
    advice: driverHasOCP
      ? null
      : 'This driver IC has NO built-in OCP. Add external comparator → driver EN/FAULT pin. Without it there is no sub-µs hardware overcurrent protection.',
  } : null

  const tipOvpTrip = prot ? {
    title: 'OVP Trip Point',
    detail: `Target: ${prot.ovp.trip_voltage_v} V | Actual: ${prot.ovp.actual_trip_v} V — R1=${prot.ovp.r1_kohm} kΩ / R2=${prot.ovp.r2_standard_kohm} kΩ`,
    theory: `Set above peak bus (${sys?.peak_voltage ?? '—'} V). Filter cap ${prot.ovp.c_filter_nf} nF → Fc=${prot.ovp.f_cutoff_hz ? (prot.ovp.f_cutoff_hz / 1000).toFixed(1) : '—'} kHz — must be below PWM freq to avoid false trips.`,
    formula: 'V_trip = Vref × (1 + R1/R2)',
  } : null

  const tipUvpActual = prot ? {
    title: 'UVP Actual Trip (E24 snap)',
    detail: `Target: ${prot.uvp.trip_voltage_v} V → Actual: ${prot.uvp.actual_trip_v} V (${uvpErrPct}% error)`,
    theory: `Divider: R1=${prot.uvp.r1_kohm} kΩ / R2=${prot.uvp.r2_standard_kohm} kΩ. Error comes from nearest available E24 resistor values.`,
    advice: uvpErrBad
      ? `Error >5% — bus can drop ${Math.abs(parseFloat(uvpErrPct)).toFixed(1)}% further before UVP fires. Controller may run below safe minimum voltage.`
      : null,
  } : null

  const tipOtpShutdown = prot ? {
    title: 'OTP Hard Shutdown',
    detail: `${prot.otp.shutdown_temp_c} °C | NTC V = ${prot.otp.v_ntc_at_100c_v?.toFixed(3) ?? '—'} V`,
    theory: 'All PWM halted when NTC ADC value crosses this threshold. Requires manual reset after trip.',
    advice: 'Ensure heatsink keeps Tj below this under worst-case continuous load.',
  } : null

  const tipPullup = prot ? {
    title: 'NTC Pullup Resistor',
    detail: `Configured: ${prot.otp.r_pullup_kohm} kΩ | Recommended: ${prot.otp.r_pullup_recommended_kohm} kΩ${pullupMismatch ? ' ⚠ Mismatch >3×' : ' ✓'}`,
    theory: 'Optimal pullup = geometric mean of R_NTC at warning and shutdown temps. Maximises ADC voltage swing across the thermal protection range.',
    formula: `√(R@${prot.otp.warning_temp_c}°C × R@${prot.otp.shutdown_temp_c}°C)`,
    advice: pullupMismatch
      ? `Mismatch >3× compresses counts between ${prot.otp.warning_temp_c}°C and ${prot.otp.shutdown_temp_c}°C. Firmware may skip warning and jump straight to hard shutdown.`
      : null,
  } : null

  const tipNtcCounts = (prot && lsbV) ? {
    title: 'NTC Thermal ADC Resolution',
    detail: `ΔV = |${prot.otp.v_ntc_at_80c_v?.toFixed(3) ?? '—'} − ${prot.otp.v_ntc_at_100c_v?.toFixed(3) ?? '—'}| V ÷ ${(lsbV * 1000).toFixed(2)} mV/count = ${ntcCounts} counts`,
    theory: `Counts available between warning (${prot.otp.warning_temp_c}°C) and shutdown (${prot.otp.shutdown_temp_c}°C). More counts = finer thermal protection granularity.`,
    formula: 'ΔV_ntc / LSB',
    advice: ntcCounts != null && ntcCounts < 50
      ? 'Very low thermal resolution — ADC noise can skip warning and jump straight to hard shutdown. Optimise pullup resistor value.'
      : ntcCounts != null && ntcCounts < 100 ? 'Marginal. Consider optimising pullup to recommended value.' : null,
  } : null

  const tipTvsClamp = prot ? {
    title: 'TVS Clamping Voltage',
    detail: `Clamp: ${prot.tvs.clamping_v} V | Vds_max: ${vdsMax ?? 'unknown'} V${vdsMax != null ? ` | Margin: ${(vdsMax - prot.tvs.clamping_v).toFixed(0)} V` : ''}`,
    theory: 'TVS must clamp below MOSFET Vds_max. If clamp > Vds_max, the FET reaches avalanche breakdown before TVS conducts — FET destroyed first.',
    advice: tvsExceedsVds
      ? `FAIL: choose lower standoff TVS so clamp stays ≤ ${vdsMax != null ? (vdsMax * 0.9).toFixed(0) : '—'} V (90% of Vds_max).`
      : vdsMax == null ? 'Upload MOSFET datasheet to verify.' : null,
  } : null

  const tipDtActual = dt ? {
    title: 'Actual Dead Time (Quantised)',
    detail: `${dt.dt_register_count} steps × ${dt.dt_resolution_ns} ns/step = ${dt.dt_actual_ns} ns (recommended: ${dt.dt_recommended_ns} ns)`,
    theory: `Register rounds up above recommended. Limiting path: ${dt.dt_limiting_path}.`,
    advice: dt.dt_actual_ns > dt.dt_recommended_ns * 1.5 ? 'Actual >1.5× recommended — extra duty cycle loss and body diode heating.' : null,
  } : null

  const tipDtPct = dt ? {
    title: 'Dead Time Fraction of Period',
    detail: `${dt.dt_actual_ns} ns ÷ ${pwmPeriodNs ?? '—'} ns = ${dt.dt_pct_of_period}%${dt.dt_pct_of_period > 2 ? ' ⚠' : ' ✓'}`,
    theory: 'Dead time creates a voltage notch in the phase output. Above ~2% it causes measurable current distortion in FOC at low speed and low modulation index.',
    advice: dt.dt_pct_of_period > 2
      ? 'Implement dead-time compensation in firmware (add compensating voltage vector each switching cycle).'
      : 'DT compensation still recommended for precision torque control.',
  } : null

  const tipBodyDiode = dt ? {
    title: 'Body Diode Conduction Loss',
    detail: `${dt.body_diode_vf_v} V × ${dt.dt_actual_ns} ns × ${sys?.pwm_freq_hz ? (sys.pwm_freq_hz / 1000).toFixed(0) : '—'} kHz × 6 transitions = ${dt.body_diode_loss_total_w} W`,
    theory: '6 transitions = 2 per half-bridge leg × 3 legs. Body diode conducts during each dead time gap.',
    formula: 'P = Vf × I_avg × dt × fsw × 6',
    advice: dt.body_diode_loss_total_w > 2 ? 'Significant — include in MOSFET junction temperature budget.' : null,
  } : null

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', overflow: 'hidden' }}>

      {/* ── Left: scrollable ──────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, paddingRight: 2 }}>

        {/* Header */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${config.color}18`, border: `1px solid ${config.color}35`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>🔄</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>
              Feedback &amp; Protection
            </div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>
              Current sensing · ADC scaling · OCP / OVP / UVP / OTP · Dead time · Body diode
            </div>
          </div>
          {!calc && (
            <div style={{ fontSize: 10, color: C.amber, background: 'rgba(245,158,11,.08)',
              border: '1px solid rgba(245,158,11,.2)', borderRadius: 6, padding: '3px 8px' }}>
              Run calculations first
            </div>
          )}
        </div>

        {/* ── Critical alerts ───────────────────────────────── */}
        {anyAlert && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tvsExceedsVds && (
              <CritAlert text={
                `TVS clamp ${prot.tvs.clamping_v} V > MOSFET Vds_max ${vdsMax} V — ` +
                `MOSFET will avalanche before TVS fires. Reduce TVS standoff so clamp stays below ${vdsMax} V.`
              } />
            )}
            {peakClips && (
              <CritAlert text={
                `ADC clips on peak current: swing ${active.v_adc_swing_peak} V > half-scale limit ${active.v_adc_max_limit} V. ` +
                `FOC current reconstruction breaks on every current peak — torque error + instability.`
              } />
            )}
          </div>
        )}

        {/* ── MCU warnings ─────────────────────────────────── */}
        {mcuWarn && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {hasCompPWM === false && (
              <WarnAlert text={
                `${mcuBlock?.component_name ?? 'MCU'} has no hardware complementary PWM ` +
                `(complementary_outputs = 0). Dead time must be software-only — ` +
                `risk of shoot-through at ${sys?.pwm_freq_hz ? (sys.pwm_freq_hz / 1000).toFixed(0) : '—'} kHz.`
              } />
            )}
            {focRamOk === false && (
              <WarnAlert text={`MCU RAM ${ramBytes} bytes insufficient for FOC. Clarke/Park + PID state variables require ≥ 2 kB minimum.`} />
            )}
            {focFlashOk === false && (
              <WarnAlert text={`MCU flash ${flashKB?.toFixed(0)} kB insufficient for FOC firmware. Motor control code requires ≥ 16 kB minimum.`} />
            )}
          </div>
        )}

        {/* ── Signal Chain ──────────────────────────────────── */}
        <SectionCard icon="📡" title="Sensing Signal Chain">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 2px' }}>
            <ChainBlock color={C.red}   label="Phase Current"  sub="MOSFET Source" />
            <Arrow />
            <ChainBlock color={C.amber} label="Shunt Resistor"
              sub={active ? `${active.value_mohm} mΩ × ${active.quantity}` : 'R_shunt'} />
            <Arrow />
            <ChainBlock color="#a855f7" label="CSA Amplifier"
              sub={shunts ? `Gain ×${shunts.csa_gain}` : 'In Driver IC'} />
            <Arrow />
            <ChainBlock color={peakClips ? C.red : '#3b82f6'} label="ADC Input"
              sub={active ? `${active.v_adc_v} V @ Imax` : 'MCU ADC'} warn={peakClips} />
            <Arrow />
            <ChainBlock color={mcuWarn ? C.amber : C.green}
              label="MCU Control" sub={mcuSub} warn={mcuWarn} />
          </div>
          {shunts && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Badge color={C.cyan}
                label={`Topology: ${shunts.topology_mode === 'single' ? 'Single Shunt' : '3-Phase Shunts'}`} />
              <Badge color={C.gray} label={`CSA source: ${shunts.csa_gain_source}`} />
              {adcUtilBipolar && (
                <Badge
                  color={parseFloat(adcUtilBipolar) > 85 ? C.red : parseFloat(adcUtilBipolar) < 40 ? C.amber : C.green}
                  label={`Bipolar ADC use: ${adcUtilBipolar}%`}
                  tip={tipAdcUtil}
                />
              )}
            </div>
          )}
        </SectionCard>

        {/* ── Current Sensing + ADC — 2 col ─────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

          {/* Current Sensing */}
          <SectionCard icon="📏" title="Current Sensing">
            {active ? <>
              <InfoRow label="Topology"
                value={active.topology === 'single' ? 'Single Shunt' : '3-Phase Shunts'} />
              <InfoRow label="Shunt value"       value={`${active.value_mohm} mΩ`} bold />
              <InfoRow label="Qty"               value={`× ${active.quantity}`} />
              <InfoRow label="V_shunt @ Imax"    value={`${active.v_shunt_mv} mV`} />
              <InfoRow label="V_ADC @ Imax"      value={`${active.v_adc_v} V`} bold tip={tipVadc} />
              <InfoRow label="Half-scale limit"  value={`${active.v_adc_max_limit} V`} tip={tipHalfScale} />
              <InfoRow label="Peak swing (√2·I)" value={`${active.v_adc_swing_peak} V`}
                color={peakClips ? 'var(--red)' : 'var(--txt-1)'} bold tip={tipPeakSwing} />
              {peakClips && (
                <div style={{ fontSize: 10, color: 'var(--red)', padding: '3px 0 2px', fontWeight: 600 }}>
                  ⚠ {active.v_adc_swing_peak} V &gt; {active.v_adc_max_limit} V — clips on peaks
                </div>
              )}
              <InfoRow label="Bipolar ADC use" value={`${adcUtilBipolar}%`}
                color={parseFloat(adcUtilBipolar) > 85 ? 'var(--red)' : parseFloat(adcUtilBipolar) < 40 ? 'var(--amber)' : 'var(--green)'}
                bold tip={tipAdcUtil} />
              <InfoRow label="Bits used (Imax)" value={`${active.adc_bits_used?.toFixed(1)} bit`} />
              {currentLsbMa && <InfoRow label="Current LSB" value={`${currentLsbMa} mA`} tip={tipCurrentLsb} />}
              {ocpCounts != null && (
                <InfoRow label="OCP SW resolution" value={`~${ocpCounts} counts`}
                  color={ocpCounts < 100 ? 'var(--amber)' : 'var(--txt-2)'} tip={tipOcpCounts} />
              )}
            </> : <Placeholder />}
          </SectionCard>

          {/* ADC Chain */}
          <SectionCard icon="⏱️" title="ADC Chain & Sampling">
            <InfoRow label="ADC resolution" value={`${adcBits}-bit`} bold />
            <InfoRow label="ADC reference" value={shunts ? `${shunts.adc_reference_v} V` : '—'} />
            <InfoRow label="Sampling mode"  value="Center-aligned PWM" />
            <InfoRow label="Trigger"        value="Center of PWM period"
              tip={{ title: 'ADC Trigger Point', detail: 'Triangle-wave peak of center-aligned PWM', theory: 'At this instant the instantaneous phase current equals its cycle average — giving the cleanest, ripple-free current sample with no switching artefacts.' }} />
            <InfoRow label="Valid window" value={realWindowUs ? `~${realWindowUs} µs` : '—'}
              tip={halfPeriodUs ? { title: 'ADC Valid Sampling Window', detail: `${halfPeriodUs.toFixed(1)} µs − ${dtOffsetUs.toFixed(1)} µs = ${realWindowUs} µs`, theory: 'Half PWM period minus dead time. Current sample must complete within this window.' } : null} />
            <InfoRow label="Max oversampling"
              value={maxOversamp != null ? (maxOversamp < 16 ? `${maxOversamp}× (hw limit)` : `${maxOversamp}×`) : '—'}
              color={maxOversamp != null && maxOversamp < 16 ? 'var(--amber)' : 'var(--txt-2)'}
              bold={maxOversamp != null && maxOversamp < 16}
              tip={tipMaxOversamp} />
            {shunts && <>
              <InfoRow label="LSB size"
                value={lsbV ? `${(lsbV * 1000).toFixed(2)} mV` : '—'}
                tip={{ title: 'ADC Voltage LSB', detail: `${shunts.adc_reference_v} V ÷ 2^${adcBits} = ${lsbV ? (lsbV * 1000).toFixed(2) : '—'} mV/count`, theory: 'Voltage resolution of one ADC count.' }} />
              <InfoRow label="CSA gain"     value={`× ${shunts.csa_gain}`} />
              <InfoRow label="Current LSB"  value={currentLsbMa ? `${currentLsbMa} mA` : '—'} tip={tipCurrentLsb} />
            </>}
          </SectionCard>
        </div>

        {/* ── Protection Chain — full width ─────────────────── */}
        <SectionCard icon="🛡️" title="Protection Chain">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

            {/* OCP */}
            <div>
              <SubHead>Overcurrent Protection (OCP)</SubHead>
              {prot ? <>
                <ProtRow label="HW threshold" value={`${prot.ocp.hw_threshold_a} A`}
                  color={C.red} highlight
                  note={driverHasOCP ? 'Driver IC direct shutdown' : 'External comparator → driver EN pin'}
                  tip={tipOcpHw} />
                <ProtRow label="SW threshold" value={`${prot.ocp.sw_threshold_a} A`}
                  color={C.amber} note="MCU comparator, ~10µs latency"
                  tip={{ title: 'OCP Software Threshold', detail: `${prot.ocp.sw_threshold_a} A → MCU ISR → PWM disable`, theory: `Slower path (${prot.ocp.sw_response_us} µs). Second line of defense after hardware OCP. Set lower than HW threshold.` }} />
                <ProtRow label="HW response" value={`${prot.ocp.hw_response_us} µs`}
                  color="var(--txt-2)" note="Gate signal disable" />
                <ProtRow label="SW response" value={`${prot.ocp.sw_response_us} µs`}
                  color="var(--txt-2)" note="ISR latency" />
              </> : <Placeholder />}
            </div>

            {/* OVP + UVP */}
            <div>
              <SubHead>Bus Voltage Protection</SubHead>
              {prot ? <>
                <ProtRow label="OVP trip" value={`${prot.ovp.trip_voltage_v} V`}
                  color={C.amber}
                  note={`Actual: ${prot.ovp.actual_trip_v} V — R1=${prot.ovp.r1_kohm}k / R2=${prot.ovp.r2_standard_kohm}k`}
                  tip={tipOvpTrip} />
                <ProtRow label="OVP C_filter" value={`${prot.ovp.c_filter_nf} nF`}
                  color="var(--txt-2)"
                  note={`Fc=${prot.ovp.f_cutoff_hz ? (prot.ovp.f_cutoff_hz / 1000).toFixed(1) + ' kHz' : '—'} — rejects PWM noise`}
                  tip={{ title: 'OVP Noise Filter', detail: `${prot.ovp.c_filter_nf} nF → Fc = ${prot.ovp.f_cutoff_hz ? (prot.ovp.f_cutoff_hz / 1000).toFixed(1) : '—'} kHz`, theory: `Must be below PWM frequency (${sys?.pwm_freq_hz ? (sys.pwm_freq_hz / 1000).toFixed(0) : '—'} kHz) to prevent false OVP trips from switching transients on the bus.` }} />
                <ProtRow label="UVP trip" value={`${prot.uvp.trip_voltage_v} V`}
                  color={C.cyan} note={`Hyst: ${prot.uvp.hysteresis_voltage_v} V`}
                  tip={{ title: 'UVP Trip Target', detail: `${prot.uvp.trip_voltage_v} V with ${prot.uvp.hysteresis_voltage_v} V hysteresis`, theory: 'Hysteresis prevents chatter when bus voltage hovers near the threshold.' }} />
                <ProtRow label="UVP actual trip" value={`${prot.uvp.actual_trip_v} V`}
                  color={uvpErrBad ? C.amber : 'var(--txt-2)'}
                  highlight={uvpErrBad}
                  note={uvpErrBad
                    ? `${uvpErrPct}% error from E24 snap — R1=${prot.uvp.r1_kohm}k / R2=${prot.uvp.r2_standard_kohm}k`
                    : `R1=${prot.uvp.r1_kohm}k / R2=${prot.uvp.r2_standard_kohm}k`}
                  tip={tipUvpActual} />
              </> : <Placeholder />}
            </div>

            {/* OTP */}
            <div>
              <SubHead>Over-Temperature (OTP)</SubHead>
              {prot ? <>
                <ProtRow label="Warning temp" value={`${prot.otp.warning_temp_c} °C`}
                  color={C.amber} note="NTC → ADC → firmware ISR"
                  tip={{ title: 'OTP Warning Threshold', detail: `${prot.otp.warning_temp_c} °C | NTC V = ${prot.otp.v_ntc_at_80c_v?.toFixed(3) ?? '—'} V`, theory: 'Firmware reduces current limit or speed when reached. Not a hard shutdown — system continues at reduced power.' }} />
                <ProtRow label="Shutdown temp" value={`${prot.otp.shutdown_temp_c} °C`}
                  color={C.red} highlight note="Hard shutdown" tip={tipOtpShutdown} />
                <ProtRow label="NTC R25" value={`${prot.otp.ntc_value_at_25c_kohm} kΩ`}
                  color="var(--txt-2)" note={`B = ${prot.otp.ntc_b_coefficient}`}
                  tip={{ title: 'NTC Thermistor Parameters', detail: `R₂₅ = ${prot.otp.ntc_value_at_25c_kohm} kΩ, B = ${prot.otp.ntc_b_coefficient} K`, theory: 'B-coefficient model: R(T) = R₂₅ × exp(B × (1/T − 1/298.15)). Higher B = steeper resistance curve.' }} />
                <ProtRow label="Pullup configured" value={`${prot.otp.r_pullup_kohm} kΩ`}
                  color={pullupMismatch ? C.amber : 'var(--txt-2)'}
                  highlight={pullupMismatch}
                  note={pullupMismatch
                    ? `Rec: ${prot.otp.r_pullup_recommended_kohm} kΩ — mismatch reduces sensitivity`
                    : `Rec: ${prot.otp.r_pullup_recommended_kohm} kΩ`}
                  tip={tipPullup} />
                {ntcCounts != null && (
                  <ProtRow label="NTC ADC counts" value={`${ntcCounts} counts`}
                    color={ntcCounts < 50 ? C.red : ntcCounts < 100 ? C.amber : 'var(--txt-2)'}
                    highlight={ntcCounts < 50}
                    note={`Between ${prot.otp.warning_temp_c}°C and ${prot.otp.shutdown_temp_c}°C`}
                    tip={tipNtcCounts} />
                )}
              </> : <Placeholder />}
            </div>

            {/* TVS + Reverse polarity */}
            <div>
              <SubHead>Transient &amp; Reverse Protection</SubHead>
              {prot ? <>
                <ProtRow label="TVS standoff" value={`${prot.tvs.standoff_v} V`}
                  color={C.amber} note={`Clamp: ${prot.tvs.clamping_v} V`}
                  tip={{ title: 'TVS Standoff Voltage', detail: `${prot.tvs.standoff_v} V (above OVP trip: ${prot.ovp.actual_trip_v} V ✓)`, theory: 'TVS starts conducting above standoff. Must exceed OVP trip so normal overvoltage protection fires first. TVS handles fast spikes the divider cannot detect in time.' }} />
                <ProtRow label="TVS clamping V" value={`${prot.tvs.clamping_v} V`}
                  color={tvsExceedsVds ? C.red : C.green}
                  highlight={tvsExceedsVds}
                  note={tvsExceedsVds
                    ? `⚠ Exceeds MOSFET Vds_max ${vdsMax} V — FET fails before TVS clamps`
                    : vdsMax != null
                      ? `${(vdsMax - prot.tvs.clamping_v).toFixed(0)} V margin below Vds_max ${vdsMax} V ✓`
                      : 'Upload MOSFET datasheet to verify'}
                  tip={tipTvsClamp} />
                <ProtRow label="TVS rating" value={`${prot.tvs.power_rating_w} W`}
                  color="var(--txt-2)" note={`× ${prot.tvs.qty} units, near bridge`}
                  tip={{ title: 'TVS Peak Pulse Power', detail: `${prot.tvs.power_rating_w} W × ${prot.tvs.qty} units`, theory: 'Must handle the full spike energy. Place close to the half-bridge — long traces add inductance and slow the TVS response time.' }} />
                <ProtRow label="Rev. polarity" value={`${prot.reverse_polarity.vds_rating_v} V`}
                  color={C.cyan} note={prot.reverse_polarity.type}
                  tip={{ title: 'Reverse Polarity Protection', detail: `Type: ${prot.reverse_polarity.type} | ${prot.reverse_polarity.vds_rating_v} V rating`, theory: 'P-channel MOSFET: gate pulled to supply → off in forward polarity, body diode blocks reverse. Schottky diode: lower drop but passive — no gate control.' }} />
              </> : <Placeholder />}
            </div>
          </div>
        </SectionCard>

        {/* ── Dead Time Analysis — full width ───────────────── */}
        <SectionCard icon="⏳" title="Dead Time Analysis">
          {dt ? <>
            {dt.trr_warning && <CritAlert text={dt.trr_warning} />}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

              {/* Left: values */}
              <div>
                <InfoRow label="Minimum dead time" value={`${dt.dt_minimum_ns} ns`}
                  tip={{ title: 'Minimum Dead Time', detail: `Turn-off: ${dt.dt_turnoff_path_ns} ns | Turn-on: ${dt.dt_turnon_path_ns} ns`, theory: 'Absolute minimum to prevent shoot-through = td_off + tf + prop_delay_off + safety margin.' }} />
                <InfoRow label="Recommended" value={`${dt.dt_recommended_ns} ns`} bold
                  tip={{ title: 'Recommended Dead Time', detail: `dt_min + 20 ns margin = ${dt.dt_recommended_ns} ns`, theory: 'Use as register target. Rounds up to next available hardware step.' }} />
                <InfoRow label="Actual (quantised)" value={`${dt.dt_actual_ns} ns`} bold
                  color={dt.dt_actual_ns > dt.dt_recommended_ns * 1.5 ? 'var(--amber)' : 'var(--txt-1)'}
                  tip={tipDtActual} />
                <InfoRow label="Register count" value={`${dt.dt_register_count} steps`} />
                <InfoRow label="Resolution"     value={`${dt.dt_resolution_ns} ns/step`} />
                <InfoRow label="% of period"    value={`${dt.dt_pct_of_period}%`}
                  color={dt.dt_pct_of_period > 2 ? 'var(--amber)' : 'var(--green)'} bold tip={tipDtPct} />
                <InfoRow label="Duty loss"      value={`${dt.effective_duty_loss_pct}%`}
                  tip={{ title: 'Effective Duty Cycle Loss', detail: `${dt.effective_duty_loss_pct}%`, theory: 'Reduction in maximum achievable modulation index due to dead time insertion.' }} />
                <InfoRow label="MCU max dt"     value={`${dt.dt_max_ns} ns`} />
                {!dt.dt_feasible && (
                  <Alert color="rgba(239,68,68,.06)" border="rgba(239,68,68,.25)"
                    text="🚨 Dead time exceeds MCU maximum — reduce safety margin or choose a different MCU." />
                )}
                {hasCompPWM === false && (
                  <Alert color="rgba(245,158,11,.07)" border="rgba(245,158,11,.25)"
                    text="⚠ No hardware dead-time generator on this MCU. Values above are calculation targets only — software implementation required." />
                )}
              </div>

              {/* Right: path breakdown */}
              <div>
                <SubHead>
                  Path Breakdown ({dt.dt_limiting_path === 'turn_off' ? 'Turn-off limiting' : 'Turn-on limiting'})
                </SubHead>
                <div style={{ fontSize: 10, color: C.cyan, fontWeight: 600, marginBottom: 3 }}>
                  Turn-off → {dt.dt_turnoff_path_ns} ns
                </div>
                <InfoRow label="  td_off"          value={`${dt.td_off_ns} ns`} />
                <InfoRow label="  t_fall"           value={`${dt.tf_ns} ns`} />
                <InfoRow label="  prop_delay_off"   value={`${dt.prop_delay_off_ns} ns`} />
                <div style={{ fontSize: 10, color: C.cyan, fontWeight: 600, margin: '5px 0 3px' }}>
                  Turn-on → {dt.dt_turnon_path_ns} ns
                </div>
                <InfoRow label="  td_on"            value={`${dt.td_on_ns} ns`} />
                <InfoRow label="  t_rise"           value={`${dt.tr_ns} ns`} />
                <InfoRow label="  prop_delay_on"    value={`${dt.prop_delay_on_ns} ns`} />
                <InfoRow label="Body diode Vf"   value={`${dt.body_diode_vf_v} V`}
                  tip={{ title: 'Body Diode Forward Voltage', detail: `Vf = ${dt.body_diode_vf_v} V`, theory: 'MOSFET body diode conducts during every dead time interval. Sets the conduction loss per transition.' }} />
                <InfoRow label="Body diode loss" value={`${dt.body_diode_loss_total_w} W`}
                  color={dt.body_diode_loss_total_w > 2 ? 'var(--amber)' : 'var(--txt-1)'} bold
                  tip={tipBodyDiode} />
              </div>
            </div>
            <Alert color="rgba(245,158,11,.05)" border="rgba(245,158,11,.15)"
              text="⚠ Dead-time compensation mandatory in FOC firmware — uncorrected DT causes current distortion at low speed and low modulation index." />
          </> : <Placeholder />}
        </SectionCard>

      </div>

      {/* ── Right: calculations sidebar ───────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <CalculationsPanel />
      </div>

    </div>
  )
}

/* ─── helpers ──────────────────────────────────────────────────── */

function SectionCard({ icon, title, children }) {
  return (
    <div className="card" style={{ overflow: 'hidden', flexShrink: 0 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--txt-2)',
        textTransform: 'uppercase', letterSpacing: '.06em',
        padding: '9px 14px 7px', borderBottom: '1px solid var(--border-1)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span>{icon}</span> {title}
      </div>
      <div style={{ padding: '10px 14px' }}>{children}</div>
    </div>
  )
}

function SubHead({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, color: 'var(--txt-3)',
      textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
    }}>{children}</div>
  )
}

function ChainBlock({ color, label, sub, warn }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '6px 10px', borderRadius: 8, textAlign: 'center', minWidth: 72,
      background: warn ? 'rgba(239,68,68,.1)' : `${color}15`,
      border: `1px solid ${warn ? 'rgba(239,68,68,.4)' : color + '30'}`,
    }}>
      <span style={{ fontWeight: 600, fontSize: 11, color: warn ? C.red : color }}>{label}</span>
      <span style={{ fontSize: 9, color: 'var(--txt-3)', marginTop: 2 }}>{sub}</span>
    </div>
  )
}

function Arrow() {
  return <span style={{ color: 'var(--txt-3)', fontSize: 14, flexShrink: 0 }}>→</span>
}

function InfoRow({ label, value, bold, color, tip }) {
  return (
    <div {...tipProps(tip)} style={{
      display: 'flex', justifyContent: 'space-between', gap: 8,
      padding: '2px 0', borderBottom: '1px solid var(--border-1)',
      cursor: tip ? 'help' : 'default',
    }}>
      <span style={{ fontSize: 11, color: 'var(--txt-3)', flex: 1 }}>{label}</span>
      <span style={{
        fontSize: 11, fontFamily: 'var(--font-mono)',
        fontWeight: bold ? 700 : 500,
        color: color || (bold ? 'var(--txt-1)' : 'var(--txt-2)'),
        flexShrink: 0,
      }}>{value ?? '—'}</span>
    </div>
  )
}

// color prop MUST be a hex string (e.g. C.amber) for highlight bg/border to work
function ProtRow({ label, value, color, note, highlight, tip }) {
  const isVar = typeof color === 'string' && color.startsWith('var(')
  const bg     = isVar ? 'transparent'               : (highlight ? `${color}22` : `${color}12`)
  const border = isVar ? 'none'                       : (highlight ? `1px solid ${color}50` : 'none')
  return (
    <div {...tipProps(tip)} style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 8, padding: '2px 0', borderBottom: '1px solid var(--border-1)',
      cursor: tip ? 'help' : 'default',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--txt-2)' }}>{label}</div>
        {note && (
          <div style={{
            fontSize: 9, lineHeight: 1.3, marginTop: 1,
            color: highlight ? C.amber : note.startsWith('⚠') ? C.amber : 'var(--txt-3)',
          }}>{note}</div>
        )}
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)', fontWeight: 700, flexShrink: 0,
        padding: highlight ? '2px 8px' : '1px 6px', borderRadius: 4, fontSize: 11,
        background: bg, border, color,
      }}>{value}</span>
    </div>
  )
}

function Badge({ color, label, tip }) {
  const isHex = typeof color === 'string' && color.startsWith('#')
  return (
    <span {...tipProps(tip)} style={{
      fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
      background: isHex ? `${color}18` : 'rgba(136,136,136,0.1)',
      border: `1px solid ${isHex ? `${color}35` : 'rgba(136,136,136,0.25)'}`,
      color,
      cursor: tip ? 'help' : 'default',
    }}>{label}</span>
  )
}

function Alert({ color, border, text }) {
  return (
    <div style={{
      marginTop: 7, padding: '5px 8px', borderRadius: 5, fontSize: 10,
      lineHeight: 1.5, background: color, border: `1px solid ${border}`,
      color: 'var(--txt-2)',
    }}>{text}</div>
  )
}

function CritAlert({ text }) {
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 6, fontSize: 11, lineHeight: 1.6,
      background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.35)',
      color: 'var(--red)', fontWeight: 500,
    }}>🚨 {text}</div>
  )
}

function WarnAlert({ text }) {
  return (
    <div style={{
      padding: '7px 12px', borderRadius: 6, fontSize: 11, lineHeight: 1.6,
      background: 'rgba(245,158,11,.07)', border: '1px solid rgba(245,158,11,.25)',
      color: 'var(--amber)', fontWeight: 500,
    }}>⚠ {text}</div>
  )
}

function Placeholder() {
  return (
    <div style={{ color: 'var(--txt-3)', fontSize: 11, padding: '4px 0' }}>
      Run calculations first
    </div>
  )
}
