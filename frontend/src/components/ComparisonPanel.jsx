import React, { useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'
import { extractDatasheet } from '../api.js'
import './ComparisonPanel.css'

const MAX_UPLOADS = 12

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function toNum(v) {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function normUnit(unit) {
  return (unit || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/μ/g, 'u')
    .replace(/µ/g, 'u')
    .replace(/ω/g, 'ohm')
    .replace(/Ω/g, 'ohm')
    .replace(/°/g, '')
}

function convertUnit(value, fromUnit, targetUnit) {
  const v = toNum(value)
  if (!Number.isFinite(v)) return null
  const u = normUnit(fromUnit)

  if (targetUnit === 'v') {
    if (u === 'v') return v
    if (u === 'mv') return v / 1000
    return null
  }
  if (targetUnit === 'a') {
    if (u === 'a') return v
    if (u === 'ma') return v / 1000
    return null
  }
  if (targetUnit === 'ohm') {
    if (u === 'ohm') return v
    if (u === 'mohm') return v / 1000
    return null
  }
  if (targetUnit === 'mohm') {
    if (u === 'mohm') return v
    if (u === 'ohm') return v * 1000
    return null
  }
  if (targetUnit === 'nc') {
    if (u === 'nc') return v
    if (u === 'uc') return v * 1000
    if (u === 'c') return v * 1e9
    return null
  }
  if (targetUnit === 'pf') {
    if (u === 'pf') return v
    if (u === 'nf') return v * 1000
    if (u === 'uf') return v * 1e6
    if (u === 'f') return v * 1e12
    return null
  }
  if (targetUnit === 'ns') {
    if (u === 'ns') return v
    if (u === 'us') return v * 1000
    if (u === 'ms') return v * 1e6
    if (u === 's') return v * 1e9
    return null
  }
  if (targetUnit === 'c/w') {
    if (u === 'c/w') return v
    return null
  }
  // Siemens (transconductance g_fs)
  if (targetUnit === 's') {
    if (u === 's' || u === 'a/v') return v
    if (u === 'ms') return v / 1000
    return null
  }
  return null
}

function pickCondition(param, conditionRegex) {
  const conds = param?.conditions || []
  if (!conds.length) return null
  if (!conditionRegex) return conds[0]
  const found = conds.find(c => conditionRegex.test(String(c.condition_text || '')))
  return found || conds[0]
}

function pickStatValue(cond, statOrder) {
  if (!cond) return null
  for (const key of statOrder) {
    const v = toNum(cond[key])
    if (Number.isFinite(v)) return v
  }
  return null
}

function extractValue(rawData, paramId, options = {}) {
  const {
    targetUnit,
    conditionRegex = null,
    statOrder = ['selected', 'typ', 'max', 'min'],
  } = options
  const param = (rawData?.parameters || []).find(p => p.id === paramId)
  if (!param) return null
  const cond = pickCondition(param, conditionRegex)
  const value = pickStatValue(cond, statOrder)
  if (!Number.isFinite(value)) return null
  if (!targetUnit) return value
  return convertUnit(value, cond?.unit || '', targetUnit)
}

function normalizeExtracted(rawData, fallbackName) {
  return {
    name: rawData?.component_name || fallbackName,
    manufacturer: rawData?.manufacturer || '',
    package: rawData?.package || '',
    vds_max: extractValue(rawData, 'vds_max', { targetUnit: 'v', statOrder: ['selected', 'max', 'typ', 'min'] }),
    id_max_25c: extractValue(rawData, 'id_cont', {
      targetUnit: 'a',
      conditionRegex: /(25\s*c|tc\s*=\s*25|tcase\s*=\s*25|tj\s*=\s*25)/i,
      statOrder: ['selected', 'max', 'typ', 'min'],
    }) ?? extractValue(rawData, 'id_cont', { targetUnit: 'a', statOrder: ['selected', 'max', 'typ', 'min'] }),
    rds_on_max_10v: extractValue(rawData, 'rds_on', {
      targetUnit: 'mohm',
      conditionRegex: /(vgs\s*=\s*10|10\s*v)/i,
      statOrder: ['max', 'selected', 'typ', 'min'],
    }) ?? extractValue(rawData, 'rds_on', { targetUnit: 'mohm', statOrder: ['max', 'selected', 'typ', 'min'] }),
    rds_on_typ_10v: extractValue(rawData, 'rds_on', {
      targetUnit: 'mohm',
      conditionRegex: /(vgs\s*=\s*10|10\s*v)/i,
      statOrder: ['typ', 'selected', 'max', 'min'],
    }) ?? extractValue(rawData, 'rds_on', { targetUnit: 'mohm', statOrder: ['typ', 'selected', 'max', 'min'] }),
    // Rds(on) at elevated temperature — used for accurate 85°C derating instead of a fixed multiplier.
    // Many datasheets only give values at 100°C or 125°C; we interpolate to 85°C from whichever is available.
    rds_on_85c: extractValue(rawData, 'rds_on', {
      targetUnit: 'mohm',
      conditionRegex: /(t[jc]\s*=\s*85(?:\s*°?\s*c)?)/i,
      statOrder: ['max', 'selected', 'typ', 'min'],
    }),
    rds_on_100c: extractValue(rawData, 'rds_on', {
      targetUnit: 'mohm',
      conditionRegex: /(t[jc]\s*=\s*100(?:\s*°?\s*c)?)/i,
      statOrder: ['max', 'selected', 'typ', 'min'],
    }),
    rds_on_125c: extractValue(rawData, 'rds_on', {
      targetUnit: 'mohm',
      conditionRegex: /(t[jc]\s*=\s*125(?:\s*°?\s*c)?)/i,
      statOrder: ['max', 'selected', 'typ', 'min'],
    }),
    vgs_th_typ: extractValue(rawData, 'vgs_th', { targetUnit: 'v', statOrder: ['typ', 'selected', 'max', 'min'] }),
    qg_total: extractValue(rawData, 'qg', { targetUnit: 'nc' }),
    qgs: extractValue(rawData, 'qgs', { targetUnit: 'nc' }),
    qgd: extractValue(rawData, 'qgd', { targetUnit: 'nc' }),
    qrr: extractValue(rawData, 'qrr', { targetUnit: 'nc' }),
    trr: extractValue(rawData, 'trr', { targetUnit: 'ns' }),
    ciss: extractValue(rawData, 'ciss', { targetUnit: 'pf' }),
    coss: extractValue(rawData, 'coss', { targetUnit: 'pf' }),
    rg_internal: extractValue(rawData, 'rg_int', { targetUnit: 'ohm' }),
    rth_jc: extractValue(rawData, 'rth_jc', { targetUnit: 'c/w' }),
    td_on: extractValue(rawData, 'td_on', { targetUnit: 'ns' }),
    tr: extractValue(rawData, 'tr', { targetUnit: 'ns' }),
    td_off: extractValue(rawData, 'td_off', { targetUnit: 'ns' }),
    tf: extractValue(rawData, 'tf', { targetUnit: 'ns' }),
    // ── New fields for ringing analysis ──
    vgs_plateau: extractValue(rawData, 'vgs_plateau', { targetUnit: 'v', statOrder: ['typ', 'selected', 'min', 'max'] }),
    coss_er: extractValue(rawData, 'coss_er', { targetUnit: 'pf' }),
    g_fs: extractValue(rawData, 'g_fs', { targetUnit: 's' }),
  }
}

// ── Loss & timing calcs (unchanged) ──────────────────────────────────────────

function calcTiming(p, sys) {
  const N = sys.npar || 1
  const Qg = (p.qg_total || 120) * 1e-9 * N
  const Qgd = (p.qgd || 35) * 1e-9
  const Ciss = (p.ciss || 8000) * 1e-12
  const Rgi = p.rg_internal || 2.0
  const Vth = p.vgs_th_typ || 3.0
  const Vpl = Vth + 1.5
  const Rg_on = sys.rg_on + Rgi
  const Rg_off = sys.rg_off + Rgi
  const td_on = Ciss * Rg_on * Math.log(sys.vgs / Math.max(sys.vgs - Vth, 0.1))
  const td_off = Ciss * Rg_off * Math.log(sys.vgs / Math.max(sys.vgs - Vpl, 0.1))
  const Ig_on_pl = Math.max((sys.vgs - Vpl) / Rg_on, 0.05)
  const Ig_off_pl = Math.max(Vpl / Rg_off, 0.05)
  const t_rise = Qgd / Ig_on_pl
  const t_fall = Qgd / Ig_off_pl
  const t_on_tot = td_on + t_rise
  const t_off_tot = td_off + t_fall
  const Ig_on_pk = (sys.vgs / (Rg_on / N)) * 1000
  const Ig_off_pk = (sys.vgs / (Rg_off / N)) * 1000
  const dt_min = Math.max(t_fall * 1.3, t_rise * 1.3, 100e-9)
  const dt_rec = dt_min * 1.25
  const dt_pct = dt_rec * sys.fsw * 100
  const dVb = 0.5
  const Cb_min_nF = (Qg / dVb) * 1e9
  const Vboot = sys.vgs - sys.vf
  const Cb_act = sys.cb * 1e-6
  const dVb_act = Qg / Cb_act
  const Rboot = sys.rboot || 10
  const t_rech = 5 * Rboot * Cb_act
  const D_max = Math.max(0, Math.min((1 - t_rech * sys.fsw) * 100, 99))
  const cbOk = (sys.cb * 1000) >= Cb_min_nF
  return {
    Rg_on: Rg_on.toFixed(2), Rg_off: Rg_off.toFixed(2), Vpl: Vpl.toFixed(1),
    Ig_on_pk: Ig_on_pk.toFixed(0), Ig_off_pk: Ig_off_pk.toFixed(0),
    td_on: (td_on * 1e9).toFixed(1), td_off: (td_off * 1e9).toFixed(1),
    t_rise: (t_rise * 1e9).toFixed(1), t_fall: (t_fall * 1e9).toFixed(1),
    t_on_tot: (t_on_tot * 1e9).toFixed(1), t_off_tot: (t_off_tot * 1e9).toFixed(1),
    dt_min: (dt_min * 1e9).toFixed(0), dt_rec: (dt_rec * 1e9).toFixed(0),
    dt_pct: dt_pct.toFixed(2), Cb_min: Cb_min_nF.toFixed(1), cbOk,
    Vboot: Vboot.toFixed(1), dVb_act: dVb_act.toFixed(3),
    t_rech: (t_rech * 1e6).toFixed(2), D_max: D_max.toFixed(1),
  }
}

function calcLosses(p, sys, tc) {
  const N = sys.npar || 1
  const Ipk = sys.irms * Math.sqrt(2)
  const Isw = Ipk / Math.sqrt(3)
  const Isw_dev = Isw / N
  const Ipk_dev = Ipk / N
  const rds_25_mohm = p.rds_on_max_10v || (p.rds_on_typ_10v || 1.5) * 1.2
  let Tder, rds_derate_src
  if (tc === 25) {
    Tder = 1.0
    rds_derate_src = '25°C baseline'
  } else {
    // Priority: exact datasheet @85°C > interpolated from @100°C > interpolated from @125°C > fixed industry estimate
    // Guard: hot value must be ≥ 25°C value (temperature coefficient is always positive for Si MOSFETs)
    if (p.rds_on_85c != null && p.rds_on_85c >= rds_25_mohm) {
      Tder = p.rds_on_85c / rds_25_mohm
      rds_derate_src = `×${Tder.toFixed(2)} (datasheet @85°C)`
    } else if (p.rds_on_100c != null && p.rds_on_100c >= rds_25_mohm) {
      // Linear interpolation: 85°C is 60/75 of the way from 25°C to 100°C
      const rds_85 = rds_25_mohm + (p.rds_on_100c - rds_25_mohm) * (60 / 75)
      Tder = rds_85 / rds_25_mohm
      rds_derate_src = `×${Tder.toFixed(2)} (interpolated from datasheet @100°C)`
    } else if (p.rds_on_125c != null && p.rds_on_125c >= rds_25_mohm) {
      // Linear interpolation: 85°C is 60/100 of the way from 25°C to 125°C
      const rds_85 = rds_25_mohm + (p.rds_on_125c - rds_25_mohm) * (60 / 100)
      Tder = rds_85 / rds_25_mohm
      rds_derate_src = `×${Tder.toFixed(2)} (interpolated from datasheet @125°C)`
    } else {
      // No hot-temp datasheet value — use Si MOSFET industry estimate (~1.4–1.6× at 85°C junction)
      Tder = 1.55
      rds_derate_src = '×1.55 (estimated — no 85/100/125°C Rds value in datasheet)'
    }
  }
  const Rds_single = (rds_25_mohm / 1000) * Tder
  const Rds = Rds_single / N
  const Pcond = Isw_dev * Isw_dev * Rds_single * N
  const Rgi = p.rg_internal || 2.0
  const Vpl = (p.vgs_th_typ || 3.0) + 1.5
  const Ig_on = Math.max((sys.vgs - Vpl) / (sys.rg_on + Rgi), 0.05)
  const Ig_off = Math.max(Vpl / (sys.rg_off + Rgi), 0.05)
  const Qgd = (p.qgd || 40) * 1e-9
  const Psw_on = 0.5 * sys.vbus * Ipk_dev * (Qgd / Ig_on) * sys.fsw * (tc === 85 ? 1.05 : 1.0) * N
  const Psw_off = 0.5 * sys.vbus * Ipk_dev * (Qgd / Ig_off) * sys.fsw * (tc === 85 ? 1.05 : 1.0) * N
  const Pqrr = sys.vbus * (p.qrr || 200) * 1e-9 * sys.fsw * (tc === 85 ? 1.1 : 1.0) * N
  const Pcoss = 0.5 * (p.coss || 3000) * 1e-12 * sys.vbus * sys.vbus * sys.fsw * N
  const Pgate = (p.qg_total || 150) * 1e-9 * sys.vgs * sys.fsw * N
  const Ptot = Pcond + Psw_on + Psw_off + Pqrr + Pcoss + Pgate
  const P3ph = Ptot * 6
  const Pout = sys.vbus * sys.irms
  const coolingRth = { natural: 40.0, enhanced_pcb: 20.0, forced_air: 10.0, heatsink: 5.0 }[sys.cooling || 'natural'] || 40.0
  const rth_jc = p.rth_jc || 0.4
  const rth_cs = 0.5
  const rth_sa = coolingRth
  const p_dev = Ptot / N
  const dtj = (p_dev * (rth_jc + rth_cs + rth_sa)).toFixed(1)
  const t_junc = (tc + p_dev * (rth_jc + rth_cs + rth_sa)).toFixed(1)
  const dtj_jc = (p_dev * rth_jc).toFixed(1)
  return {
    cond: Pcond.toFixed(2), sw_on: Psw_on.toFixed(3), sw_off: Psw_off.toFixed(3),
    qrr: Pqrr.toFixed(3), coss: Pcoss.toFixed(3), gate: Pgate.toFixed(3),
    total: Ptot.toFixed(2), total3ph: P3ph.toFixed(1),
    eff: (Pout > 0 ? (Pout / (Pout + P3ph)) * 100 : 0).toFixed(2),
    dtj, t_junc, dtj_jc, rds: (Rds * 1000).toFixed(3),
    rds_derate_src, rds_tder: Tder.toFixed(2),
  }
}

// ── Ringing analysis — Steps 1-8 from framework ──────────────────────────────

function calcRinging(p, sys, ringCfg) {
  const N = Math.max(1, sys.npar || 1)
  const sources = {}
  const conf_notes = []

  // Step 1 — scale for N parallel
  const Q_rr_single = toNum(p.qrr)          // nC per device
  const t_rr_ns     = toNum(p.trr)           // ns (does not scale with N)
  const Q_rr_total  = Q_rr_single != null ? Q_rr_single * N : null
  const Rg_int      = toNum(p.rg_internal) || 2.0
  const Vth         = toNum(p.vgs_th_typ)  || 3.0
  const Q_gd_nc     = toNum(p.qgd)         || 35

  // Step 2 — effective C_oss
  const C_oss_er = toNum(p.coss_er)
  const C_oss_ds = toNum(p.coss)
  let C_oss_eff, c_oss_src
  if (C_oss_er != null) {
    C_oss_eff = C_oss_er
    c_oss_src = 'datasheet (Coss,er)'
  } else if (C_oss_ds != null) {
    C_oss_eff = C_oss_ds * 1.4
    c_oss_src = `1.4 × Coss (${C_oss_ds.toFixed(0)} pF) — Coss,er not in datasheet`
    conf_notes.push('Coss,er not found — 1.4×Coss(40V) fallback used')
  } else {
    C_oss_eff = 4200
    c_oss_src = '1.4 × 3000 pF default — Coss not found'
    conf_notes.push('Coss not found — 3000 pF default used')
  }
  sources.c_oss_eff = c_oss_src
  const C_oss_total = C_oss_eff * N   // pF, scaled for N parallel

  // Step 3 — transition time (Miller plateau)
  const I_load_total = sys.irms * Math.sqrt(2) / Math.sqrt(3)  // A, peak phase current

  // g_fs: datasheet > derived
  const gfs_ds  = toNum(p.g_fs)
  const V_pl_ds = toNum(p.vgs_plateau)
  let gfs_val, gfs_src
  if (gfs_ds != null && gfs_ds > 0) {
    gfs_val = gfs_ds
    gfs_src = `datasheet: ${gfs_ds.toFixed(0)} S`
  } else {
    const v_ref = V_pl_ds != null ? V_pl_ds : (Vth + 1.5)
    gfs_val = Math.max(I_load_total / Math.max(v_ref - Vth, 0.1), 1.0)
    gfs_src = `derived: I_load/(V_pl−Vth) = ${I_load_total.toFixed(1)}/(${v_ref.toFixed(1)}−${Vth.toFixed(1)}) = ${gfs_val.toFixed(0)} S`
  }
  sources.g_fs = gfs_src

  // V_plateau: datasheet > derived
  let V_pl, v_pl_src
  if (V_pl_ds != null) {
    V_pl     = V_pl_ds
    v_pl_src = `datasheet: ${V_pl_ds.toFixed(2)} V`
  } else {
    const raw = Vth + I_load_total / Math.max(gfs_val, 0.1)
    V_pl     = Math.max(Vth + 0.3, Math.min(raw, sys.vgs - 0.5))
    v_pl_src = `derived: Vth + I_load/gfs = ${Vth.toFixed(1)} + ${(I_load_total / gfs_val).toFixed(2)} = ${V_pl.toFixed(2)} V`
  }
  sources.v_plateau = v_pl_src

  const I_gate       = Math.max((sys.vgs - V_pl) / (sys.rg_on + Rg_int), 0.05)   // A
  const t_plateau_s  = (Q_gd_nc * 1e-9) / I_gate                                   // s
  const t_plateau_ns = t_plateau_s * 1e9                                            // ns
  const dV_dt        = sys.vbus / t_plateau_s                                       // V/s

  // Step 4 — total resonant capacitance
  const C_snub_pf  = (toNum(ringCfg.c_snub_nf) || 0) * 1000   // nF → pF
  const C_stray_pf = 500                                         // 0.5 nF assumed stray
  const C_external = C_snub_pf + C_stray_pf                     // pF
  const C_total    = C_oss_total + C_external                    // pF

  let L_nh, l_src
  const f_ref    = toNum(ringCfg.f_ring_ref_mhz)
  const l_given  = toNum(ringCfg.l_loop_nh)

  if (f_ref != null && f_ref > 0) {
    // Back-solve L from measured ring frequency — most accurate
    const C_ref_F = C_total * 1e-12
    L_nh  = 1e9 / (Math.pow(2 * Math.PI * f_ref * 1e6, 2) * C_ref_F)
    l_src = `inferred from f_ring_ref = ${f_ref} MHz`
  } else if (l_given != null && l_given > 0) {
    L_nh  = l_given
    l_src = 'user-provided'
  } else {
    L_nh  = 20
    l_src = 'default 20 nH (4-layer PCB estimate) — not provided'
    conf_notes.push('L_loop and f_ring_ref not provided — 20 nH default used. Results valid for ranking only.')
  }
  sources.l_loop = l_src

  // Step 5 — ring frequency & impedance
  const L_H       = L_nh * 1e-9
  const C_F       = C_total * 1e-12
  const f_ring_hz = 1 / (2 * Math.PI * Math.sqrt(L_H * C_F))
  const f_ring_mhz = f_ring_hz / 1e6
  const T_half_s  = 1 / (2 * f_ring_hz)
  const T_half_ns = T_half_s * 1e9
  const Z0        = Math.sqrt(L_H / C_F)   // Ω

  // Step 6 — peak commutation current
  let I_rr_pk, i_rr_src, body_diode_type
  const is_sync = ringCfg.synchronous !== false

  if (!is_sync) {
    I_rr_pk         = 0
    i_rr_src        = 'non-synchronous — body diode not in commutation loop'
    body_diode_type = 'n/a'
  } else if (Q_rr_total != null && t_rr_ns != null && t_rr_ns > 0) {
    I_rr_pk         = 2 * (Q_rr_total * 1e-9) / (t_rr_ns * 1e-9)
    i_rr_src        = `datasheet: 2×Q_rr,total/t_rr = 2×${Q_rr_total.toFixed(0)} nC/${t_rr_ns} ns = ${I_rr_pk.toFixed(2)} A`
    body_diode_type = 'hard'
  } else {
    I_rr_pk         = 0.15 * I_load_total
    i_rr_src        = `soft-diode heuristic: 0.15×I_load = 0.15×${I_load_total.toFixed(1)} A = ${I_rr_pk.toFixed(2)} A (Q_rr not in datasheet)`
    body_diode_type = 'soft'
    if (is_sync) conf_notes.push('Q_rr not specified (synchronous) — soft-diode heuristic: I_rr,pk = 0.15×I_load')
  }
  sources.i_rr = i_rr_src

  const I_dvdt = (C_oss_total * 1e-12) * dV_dt   // A
  const I_pk   = I_load_total + I_rr_pk + 0.4 * I_dvdt

  // Step 7 — excitation factor
  const EF = t_plateau_ns / T_half_ns

  // Step 8 — predicted ring amplitude
  const V_ring = EF >= 1.0
    ? I_pk * Z0 * (T_half_s / t_plateau_s)   // under-excited
    : I_pk * Z0                               // fully excited

  // Regime classification
  let regime
  if      (EF >= 1.2) regime = 'over_damped'
  else if (EF >= 1.0) regime = 'critical'
  else if (EF >= 0.5) regime = 'borderline'
  else                regime = 'impulsive'

  // Hard disqualifiers
  let disqualified = false
  const disq_reasons = []
  const V_dss   = toNum(p.vds_max)
  const I_D_max = toNum(p.id_max_25c)
  if (V_dss   != null && V_dss   < 1.4 * (sys.vbus + V_ring)) {
    disqualified = true
    disq_reasons.push(`V_DSS (${V_dss}V) < 1.4×(V_bus+V_ring) = ${(1.4 * (sys.vbus + V_ring)).toFixed(0)} V`)
  }
  if (I_D_max != null && I_D_max < 1.5 * I_load_total) {
    disqualified = true
    disq_reasons.push(`I_D (${I_D_max}A) < 1.5×I_load = ${(1.5 * I_load_total).toFixed(0)} A`)
  }

  const confidence = conf_notes.length === 0 ? 'high' : conf_notes.length === 1 ? 'medium' : 'low'

  // Rg,ext needed to push EF to ≥ 1.2 (used in board recommendations)
  const t_pl_for12   = 1.2 * T_half_s
  const Ig_for12     = (Q_gd_nc * 1e-9) / t_pl_for12
  const rg_ext_for12 = Math.max(0, (sys.vgs - V_pl) / Math.max(Ig_for12, 0.001) - Rg_int)

  return {
    v_ring_pred_v: V_ring,
    excitation_factor: EF,
    f_ring_mhz,
    t_half_ns: T_half_ns,
    z0_ohms: Z0,
    regime,
    body_diode_type,
    disqualified,
    disq_reasons,
    confidence,
    conf_notes,
    // Intermediates for display
    c_oss_eff_pf: C_oss_eff,
    c_oss_total_pf: C_oss_total,
    c_external_pf: C_external,
    c_total_pf: C_total,
    l_loop_nh: L_nh,
    t_plateau_ns,
    dv_dt_vns: dV_dt * 1e-9,   // V/ns for display
    i_rr_pk_a: I_rr_pk,
    i_dvdt_a: I_dvdt,
    i_pk_a: I_pk,
    i_load_total_a: I_load_total,
    i_gate_a: I_gate,
    v_plateau: V_pl,
    gfs: gfs_val,
    q_rr_total_nc: Q_rr_total,
    q_gd_nc: Q_gd_nc,
    rg_int_ohm: Rg_int,
    sources,
    rg_ext_for12,
  }
}

function generateBoardRecs(doneItems, ringings, cfg) {
  if (!doneItems.length) return []
  const pairs = ringings.map((r, i) => ({ r, item: doneItems[i] }))
  const valid = pairs.filter(x => !x.r.disqualified)
  if (!valid.length) return ['All candidates disqualified — check V_DSS ratings vs. bus voltage.']

  const sorted = [...valid].sort((a, b) => a.r.v_ring_pred_v - b.r.v_ring_pred_v)
  const best   = sorted[0]
  const recs   = []

  valid.forEach(({ r, item }) => {
    if (r.excitation_factor < 1.2 && r.rg_ext_for12 > cfg.rg_on + 1) {
      recs.push(
        `${item.norm.name}: Increase HS Rg,on from ${cfg.rg_on} Ω to ≥ ${r.rg_ext_for12.toFixed(0)} Ω to push EF ≥ 1.2 (over-damped — zero overshoot above rail).`
      )
    }
  })

  const R_snub_rec = best.r.z0_ohms
  const C_snub_rec = Math.max(1, (best.r.c_oss_total_pf * 3) / 1000)
  const V_snub_min = (cfg.vbus * 1.5).toFixed(0)
  recs.push(
    `Snubber sizing for ${best.item.norm.name} ×${cfg.npar}: R_snub ≈ ${R_snub_rec.toFixed(1)} Ω, C_snub ≈ ${C_snub_rec.toFixed(1)} nF C0G ≥ ${V_snub_min} V. ` +
    `R_snub ≈ Z₀ absorbs ring energy. C_snub ≈ 3×N×C_oss,eff spreads resonant energy over the ring half-period.`
  )

  if (best.r.l_loop_nh > 100) {
    recs.push(
      `L_loop = ${best.r.l_loop_nh.toFixed(0)} nH is high (> 100 nH). Layout optimization (tighter power loop, minimize high-di/dt loop area) should take priority over MOSFET selection.`
    )
  }

  const softParts = valid.filter(x => x.r.body_diode_type === 'soft')
  if (softParts.length > 0) {
    recs.push(
      `${softParts.map(x => x.item.norm.name).join(', ')}: Q_rr not specified — likely a soft/slow-recovery body diode. ` +
      `Per bench validation on a real 28V/24kHz motor drive, a soft body diode alone produced 73% ring amplitude reduction vs. a hard-diode MOSFET at comparable paralleling and gate drive.`
    )
  }

  const hardParallel = valid.filter(x => x.r.body_diode_type === 'hard')
  if (hardParallel.length > 0 && cfg.npar > 1) {
    recs.push(
      `Hard-diode MOSFETs when paralleled: Q_rr scales N×, but Z₀ only drops ∝ 1/√N — net ringing grows with paralleling. Prefer soft-diode parts for high-N configurations.`
    )
  }

  return recs
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function getRanks(values, lowerBetter) {
  const nums = values.map(v => toNum(v))
  const valid = nums.filter(v => Number.isFinite(v))
  if (valid.length < 2) return values.map(() => '')
  const best = lowerBetter ? Math.min(...valid) : Math.max(...valid)
  const worst = lowerBetter ? Math.max(...valid) : Math.min(...valid)
  return nums.map(n => {
    if (!Number.isFinite(n)) return ''
    if (n === best) return 'best'
    if (n === worst) return 'worst'
    return ''
  })
}

function rankStyle(rank) {
  if (rank === 'best') return { background: 'rgba(0,230,118,0.12)', color: 'var(--green)', fontWeight: 700 }
  if (rank === 'worst') return { background: 'rgba(255,68,68,0.12)', color: 'var(--red)' }
  return null
}

function num(v, d = 2) {
  const n = toNum(v)
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}

function efColor(ef) {
  if (ef >= 1.2) return 'var(--green)'
  if (ef >= 1.0) return '#eab308'
  if (ef >= 0.5) return 'var(--amber)'
  return 'var(--red)'
}

function ringingVerdict(r, norm, rank) {
  if (r.body_diode_type === 'soft' && r.excitation_factor >= 1.0) return 'Soft diode + under-excited — quietest possible'
  if (r.body_diode_type === 'soft') return 'Soft diode favors low ringing — increase Rg,on to cross EF=1.0'
  if (r.excitation_factor >= 1.2) return 'Over-damped — no overshoot above rail'
  if (r.excitation_factor >= 1.0) return 'Critical regime — tiny residual ring'
  if (rank === 0) return 'Best among hard-diode candidates'
  return 'Increase Rg,on to reduce ringing'
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ComparisonPanel() {
  const { state, dispatch } = useProject()
  const { project, settings } = state

  const fileInputRef = useRef(null)
  const [phase, setPhase] = useState('upload')
  const [files, setFiles] = useState([])
  const [currentTemp, setCurrentTemp] = useState(25)
  const [analysisMode, setAnalysisMode] = useState('ringing')   // 'ringing' | 'loss'
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  const defaultNpar = Number.isFinite(parseInt(project.system_specs.mosfets_parallel_per_switch, 10))
    ? Math.max(1, parseInt(project.system_specs.mosfets_parallel_per_switch, 10))
    : Math.max(1, Math.round((project.system_specs.num_fets || 6) / 6))

  const [cfg, setCfg] = useState({
    vbus:   Number(project.system_specs.peak_voltage)       || 60,
    irms:   Number(project.system_specs.max_phase_current)  || 120,
    fsw:    Number(project.system_specs.pwm_freq_hz)        || 20000,
    vgs:    Number(project.system_specs.gate_drive_voltage) || 12,
    rg_on:  Number(project.system_specs.rg_on_override)    || 4.7,
    rg_off: Number(project.system_specs.rg_off_override)   || 4.7,
    idr_src:  4,
    idr_snk:  4,
    cb:       0.1,
    vf:       0.5,
    npar:     defaultNpar,
    rboot:    10,
    // Ringing-specific
    l_loop_nh:      20,
    f_ring_ref_mhz: '',
    c_snub_nf:      0,
    synchronous:    true,
  })

  const doneItems = useMemo(
    () => files.filter(f => f.status === 'done' && f.rawData && f.norm),
    [files],
  )

  const losses = useMemo(
    () => doneItems.map(item => calcLosses(item.norm, cfg, currentTemp)),
    [doneItems, cfg, currentTemp],
  )

  const timings = useMemo(
    () => doneItems.map(item => calcTiming(item.norm, cfg)),
    [doneItems, cfg],
  )

  const ringCfg = useMemo(() => ({
    l_loop_nh:      cfg.l_loop_nh,
    f_ring_ref_mhz: cfg.f_ring_ref_mhz,
    c_snub_nf:      cfg.c_snub_nf,
    synchronous:    cfg.synchronous,
  }), [cfg.l_loop_nh, cfg.f_ring_ref_mhz, cfg.c_snub_nf, cfg.synchronous])

  const ringings = useMemo(
    () => doneItems.map(item => calcRinging(item.norm, cfg, ringCfg)),
    [doneItems, cfg, ringCfg],
  )

  const rankedRinging = useMemo(() => {
    const combined = doneItems.map((item, i) => ({ item, r: ringings[i] }))
    return combined.sort((a, b) => {
      if (a.r.disqualified && !b.r.disqualified) return 1
      if (!a.r.disqualified && b.r.disqualified) return -1
      return a.r.v_ring_pred_v - b.r.v_ring_pred_v
    })
  }, [doneItems, ringings])

  const boardRecs = useMemo(
    () => generateBoardRecs(doneItems, ringings, cfg),
    [doneItems, ringings, cfg],
  )

  const derived = useMemo(() => {
    const Ipk = cfg.irms * Math.sqrt(2)
    const Isw = Ipk / Math.sqrt(3)
    const IswDev = Isw / Math.max(cfg.npar, 1)
    const IpkDev = Ipk / Math.max(cfg.npar, 1)
    return { Ipk, Isw, IswDev, IpkDev }
  }, [cfg])

  const ranked = useMemo(() => {
    const combined = doneItems.map((item, i) => ({ item, l: losses[i], t: timings[i] }))
    return combined.sort((a, b) => {
      const sa = toNum(a.l?.eff) * 10 - (toNum(a.item.norm?.qrr) || 300) * 0.05 - toNum(a.l?.total)
      const sb = toNum(b.l?.eff) * 10 - (toNum(b.item.norm?.qrr) || 300) * 0.05 - toNum(b.l?.total)
      return sb - sa
    })
  }, [doneItems, losses, timings])

  function updateCfg(key, value) {
    const parsed = toNum(value)
    setCfg(prev => ({ ...prev, [key]: Number.isFinite(parsed) ? parsed : prev[key] }))
  }

  function addFiles(newFiles) {
    const pdfs = newFiles.filter(f => /\.pdf$/i.test(f.name))
    if (!pdfs.length) { toast.error('Please upload PDF datasheets only'); return }
    setFiles(prev => {
      const slots = Math.max(0, MAX_UPLOADS - prev.length)
      const sliced = pdfs.slice(0, slots)
      if (pdfs.length > sliced.length) toast.error(`Maximum ${MAX_UPLOADS} files allowed`)
      return [...prev, ...sliced.map(file => ({ id: makeId(), file, name: file.name, status: 'queued', error: null, rawData: null, norm: null }))]
    })
  }

  function removeFile(id) { setFiles(prev => prev.filter(f => f.id !== id)) }

  function resetAll() { setFiles([]); setPhase('upload'); setCurrentTemp(25) }

  function goToConfig() {
    if (files.length < 2) { toast.error('Upload at least 2 MOSFET datasheets'); return }
    setPhase('config')
  }

  async function runAnalysis() {
    if (!settings.gemini_api_keys?.some(k => k.trim())) {
      toast.error('Add your Gemini API key in Settings first')
      dispatch({ type: 'TOGGLE_SETTINGS' })
      return
    }
    if (files.length < 2) { toast.error('Upload at least 2 MOSFET datasheets'); return }
    setPhase('loading')
    setFiles(prev => prev.map(f => ({ ...f, status: f.rawData ? 'done' : 'queued', error: null })))

    let successCount = files.filter(f => f.rawData).length
    let failureCount = 0

    for (let i = 0; i < files.length; i++) {
      const item = files[i]
      if (item.rawData) continue
      setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: 'extracting', error: null } : f))
      try {
        const data = await extractDatasheet('mosfet', item.file, settings.gemini_api_keys)
        const norm = normalizeExtracted(data, item.name)
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: 'done', rawData: data, norm, error: null } : f))
        successCount += 1
      } catch (e) {
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: 'error', error: e?.message || 'Extraction failed' } : f))
        failureCount += 1
      }
    }

    if (successCount <= 0) { toast.error('No datasheet extraction succeeded'); setPhase('config'); return }
    if (failureCount > 0) toast('Some files failed. Showing successful devices.', { icon: '⚠️', duration: 4000 })
    else toast.success('Analysis completed')
    setPhase('results')
  }

  function applyMosfetToProject(item) {
    if (!item?.rawData) return
    dispatch({ type: 'SET_BLOCK_DATA', payload: { block: 'mosfet', filename: item.name, raw_data: item.rawData } })
    dispatch({ type: 'SET_ACTIVE_BLOCK', payload: 'mosfet' })
    toast.success(`${item.norm?.name || item.name} selected in MOSFET tab`)
  }

  // ── Sort helper for ringing hero table ──────────────────────────────────────
  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const displayRinging = useMemo(() => {
    if (!sortKey) return rankedRinging
    return [...rankedRinging].sort((a, b) => {
      const va = sortKey === 'ef' ? a.r.excitation_factor
        : sortKey === 'vring' ? a.r.v_ring_pred_v
        : sortKey === 'fring' ? a.r.f_ring_mhz
        : sortKey === 'z0' ? a.r.z0_ohms
        : 0
      const vb = sortKey === 'ef' ? b.r.excitation_factor
        : sortKey === 'vring' ? b.r.v_ring_pred_v
        : sortKey === 'fring' ? b.r.f_ring_mhz
        : sortKey === 'z0' ? b.r.z0_ohms
        : 0
      return sortDir === 'asc' ? va - vb : vb - va
    })
  }, [rankedRinging, sortKey, sortDir])

  // ── Export comparison as printable HTML ─────────────────────────────────────
  function exportComparison() {
    const ts = new Date().toLocaleString()
    const parts = doneItems.map(d => d.norm.name).join(', ')
    const thStyle = 'border:1px solid #ccc;padding:5px 8px;background:#f3f4f6;font-size:11px;text-align:left'
    const tdStyle = 'border:1px solid #ddd;padding:4px 8px;font-size:11px'
    const tdMono = tdStyle + ';font-family:monospace'

    const paramRows = [
      ['VDS max [V]', 'vds_max'], ['ID max @25°C [A]', 'id_max_25c'],
      ['RDS(on) max @10V [mΩ]', 'rds_on_max_10v'], ['Vgs(th) typ [V]', 'vgs_th_typ'],
      ['Qg total [nC]', 'qg_total'], ['Qgd [nC]', 'qgd'], ['Qrr [nC]', 'qrr'],
      ['trr [ns]', 'trr'], ['Ciss [pF]', 'ciss'], ['Coss [pF]', 'coss'],
      ['Coss,er [pF]', 'coss_er'], ['g_fs [S]', 'g_fs'],
      ['Rg int [Ω]', 'rg_internal'], ['RthJC [°C/W]', 'rth_jc'], ['Package', 'package'],
    ]

    const paramTable = `<table style="border-collapse:collapse;width:100%">
      <thead><tr><th style="${thStyle}">Parameter</th>${doneItems.map(d => `<th style="${thStyle}">${d.norm.name}<br><small>${d.norm.manufacturer || ''}</small></th>`).join('')}</tr></thead>
      <tbody>${paramRows.map(([label, key]) => `<tr><td style="${tdStyle}">${label}</td>${doneItems.map(d => `<td style="${tdMono}">${key === 'package' ? (d.norm[key] || '—') : (d.norm[key] != null ? Number(d.norm[key]).toFixed(2) : '—')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`

    const ringTable = `<table style="border-collapse:collapse;width:100%">
      <thead><tr>${['Rank','Part','Body Diode','EF','Regime','V_ring (V)','f_ring (MHz)','Z₀ (Ω)','Confidence'].map(h => `<th style="${thStyle}">${h}</th>`).join('')}</tr></thead>
      <tbody>${displayRinging.map((e, i) => {
        const { item, r } = e
        const bg = r.disqualified ? '#fee2e2' : i === 0 ? '#ecfdf5' : ''
        return `<tr style="background:${bg}">
          <td style="${tdStyle}">${r.disqualified ? 'DQ' : i + 1}</td>
          <td style="${tdStyle}"><strong>${item.norm.name}</strong><br><small>${item.norm.manufacturer || ''}</small></td>
          <td style="${tdStyle}">${r.body_diode_type}</td>
          <td style="${tdMono}">${r.disqualified ? '—' : r.excitation_factor.toFixed(3)}</td>
          <td style="${tdStyle}">${r.disqualified ? '—' : r.regime}</td>
          <td style="${tdMono}">${r.disqualified ? r.disq_reasons[0] : r.v_ring_pred_v.toFixed(2)}</td>
          <td style="${tdMono}">${r.disqualified ? '' : r.f_ring_mhz.toFixed(1)}</td>
          <td style="${tdMono}">${r.disqualified ? '' : r.z0_ohms.toFixed(2)}</td>
          <td style="${tdStyle}">${r.disqualified ? '' : r.confidence}</td>
        </tr>`
      }).join('')}</tbody>
    </table>`

    const lossRows25 = doneItems.map(d => calcLosses(d.norm, cfg, 25))
    const lossRows85 = doneItems.map(d => calcLosses(d.norm, cfg, 85))
    const lossTable = (rows, tempLabel) => `<table style="border-collapse:collapse;width:100%">
      <caption style="text-align:left;font-weight:700;margin-bottom:4px">Loss @ ${tempLabel}</caption>
      <thead><tr>${['Loss Component','Formula',...doneItems.map(d => d.norm.name)].map(h => `<th style="${thStyle}">${h}</th>`).join('')}</tr></thead>
      <tbody>
        ${[
          ['Conduction [W]','Isw²×Rds_par',rows.map(l=>l.cond)],
          ['Turn-ON sw [W]','½·Vbus·Ipk·(Qgd/Ig_on)·fsw·N',rows.map(l=>l.sw_on)],
          ['Turn-OFF sw [W]','½·Vbus·Ipk·(Qgd/Ig_off)·fsw·N',rows.map(l=>l.sw_off)],
          ['Qrr loss [W]','Vbus·Qrr·fsw·N',rows.map(l=>l.qrr)],
          ['Coss [W]','½·Coss·Vbus²·fsw·N',rows.map(l=>l.coss)],
          ['Gate [W]','Qg·Vgs·fsw·N',rows.map(l=>l.gate)],
          ['TOTAL / switch-pos [W]','',rows.map(l=>l.total)],
          ['Efficiency [%]','Pout/(Pout+Ploss)',rows.map(l=>l.eff)],
          ['Est. Tj [°C]','',rows.map(l=>l.t_junc)],
          ['Rds derate','',rows.map(l=>l.rds_derate_src)],
        ].map(([label, formula, vals]) => `<tr><td style="${tdStyle}">${label}</td><td style="${tdStyle};color:#666;font-family:monospace">${formula}</td>${vals.map(v => `<td style="${tdMono}">${v}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>`

    const html = `<!DOCTYPE html><html><head><title>MOSFET Comparison — ${parts}</title>
    <style>body{font-family:Arial,sans-serif;padding:24px;color:#111} h1{font-size:18px} h2{font-size:14px;margin-top:24px;border-bottom:2px solid #3b82f6;padding-bottom:4px;color:#1d4ed8} p{font-size:11px;color:#555} @media print{body{padding:8px}}</style>
    </head><body>
    <h1>⚡ MOSFET Comparison Report</h1>
    <p>Generated: ${ts} | System: ${sysInfo}</p>
    <h2>Extracted Datasheet Parameters</h2>${paramTable}
    <h2>Ringing Analysis Ranking (Switch-Node Physics, Steps 1–8)</h2>
    <p>L_loop = ${cfg.l_loop_nh} nH | Synchronous = ${cfg.synchronous ? 'yes' : 'no'} | C_snub = ${cfg.c_snub_nf || 0} nF</p>
    ${ringTable}
    <h2>Loss Analysis @ 25°C</h2>${lossTable(lossRows25, '25°C')}
    <h2>Loss Analysis @ 85°C</h2>${lossTable(lossRows85, '85°C (derating per device above)')}
    <p style="margin-top:16px;font-size:10px;color:#888">V_ring predictions are relative rankings. Absolute accuracy limited by damping (not modeled), Qrr di/dt dependence, and Coss nonlinearity. MC Designer v2 — mc-designer.app</p>
    </body></html>`

    const win = window.open('', '_blank')
    if (!win) { toast.error('Popup blocked — allow popups for this site and retry'); return }
    win.document.write(html)
    win.document.close()
    setTimeout(() => win.print(), 400)
  }

  const sysInfo = `${cfg.vbus}V · ${cfg.irms}A(phase) · ${(cfg.fsw / 1000).toFixed(0)}kHz · ${cfg.npar}× parallel/switch`

  const anyLowConf = ringings.some(r => r.confidence === 'low')
  const anyMedConf = ringings.some(r => r.confidence === 'medium')

  return (
    <div className="mla-root" style={{ maxWidth: 1280, margin: '0 auto', padding: '8px 8px 24px 8px' }}>

      {/* ── Header ── */}
      <div className="card mla-header-card" style={{ padding: '14px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="mla-header-icon" style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(37,99,235,0.16)', border: '1px solid rgba(37,99,235,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>⚡</div>
        <div style={{ flex: 1 }}>
          <div className="mla-header-logo">Power Electronics Tool</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--txt-1)' }}>MOSFET Loss &amp; Ringing Analyzer</div>
          <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>Upload up to {MAX_UPLOADS} datasheets — AI extracts, then compare by loss efficiency or switch-node ringing physics.</div>
        </div>
        {phase === 'results' && <button className="btn btn-ghost" onClick={resetAll}>New Analysis</button>}
      </div>

      {/* ── Steps ── */}
      <div className="card mla-steps-wrap" style={{ padding: 6, marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          {[
            { key: 'upload', title: 'Upload PDFs', idx: 1 },
            { key: 'config', title: 'Set Conditions', idx: 2 },
            { key: 'results', title: 'Results', idx: 3 },
          ].map(step => {
            const done = (step.key === 'upload' && ['config','loading','results'].includes(phase))
              || (step.key === 'config' && ['loading','results'].includes(phase))
            const active = (step.key === 'upload' && phase === 'upload')
              || (step.key === 'config' && phase === 'config')
              || (step.key === 'results' && ['loading','results'].includes(phase))
            // Steps are clickable to navigate back when results exist
            const clickable =
              (step.key === 'upload' && ['config', 'results'].includes(phase)) ||
              (step.key === 'config' && phase === 'results')
            const clickTarget = step.key === 'upload' ? 'upload' : 'config'
            const hint = step.key === 'upload'
              ? 'click to add / remove PDFs ↩'
              : 'click to edit conditions ↩'
            return (
              <div
                key={step.key}
                className={`mla-step ${active ? 'active' : ''} ${done ? 'done' : ''}`.trim()}
                onClick={clickable ? () => setPhase(clickTarget) : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8, padding: '8px 10px',
                  border: `1px solid ${active ? 'rgba(79,195,247,0.5)' : clickable ? 'rgba(0,230,118,0.4)' : 'var(--border-1)'}`,
                  background: active ? 'rgba(79,195,247,0.08)' : clickable ? 'rgba(0,230,118,0.06)' : 'var(--bg-2)',
                  cursor: clickable ? 'pointer' : 'default',
                }}
                title={clickable ? hint : undefined}
              >
                <div className="mla-step-num" style={{ width: 22, height: 22, borderRadius: 6, background: done ? 'var(--green)' : active ? 'var(--accent)' : 'var(--bg-4)', color: done || active ? '#fff' : 'var(--txt-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {done ? '✓' : step.idx}
                </div>
                <div style={{ flex: 1 }}>
                  <span className="mla-step-label" style={{ fontSize: 11, color: active ? 'var(--txt-1)' : 'var(--txt-3)', fontWeight: active ? 700 : 600 }}>{step.title}</span>
                  {clickable && <div style={{ fontSize: 9, color: 'var(--green)', marginTop: 1 }}>{hint}</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Upload ── */}
      {phase === 'upload' && (
        <div className="card" style={{ padding: 14 }}>
          <div className="mla-card-title" style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt-2)', marginBottom: 10 }}>Step 1 — Upload MOSFET Datasheets (2 to {MAX_UPLOADS})</div>
          <input ref={fileInputRef} type="file" accept=".pdf" multiple style={{ display: 'none' }} onChange={e => addFiles(Array.from(e.target.files || []))} />
          <div className="mla-dropzone" onClick={() => fileInputRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files || [])) }} style={{ border: '2px dashed var(--border-2)', borderRadius: 10, padding: '34px 16px', textAlign: 'center', cursor: 'pointer', background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ fontSize: 38, marginBottom: 10 }}>📄</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt-1)' }}>Drop MOSFET PDFs here or click to browse</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 4 }}>All files queued. Extraction runs one-by-one safely.</div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map((f, idx) => (
              <div key={f.id} className="mla-file-item" style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 7, border: '1px solid var(--border-1)', background: 'var(--bg-3)', padding: '6px 10px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt-3)', width: 24 }}>{idx + 1}</span>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--txt-2)', fontFamily: 'var(--font-mono)' }}>{f.name}</span>
                <span style={{ fontSize: 10, color: f.status === 'error' ? 'var(--red)' : f.status === 'done' ? 'var(--green)' : 'var(--txt-3)' }}>{f.status === 'done' ? 'ready' : f.status}</span>
                <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => removeFile(f.id)}>Remove</button>
              </div>
            ))}
            {!files.length && <div style={{ fontSize: 11, color: 'var(--txt-3)', padding: '8px 2px' }}>No files added yet.</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={files.length < 2} onClick={goToConfig}>Continue → Set Conditions</button>
            <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>+ Add More</button>
            <span style={{ fontSize: 11, color: files.length < 2 ? 'var(--amber)' : 'var(--txt-3)' }}>
              {files.length < 2 ? 'Upload at least 2 files to compare' : `${files.length}/${MAX_UPLOADS} files selected`}
            </span>
            {doneItems.length > 0 && (
              <button className="btn btn-ghost" style={{ marginLeft: 'auto', color: 'var(--green)', borderColor: 'rgba(0,230,118,0.4)' }} onClick={() => setPhase('results')}>
                → Back to Results
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Config ── */}
      {phase === 'config' && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt-2)', marginBottom: 10 }}>Step 2 — Operating Conditions</div>

          {/* Existing fields */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 }}>
            <FormInput label="DC Bus Voltage [V]" value={cfg.vbus} onChange={v => updateCfg('vbus', v)} />
            <FormInput label="Phase Current RMS [A] (total)" value={cfg.irms} onChange={v => updateCfg('irms', v)} />
            <FormInput label="Switching Freq [Hz]" value={cfg.fsw} onChange={v => updateCfg('fsw', v)} />
            <FormInput label="Parallel MOSFETs / switch" value={cfg.npar} onChange={v => updateCfg('npar', Math.max(1, Math.min(12, parseInt(v || '1', 10) || 1)))} />
            <FormInput label="Bootstrap Resistor Rboot [Ω]" value={cfg.rboot} onChange={v => updateCfg('rboot', v)} />
            <FormInput label="Gate Drive Voltage Vgs [V]" value={cfg.vgs} onChange={v => updateCfg('vgs', v)} />
            <FormInput label="Turn-ON Gate Rg_on [Ω] (per MOSFET)" value={cfg.rg_on} onChange={v => updateCfg('rg_on', v)} />
            <FormInput label="Turn-OFF Gate Rg_off [Ω] (per MOSFET)" value={cfg.rg_off} onChange={v => updateCfg('rg_off', v)} />
            <FormInput label="Driver Source Current [A]" value={cfg.idr_src} onChange={v => updateCfg('idr_src', v)} />
            <FormInput label="Driver Sink Current [A]" value={cfg.idr_snk} onChange={v => updateCfg('idr_snk', v)} />
            <FormInput label="Bootstrap Cap Cb [μF]" value={cfg.cb} onChange={v => updateCfg('cb', v)} />
            <FormInput label="Bootstrap Diode Vf [V]" value={cfg.vf} onChange={v => updateCfg('vf', v)} />
          </div>

          <div className="note-box blue" style={{ marginTop: 10, fontFamily: 'var(--font-mono)' }}>
            I_peak(total)={num(derived.Ipk, 1)}A · I_sw_rms(total)={num(derived.Isw, 1)}A · I_sw_rms/device={num(derived.IswDev, 1)}A · I_peak/device={num(derived.IpkDev, 1)}A · T_sw={num(1e6 / Math.max(cfg.fsw, 1), 2)}µs
          </div>

          {/* ── Ringing Analysis Parameters ── */}
          <div style={{ marginTop: 20, borderTop: '2px solid var(--border-1)', paddingTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--cyan)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 12 }}>
              ⚡ Ringing Analysis Parameters
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10 }}>

              {/* L_loop — primary required input */}
              <FormInput
                label="Power-Loop Inductance [nH]"
                value={cfg.l_loop_nh}
                onChange={v => updateCfg('l_loop_nh', v)}
              />

              {/* f_ring_ref — optional, with info icon */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                  Measured Ring Freq [MHz]
                  <InfoIcon text="Optional. If you have a scope measurement of ringing frequency on your board with any MOSFET, enter it here. L_loop is back-solved as L = 1/((2π·f)²·C_total). This is more accurate than a manual L_loop estimate. Leave blank if no scope measurement is available." />
                  <span style={{ color: 'var(--txt-4)', fontSize: 9, fontWeight: 500, textTransform: 'none' }}>(optional)</span>
                </span>
                <input
                  className="inp inp-mono"
                  type="number" step="any" min="0"
                  value={cfg.f_ring_ref_mhz}
                  onChange={e => setCfg(prev => ({ ...prev, f_ring_ref_mhz: e.target.value }))}
                  placeholder="e.g. 12.9"
                />
              </label>

              {/* C_snub — optional */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                  Snubber Cap Total [nF]
                  <InfoIcon text="Optional. Sum of all snubber capacitors in the resonant loop (HS + LS snubbers if both fitted). If left at 0, calculation uses only Coss×N + 0.5 nF stray for C_total. Entering the actual snubber value improves frequency prediction accuracy." />
                  <span style={{ color: 'var(--txt-4)', fontSize: 9, fontWeight: 500, textTransform: 'none' }}>(optional)</span>
                </span>
                <input
                  className="inp inp-mono"
                  type="number" step="any" min="0"
                  value={cfg.c_snub_nf}
                  onChange={e => updateCfg('c_snub_nf', e.target.value)}
                  placeholder="e.g. 2"
                />
              </label>

              {/* Synchronous checkbox */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                  Synchronous Topology
                  <InfoIcon text="Enable for synchronous rectification / motor drives where the off-side MOSFET body diode conducts during dead-time. This activates the Q_rr term in the peak commutation current formula. Disable for non-synchronous topologies (Schottky free-wheel diode) — the Q_rr term becomes zero." />
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '7px 10px', border: '1px solid var(--border-2)', borderRadius: 6, background: 'var(--bg-3)', marginTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={cfg.synchronous}
                    onChange={e => setCfg(prev => ({ ...prev, synchronous: e.target.checked }))}
                    style={{ width: 14, height: 14, accentColor: 'var(--cyan)', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 12, color: cfg.synchronous ? 'var(--cyan)' : 'var(--txt-2)', fontWeight: 600 }}>
                    {cfg.synchronous ? 'Synchronous (body diode conducts)' : 'Non-synchronous (no Q_rr term)'}
                  </span>
                </label>
              </label>
            </div>

            {/* Warning if L_loop will use default */}
            {(!(toNum(cfg.l_loop_nh) > 0) && !(toNum(cfg.f_ring_ref_mhz) > 0)) && (
              <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 7, border: '1px solid var(--amber)', background: 'rgba(255,171,0,0.08)', fontSize: 11, color: 'var(--amber)' }}>
                ⚠ L_loop not set and no f_ring_ref provided — ringing analysis will use 20 nH default (4-layer PCB estimate). Predictions valid for ranking only. For higher accuracy: measure f_ring on scope and enter it above.
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={() => setPhase('upload')}>← Back</button>
            <button className="btn btn-primary" onClick={runAnalysis}>Run AI Analysis</button>
            {doneItems.length > 0 && (
              <button className="btn btn-ghost" style={{ marginLeft: 'auto', color: 'var(--green)', borderColor: 'rgba(0,230,118,0.4)' }} onClick={() => setPhase('results')}>
                → Back to Results
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Loading ── */}
      {phase === 'loading' && (
        <div className="card" style={{ padding: '28px 18px' }}>
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 34, marginBottom: 6 }}>⏳</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt-1)' }}>Extracting Datasheets Sequentially</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>Files processed one-by-one to keep extraction stable.</div>
          </div>
          <div style={{ maxWidth: 620, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map(f => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border-1)', borderRadius: 7, padding: '7px 10px', background: f.status === 'extracting' ? 'rgba(30,144,255,0.09)' : 'var(--bg-3)' }}>
                <span style={{ width: 18, textAlign: 'center', fontSize: 11, color: f.status === 'done' ? 'var(--green)' : f.status === 'error' ? 'var(--red)' : 'var(--txt-3)' }}>
                  {f.status === 'done' ? '✓' : f.status === 'extracting' ? '►' : f.status === 'error' ? '✗' : '○'}
                </span>
                <span style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--txt-2)' }}>{f.name}</span>
                <span style={{ fontSize: 10, color: f.status === 'done' ? 'var(--green)' : f.status === 'error' ? 'var(--red)' : 'var(--txt-3)' }}>
                  {f.status === 'extracting' ? 'extracting…' : f.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {phase === 'results' && (
        <>
          {/* Results header: sys info + mode toggle + temp toggle (loss mode only) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="mla-result-info" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt-2)', background: 'var(--bg-3)', border: '1px solid var(--border-1)', borderRadius: 6, padding: '5px 8px' }}>{sysInfo}</span>

            {/* Mode toggle */}
            <div style={{ marginLeft: 'auto', display: 'flex', border: '1px solid var(--border-2)', borderRadius: 6, overflow: 'hidden' }}>
              <button
                style={{ border: 'none', borderRadius: 0, padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'background 0.15s', background: analysisMode === 'ringing' ? 'var(--cyan)' : 'var(--bg-3)', color: analysisMode === 'ringing' ? '#000' : 'var(--txt-3)' }}
                onClick={() => setAnalysisMode('ringing')}
              >⚡ Ringing Analysis</button>
              <button
                style={{ border: 'none', borderLeft: '1px solid var(--border-2)', borderRadius: 0, padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'background 0.15s', background: analysisMode === 'loss' ? 'var(--accent)' : 'var(--bg-3)', color: analysisMode === 'loss' ? '#fff' : 'var(--txt-3)' }}
                onClick={() => setAnalysisMode('loss')}
              >🔥 Loss Analysis</button>
            </div>

            {/* Export PDF */}
            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }} onClick={exportComparison} title="Export comparison as printable HTML/PDF">📄 Export PDF</button>

            {/* Temperature toggle — loss mode only */}
            {analysisMode === 'loss' && (
              <div className="mla-temp-toggle" style={{ display: 'flex', border: '1px solid var(--border-2)', borderRadius: 6, overflow: 'hidden' }}>
                <button className={`btn mla-temp-btn ${currentTemp === 25 ? 'active' : ''}`} style={{ border: 'none', borderRadius: 0, background: currentTemp === 25 ? 'var(--accent)' : 'var(--bg-3)', color: currentTemp === 25 ? '#fff' : 'var(--txt-3)', padding: '6px 12px' }} onClick={() => setCurrentTemp(25)}>25°C</button>
                <button className={`btn mla-temp-btn ${currentTemp === 85 ? 'active' : ''}`} style={{ border: 'none', borderRadius: 0, background: currentTemp === 85 ? 'var(--accent)' : 'var(--bg-3)', color: currentTemp === 85 ? '#fff' : 'var(--txt-3)', padding: '6px 12px' }} onClick={() => setCurrentTemp(85)}>85°C</button>
              </div>
            )}
          </div>

          {/* Extracted params table — always shown in both modes */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="sec-head">
              <span>📋 Extracted Datasheet Parameters</span>
              <span className="mla-tag">AI Extracted From PDF</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="ptable">
                <thead>
                  <tr>
                    <th style={{ minWidth: 200 }}>Parameter</th>
                    {doneItems.map(item => (
                      <th key={item.id} style={{ minWidth: 130 }}>
                        {item.norm.name}
                        <div style={{ fontSize: 10, color: 'var(--txt-3)', fontWeight: 500 }}>{item.norm.manufacturer || '—'}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'VDS max [V]', key: 'vds_max', lb: false },
                    { label: 'ID max @25°C [A]', key: 'id_max_25c', lb: false },
                    { label: 'RDS(on) max @10V [mΩ]', key: 'rds_on_max_10v', lb: true },
                    { label: 'Vgs(th) typ [V]', key: 'vgs_th_typ', lb: true },
                    { label: 'Qg total [nC]', key: 'qg_total', lb: true },
                    { label: 'Qgs [nC]', key: 'qgs', lb: true },
                    { label: 'Qgd Miller [nC]', key: 'qgd', lb: true },
                    { label: 'Qrr [nC]', key: 'qrr', lb: true },
                    { label: 'trr [ns]', key: 'trr', lb: true },
                    { label: 'Ciss [pF]', key: 'ciss', lb: true },
                    { label: 'Coss [pF]', key: 'coss', lb: true },
                    { label: 'Coss,er [pF]', key: 'coss_er', lb: true },
                    { label: 'g_fs [S]', key: 'g_fs', lb: false },
                    { label: 'Vgs plateau [V]', key: 'vgs_plateau', lb: null },
                    { label: 'Rg internal [Ω]', key: 'rg_internal', lb: true },
                    { label: 'td(on) [ns]', key: 'td_on', lb: true },
                    { label: 'tr [ns]', key: 'tr', lb: true },
                    { label: 'td(off) [ns]', key: 'td_off', lb: true },
                    { label: 'tf [ns]', key: 'tf', lb: true },
                    { label: 'RthJC max [°C/W]', key: 'rth_jc', lb: true },
                    { label: 'Package', key: 'package', lb: null },
                  ].map(row => {
                    const values = doneItems.map(item => item.norm[row.key])
                    const ranks = row.lb == null ? values.map(() => '') : getRanks(values, row.lb)
                    return (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        {values.map((v, i) => (
                          <td key={`${row.key}_${doneItems[i].id}`} style={rankStyle(ranks[i]) || undefined}>
                            {row.key === 'package' ? (v || '—') : num(v, 2)}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ═══════════════ RINGING MODE ═══════════════ */}
          {analysisMode === 'ringing' && (
            <>
              {/* Confidence banner */}
              {(anyLowConf || anyMedConf) && (
                <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 8, border: `1px solid ${anyLowConf ? 'var(--amber)' : 'var(--border-2)'}`, background: anyLowConf ? 'rgba(255,171,0,0.08)' : 'rgba(255,255,255,0.03)', fontSize: 12 }}>
                  <span style={{ fontWeight: 700, color: anyLowConf ? 'var(--amber)' : 'var(--txt-2)' }}>
                    {anyLowConf ? '⚠ LOW CONFIDENCE' : 'ℹ MEDIUM CONFIDENCE'}
                  </span>
                  <span style={{ color: 'var(--txt-3)', marginLeft: 8 }}>
                    {anyLowConf
                      ? 'One or more predictions use default/fallback values (L_loop not provided, Coss,er missing, or soft-diode heuristic active). Provide L_loop nH or measured f_ring_ref in Step 2 for higher accuracy. Rankings remain valid; absolute V_ring values may vary ±30%.'
                      : 'Some parameters use fallback values (e.g. 1.4×Coss instead of Coss,er). Rankings are reliable. See per-device details for specifics.'}
                  </span>
                </div>
              )}

              {/* Hero ranking table */}
              <div className="card" style={{ marginTop: 10, overflow: 'hidden' }}>
                <div className="sec-head">
                  <span>⚡ Ringing Analysis Ranking</span>
                  <span className="mla-tag" style={{ borderColor: 'rgba(0,212,232,0.35)', color: 'var(--cyan)', background: 'rgba(0,212,232,0.11)' }}>Switch-Node Physics · Steps 1–8</span>
                </div>
                <div className="table-wrap">
                  <table className="ptable">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th style={{ minWidth: 150 }}>Part</th>
                        <th>Body Diode</th>
                        {[
                          { key: 'ef', label: 'EF ⓘ', title: 't_plateau/(T_ring/2) — >1.0 = quiet, <1.0 = loud' },
                          { key: null, label: 'Regime' },
                          { key: 'vring', label: 'V_ring pred.' },
                          { key: 'fring', label: 'f_ring' },
                          { key: 'z0', label: 'Z₀' },
                          { key: null, label: 'Confidence' },
                          { key: null, label: 'Verdict', style: { minWidth: 180 } },
                        ].map(({ key, label, title, style }) => (
                          <th key={label} style={{ ...style, cursor: key ? 'pointer' : undefined, userSelect: 'none' }}
                            title={title}
                            onClick={key ? () => toggleSort(key) : undefined}
                          >
                            {label}
                            {key && sortKey === key && <span style={{ marginLeft: 4, fontSize: 9 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
                            {key && sortKey !== key && <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.3 }}>⇅</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayRinging.map((entry, rank) => {
                        const { item, r } = entry
                        const medals = ['🏆', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']
                        if (r.disqualified) {
                          return (
                            <tr key={item.id} style={{ background: 'rgba(255,68,68,0.07)' }}>
                              <td style={{ color: 'var(--red)', fontWeight: 700 }}>DQ</td>
                              <td><strong style={{ color: 'var(--red)' }}>{item.norm.name}</strong><div style={{ fontSize: 10, color: 'var(--txt-3)' }}>{item.norm.manufacturer}</div></td>
                              <td><DiodeBadge type={r.body_diode_type} /></td>
                              <td colSpan={7} style={{ color: 'var(--red)', fontSize: 11 }}>Disqualified: {r.disq_reasons.join(' | ')}</td>
                            </tr>
                          )
                        }
                        return (
                          <tr key={item.id} style={{ background: rank === 0 ? 'rgba(0,212,232,0.05)' : undefined }}>
                            <td style={{ fontSize: 18, fontWeight: 700 }}>{medals[rank] || rank + 1}</td>
                            <td>
                              <strong style={{ color: rank === 0 ? 'var(--cyan)' : 'var(--txt-1)' }}>{item.norm.name}</strong>
                              <div style={{ fontSize: 10, color: 'var(--txt-3)' }}>{item.norm.manufacturer} · {item.norm.package || '—'}</div>
                            </td>
                            <td><DiodeBadge type={r.body_diode_type} /></td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 15, color: efColor(r.excitation_factor) }}>
                              {r.excitation_factor.toFixed(3)}
                            </td>
                            <td><RegimeBadge regime={r.regime} /></td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: rank === 0 ? 'var(--green)' : 'var(--txt-1)' }}>
                              {r.v_ring_pred_v.toFixed(2)} V
                            </td>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{r.f_ring_mhz.toFixed(1)} MHz</td>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{r.z0_ohms.toFixed(2)} Ω</td>
                            <td><ConfBadge level={r.confidence} /></td>
                            <td style={{ fontSize: 11, color: 'var(--txt-2)', lineHeight: 1.4 }}>{ringingVerdict(r, item.norm, rank)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--txt-4)', borderTop: '1px solid var(--border-1)', fontFamily: 'var(--font-mono)' }}>
                  V_ring_pred = I_pk · Z₀ (EF&lt;1) or I_pk · Z₀ · (T_ring/2)/t_plateau (EF≥1) · EF = t_plateau/(T_ring/2) · I_pk = I_load + I_rr,pk + 0.4·I_dvdt
                </div>
              </div>

              {/* Per-device calculation detail cards */}
              <div className="card" style={{ marginTop: 10 }}>
                <div className="sec-head">🔬 Per-Device Calculation Breakdown</div>
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {doneItems.map((item, idx) => {
                    const r = ringings[idx]
                    return (
                      <div key={item.id} style={{ border: '1px solid var(--border-1)', borderRadius: 10, overflow: 'hidden' }}>
                        {/* Device header */}
                        <div style={{ padding: '8px 12px', background: 'var(--bg-3)', borderBottom: '1px solid var(--border-1)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--txt-1)' }}>{item.norm.name}</span>
                            <span style={{ fontSize: 10, color: 'var(--txt-3)', marginLeft: 8 }}>{item.norm.manufacturer} · {item.norm.package || '—'}</span>
                          </div>
                          <DiodeBadge type={r.body_diode_type} />
                          <RegimeBadge regime={r.regime} ef={r.excitation_factor} />
                          <ConfBadge level={r.confidence} />
                          {r.disqualified && (
                            <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(255,68,68,0.15)', color: 'var(--red)', fontWeight: 700 }}>DISQUALIFIED</span>
                          )}
                        </div>

                        {/* Confidence/fallback notes */}
                        {r.conf_notes.length > 0 && (
                          <div style={{ padding: '7px 12px', background: 'rgba(255,171,0,0.06)', borderBottom: '1px solid var(--border-1)' }}>
                            {r.conf_notes.map((n, i) => <div key={i} style={{ fontSize: 10, color: 'var(--amber)' }}>⚠ {n}</div>)}
                          </div>
                        )}

                        {/* Disqualifier reasons */}
                        {r.disqualified && (
                          <div style={{ padding: '7px 12px', background: 'rgba(255,68,68,0.06)', borderBottom: '1px solid var(--border-1)' }}>
                            {r.disq_reasons.map((n, i) => <div key={i} style={{ fontSize: 11, color: 'var(--red)' }}>✗ {n}</div>)}
                          </div>
                        )}

                        {/* Calculation grid */}
                        <div style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 }}>
                          <RingMetric title="C_oss,eff (per device)" value={`${r.c_oss_eff_pf.toFixed(0)} pF`} formula="Coss,er or 1.4×Coss(40V)" source={r.sources.c_oss_eff} />
                          <RingMetric title={`C_oss,total (×${cfg.npar})`} value={`${r.c_oss_total_pf.toFixed(0)} pF`} formula={`${cfg.npar} × C_oss,eff`} source="calc: scaled for N parallel" />
                          <RingMetric title="C_external (snubber + stray)" value={`${r.c_external_pf.toFixed(0)} pF`} formula="C_snub + 0.5 nF stray" source={`calc: C_snub = ${(toNum(cfg.c_snub_nf)||0)} nF entered`} />
                          <RingMetric title="C_total (resonant tank)" value={`${r.c_total_pf.toFixed(0)} pF`} formula="N×C_oss,eff + C_external" source="calc" hue="blue" />
                          <RingMetric title="L_loop" value={`${r.l_loop_nh.toFixed(1)} nH`} formula="power-loop parasitic inductance" source={r.sources.l_loop} />
                          <RingMetric title="g_fs (transconductance)" value={`${r.gfs.toFixed(0)} S`} formula="I_load/(V_pl−Vth) if derived" source={r.sources.g_fs} />
                          <RingMetric title="V_plateau" value={`${r.v_plateau.toFixed(2)} V`} formula="Vth + I_load/gfs if derived" source={r.sources.v_plateau} />
                          <RingMetric title="I_gate (HS turn-on)" value={`${(r.i_gate_a * 1000).toFixed(0)} mA`} formula="(Vgs − V_pl) / (Rg,on + Rg,int)" source="calc" />
                          <RingMetric title="t_plateau (Miller dwell)" value={`${r.t_plateau_ns.toFixed(1)} ns`} formula="Q_gd / I_gate" source="calc" hue="blue" />
                          <RingMetric title="dV/dt" value={`${r.dv_dt_vns.toFixed(2)} V/ns`} formula="V_bus / t_plateau" source="calc" />
                          <RingMetric title="f_ring" value={`${r.f_ring_mhz.toFixed(2)} MHz`} formula="1/(2π·√(L·C))" source="calc" />
                          <RingMetric title="T_ring / 2" value={`${r.t_half_ns.toFixed(1)} ns`} formula="1/(2·f_ring)" source="calc" />
                          <RingMetric title="Z₀ (char. impedance)" value={`${r.z0_ohms.toFixed(3)} Ω`} formula="√(L/C)" source="calc" />
                          <RingMetric title="I_rr,pk" value={`${r.i_rr_pk_a.toFixed(2)} A`} formula="2·Q_rr,total/t_rr or 0.15·I_load" source={r.sources.i_rr} />
                          <RingMetric title="I_dvdt (Coss charging)" value={`${r.i_dvdt_a.toFixed(2)} A`} formula="C_oss,total × dV/dt" source="calc" />
                          <RingMetric title="I_pk (commutation)" value={`${r.i_pk_a.toFixed(2)} A`} formula="I_load + I_rr,pk + 0.4·I_dvdt" source="calc" hue="blue" />
                          <RingMetric
                            title="Excitation Factor"
                            value={r.excitation_factor.toFixed(3)}
                            formula="t_plateau / (T_ring/2)"
                            source="calc — KEY METRIC"
                            hue={r.excitation_factor >= 1.0 ? 'green' : 'red'}
                          />
                          <RingMetric
                            title="V_ring predicted"
                            value={`${r.v_ring_pred_v.toFixed(2)} V`}
                            formula={r.excitation_factor >= 1.0 ? 'I_pk·Z₀·(T½/t_pl) [under-excited]' : 'I_pk · Z₀ [fully excited]'}
                            source="calc — ranking metric"
                            hue={r.excitation_factor >= 1.0 ? 'green' : 'red'}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Board Recommendations */}
              {boardRecs.length > 0 && (
                <div className="card" style={{ marginTop: 10 }}>
                  <div className="sec-head">💡 Board-Level Recommendations</div>
                  <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {boardRecs.map((rec, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border-1)', background: 'var(--bg-3)', fontSize: 12, color: 'var(--txt-2)', lineHeight: 1.6 }}>
                        <span style={{ color: 'var(--cyan)', fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
                        <span>{rec}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 10, color: 'var(--txt-4)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                      Note: V_ring predictions are relative for ranking. Absolute accuracy limited by damping (not modeled), Q_rr di/dt dependence, and C_oss nonlinearity. Relative rankings remain valid.
                    </div>
                  </div>
                </div>
              )}

              {/* Apply to project — ringing ranking order */}
              <div className="card" style={{ marginTop: 10 }}>
                <div className="sec-head">🏆 Ringing Ranking — Apply to Project</div>
                <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
                  {rankedRinging.map((entry, rank) => {
                    const { item, r } = entry
                    const medals = ['🏆', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']
                    const borderColors = ['#06b6d4', '#2563eb', '#d97706', '#607d8b']
                    return (
                      <div key={item.id} className="mla-rank-card" style={{ border: '1px solid var(--border-1)', borderLeft: `4px solid ${r.disqualified ? '#ef4444' : (borderColors[rank] || '#607d8b')}`, borderRadius: 10, padding: 12, background: 'var(--bg-2)' }}>
                        <div style={{ fontSize: 22, marginBottom: 4 }}>{medals[rank] || rank + 1}</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--txt-1)' }}>{item.norm.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--txt-3)', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>{item.norm.manufacturer || '—'} · {item.norm.package || '—'}</div>
                        {r.disqualified ? (
                          <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8 }}>✗ Disqualified: {r.disq_reasons[0]}</div>
                        ) : (
                          <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                            <div>⚡ Excitation Factor: <strong style={{ color: efColor(r.excitation_factor) }}>{r.excitation_factor.toFixed(3)}</strong></div>
                            <div>📊 Regime: <strong><RegimeBadge regime={r.regime} inline /></strong></div>
                            <div>🔔 V_ring_pred: <strong style={{ color: rank === 0 ? 'var(--green)' : 'var(--txt-1)' }}>{r.v_ring_pred_v.toFixed(2)} V</strong></div>
                            <div>🌀 Body Diode: <strong><DiodeBadge type={r.body_diode_type} inline /></strong></div>
                            <div>📐 Z₀: <strong>{r.z0_ohms.toFixed(2)} Ω</strong></div>
                            <div>📡 f_ring: <strong>{r.f_ring_mhz.toFixed(1)} MHz</strong></div>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => applyMosfetToProject(item)}>
                            Use in MOSFET Tab
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {/* ═══════════════ LOSS MODE ═══════════════ */}
          {analysisMode === 'loss' && (
            <>
              <div className="card" style={{ marginTop: 10, overflow: 'hidden' }}>
                <div className="sec-head">🔥 Loss Breakdown @ {currentTemp}°C — Per Switch Position</div>
                <div className="table-wrap" style={{ maxHeight: 420 }}>
                  <table className="ptable">
                    <thead>
                      <tr>
                        <th style={{ minWidth: 220 }}>Loss Component</th>
                        <th style={{ minWidth: 210 }}>Formula</th>
                        {doneItems.map(item => <th key={`loss_h_${item.id}`} style={{ minWidth: 120 }}>{item.norm.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { label: `1. Conduction [W]${cfg.npar > 1 ? ` (${cfg.npar} dev)` : ''}`, formula: 'Isw²×RDS_par×Tderate', key: 'cond', lb: true },
                        { label: '2. Turn-ON switching [W]', formula: '½×Vbus×Ipk_dev×(Qgd/Ig_on)×fsw×N', key: 'sw_on', lb: true },
                        { label: '3. Turn-OFF switching [W]', formula: '½×Vbus×Ipk_dev×(Qgd/Ig_off)×fsw×N', key: 'sw_off', lb: true },
                        { label: '4. Body Diode Qrr [W]', formula: 'Vbus×Qrr×fsw×N', key: 'qrr', lb: true },
                        { label: '5. Coss [W]', formula: '½×Coss×Vbus²×fsw×N', key: 'coss', lb: true },
                        { label: '6. Gate Drive [W]', formula: 'Qg×Vgs×fsw×N', key: 'gate', lb: true },
                      ].map(row => {
                        const vals = losses.map(l => l[row.key])
                        const ranks = getRanks(vals, row.lb)
                        return (
                          <tr key={row.key}>
                            <td>{row.label}</td>
                            <td style={{ color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>{row.formula}</td>
                            {vals.map((v, i) => <td key={`${row.key}_${doneItems[i].id}`} style={rankStyle(ranks[i]) || undefined}>{v}</td>)}
                          </tr>
                        )
                      })}
                      {[
                        { label: `TOTAL / switch-pos [W]${cfg.npar > 1 ? ` (${cfg.npar}× MOSFET)` : ''}`, formula: 'Σ rows 1–6', key: 'total', lb: true, cls: 'rgba(30,144,255,0.10)' },
                        { label: '3-phase total [W] (×6 positions)', formula: '×6 switch positions', key: 'total3ph', lb: true },
                        { label: 'Efficiency [%]', formula: 'Pout/(Pout+Ploss)', key: 'eff', lb: false, cls: 'rgba(0,230,118,0.10)' },
                        { label: 'Est. Junction Temp Tj [°C]', formula: `Tamb + P_dev×(RthJC+RthCS+RthSA[${project.system_specs.cooling || 'natural'}])`, key: 't_junc', lb: true, cls: 'rgba(255,171,0,0.10)' },
                        { label: 'ΔTj (J-C) per MOSFET [°C]', formula: 'P_dev × RthJC', key: 'dtj_jc', lb: true },
                        { label: `RDS parallel [mΩ] @${currentTemp}°C`, formula: 'RDS_single÷N × Tder', key: 'rds', lb: true },
                        { label: 'Rds derate source', formula: 'datasheet or interpolated', key: 'rds_derate_src', lb: null, noRank: true },
                      ].map(row => {
                        const vals = losses.map(l => l[row.key])
                        const ranks = row.lb == null ? vals.map(() => '') : getRanks(vals, row.lb)
                        return (
                          <tr key={row.key} style={{ background: row.cls || undefined }}>
                            <td>{row.label}</td>
                            <td style={{ color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>{row.formula}</td>
                            {vals.map((v, i) => (
                              <td key={`${row.key}_${doneItems[i].id}`} style={{ ...(rankStyle(ranks[i]) || {}), ...(row.noRank ? { fontSize: 10, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' } : {}) }}>
                                {v}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card" style={{ marginTop: 10 }}>
                <div className="sec-head">⏱️ Gate Drive, Timing, Dead Time, Bootstrap</div>
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {doneItems.map((item, idx) => {
                    const t = timings[idx]
                    const p = item.norm
                    const dtRec = toNum(t.dt_rec)
                    const dtClass = dtRec > 500 ? 'rgba(255,68,68,0.12)' : dtRec > 200 ? 'rgba(255,171,0,0.12)' : 'rgba(0,230,118,0.10)'
                    const cbClass = t.cbOk ? 'rgba(0,230,118,0.10)' : 'rgba(255,68,68,0.12)'
                    const rippleClass = toNum(t.dVb_act) > 0.5 ? 'rgba(255,171,0,0.12)' : 'rgba(0,230,118,0.10)'
                    const dutyClass = toNum(t.D_max) < 80 ? 'rgba(255,171,0,0.12)' : 'rgba(30,144,255,0.10)'
                    return (
                      <div key={`tim_${item.id}`} style={{ border: '1px solid var(--border-1)', borderRadius: 10, overflow: 'hidden' }}>
                        <div style={{ padding: '8px 10px', background: 'var(--bg-3)', borderBottom: '1px solid var(--border-1)' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt-1)' }}>{p.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--txt-3)' }}>{p.manufacturer || '—'} · {p.package || '—'} · Rg_total_on={t.Rg_on}Ω/dev · Rg_total_off={t.Rg_off}Ω/dev · Vplateau={t.Vpl}V</div>
                        </div>
                        <div style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 }}>
                          <MetricCard title="Turn-ON Delay td(on)" value={t.td_on} unit="ns" formula="Ciss×Rg_on×ln(Vgs/(Vgs−Vth))" />
                          <MetricCard title="Rise Time t_rise (Vds fall)" value={t.t_rise} unit="ns" formula="Qgd ÷ ((Vgs−Vpl)/Rg_on)" hue="blue" />
                          <MetricCard title="Total Turn-ON" value={t.t_on_tot} unit="ns" formula="td(on)+t_rise" />
                          <MetricCard title="Turn-OFF Delay td(off)" value={t.td_off} unit="ns" formula="Ciss×Rg_off×ln(Vgs/(Vgs−Vpl))" />
                          <MetricCard title="Fall Time t_fall (Vds rise)" value={t.t_fall} unit="ns" formula="Qgd ÷ (Vpl/Rg_off)" hue="blue" />
                          <MetricCard title="Total Turn-OFF" value={t.t_off_tot} unit="ns" formula="td(off)+t_fall" />
                          <MetricCard title="Peak Gate I — Source" value={t.Ig_on_pk} unit="mA" formula="Vgs ÷ Rg_on_total" />
                          <MetricCard title="Peak Gate I — Sink" value={t.Ig_off_pk} unit="mA" formula="Vgs ÷ Rg_off_total" />
                          <MetricCard title="Dead Time Minimum DT_min" value={t.dt_min} unit="ns" formula="max(t_rise,t_fall)×1.3, floor 100ns" bg={dtClass} />
                          <MetricCard title="Recommended Dead Time" value={t.dt_rec} unit="ns" formula="DT_min × 1.25" bg={dtClass} />
                          <MetricCard title="Dead Time % of T_sw" value={t.dt_pct} unit="%" formula="DT_rec ÷ T_sw × 100" />
                          <MetricCard title="Body Diode Conduction / cycle" value={(toNum(t.dt_rec) * 2).toFixed(0)} unit="ns" formula="2 × DT_rec" />
                          <MetricCard title="Cb Min (N×Qg÷0.5V)" value={t.Cb_min} unit="nF" formula={`${cfg.npar}×Qg ÷ ΔVb`} bg={cbClass} />
                          <MetricCard title={`Your Cb = ${cfg.cb} µF`} value={t.cbOk ? 'OK' : 'LOW'} formula={`${(cfg.cb * 1000).toFixed(0)}nF vs ${t.Cb_min}nF`} bg={cbClass} />
                          <MetricCard title="Bootstrap Voltage" value={t.Vboot} unit="V" formula={`Vgs − Vf(${cfg.vf}V)`} />
                          <MetricCard title="Cb Voltage Ripple" value={t.dVb_act} unit="V" formula={`${cfg.npar}×Qg ÷ Cb_actual`} bg={rippleClass} />
                          <MetricCard title="Bootstrap Recharge Time" value={t.t_rech} unit="µs" formula="5 × Rboot × Cb" />
                          <MetricCard title="Max HS Duty Cycle" value={t.D_max} unit="%" formula="1 − t_recharge × fsw" bg={dutyClass} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="card" style={{ marginTop: 10 }}>
                <div className="sec-head">🏆 Loss-Based Ranking &amp; Recommendations</div>
                <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 10 }}>
                  {ranked.map((entry, rank) => {
                    const { item, l, t } = entry
                    const p = item.norm
                    const medals = ['🏆', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '11', '12']
                    const borderColors = ['#16a34a', '#2563eb', '#d97706']
                    const borderColor = borderColors[rank] || '#607d8b'
                    const qrrVal = toNum(p.qrr) || 0
                    const qrrBad  = qrrVal > 400
                    const qrrGood = qrrVal > 0 && qrrVal < 150
                    return (
                      <div key={`rank_${item.id}`} className="mla-rank-card" style={{ border: '1px solid var(--border-1)', borderLeft: `4px solid ${borderColor}`, borderRadius: 10, padding: 12, background: 'var(--bg-2)' }}>
                        <div style={{ fontSize: 24, marginBottom: 4 }}>{medals[rank] || `${rank + 1}`}</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--txt-1)' }}>{p.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--txt-3)', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>{p.manufacturer || '—'} · {p.package || '—'}</div>
                        <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                          <div>⚡ Efficiency: <strong style={{ color: 'var(--green)' }}>{l.eff}%</strong></div>
                          <div>🔥 Total loss/position: <strong>{l.total} W</strong></div>
                          <div>↩ Qrr loss: <strong style={{ color: qrrBad ? 'var(--red)' : qrrGood ? 'var(--green)' : 'var(--txt-1)' }}>{l.qrr} W</strong></div>
                          <div>📉 RDS parallel: <strong>{l.rds} mΩ</strong></div>
                          <div>🌡 ΔTj/MOSFET: <strong>{l.dtj}°C</strong></div>
                          <div>⏱ t_rise / t_fall: <strong>{t.t_rise} / {t.t_fall} ns</strong></div>
                          <div>⏸ Dead time rec: <strong>{t.dt_rec} ns</strong></div>
                          <div>🔋 Cb min: <strong>{t.Cb_min} nF</strong></div>
                          <div>🏭 3-phase total: <strong>{l.total3ph} W</strong></div>
                        </div>
                        {qrrBad  && <div className="note-box red"   style={{ marginTop: 8 }}>Qrr is high for hard-switched behavior; consider diode strategy.</div>}
                        {qrrGood && <div className="note-box green" style={{ marginTop: 8 }}>Low Qrr profile is favorable for hard-switched transitions.</div>}
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => applyMosfetToProject(item)}>Use in MOSFET Tab</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Helper sub-components ─────────────────────────────────────────────────────

function renderLabel(labelText) {
  if (!labelText) return null
  return labelText.split(/(\[.*?\])/g).map((p, i) =>
    p.startsWith('[') && p.endsWith(']') ? <span key={i} style={{ textTransform: 'none' }}>{p}</span> : p
  )
}

function FormInput({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>
        {renderLabel(label)}
      </span>
      <input className="inp inp-mono" type="number" step="any" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  )
}

function MetricCard({ title, value, unit, formula, hue, bg }) {
  const accent = hue === 'blue' ? 'var(--accent)' : 'var(--txt-1)'
  return (
    <div className="mla-metric-card" style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: '9px 10px', background: bg || 'var(--bg-3)' }}>
      <div style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 20, color: accent, fontFamily: 'var(--font-mono)', fontWeight: 800, lineHeight: 1.1 }}>
        {value}
        {unit && <span style={{ fontSize: 11, marginLeft: 4, color: 'var(--txt-3)', fontWeight: 600 }}>{unit}</span>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--txt-4)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>{formula}</div>
    </div>
  )
}

function InfoIcon({ text }) {
  const [show, setShow] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: '50%', background: 'rgba(0,212,232,0.18)', color: 'var(--cyan)', fontSize: 9, fontWeight: 800, cursor: 'help', border: '1px solid rgba(0,212,232,0.3)', flexShrink: 0 }}>i</span>
      {show && (
        <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 200, background: 'var(--bg-1)', border: '1px solid var(--border-2)', borderRadius: 7, padding: '8px 10px', fontSize: 11, color: 'var(--txt-2)', width: 260, lineHeight: 1.6, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', pointerEvents: 'none' }}>
          {text}
        </div>
      )}
    </span>
  )
}

function SourceBadge({ source }) {
  if (!source) return null
  const isDs  = source.includes('datasheet')
  const isFb  = source.includes('fallback') || source.includes('default') || source.includes('heuristic')
  const isDer = !isDs && !isFb
  const color = isDs ? 'var(--green)' : isFb ? 'var(--amber)' : '#60a5fa'
  const label = isDs ? 'DATASHEET' : isFb ? 'FALLBACK' : 'DERIVED'
  return (
    <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: `${color}22`, color, fontWeight: 800, border: `1px solid ${color}44`, fontFamily: 'var(--font-mono)', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function DiodeBadge({ type, inline }) {
  if (!type || type === 'n/a') return <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>n/a</span>
  const isSoft = type === 'soft'
  const color = isSoft ? 'var(--green)' : 'var(--amber)'
  const label = isSoft ? 'SOFT' : 'HARD'
  const title = isSoft
    ? 'Q_rr not specified — likely soft/slow-recovery body diode. Favorable for ringing suppression.'
    : 'Fast/hard body diode with specified Q_rr. Higher I_rr,pk excitation.'
  return (
    <span title={title} style={{ fontSize: inline ? 10 : 11, padding: inline ? '1px 5px' : '2px 8px', borderRadius: 4, background: `${color}22`, color, fontWeight: 700, border: `1px solid ${color}44`, cursor: 'default', whiteSpace: 'nowrap' }}>
      {label} DIODE
    </span>
  )
}

const REGIME_META = {
  over_damped: { label: 'Over-damped', color: '#22c55e', desc: 'EF ≥ 1.2 — No overshoot above rail. Quietest result. Peak V_DS stays at or below V_DD.' },
  critical:    { label: 'Critical',    color: '#eab308', desc: 'EF 1.0–1.2 — Smooth settling, tiny residual. Near-optimal.' },
  borderline:  { label: 'Borderline',  color: '#f97316', desc: 'EF 0.5–1.0 — Reduced overshoot but classic ringing present. Increase Rg,on.' },
  impulsive:   { label: 'Impulsive',   color: '#ef4444', desc: 'EF < 0.5 — Sharp overshoot, many ring cycles. Significant layout or gate-drive changes needed.' },
}

function RegimeBadge({ regime, ef, inline }) {
  const meta = REGIME_META[regime] || { label: regime, color: 'var(--txt-3)', desc: '' }
  return (
    <span title={meta.desc + (ef != null ? ` EF = ${ef.toFixed(3)}` : '')} style={{ fontSize: inline ? 10 : 11, padding: inline ? '1px 5px' : '2px 8px', borderRadius: 4, background: `${meta.color}22`, color: meta.color, fontWeight: 700, border: `1px solid ${meta.color}44`, cursor: 'default', whiteSpace: 'nowrap' }}>
      {meta.label}
    </span>
  )
}

function ConfBadge({ level }) {
  const meta = {
    high:   { color: 'var(--green)', label: 'HIGH' },
    medium: { color: 'var(--amber)', label: 'MED' },
    low:    { color: 'var(--red)',   label: 'LOW' },
  }[level] || { color: 'var(--txt-3)', label: '—' }
  return (
    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: `${meta.color}22`, color: meta.color, fontWeight: 700, border: `1px solid ${meta.color}44`, fontFamily: 'var(--font-mono)' }}>
      {meta.label}
    </span>
  )
}

function RingMetric({ title, value, formula, source, hue }) {
  const accentMap = { blue: 'var(--accent)', green: 'var(--green)', red: 'var(--red)' }
  const accent = accentMap[hue] || 'var(--txt-1)'
  return (
    <div className="mla-metric-card" style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: '9px 10px', background: 'var(--bg-3)' }}>
      <div style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 18, color: accent, fontFamily: 'var(--font-mono)', fontWeight: 800, lineHeight: 1.2, marginBottom: 4 }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--txt-4)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>{formula}</div>
      {source && <SourceBadge source={source} />}
    </div>
  )
}
