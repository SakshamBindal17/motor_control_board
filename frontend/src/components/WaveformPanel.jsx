import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import { useProject, buildParamsDict } from '../context/ProjectContext.jsx'

/* ═══════════════════════════════════════════════════════════════════════
   CHANNEL DEFINITIONS — Standard oscilloscope color palette
   ═══════════════════════════════════════════════════════════════════════ */

const CHANNELS = [
  { id: 'vgs', label: 'CH1 Vgs', short: 'Vgs', unit: 'V', color: '#FFD700', desc: 'Gate-Source Voltage' },
  { id: 'vds', label: 'CH2 Vds', short: 'Vds', unit: 'V', color: '#00CED1', desc: 'Drain-Source Voltage' },
  { id: 'id',  label: 'CH3 Id',  short: 'Id',  unit: 'A', color: '#32CD32', desc: 'Drain Current' },
  { id: 'ig',  label: 'CH4 Ig',  short: 'Ig',  unit: 'A', color: '#FF69B4', desc: 'Gate Current' },
  { id: 'pd',  label: 'CH5 Pd',  short: 'Pd',  unit: 'W', color: '#FF4444', desc: 'Instantaneous Power' },
]

const DEFAULT_VISIBLE = { vgs: true, vds: true, id: false, ig: false, pd: false }

/* ═══════════════════════════════════════════════════════════════════════
   FRONTEND WAVEFORM COMPUTATION
   Same 4-region model as backend, computed from extracted params
   so it works immediately when datasheets are uploaded (no Run All needed)
   ═══════════════════════════════════════════════════════════════════════ */

function extractSIParam(dict, key, unitMap) {
  const raw = dict[key]
  if (raw == null) return null
  const u = (dict[key + '__unit'] || '').trim()
  const m = unitMap[u] || Object.values(unitMap)[0] || 1
  return parseFloat(raw) * m
}

function extractDriverSIParams(blockState) {
  if (!blockState || blockState.status !== 'done') return null
  const dict = buildParamsDict(blockState)
  return {
    io_source: extractSIParam(dict, 'io_source', { 'A': 1 }) || 4,
    io_sink:   extractSIParam(dict, 'io_sink',   { 'A': 1 }) || 4,
  }
}

function extractMosfetSIParams(blockState) {
  if (!blockState || blockState.status !== 'done') return null
  const dict = buildParamsDict(blockState)
  return {
    ciss:     extractSIParam(dict, 'ciss',     { 'pF': 1e-12, 'nF': 1e-9, 'F': 1 }) || 3000e-12,
    coss:     extractSIParam(dict, 'coss',     { 'pF': 1e-12, 'nF': 1e-9, 'F': 1 }) || 500e-12,
    qg:       extractSIParam(dict, 'qg',       { 'nC': 1e-9, 'µC': 1e-6, 'C': 1 })  || 92e-9,
    qgd:      extractSIParam(dict, 'qgd',      { 'nC': 1e-9, 'µC': 1e-6, 'C': 1 })  || 30e-9,
    rds_on:   extractSIParam(dict, 'rds_on',   { 'mΩ': 1e-3, 'Ω': 1 })              || 1.5e-3,
    vgs_th:   extractSIParam(dict, 'vgs_th',   { 'V': 1 })     || 3.0,
    vgs_plateau: extractSIParam(dict, 'vgs_plateau', { 'V': 1 }),
    rg_int:   extractSIParam(dict, 'rg_int',   { 'Ω': 1, 'ohm': 1 }) || 1.0,
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   TRACE INDUCTANCE — microstrip over ground plane (image method)
   Uses acosh formula: L(nH) = 0.2 × l_mm × acosh(1 + 2h/w)
   Always positive, works for both narrow and wide traces.
   ═══════════════════════════════════════════════════════════════════════ */

function calcTraceInductance_nH(len, w, h) {
  if (!len || !w || !h || len <= 0 || w <= 0 || h <= 0) return 0
  // Loop partial inductance: rectangular trace over ground plane
  // acosh(x) = ln(x + √(x²-1)) for x >= 1 — always positive
  const x = 1 + 2 * h / w
  return 0.2 * len * Math.log(x + Math.sqrt(x * x - 1))
}

/* ═══════════════════════════════════════════════════════════════════════
   PARASITIC RLC OVERLAY — adds ringing when inductance > 0
   Physics: damped sinusoid  V(t) = A × e^(-ζω₀t) × sin(ωd×t)
     ω₀ = 1/√(LC), ζ = R/(2√(L/C)), ωd = ω₀√(1-ζ²)
   Ringing starts after Miller plateau (Vds transition), not after full switching.
   ═══════════════════════════════════════════════════════════════════════ */

function applyParasitics(waveform, systemSpecs, mosfetP, rg_on, rg_off,
                          dead_time, t_turn_on, flat_on, t_turn_off, regionTimes) {
  const gateL_nH = calcTraceInductance_nH(
    systemSpecs.gate_trace_length_mm || 0,
    systemSpecs.gate_trace_width_mm || 0,
    systemSpecs.gate_trace_height_mm || 0,
  )
  const powerL_nH = calcTraceInductance_nH(
    systemSpecs.power_trace_length_mm || 0,
    systemSpecs.power_trace_width_mm || 0,
    systemSpecs.power_trace_height_mm || 0,
  )

  const Lg = gateL_nH * 1e-9   // nH → H
  const Lp = powerL_nH * 1e-9  // nH → H
  if (Lg <= 0 && Lp <= 0) return waveform  // no parasitics → return ideal

  const ciss = mosfetP.ciss
  const coss = mosfetP.coss || 500e-12  // fallback Coss
  const n = waveform.time_ns.length
  const vgs = [...waveform.vgs]
  const vds = [...waveform.vds]
  const id  = [...waveform.id]
  const ig  = [...waveform.ig]

  // Key timing points (in ns)
  const tOnStart = dead_time * 1e9
  // Vds transition completes at end of Miller plateau (Region 3), NOT end of full transition
  const { t_r1, t_r2, t_r3, t_r4_off, t_r3_off } = regionTimes
  const tMillerOnEnd_ns  = tOnStart + (t_r1 + t_r2 + t_r3) * 1e9  // Vds done falling
  const tOnEnd_ns        = tOnStart + t_turn_on * 1e9
  const tFlatEnd_ns      = tOnEnd_ns + flat_on * 1e9
  // Turn-off: Vds rises during Miller off (Region 3')
  const tMillerOffEnd_ns = tFlatEnd_ns + (t_r4_off + t_r3_off) * 1e9  // Vds done rising
  const tOffEnd_ns       = tFlatEnd_ns + t_turn_off * 1e9

  const v_bus = systemSpecs.peak_voltage || 60
  const i_load = systemSpecs.max_phase_current || 80

  for (let i = 0; i < n; i++) {
    const t_ns = waveform.time_ns[i]

    // ── Gate loop ringing — LgCiss oscillation on Vgs ──
    // Superimposed during Region 4 (post-plateau) and after turn-off
    if (Lg > 0 && ciss > 0) {
      const R = (t_ns > tFlatEnd_ns) ? rg_off : rg_on
      const w0 = 1 / Math.sqrt(Lg * ciss)
      const zeta = R / (2 * Math.sqrt(Lg / ciss))

      if (zeta < 1) {
        const wd = w0 * Math.sqrt(1 - zeta * zeta)
        let dt_ring = -1

        // After turn-on Miller plateau: Vgs overshoots toward Vdrv
        if (t_ns > tMillerOnEnd_ns && t_ns < tFlatEnd_ns) {
          dt_ring = (t_ns - tMillerOnEnd_ns) * 1e-9
        }
        // After turn-off completes: Vgs rings around 0
        else if (t_ns > tOffEnd_ns) {
          dt_ring = (t_ns - tOffEnd_ns) * 1e-9
        }

        if (dt_ring > 0) {
          // Amplitude from energy stored in gate inductance: V = Ig × √(Lg/Ciss)
          const ig_peak = (t_ns > tFlatEnd_ns)
            ? mosfetP.vgs_plateau / rg_off   // turn-off Miller current
            : ((systemSpecs.gate_drive_voltage || 12) - (mosfetP.vgs_plateau || 5)) / rg_on
          const v_ring_amp = Math.min(ig_peak * Math.sqrt(Lg / ciss), 3.0) // cap at 3V
          const dir = (t_ns > tFlatEnd_ns) ? -1 : 1
          const ring = dir * v_ring_amp * Math.exp(-zeta * w0 * dt_ring) * Math.sin(wd * dt_ring)
          vgs[i] += ring
          ig[i]  += ring * ciss * wd * 0.5  // approximate Ig perturbation
        }
      }
    }

    // ── Power loop ringing — LpCoss oscillation on Vds ──
    // Starts after Miller plateau when Vds transition completes
    if (Lp > 0 && coss > 0) {
      const R_damp = 0.3 + (mosfetP.rds_on || 1.5e-3) * 1000  // trace R + Rds(on) contribution
      const w0 = 1 / Math.sqrt(Lp * coss)
      const zeta = R_damp / (2 * Math.sqrt(Lp / coss))

      if (zeta < 1) {
        const wd = w0 * Math.sqrt(1 - zeta * zeta)
        let dt_ring = -1
        let direction = 0

        // Turn-on: Vds just fell to Vds_on — ring below Vds_on
        if (t_ns > tMillerOnEnd_ns && t_ns < tFlatEnd_ns) {
          dt_ring = (t_ns - tMillerOnEnd_ns) * 1e-9
          direction = -1
        }
        // Turn-off: Vds just rose to Vbus — ring above Vbus (overshoot)
        else if (t_ns > tMillerOffEnd_ns) {
          dt_ring = (t_ns - tMillerOffEnd_ns) * 1e-9
          direction = 1
        }

        if (dt_ring > 0 && direction !== 0) {
          // V_spike = I × √(L/C) — characteristic impedance of parasitic LC
          // Real circuits see ~50% of theoretical (package parasitics, snubbing)
          const z_char = Math.sqrt(Lp / coss)
          const v_spike = Math.min(i_load * z_char * 0.5, v_bus * 0.5)  // realistic cap
          const ring = direction * v_spike * Math.exp(-zeta * w0 * dt_ring) * Math.sin(wd * dt_ring)
          vds[i] += ring
          // Parasitic ringing also perturbs Id slightly via Coss dV/dt
          id[i] += coss * ring * wd * direction * 0.2
        }
      }
    }
  }

  // Recalculate Pd with parasitic-modified signals
  const pd = vds.map((v, i) => Math.round(v * id[i] * 10) / 10)

  const hasGate = Lg > 0
  const hasPower = Lp > 0
  let note = waveform.model_note
  if (hasGate || hasPower) {
    note = `Includes parasitic effects: ${hasGate ? `gate loop ${(Lg*1e9).toFixed(1)}nH` : ''}${hasGate && hasPower ? ', ' : ''}${hasPower ? `power loop ${(Lp*1e9).toFixed(1)}nH` : ''}. ` + note
  }

  const R_gate = rg_on
  const R_power = 0.3 + (mosfetP.rds_on || 1.5e-3) * 1000
  return {
    ...waveform,
    vgs: vgs.map(v => Math.round(v * 1000) / 1000),
    vds: vds.map(v => Math.round(v * 100) / 100),
    id: id.map(v => Math.round(v * 100) / 100),
    ig: ig.map(v => Math.round(v * 1000) / 1000),
    pd,
    model_note: note,
    parasitics: {
      gate_loop_nh: Math.round(Lg * 1e9 * 10) / 10,
      power_loop_nh: Math.round(Lp * 1e9 * 10) / 10,
      gate_damping: Lg > 0 && ciss > 0 ? Math.round(R_gate / (2 * Math.sqrt(Lg / ciss)) * 100) / 100 : null,
      power_damping: Lp > 0 && coss > 0 ? Math.round(R_power / (2 * Math.sqrt(Lp / coss)) * 100) / 100 : null,
    },
  }
}


function computeWaveformFrontend(mosfetP, driverP, systemSpecs, gateCalc) {
  if (!mosfetP) return null

  const ciss     = mosfetP.ciss
  const qgd      = mosfetP.qgd
  const rds_on   = mosfetP.rds_on
  const vgs_th   = mosfetP.vgs_th
  const rg_int   = mosfetP.rg_int

  const io_source = driverP?.io_source || 4
  const io_sink   = driverP?.io_sink   || 4

  // Use overrides from system_specs if provided, else use calculated values
  const v_drv  = parseFloat(systemSpecs.vgs_drive_override) || systemSpecs.gate_drive_voltage || 12
  const v_bus  = parseFloat(systemSpecs.vds_override) || systemSpecs.peak_voltage || 60
  const i_load = parseFloat(systemSpecs.id_override) || systemSpecs.max_phase_current || 80

  const rg_on_ext  = parseFloat(systemSpecs.rg_on_override) || gateCalc?.rg_on_recommended_ohm || 4.7
  const rg_off_ext = parseFloat(systemSpecs.rg_off_override) || gateCalc?.rg_off_recommended_ohm || 2.2

  const rg_on  = rg_int + rg_on_ext
  const rg_off = rg_int + rg_off_ext

  let vgs_pl = mosfetP.vgs_plateau
  if (vgs_pl == null) vgs_pl = vgs_th + 1.0
  vgs_pl = Math.max(vgs_th + 0.2, Math.min(vgs_pl, v_drv - 0.5))

  const vds_on = i_load * rds_on * 1.5
  const tau_on  = rg_on * ciss
  const tau_off = rg_off * ciss

  // Turn-on region durations
  const t_r1 = (v_drv > vgs_th && tau_on > 0) ? -tau_on * Math.log(1 - vgs_th / v_drv) : 10e-9
  const t_r1_r2 = (v_drv > vgs_pl && tau_on > 0) ? -tau_on * Math.log(1 - vgs_pl / v_drv) : t_r1 + 5e-9
  const t_r2 = Math.max(0, t_r1_r2 - t_r1)

  let ig_miller_on = (v_drv - vgs_pl) / rg_on
  ig_miller_on = Math.min(ig_miller_on, io_source)
  const t_r3 = ig_miller_on > 0 ? qgd / ig_miller_on : 20e-9

  let t_r4 = tau_on > 0 ? -tau_on * Math.log(0.02) : 20e-9
  t_r4 = Math.min(t_r4, 200e-9)

  const t_turn_on = t_r1 + t_r2 + t_r3 + t_r4

  // Turn-off region durations
  let t_r4_off = (v_drv > 0 && tau_off > 0) ? -tau_off * Math.log(vgs_pl / v_drv) : 20e-9
  t_r4_off = Math.min(t_r4_off, 200e-9)

  let ig_miller_off = vgs_pl / rg_off
  ig_miller_off = Math.min(ig_miller_off, io_sink)
  const t_r3_off = ig_miller_off > 0 ? qgd / ig_miller_off : 20e-9

  let t_r2_off = (vgs_pl > 0 && tau_off > 0 && vgs_th < vgs_pl) ? -tau_off * Math.log(vgs_th / vgs_pl) : 5e-9
  t_r2_off = Math.min(t_r2_off, 50e-9)

  let t_r1_off = (vgs_th > 0.02 && tau_off > 0) ? -tau_off * Math.log(0.02 / vgs_th) : 20e-9
  t_r1_off = Math.min(t_r1_off, 200e-9)

  const t_turn_off = t_r4_off + t_r3_off + t_r2_off + t_r1_off

  // Dead time
  const dead_time = Math.min(2e-6, Math.max(50e-9, t_turn_off * 1.3 + 50e-9))

  // View window: show transitions with some flat time around them
  const flat_on  = Math.max(t_turn_on * 1.5, 100e-9)
  const flat_off_pad = Math.max(t_turn_off, 100e-9)
  const total_view = dead_time + t_turn_on + flat_on + t_turn_off + dead_time + flat_off_pad

  // Sample ~800 points
  const n_points = 800
  const dt_step = total_view / n_points

  const time_ns = [], vgs = [], vds = [], id = [], ig = [], pd = []

  for (let i = 0; i < n_points; i++) {
    const t = i * dt_step
    const s = sampleWaveform(
      t, v_drv, v_bus, i_load, vgs_th, vgs_pl, vds_on,
      rg_on, rg_off, tau_on, tau_off,
      ig_miller_on, ig_miller_off,
      t_r1, t_r2, t_r3, t_r4,
      t_r4_off, t_r3_off, t_r2_off, t_r1_off,
      dead_time, t_turn_on, flat_on, t_turn_off,
    )
    time_ns.push(Math.round(t * 1e9 * 100) / 100)
    vgs.push(Math.round(s[0] * 1000) / 1000)
    vds.push(Math.round(s[1] * 100) / 100)
    id.push(Math.round(s[2] * 100) / 100)
    ig.push(Math.round(s[3] * 1000) / 1000)
    pd.push(Math.round(s[1] * s[2] * 10) / 10)
  }

  const idealResult = {
    time_ns, vgs, vds, id, ig, pd,
    annotations: {
      turn_on: {
        t_r1_ns: Math.round(t_r1 * 1e10) / 10,
        t_r2_ns: Math.round(t_r2 * 1e10) / 10,
        t_miller_on_ns: Math.round(t_r3 * 1e10) / 10,
        t_r4_ns: Math.round(t_r4 * 1e10) / 10,
        total_on_ns: Math.round(t_turn_on * 1e10) / 10,
        ig_miller_on_a: Math.round(ig_miller_on * 100) / 100,
      },
      turn_off: {
        t_r4_off_ns: Math.round(t_r4_off * 1e10) / 10,
        t_miller_off_ns: Math.round(t_r3_off * 1e10) / 10,
        t_r2_off_ns: Math.round(t_r2_off * 1e10) / 10,
        t_r1_off_ns: Math.round(t_r1_off * 1e10) / 10,
        total_off_ns: Math.round(t_turn_off * 1e10) / 10,
        ig_miller_off_a: Math.round(ig_miller_off * 100) / 100,
      },
      dead_time_ns: Math.round(dead_time * 1e10) / 10,
      vgs_plateau_v: Math.round(vgs_pl * 100) / 100,
      vgs_threshold_v: Math.round(vgs_th * 100) / 100,
    },
    params_used: {
      ciss_pf: Math.round(ciss * 1e12),
      qg_nc: Math.round(mosfetP.qg * 1e10) / 10,
      qgd_nc: Math.round(qgd * 1e10) / 10,
      rds_on_mohm: Math.round(rds_on * 1e5) / 100,
      vgs_th_v: Math.round(vgs_th * 100) / 100,
      vgs_pl_v: Math.round(vgs_pl * 100) / 100,
      rg_int_ohm: Math.round(rg_int * 100) / 100,
      rg_on_ext_ohm: rg_on_ext,
      rg_off_ext_ohm: rg_off_ext,
      v_drv_v: v_drv,
      v_bus_v: v_bus,
      i_load_a: i_load,
      fsw_khz: (systemSpecs.pwm_freq_hz || 20000) / 1000,
    },
    model_note: 'Analytical 4-region MOSFET switching model. Assumes linear Ciss/Cgd, constant load current, and ideal gate driver current limiting. Waveform shapes and timing are representative — for exact behavior, validate with oscilloscope measurement.',
  }

  // Apply parasitic RLC effects if inductance values are present
  const regionTimes = { t_r1, t_r2, t_r3, t_r4, t_r4_off, t_r3_off, t_r2_off, t_r1_off }
  return applyParasitics(idealResult, systemSpecs, mosfetP, rg_on, rg_off, dead_time, t_turn_on, flat_on, t_turn_off, regionTimes)
}

function sampleWaveform(
  t, v_drv, v_bus, i_load, vgs_th, vgs_pl, vds_on,
  rg_on, rg_off, tau_on, tau_off,
  ig_miller_on, ig_miller_off,
  t_r1, t_r2, t_r3, t_r4,
  t_r4_off, t_r3_off, t_r2_off, t_r1_off,
  dead_time, t_turn_on, flat_on, t_turn_off,
) {
  const t_on_start = dead_time
  const t_on_end   = dead_time + t_turn_on
  const t_flat_end = t_on_end + flat_on
  const t_off_end  = t_flat_end + t_turn_off

  // Dead time (before turn-on)
  if (t < t_on_start) return [0, v_bus, 0, 0]

  // Turn-on
  if (t < t_on_end) {
    const tl = t - t_on_start
    // Region 1: Pre-threshold
    if (tl < t_r1) {
      const vgs = tau_on > 0 ? v_drv * (1 - Math.exp(-tl / tau_on)) : 0
      const ig = rg_on > 0 ? (v_drv - vgs) / rg_on : 0
      return [vgs, v_bus, 0, ig]
    }
    // Region 2: Active (Vth → Vplateau, Id ramps)
    if (tl < t_r1 + t_r2) {
      const vgs = tau_on > 0 ? Math.min(vgs_pl, v_drv * (1 - Math.exp(-tl / tau_on))) : vgs_pl
      const frac = t_r2 > 0 ? Math.min(1, Math.max(0, (tl - t_r1) / t_r2)) : 1
      const i_d = i_load * frac
      const ig = rg_on > 0 ? (v_drv - vgs) / rg_on : 0
      return [vgs, v_bus, i_d, ig]
    }
    // Region 3: Miller plateau (Vgs flat, Vds drops)
    if (tl < t_r1 + t_r2 + t_r3) {
      const frac = t_r3 > 0 ? Math.min(1, Math.max(0, (tl - t_r1 - t_r2) / t_r3)) : 1
      const v_ds = v_bus - (v_bus - vds_on) * frac
      return [vgs_pl, v_ds, i_load, ig_miller_on]
    }
    // Region 4: Post-plateau (Vplateau → Vdrv)
    const tl4 = tl - t_r1 - t_r2 - t_r3
    const vgs = tau_on > 0 ? v_drv - (v_drv - vgs_pl) * Math.exp(-tl4 / tau_on) : v_drv
    const ig = rg_on > 0 ? (v_drv - vgs) / rg_on : 0
    return [vgs, vds_on, i_load, ig]
  }

  // Fully on (flat)
  if (t < t_flat_end) return [v_drv, vds_on, i_load, 0]

  // Turn-off
  if (t < t_off_end) {
    const tl = t - t_flat_end
    // Region 4': Vdrv → Vplateau
    if (tl < t_r4_off) {
      const vgs = tau_off > 0 ? Math.max(vgs_pl, v_drv * Math.exp(-tl / tau_off)) : vgs_pl
      const ig = rg_off > 0 ? -vgs / rg_off : 0
      return [vgs, vds_on, i_load, ig]
    }
    // Region 3': Miller plateau (Vgs flat, Vds rises)
    if (tl < t_r4_off + t_r3_off) {
      const frac = t_r3_off > 0 ? Math.min(1, Math.max(0, (tl - t_r4_off) / t_r3_off)) : 1
      const v_ds = vds_on + (v_bus - vds_on) * frac
      return [vgs_pl, v_ds, i_load, -ig_miller_off]
    }
    // Region 2': Active (Vplateau → Vth, Id falls)
    if (tl < t_r4_off + t_r3_off + t_r2_off) {
      const frac = t_r2_off > 0 ? Math.min(1, Math.max(0, (tl - t_r4_off - t_r3_off) / t_r2_off)) : 1
      const vgs = vgs_pl - (vgs_pl - vgs_th) * frac
      const i_d = i_load * (1 - frac)
      const ig = rg_off > 0 ? -vgs / rg_off : 0
      return [vgs, v_bus, i_d, ig]
    }
    // Region 1': Sub-threshold (Vth → 0)
    const tl1 = tl - t_r4_off - t_r3_off - t_r2_off
    const vgs = tau_off > 0 ? vgs_th * Math.exp(-tl1 / tau_off) : 0
    const ig = rg_off > 0 ? -vgs / rg_off : 0
    return [vgs, v_bus, 0, ig]
  }

  // Dead time (after turn-off)
  return [0, v_bus, 0, 0]
}


/* ═══════════════════════════════════════════════════════════════════════
   NICE SCALE — human-readable axis ticks
   ═══════════════════════════════════════════════════════════════════════ */

function niceScale(min, max, maxTicks = 8) {
  const range = max - min || 1
  const roughStep = range / maxTicks
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const residual = roughStep / mag
  let niceStep
  if (residual <= 1.5) niceStep = 1 * mag
  else if (residual <= 3) niceStep = 2 * mag
  else if (residual <= 7) niceStep = 5 * mag
  else niceStep = 10 * mag

  const niceMin = Math.floor(min / niceStep) * niceStep
  const niceMax = Math.ceil(max / niceStep) * niceStep
  const ticks = []
  for (let v = niceMin; v <= niceMax + niceStep * 0.5; v += niceStep) {
    ticks.push(parseFloat(v.toPrecision(10)))
  }
  return { min: niceMin, max: niceMax, step: niceStep, ticks }
}

function fmtAxis(v, range) {
  if (Math.abs(v) < 1e-10) return '0'
  if (range < 0.5) return v.toFixed(3)
  if (range < 5) return v.toFixed(2)
  if (range < 50) return v.toFixed(1)
  return v.toFixed(0)
}


/* ═══════════════════════════════════════════════════════════════════════
   CANVAS RENDERER
   ═══════════════════════════════════════════════════════════════════════ */

function drawScope(canvas, waveform, visibleChannels, viewWindow) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !waveform) return

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.scale(dpr, dpr)

  // Layout: leave space for channel badges at top
  const activeChannels = CHANNELS.filter(ch => visibleChannels[ch.id] && waveform[ch.id])
  const badgeBarH = 22
  const pad = { top: 10 + badgeBarH, right: 20, bottom: 46, left: 58 }
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom

  // ── Background ──
  const bgGrad = ctx.createLinearGradient(0, 0, 0, h)
  bgGrad.addColorStop(0, '#080818')
  bgGrad.addColorStop(1, '#0c0c1e')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, w, h)

  // CRT vignette
  const vign = ctx.createRadialGradient(w / 2, h / 2, plotW * 0.3, w / 2, h / 2, w * 0.8)
  vign.addColorStop(0, 'rgba(0,0,0,0)')
  vign.addColorStop(1, 'rgba(0,0,0,0.25)')
  ctx.fillStyle = vign
  ctx.fillRect(0, 0, w, h)

  // ── Data ──
  const timeArr = waveform.time_ns
  if (!timeArr || timeArr.length === 0) return

  const tMin = viewWindow.tMin
  const tMax = viewWindow.tMax
  const tRange = tMax - tMin || 1
  const xScale = niceScale(tMin, tMax, 10)

  // ── Grid ──
  // Minor
  ctx.lineWidth = 0.5
  ctx.strokeStyle = 'rgba(255,255,255,0.02)'
  const minorXStep = xScale.step / 5
  for (let t = xScale.min; t <= xScale.max; t += minorXStep) {
    const x = pad.left + ((t - tMin) / tRange) * plotW
    if (x < pad.left || x > pad.left + plotW) continue
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke()
  }
  const nMajorY = 8
  const minorYStep = plotH / (nMajorY * 5)
  for (let y = pad.top; y <= pad.top + plotH; y += minorYStep) {
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke()
  }
  // Major
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 0.7
  for (const t of xScale.ticks) {
    const x = pad.left + ((t - tMin) / tRange) * plotW
    if (x < pad.left - 1 || x > pad.left + plotW + 1) continue
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke()
  }
  for (let i = 0; i <= nMajorY; i++) {
    const y = pad.top + (plotH / nMajorY) * i
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke()
  }

  // Center crosshair
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 0.7
  ctx.setLineDash([4, 4])
  ctx.beginPath(); ctx.moveTo(pad.left + plotW / 2, pad.top); ctx.lineTo(pad.left + plotW / 2, pad.top + plotH); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top + plotH / 2); ctx.lineTo(pad.left + plotW, pad.top + plotH / 2); ctx.stroke()
  ctx.setLineDash([])

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(pad.left, pad.top, plotW, plotH)

  // ── Per-channel Y scales ──
  const channelScales = {}
  for (const ch of activeChannels) {
    const data = waveform[ch.id]
    let yMin = Infinity, yMax = -Infinity
    for (let i = 0; i < data.length; i++) {
      // Use ALL data points for Y scale, not just visible — prevents axis jumping during pan
      yMin = Math.min(yMin, data[i])
      yMax = Math.max(yMax, data[i])
    }
    if (yMin > 0 && yMin < yMax * 0.15) yMin = 0
    const yPad = Math.max((yMax - yMin) * 0.12, 0.3)
    yMin -= yPad * 0.3
    yMax += yPad
    channelScales[ch.id] = niceScale(yMin, yMax, nMajorY)
  }

  // ── Draw traces ──
  for (const ch of activeChannels) {
    const data = waveform[ch.id]
    const scale = channelScales[ch.id]
    if (!scale) continue
    const yRange = scale.max - scale.min || 1

    // Glow
    ctx.strokeStyle = ch.color
    ctx.lineWidth = 5
    ctx.globalAlpha = 0.1
    ctx.beginPath()
    let started = false
    for (let i = 0; i < data.length; i++) {
      const t = timeArr[i]
      if (t < tMin || t > tMax) continue
      const x = pad.left + ((t - tMin) / tRange) * plotW
      const y = pad.top + plotH - ((data[i] - scale.min) / yRange) * plotH
      if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Main
    ctx.lineWidth = 1.8
    ctx.globalAlpha = 0.92
    ctx.beginPath()
    started = false
    for (let i = 0; i < data.length; i++) {
      const t = timeArr[i]
      if (t < tMin || t > tMax) continue
      const x = pad.left + ((t - tMin) / tRange) * plotW
      const y = pad.top + plotH - ((data[i] - scale.min) / yRange) * plotH
      if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // ── Channel badges — HORIZONTAL bar at top of scope ──
  {
    const badgeY = 6
    let cursorX = w - pad.right
    ctx.font = 'bold 9px "JetBrains Mono", "Fira Code", monospace'
    ctx.textAlign = 'right'

    // Draw from right to left
    for (let ci = activeChannels.length - 1; ci >= 0; ci--) {
      const ch = activeChannels[ci]
      const scale = channelScales[ch.id]
      const vPerDiv = scale.step
      const label = `${ch.short}: ${vPerDiv < 1 ? vPerDiv.toFixed(2) : vPerDiv.toFixed(1)} ${ch.unit}/div`
      const tw = ctx.measureText(label).width

      // Background pill
      ctx.fillStyle = ch.color + '15'
      ctx.beginPath()
      ctx.roundRect(cursorX - tw - 12, badgeY, tw + 12, 16, 4)
      ctx.fill()
      ctx.strokeStyle = ch.color + '30'
      ctx.lineWidth = 1
      ctx.stroke()

      // Text
      ctx.fillStyle = ch.color
      ctx.globalAlpha = 0.95
      ctx.fillText(label, cursorX - 6, badgeY + 12)
      ctx.globalAlpha = 1

      cursorX -= tw + 18
    }
  }

  // ── X-axis tick labels ──
  ctx.font = '9px "JetBrains Mono", "Fira Code", monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(200,220,255,0.6)'
  for (const t of xScale.ticks) {
    const x = pad.left + ((t - tMin) / tRange) * plotW
    if (x < pad.left - 5 || x > pad.left + plotW + 5) continue
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x, pad.top + plotH); ctx.lineTo(x, pad.top + plotH + 4); ctx.stroke()
    ctx.fillText(fmtAxis(t, tRange), x, pad.top + plotH + 15)
  }
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillStyle = 'rgba(200,220,255,0.5)'
  ctx.fillText('Time (ns)', pad.left + plotW / 2, pad.top + plotH + 32)

  // ns/div badge
  ctx.font = 'bold 9px "JetBrains Mono", monospace'
  ctx.fillStyle = 'rgba(130,180,255,0.5)'
  ctx.textAlign = 'left'
  ctx.fillText(`${xScale.step < 1 ? xScale.step.toFixed(2) : xScale.step.toFixed(1)} ns/div`, pad.left + 4, pad.top + plotH + 32)

  // ── Y-axis labels for first channel ──
  if (activeChannels.length > 0) {
    const ch0 = activeChannels[0]
    const scale0 = channelScales[ch0.id]
    const yRange0 = scale0.max - scale0.min
    ctx.font = '9px "JetBrains Mono", monospace'
    ctx.fillStyle = ch0.color + '90'
    ctx.textAlign = 'right'
    for (const v of scale0.ticks) {
      const y = pad.top + plotH - ((v - scale0.min) / yRange0) * plotH
      if (y < pad.top - 5 || y > pad.top + plotH + 5) continue
      ctx.fillText(fmtAxis(v, yRange0), pad.left - 5, y + 3)
      ctx.strokeStyle = ch0.color + '30'
      ctx.lineWidth = 0.7
      ctx.beginPath(); ctx.moveTo(pad.left - 3, y); ctx.lineTo(pad.left, y); ctx.stroke()
    }
    // Y label
    ctx.save()
    ctx.translate(12, pad.top + plotH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.font = '9px -apple-system, sans-serif'
    ctx.fillStyle = ch0.color + '70'
    ctx.textAlign = 'center'
    ctx.fillText(`${ch0.short} (${ch0.unit})`, 0, 0)
    ctx.restore()
  }

  // ── Vth / Vplateau reference lines ──
  const ann = waveform.annotations
  if (ann && visibleChannels.vgs && channelScales['vgs']) {
    const vgsS = channelScales['vgs']
    const yR = vgsS.max - vgsS.min
    const drawRef = (val, label, col) => {
      const y = pad.top + plotH - ((val - vgsS.min) / yR) * plotH
      if (y < pad.top || y > pad.top + plotH) return
      ctx.strokeStyle = col
      ctx.lineWidth = 0.6
      ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.font = '8px "JetBrains Mono", monospace'
      ctx.fillStyle = col
      ctx.textAlign = 'left'
      ctx.fillText(label, pad.left + 4, y - 3)
    }
    if (ann.vgs_threshold_v) drawRef(ann.vgs_threshold_v, `Vth=${ann.vgs_threshold_v}V`, 'rgba(255,215,0,0.4)')
    if (ann.vgs_plateau_v) drawRef(ann.vgs_plateau_v, `Vpl=${ann.vgs_plateau_v}V`, 'rgba(255,215,0,0.4)')
  }

  // ── Timing brackets on waveform ──
  if (ann && visibleChannels.vgs) {
    const dtNs = ann.dead_time_ns || 0
    const onAnn = ann.turn_on || {}
    const bracketY = pad.top + plotH - 6
    const drawBracket = (t0, dur, label) => {
      if (dur < 0.5) return
      const t1 = t0 + dur
      if (t1 < tMin || t0 > tMax) return
      const x1 = pad.left + Math.max(0, ((t0 - tMin) / tRange)) * plotW
      const x2 = pad.left + Math.min(1, ((t1 - tMin) / tRange)) * plotW
      if (x2 - x1 < 10) return
      ctx.strokeStyle = 'rgba(255,215,0,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x1, bracketY - 3); ctx.lineTo(x1, bracketY); ctx.lineTo(x2, bracketY); ctx.lineTo(x2, bracketY - 3)
      ctx.stroke()
      ctx.font = '7px "JetBrains Mono", monospace'
      ctx.fillStyle = 'rgba(255,215,0,0.35)'
      ctx.textAlign = 'center'
      ctx.fillText(label, (x1 + x2) / 2, bracketY - 5)
    }
    let cursor = dtNs
    if (onAnn.t_r1_ns > 0) { drawBracket(cursor, onAnn.t_r1_ns, `td ${onAnn.t_r1_ns.toFixed(0)}ns`); cursor += onAnn.t_r1_ns }
    if (onAnn.t_r2_ns > 0) { drawBracket(cursor, onAnn.t_r2_ns, `tr ${onAnn.t_r2_ns.toFixed(0)}ns`); cursor += onAnn.t_r2_ns }
    if (onAnn.t_miller_on_ns > 0) { drawBracket(cursor, onAnn.t_miller_on_ns, `Miller ${onAnn.t_miller_on_ns.toFixed(0)}ns`); cursor += onAnn.t_miller_on_ns }
  }

  // Disclaimer
  ctx.font = '8px -apple-system, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.textAlign = 'right'
  ctx.fillText('Analytical 4-region model', w - 6, h - 4)
}


/* ═══════════════════════════════════════════════════════════════════════
   WAVEFORM PANEL
   ═══════════════════════════════════════════════════════════════════════ */

export default function WaveformPanel() {
  const { state, dispatch } = useProject()
  const { project } = state
  const canvasRef = useRef(null)
  const [visible, setVisible] = useState(DEFAULT_VISIBLE)

  // Use backend waveform if available; otherwise compute in frontend
  const mosfetParams = useMemo(() => extractMosfetSIParams(project.blocks.mosfet), [project.blocks.mosfet])
  const driverParams = useMemo(() => extractDriverSIParams(project.blocks.driver), [project.blocks.driver])
  const gateCalc = project.calculations?.gate_resistors

  const frontendWaveform = useMemo(
    () => computeWaveformFrontend(mosfetParams, driverParams, project.system_specs, gateCalc),
    [mosfetParams, driverParams, project.system_specs, gateCalc]
  )

  // Always prefer frontend waveform (respects user overrides in real-time)
  // Only fall back to backend waveform if frontend can't compute (no MOSFET data)
  const waveform = frontendWaveform || project.calculations?.waveform
  const hasData = waveform && waveform.time_ns && waveform.time_ns.length > 0

  // View window (pan/zoom)
  const fullRange = useMemo(() => {
    if (!hasData) return { tMin: 0, tMax: 100 }
    const t = waveform.time_ns
    return { tMin: t[0], tMax: t[t.length - 1] }
  }, [hasData, waveform])

  const [viewWindow, setViewWindow] = useState(fullRange)
  useEffect(() => { setViewWindow(fullRange) }, [fullRange])

  const zoomLevel = useMemo(() => {
    const fs = fullRange.tMax - fullRange.tMin || 1
    const vs = viewWindow.tMax - viewWindow.tMin || 1
    return fs / vs
  }, [fullRange, viewWindow])

  // ── Zoom at point ──
  const zoomAtPoint = useCallback((factor, clientX) => {
    if (!canvasRef.current || !hasData) return
    setViewWindow(prev => {
      const rect = canvasRef.current.getBoundingClientRect()
      const padL = 58, padR = 20
      const plotW = rect.width - padL - padR
      const relX = Math.max(0, Math.min(1, (clientX - rect.left - padL) / plotW))
      const span = prev.tMax - prev.tMin
      const focusT = prev.tMin + span * relX
      const fullSpan = fullRange.tMax - fullRange.tMin
      const minSpan = fullSpan / 10  // max 10x zoom
      const newSpan = Math.max(minSpan, Math.min(fullSpan, span / factor))
      let tMin = focusT - newSpan * relX
      let tMax = focusT + newSpan * (1 - relX)
      if (tMin < fullRange.tMin) { tMax += fullRange.tMin - tMin; tMin = fullRange.tMin }
      if (tMax > fullRange.tMax) { tMin -= tMax - fullRange.tMax; tMax = fullRange.tMax }
      return { tMin: Math.max(fullRange.tMin, tMin), tMax: Math.min(fullRange.tMax, tMax) }
    })
  }, [hasData, fullRange])

  const panBy = useCallback((deltaNs) => {
    setViewWindow(prev => {
      const span = prev.tMax - prev.tMin
      let tMin = prev.tMin + deltaNs
      let tMax = prev.tMax + deltaNs
      if (tMin < fullRange.tMin) { tMin = fullRange.tMin; tMax = tMin + span }
      if (tMax > fullRange.tMax) { tMax = fullRange.tMax; tMin = tMax - span }
      return { tMin, tMax }
    })
  }, [fullRange])

  // Wheel zoom/pan
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !hasData) return
    const handler = (e) => {
      e.preventDefault()
      if (e.ctrlKey) {
        zoomAtPoint(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX)
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const span = viewWindow.tMax - viewWindow.tMin
        panBy((e.deltaX || e.deltaY) * span * 0.002)
      } else {
        zoomAtPoint(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX)
      }
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [hasData, zoomAtPoint, panBy, viewWindow])

  // Ref to track current viewWindow without causing effect re-runs
  const viewWindowRef = useRef(viewWindow)
  useEffect(() => { viewWindowRef.current = viewWindow }, [viewWindow])

  // Left-click drag to pan — uses refs to avoid effect re-running on state change
  const dragRef = useRef({ dragging: false, lastX: 0 })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !hasData) return

    const onMouseDown = (e) => {
      if (e.button === 0) {
        e.preventDefault()
        dragRef.current.dragging = true
        dragRef.current.lastX = e.clientX
        canvas.style.cursor = 'grabbing'
      }
    }
    const onMouseMove = (e) => {
      if (!dragRef.current.dragging) return
      const diffPx = e.clientX - dragRef.current.lastX
      if (Math.abs(diffPx) > 0) {
        const rect = canvas.getBoundingClientRect()
        const plotW = rect.width - 78
        const vw = viewWindowRef.current
        const span = vw.tMax - vw.tMin
        panBy(-diffPx / plotW * span)
        dragRef.current.lastX = e.clientX
      }
    }
    const onMouseUp = (e) => {
      if (e.button === 0 && dragRef.current.dragging) {
        dragRef.current.dragging = false
        canvas.style.cursor = 'default'
      }
    }
    const onMouseLeave = () => {
      if (dragRef.current.dragging) {
        dragRef.current.dragging = false
        canvas.style.cursor = 'default'
      }
    }

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('mouseleave', onMouseLeave)
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [hasData, panBy])

  // Touch pinch+pan
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !hasData) return
    let lastTouches = null, lastDist = null
    const onStart = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        lastTouches = Array.from(e.touches)
        const dx = e.touches[1].clientX - e.touches[0].clientX
        const dy = e.touches[1].clientY - e.touches[0].clientY
        lastDist = Math.sqrt(dx * dx + dy * dy)
      }
    }
    const onMove = (e) => {
      if (e.touches.length === 2 && lastTouches && lastDist) {
        e.preventDefault()
        const dx = e.touches[1].clientX - e.touches[0].clientX
        const dy = e.touches[1].clientY - e.touches[0].clientY
        const dist = Math.sqrt(dx * dx + dy * dy)
        const scale = dist / lastDist
        if (Math.abs(scale - 1) > 0.01) {
          zoomAtPoint(scale, (e.touches[0].clientX + e.touches[1].clientX) / 2)
          lastDist = dist
        }
        const prevMidX = (lastTouches[0].clientX + lastTouches[1].clientX) / 2
        const currMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2
        const diffPx = currMidX - prevMidX
        if (Math.abs(diffPx) > 1) {
          const rect = canvas.getBoundingClientRect()
          const plotW = rect.width - 78
          const span = viewWindow.tMax - viewWindow.tMin
          panBy(-diffPx / plotW * span)
        }
        lastTouches = Array.from(e.touches)
      }
    }
    const onEnd = () => { lastTouches = null; lastDist = null }
    canvas.addEventListener('touchstart', onStart, { passive: false })
    canvas.addEventListener('touchmove', onMove, { passive: false })
    canvas.addEventListener('touchend', onEnd)
    return () => { canvas.removeEventListener('touchstart', onStart); canvas.removeEventListener('touchmove', onMove); canvas.removeEventListener('touchend', onEnd) }
  }, [hasData, zoomAtPoint, panBy, viewWindow])

  // Redraw
  useEffect(() => {
    if (!canvasRef.current || !hasData) return
    drawScope(canvasRef.current, waveform, visible, viewWindow)
  }, [waveform, visible, viewWindow, hasData])

  useEffect(() => {
    if (!canvasRef.current) return
    const ro = new ResizeObserver(() => { if (hasData) drawScope(canvasRef.current, waveform, visible, viewWindow) })
    ro.observe(canvasRef.current)
    return () => ro.disconnect()
  }, [waveform, visible, viewWindow, hasData])

  const toggleChannel = useCallback((id) => setVisible(prev => ({ ...prev, [id]: !prev[id] })), [])

  const exportPNG = useCallback(() => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    link.download = `waveform_${zoomLevel.toFixed(1)}x.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }, [zoomLevel])

  const handleZoomSlider = useCallback((e) => {
    const z = parseFloat(e.target.value)
    const fs = fullRange.tMax - fullRange.tMin
    const ns = fs / z
    const center = (viewWindow.tMin + viewWindow.tMax) / 2
    let tMin = center - ns / 2, tMax = center + ns / 2
    if (tMin < fullRange.tMin) { tMin = fullRange.tMin; tMax = tMin + ns }
    if (tMax > fullRange.tMax) { tMax = fullRange.tMax; tMin = tMax - ns }
    setViewWindow({ tMin: Math.max(fullRange.tMin, tMin), tMax: Math.min(fullRange.tMax, tMax) })
  }, [fullRange, viewWindow])

  const resetZoom = useCallback(() => setViewWindow(fullRange), [fullRange])

  const ann = waveform?.annotations
  const params = waveform?.params_used
  const isFromFrontend = !project.calculations?.waveform && !!frontendWaveform

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
        <span style={{ fontSize: 22 }}>🔬</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt-1)' }}>Switching Waveform Simulator</div>
          <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
            {isFromFrontend
              ? 'Preview from extracted parameters • Run Calculations for full accuracy'
              : 'Scroll to zoom • Click & drag to pan • Shift+scroll to pan'}
          </div>
        </div>
        {hasData && <button onClick={exportPNG} className="scope-btn" title="Export current zoomed view as PNG">📷 Export PNG</button>}
      </div>

      {!hasData ? (
        <div className="dashboard-empty-state">
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.5 }}>🔬</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt-2)', marginBottom: 6 }}>No Waveform Data</div>
          <div style={{ fontSize: 12, color: 'var(--txt-3)', maxWidth: 380, lineHeight: 1.6 }}>
            Upload MOSFET and Gate Driver datasheets to generate switching waveforms.
            The simulator uses your extracted Ciss, Qg, Qgd, Vgs_th, and driver parameters.
          </div>
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="scope-toolbar">
            {CHANNELS.map(ch => (
              <button
                key={ch.id}
                onClick={() => toggleChannel(ch.id)}
                title={ch.desc}
                className="scope-ch-btn"
                style={{
                  borderColor: visible[ch.id] ? ch.color : 'var(--border-2)',
                  background: visible[ch.id] ? `${ch.color}18` : 'transparent',
                  color: visible[ch.id] ? ch.color : 'var(--txt-4)',
                  opacity: visible[ch.id] ? 1 : 0.45,
                }}
              >
                <span className="scope-ch-dot" style={{ background: visible[ch.id] ? ch.color : 'var(--txt-4)' }} />
                {ch.short}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <div className="scope-zoom-group">
              <span className="scope-zoom-label">ZOOM</span>
              <input type="range" min="1" max="10" step="0.1" value={Math.min(zoomLevel, 10)} onChange={handleZoomSlider} className="scope-zoom-slider" />
              <span className="scope-zoom-value" style={{ color: zoomLevel > 1.1 ? 'var(--accent)' : 'var(--txt-4)' }}>
                {zoomLevel.toFixed(1)}×
              </span>
              {zoomLevel > 1.1 && <button onClick={resetZoom} className="scope-btn scope-btn-sm">Reset</button>}
            </div>
          </div>

          {/* Waveform Override Inputs */}
          <WaveformInputsBar project={project} dispatch={dispatch} gateCalc={gateCalc} />

          {/* PCB Parasitic Inductance Inputs */}
          <PCBParasiticsBar project={project} dispatch={dispatch} parasitics={waveform?.parasitics} />

          {/* Scope display */}
          <div style={{
            borderRadius: 10, overflow: 'hidden',
            border: '2px solid rgba(255,255,255,0.05)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
            position: 'relative',
          }}>
            <canvas
              ref={canvasRef}
              style={{ width: '100%', height: 420, display: 'block', background: '#080818', cursor: 'default', touchAction: 'none' }}
            />
            {zoomLevel > 1.1 && (
              <div style={{
                position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.6)', borderRadius: 5, padding: '2px 8px',
                fontSize: 9, fontFamily: 'var(--font-mono)', color: 'rgba(255,255,255,0.35)',
              }}>
                {viewWindow.tMin.toFixed(0)}–{viewWindow.tMax.toFixed(0)} ns ({zoomLevel.toFixed(1)}×)
              </div>
            )}
          </div>

          {/* Timing cards */}
          {ann && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
              <TimingCard title="Turn-On" color="#FFD700" icon="⚡" rows={ann.turn_on ? [
                { label: 'Pre-threshold', value: ann.turn_on.t_r1_ns, unit: 'ns' },
                { label: 'Active region', value: ann.turn_on.t_r2_ns, unit: 'ns' },
                { label: 'Miller plateau', value: ann.turn_on.t_miller_on_ns, unit: 'ns', hl: true },
                { label: 'Post-plateau', value: ann.turn_on.t_r4_ns, unit: 'ns' },
                { sep: true },
                { label: 'Total turn-on', value: ann.turn_on.total_on_ns, unit: 'ns', bold: true },
                { label: 'Ig (Miller)', value: ann.turn_on.ig_miller_on_a, unit: 'A' },
              ] : []} />
              <TimingCard title="Turn-Off" color="#00CED1" icon="⏹" rows={ann.turn_off ? [
                { label: 'Post-plateau', value: ann.turn_off.t_r4_off_ns, unit: 'ns' },
                { label: 'Miller plateau', value: ann.turn_off.t_miller_off_ns, unit: 'ns', hl: true },
                { label: 'Active region', value: ann.turn_off.t_r2_off_ns, unit: 'ns' },
                { label: 'Sub-threshold', value: ann.turn_off.t_r1_off_ns, unit: 'ns' },
                { sep: true },
                { label: 'Total turn-off', value: ann.turn_off.total_off_ns, unit: 'ns', bold: true },
                { label: 'Ig (Miller)', value: ann.turn_off.ig_miller_off_a, unit: 'A' },
              ] : []} />
              <TimingCard title="System" color="#FF69B4" icon="⚙" rows={[
                { label: 'Dead time', value: ann.dead_time_ns, unit: 'ns', bold: true },
                { label: 'Vgs plateau', value: ann.vgs_plateau_v, unit: 'V' },
                { label: 'Vgs threshold', value: ann.vgs_threshold_v, unit: 'V' },
              ]} />
            </div>
          )}

          {/* Params strip */}
          {params && (
            <div style={{
              padding: '6px 12px', background: 'var(--bg-2)', borderRadius: 8,
              border: '1px solid var(--border-1)', fontSize: 10, color: 'var(--txt-3)',
              lineHeight: 1.7, fontFamily: 'var(--font-mono)',
            }}>
              <span style={{ color: 'var(--txt-2)', fontWeight: 700 }}>Params: </span>
              Ciss={params.ciss_pf}pF · Qg={params.qg_nc}nC · Qgd={params.qgd_nc}nC ·
              Rg_int={params.rg_int_ohm}Ω · Rg_on={params.rg_on_ext_ohm}Ω · Rg_off={params.rg_off_ext_ohm}Ω ·
              Vdrv={params.v_drv_v}V · Vbus={params.v_bus_v}V · Iload={params.i_load_a}A · fsw={params.fsw_khz}kHz
            </div>
          )}

          {/* Note */}
          <div style={{
            padding: '5px 12px', background: 'rgba(255,171,0,0.04)', borderRadius: 8,
            border: '1px solid rgba(255,171,0,0.1)', fontSize: 10, color: 'var(--amber)', lineHeight: 1.5, opacity: 0.7,
          }}>
            ⚠ {waveform.model_note}
          </div>
        </>
      )}
    </div>
  )
}


/* ═══════════════════════════════════════════════════════════════════════
   WAVEFORM OVERRIDE INPUTS BAR
   Source R, Sink R, Vds, Id, Vgs — synced with system_specs
   ═══════════════════════════════════════════════════════════════════════ */

function WaveformInputsBar({ project, dispatch, gateCalc }) {
  const specs = project.system_specs

  const PARAM_KEYS = ['rg_on_override', 'rg_off_override', 'vds_override', 'id_override', 'vgs_drive_override']
  const initLocal = () => {
    const o = {}
    for (const k of PARAM_KEYS) o[k] = specs[k] != null ? String(specs[k]) : ''
    return o
  }
  const [local, setLocal] = useState(initLocal)
  const [dirty, setDirty] = useState(false)

  const localUpdate = (key, val) => {
    setLocal(prev => ({ ...prev, [key]: val }))
    setDirty(true)
  }

  const applyAll = () => {
    const payload = {}
    for (const k of PARAM_KEYS) payload[k] = local[k]
    dispatch({ type: 'SET_SYSTEM_SPECS', payload })
    setDirty(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') applyAll()
  }

  const inputStyle = {
    width: 64, padding: '3px 6px', fontSize: 11, textAlign: 'right',
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.20)',
    borderRadius: 4, color: '#ffffff', fontFamily: 'var(--font-mono)', fontWeight: 600,
  }
  const labelStyle = { fontSize: 11, color: '#c8cfd8', whiteSpace: 'nowrap', fontWeight: 600 }
  const unitStyle = { fontSize: 10, color: '#90a0b0', fontWeight: 500 }
  const placeholderFor = (v) => v != null ? String(Math.round(v * 100) / 100) : '—'

  const calcRgOn = gateCalc?.rg_on_recommended_ohm
  const calcRgOff = gateCalc?.rg_off_recommended_ohm

  const hasOverrides = local.rg_on_override || local.rg_off_override ||
    local.vds_override || local.id_override || local.vgs_drive_override

  const clearAll = () => {
    const empty = {}
    for (const k of PARAM_KEYS) empty[k] = ''
    setLocal(empty)
    setDirty(false)
    dispatch({ type: 'SET_SYSTEM_SPECS', payload: {
      rg_on_override: '', rg_off_override: '',
      vds_override: '', id_override: '', vgs_drive_override: '',
    }})
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px',
      background: hasOverrides ? 'rgba(100,200,255,0.06)' : 'rgba(255,255,255,0.03)',
      borderRadius: 8, border: `1px solid ${hasOverrides ? 'rgba(100,200,255,0.20)' : 'rgba(255,255,255,0.10)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: hasOverrides ? '#4FC3F7' : '#c0cad4', letterSpacing: '.04em' }}>
          🎛 WAVEFORM PARAMETERS
        </span>
        {hasOverrides && (
          <button className="scope-btn scope-btn-sm" onClick={clearAll}>Reset to Calc</button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ ...labelStyle, color: '#FFD700' }}>Rg(on):</span>
          <input type="text" inputMode="decimal" style={inputStyle}
            className="inp" placeholder={placeholderFor(calcRgOn)}
            value={local.rg_on_override} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('rg_on_override', e.target.value)} />
          <span style={unitStyle}>Ω</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ ...labelStyle, color: '#FFD700' }}>Rg(off):</span>
          <input type="text" inputMode="decimal" style={inputStyle}
            className="inp" placeholder={placeholderFor(calcRgOff)}
            value={local.rg_off_override} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('rg_off_override', e.target.value)} />
          <span style={unitStyle}>Ω</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ ...labelStyle, color: '#00CED1' }}>Vds:</span>
          <input type="text" inputMode="decimal" style={inputStyle}
            className="inp" placeholder={String(specs.peak_voltage || 60)}
            value={local.vds_override} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('vds_override', e.target.value)} />
          <span style={unitStyle}>V</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ ...labelStyle, color: '#32CD32' }}>Id:</span>
          <input type="text" inputMode="decimal" style={inputStyle}
            className="inp" placeholder={String(specs.max_phase_current || 80)}
            value={local.id_override} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('id_override', e.target.value)} />
          <span style={unitStyle}>A</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ ...labelStyle, color: '#FFD700' }}>Vgs:</span>
          <input type="text" inputMode="decimal" style={inputStyle}
            className="inp" placeholder={String(specs.gate_drive_voltage || 12)}
            value={local.vgs_drive_override} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('vgs_drive_override', e.target.value)} />
          <span style={unitStyle}>V</span>
        </div>
      </div>

      {/* Apply button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="scope-btn"
          onClick={applyAll}
          disabled={!dirty}
          style={{
            padding: '5px 14px', fontSize: 11, fontWeight: 700,
            background: dirty ? 'rgba(76,175,80,0.25)' : 'rgba(255,255,255,0.06)',
            border: `1px solid ${dirty ? 'rgba(76,175,80,0.5)' : 'rgba(255,255,255,0.15)'}`,
            color: dirty ? '#81C784' : '#808890',
            borderRadius: 5, cursor: dirty ? 'pointer' : 'default',
          }}
        >
          {dirty ? '▶ Apply to Waveform' : '✓ Applied'}
        </button>
        {dirty && <span style={{ fontSize: 10, color: '#FFD54F' }}>Press Enter or click Apply</span>}
        <div style={{ fontSize: 9, color: 'var(--txt-4)', marginLeft: 'auto' }}>
          Leave empty for defaults. Syncs with Passives tab.
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════
   PCB PARASITIC INDUCTANCE INPUT BAR
   ═══════════════════════════════════════════════════════════════════════ */

function PCBParasiticsBar({ project, dispatch, parasitics }) {
  const specs = project.system_specs

  // Local state for all trace inputs — allows decimal typing without losing cursor
  const TRACE_KEYS = [
    'gate_trace_length_mm', 'gate_trace_width_mm', 'gate_trace_height_mm',
    'power_trace_length_mm', 'power_trace_width_mm', 'power_trace_height_mm',
  ]
  const initLocal = () => {
    const o = {}
    for (const k of TRACE_KEYS) o[k] = specs[k] ? String(specs[k]) : ''
    return o
  }
  const [local, setLocal] = useState(initLocal)
  const [dirty, setDirty] = useState(false)

  const localUpdate = (key, val) => {
    setLocal(prev => ({ ...prev, [key]: val }))
    setDirty(true)
  }

  const applyAll = () => {
    const payload = {}
    for (const k of TRACE_KEYS) {
      const v = parseFloat(local[k])
      payload[k] = isNaN(v) ? 0 : v
    }
    dispatch({ type: 'SET_SYSTEM_SPECS', payload })
    setDirty(false)
  }

  // Apply on Enter key
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') applyAll()
  }

  const gateL = Math.round(calcTraceInductance_nH(
    parseFloat(local.gate_trace_length_mm) || 0,
    parseFloat(local.gate_trace_width_mm) || 0,
    parseFloat(local.gate_trace_height_mm) || 0
  ) * 10) / 10
  const powerL = Math.round(calcTraceInductance_nH(
    parseFloat(local.power_trace_length_mm) || 0,
    parseFloat(local.power_trace_width_mm) || 0,
    parseFloat(local.power_trace_height_mm) || 0
  ) * 10) / 10
  const hasParasitics = (parseFloat(local.gate_trace_length_mm) > 0 && parseFloat(local.gate_trace_width_mm) > 0 && parseFloat(local.gate_trace_height_mm) > 0) ||
    (parseFloat(local.power_trace_length_mm) > 0 && parseFloat(local.power_trace_width_mm) > 0 && parseFloat(local.power_trace_height_mm) > 0)

  const clearAll = () => {
    const empty = {}
    for (const k of TRACE_KEYS) empty[k] = ''
    setLocal(empty)
    setDirty(false)
    dispatch({ type: 'SET_SYSTEM_SPECS', payload: {
      gate_trace_length_mm: 0, gate_trace_width_mm: 0, gate_trace_height_mm: 0,
      power_trace_length_mm: 0, power_trace_width_mm: 0, power_trace_height_mm: 0,
    }})
  }

  const inputStyle = {
    width: 52, padding: '3px 6px', fontSize: 11, textAlign: 'right',
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.20)',
    borderRadius: 4, color: '#ffffff', fontFamily: 'var(--font-mono)', fontWeight: 600,
  }

  const labelStyle = { fontSize: 11, color: '#c8cfd8', whiteSpace: 'nowrap', fontWeight: 500 }
  const unitStyle = { fontSize: 10, color: '#90a0b0', fontWeight: 500 }
  const arrowStyle = { margin: '0 4px', color: '#90a0b0', fontSize: 12, fontWeight: 700 }
  const resultStyle = (v) => ({
    fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
    color: v > 0 ? '#4fc3f7' : '#808890',
    padding: '2px 8px', borderRadius: 4,
    background: v > 0 ? 'rgba(79,195,247,0.12)' : 'rgba(255,255,255,0.04)',
    border: v > 0 ? '1px solid rgba(79,195,247,0.25)' : '1px solid rgba(255,255,255,0.08)',
  })

  const dampingBadge = (zeta) => {
    if (zeta == null || zeta <= 0) return null
    const label = zeta < 0.5 ? 'Underdamped' : zeta < 1 ? 'Lightly damped' : zeta === 1 ? 'Critical' : 'Overdamped'
    const color = zeta < 0.5 ? '#FF6B6B' : zeta < 1 ? '#FFD93D' : '#6BCB77'
    return <span style={{ fontSize: 10, color, fontWeight: 700, marginLeft: 6 }}>ζ={zeta.toFixed(2)} ({label})</span>
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px',
      background: hasParasitics ? 'rgba(255,140,0,0.06)' : 'rgba(255,255,255,0.03)',
      borderRadius: 8, border: `1px solid ${hasParasitics ? 'rgba(255,140,0,0.20)' : 'rgba(255,255,255,0.10)'}`,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: hasParasitics ? '#FFB74D' : '#c0cad4', letterSpacing: '.04em' }}>
          📐 PCB TRACE PARASITICS
        </span>
        {hasParasitics && (
          <button className="scope-btn scope-btn-sm" onClick={clearAll}>Clear All</button>
        )}
      </div>

      {/* Ideal waveform warning box */}
      {!hasParasitics && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
          background: 'rgba(255,193,7,0.10)', border: '1px solid rgba(255,193,7,0.25)',
          borderRadius: 6,
        }}>
          <span style={{ fontSize: 14 }}>⚡</span>
          <span style={{ fontSize: 11, color: '#FFD54F', fontWeight: 600 }}>
            Showing ideal waveform — enter PCB trace dimensions below for real-world parasitic effects
          </span>
        </div>
      )}

      {/* Gate Loop Row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#64B5F6', minWidth: 78 }}>Gate Loop</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={labelStyle}>L:</span>
          <input type="text" inputMode="decimal" placeholder="0" style={inputStyle}
            className="inp" value={local.gate_trace_length_mm} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('gate_trace_length_mm', e.target.value)} />
          <span style={unitStyle}>mm</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={labelStyle}>W:</span>
          <input type="text" inputMode="decimal" placeholder="0" style={inputStyle}
            className="inp" value={local.gate_trace_width_mm} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('gate_trace_width_mm', e.target.value)} />
          <span style={unitStyle}>mm</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={labelStyle}>H:</span>
          <input type="text" inputMode="decimal" placeholder="0" style={inputStyle}
            className="inp" value={local.gate_trace_height_mm} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('gate_trace_height_mm', e.target.value)} />
          <span style={unitStyle}>mm</span>
        </div>
        <span style={arrowStyle}>→</span>
        <span style={resultStyle(gateL)}>{gateL > 0 ? `${gateL.toFixed(1)} nH` : '— nH'}</span>
        {parasitics && dampingBadge(parasitics.gate_damping)}
      </div>

      {/* Power Loop Row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#EF5350', minWidth: 78 }}>Power Loop</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={labelStyle}>L:</span>
          <input type="text" inputMode="decimal" placeholder="0" style={inputStyle}
            className="inp" value={local.power_trace_length_mm} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('power_trace_length_mm', e.target.value)} />
          <span style={unitStyle}>mm</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={labelStyle}>W:</span>
          <input type="text" inputMode="decimal" placeholder="0" style={inputStyle}
            className="inp" value={local.power_trace_width_mm} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('power_trace_width_mm', e.target.value)} />
          <span style={unitStyle}>mm</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={labelStyle}>H:</span>
          <input type="text" inputMode="decimal" placeholder="0" style={inputStyle}
            className="inp" value={local.power_trace_height_mm} onKeyDown={handleKeyDown}
            onChange={e => localUpdate('power_trace_height_mm', e.target.value)} />
          <span style={unitStyle}>mm</span>
        </div>
        <span style={arrowStyle}>→</span>
        <span style={resultStyle(powerL)}>{powerL > 0 ? `${powerL.toFixed(1)} nH` : '— nH'}</span>
        {parasitics && dampingBadge(parasitics.power_damping)}
      </div>

      {/* Apply button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="scope-btn"
          onClick={applyAll}
          disabled={!dirty}
          style={{
            padding: '5px 14px', fontSize: 11, fontWeight: 700,
            background: dirty ? 'rgba(76,175,80,0.25)' : 'rgba(255,255,255,0.06)',
            border: `1px solid ${dirty ? 'rgba(76,175,80,0.5)' : 'rgba(255,255,255,0.15)'}`,
            color: dirty ? '#81C784' : '#808890',
            borderRadius: 5, cursor: dirty ? 'pointer' : 'default',
          }}
        >
          {dirty ? '▶ Apply to Waveform' : '✓ Applied'}
        </button>
        {dirty && <span style={{ fontSize: 10, color: '#FFD54F' }}>Press Enter or click Apply</span>}
      </div>

      {/* Formula badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
        background: 'rgba(100,181,246,0.08)', border: '1px solid rgba(100,181,246,0.15)',
        borderRadius: 5, width: 'fit-content',
      }}>
        <span style={{ fontSize: 10, color: '#90CAF9', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
          L(nH) = 0.2 × len × acosh(1 + 2h/w)
        </span>
        <span style={{ fontSize: 9, color: '#78909C' }}>— IPC microstrip</span>
        {hasParasitics && (
          <span style={{ fontSize: 9, color: '#B0BEC5', marginLeft: 4 }}>
            L = trace length, W = trace width, H = height above ground plane
          </span>
        )}
      </div>
    </div>
  )
}


/* ═══════════════════════════════════════════════════════════════════════
   TIMING CARD
   ═══════════════════════════════════════════════════════════════════════ */

function TimingCard({ title, color, icon, rows }) {
  return (
    <div className="dashboard-card" style={{ padding: '10px 12px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
        <span>{icon}</span> {title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 3, columnGap: 8, fontSize: 10 }}>
        {rows.map((r, i) => {
          if (r.sep) return <div key={i} style={{ gridColumn: '1/3', borderTop: '1px solid var(--border-1)', margin: '1px 0' }} />
          if (r.value == null) return null
          return (
            <React.Fragment key={i}>
              <span style={{ color: 'var(--txt-3)' }}>{r.label}</span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontWeight: r.bold ? 700 : 500,
                color: r.hl ? '#FFD700' : r.bold ? 'var(--txt-1)' : 'var(--txt-2)', textAlign: 'right',
              }}>
                {typeof r.value === 'number' ? r.value.toFixed(1) : r.value} {r.unit}
              </span>
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}
