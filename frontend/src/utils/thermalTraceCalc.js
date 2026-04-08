/**
 * PCB Trace Thermal Calculator — IPC-2221B / IPC-2152
 * Pure calculation module (no DOM, no side effects).
 * Ported from pcb_thermal_v2 artifact with full physics fidelity.
 *
 * All units: mm, Ω·mm, °C, A, W unless stated otherwise.
 */

// ─── Constants ───────────────────────────────────────────────────────
export const RHO_20    = 1.72e-5;   // Ω·mm at 20°C (copper resistivity)
export const ALPHA_CU  = 0.00393;   // /°C resistivity temperature coefficient
export const MM2MIL    = 39.3701;
export const OZ2MM     = { 1: 0.035, 2: 0.070, 3: 0.105, 4: 0.140, 6: 0.210 };
export const K_EXT     = 0.048;     // IPC-2221B external layer constant
export const K_INT     = 0.024;     // IPC-2221B internal layer constant
export const K_CU_mm   = 0.385;    // W/(mm·K) — copper thermal conductivity

// Convection coefficients by board orientation (W/m²K)
export const H_NATURAL = { horizontal: 7, vertical: 10, enclosed: 5 };

export const ORIENT_NOTES = {
  horizontal: 'Horizontal board — h ≈ 7 W/m²K (worst for natural conv, hot air traps below)',
  vertical:   'Vertical board — h ≈ 10 W/m²K (IPC-2221 baseline, free air column)',
  enclosed:   'Enclosed / inside case — h ≈ 5 W/m²K (limited air movement)',
};

// Safety thresholds
export const TRACE_SAFE_DT = 30;  // °C
export const VIA_SAFE_DT   = 30;  // °C
export const CD_SAFE       = 8;   // A/mm²

// ─── Utility ─────────────────────────────────────────────────────────
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── Cooling Parameters ─────────────────────────────────────────────
/**
 * Compute effective convective coefficient h and heatsink params.
 * @param {string} mode — 'natural'|'enhanced'|'forced'|'heatsink'
 * @param {object} options — mode-specific options
 * @returns {{ h: number, mode: string, heatsink: object|null, ... }}
 */
export function getCoolingParams(mode, options = {}) {
  switch (mode) {
    case 'natural': {
      const orient = options.orientation || 'vertical';
      const h = H_NATURAL[orient] || 10;
      return { h, mode: 'natural', heatsink: null };
    }
    case 'enhanced': {
      const sf = clamp(options.spreading_factor || 1.5, 1.0, 3.0);
      const h = 10 * sf;
      return { h, mode: 'enhanced', sf, heatsink: null };
    }
    case 'forced': {
      const v = Math.max(0.1, options.air_velocity_ms || 1);
      const h = 10 + 12 * Math.pow(v, 0.8);
      return { h, mode: 'forced', v_ms: v, heatsink: null };
    }
    case 'heatsink': {
      const theta_sa  = Math.max(0.1, options.hs_theta_sa || 5);
      const theta_int = Math.max(0.05, options.hs_theta_int || 0.5);
      const A_contact = Math.max(0.5, options.hs_contact_area_cm2 || 10);
      const R_hs      = theta_sa + theta_int / A_contact;
      const A_m2      = A_contact * 1e-4;
      const h_equiv   = Math.max(10, 1 / (R_hs * A_m2));
      return {
        h: h_equiv, mode: 'heatsink',
        heatsink: { theta_sa, theta_int, A_contact, R_hs },
      };
    }
    default:
      return { h: 10, mode: 'natural', heatsink: null };
  }
}

// ─── IPC-2221B ΔT Model ─────────────────────────────────────────────
/**
 * Compute ΔT from IPC-2221B empirical formula.
 * I = K · ΔT^0.44 · (W×H)^0.725  → solve for ΔT.
 * Then apply convection correction: ΔT_corrected = ΔT_still × (h_nat / h_actual).
 */
export function ipc2221_dT(I_per_layer, K, WH_mil2, h) {
  const h_nat = 10;
  if (WH_mil2 <= 0 || K <= 0 || I_per_layer <= 0) return 0;
  const dT_still = Math.pow(I_per_layer / (K * Math.pow(WH_mil2, 0.725)), 1 / 0.44);
  return dT_still * (h_nat / h);
}

/**
 * Compute max safe current at given ΔT allowance.
 */
export function ipc2221_Imax(K, WH_mil2, dT_allow, h) {
  const h_nat = 10;
  if (dT_allow <= 0 || WH_mil2 <= 0) return 0;
  const dT_still = dT_allow * (h / h_nat);
  return K * Math.pow(dT_still, 0.44) * Math.pow(WH_mil2, 0.725);
}

// ─── IPC-2152 Correction Factors ────────────────────────────────────
export function ipc2152_corrections(pcbThick_mm, planeDist_mm, copperFill_pct) {
  // Board thickness correction (baseline 1.6mm)
  let Cf_board = 1.0;
  const t = pcbThick_mm;
  if (t > 0) {
    Cf_board = 1.0 + 0.05 * (1.6 - t) / 1.6;
    Cf_board = clamp(Cf_board, 0.85, 1.15);
  }

  // Plane proximity correction
  let Cf_plane = 1.0;
  if (planeDist_mm > 0) {
    Cf_plane = 1.0 - 0.55 * Math.exp(-planeDist_mm / 0.6);
    Cf_plane = clamp(Cf_plane, 0.40, 1.0);
  }

  // Copper pour fill correction
  let Cf_pour = 1.0;
  if (copperFill_pct > 0) {
    Cf_pour = 1.0 - 0.22 * (copperFill_pct / 100);
    Cf_pour = clamp(Cf_pour, 0.75, 1.0);
  }

  return { Cf_board, Cf_plane, Cf_pour, total: Cf_board * Cf_plane * Cf_pour };
}

// ─── Via Thermal Model ──────────────────────────────────────────────
/**
 * Via barrel as hollow cylinder.
 * Returns geometry, thermal resistance, and electrical resistance.
 */
export function viaGeometry(drill_mm, plating_um, pcbThick_mm) {
  const t_plate = plating_um / 1000;
  const OD = drill_mm + 2 * t_plate;
  const A_barrel = Math.PI / 4 * (OD * OD - drill_mm * drill_mm);
  if (A_barrel < 1e-6) return null;

  const R_barrel   = pcbThick_mm / (K_CU_mm * A_barrel);
  const R_th_via   = R_barrel / 2;  // uniform heating correction
  const R_el_via   = (RHO_20 * pcbThick_mm) / A_barrel;

  return { OD, A_barrel, R_barrel, R_th_via, R_el_via };
}

// ─── Main Solver ────────────────────────────────────────────────────
/**
 * Iterative electro-thermal solver.
 * @param {object} params — all trace/via/cooling parameters
 * @param {object} options — { computeImax: bool }
 * @returns {object|null} — full result set
 */
export function iterativeSolve(params, options = {}) {
  const { computeImax = false } = options;
  const {
    Itot, Ta, Wmm, Lmm, oz, nExt, nInt,
    cooling, pcbThick, Tmax_allow,
    vias_on, nvias, vdrill, vplate_um,
    planeDist, copperFill, model,
  } = params;

  const N = nExt + nInt;
  if (N === 0) return null;

  const Tmm = OZ2MM[oz];
  if (!Tmm) return null;

  const Wmil = Wmm * MM2MIL;
  const Hmil = Tmm * MM2MIL;
  const WH   = Wmil * Hmil;
  const Amm2 = Wmm * Tmm;

  if (Wmm <= 0 || Tmm <= 0 || WH <= 0 || Amm2 <= 0) return null;

  const h = cooling.h;
  const corr = ipc2152_corrections(pcbThick, planeDist, copperFill);
  const Iper = Itot / N;
  const K_worst = (nInt > 0) ? K_INT : K_EXT;

  let dT = ipc2221_dT(Iper, K_worst, WH, h);
  if (model === '2152') dT *= corr.total;

  const dT_allow = clamp(Tmax_allow - Ta, 0, 200);

  const vRes = (vias_on && nvias > 0) ? viaGeometry(vdrill, vplate_um, pcbThick) : null;

  // Electro-thermal iteration on ρ(T)
  let T_avg = Ta + dT / 2;
  let rho_T = RHO_20 * (1 + ALPHA_CU * (T_avg - 20));
  let R_layer = 0, R_par = 0;
  let R_via_par = 0, R_via_each = 0;
  let R_total = 0, Vdrop = 0, Ploss = 0;
  let dT_hs = 0, dT_total = dT;

  for (let i = 0; i < 4; i++) {
    R_layer = (rho_T * Lmm) / Amm2;
    R_par   = R_layer / N;

    R_via_par  = 0;
    R_via_each = 0;
    if (vias_on && vRes) {
      R_via_each = vRes.R_el_via * (rho_T / RHO_20);
      R_via_par  = R_via_each / nvias;
    }

    R_total = R_par + R_via_par;
    Vdrop   = Itot * R_total;
    Ploss   = Itot * Itot * R_total;

    dT_hs    = cooling.heatsink ? (Ploss * cooling.heatsink.R_hs) : 0;
    dT_total = cooling.heatsink ? (dT + dT_hs) : dT;

    const tAvgNext = Ta + dT_total / 2;
    const rho_next = RHO_20 * (1 + ALPHA_CU * (tAvgNext - 20));
    if (Math.abs(rho_next - rho_T) / Math.max(rho_T, 1e-12) < 1e-4) {
      rho_T = rho_next;
      T_avg = tAvgNext;
      break;
    }
    rho_T = rho_next;
    T_avg = tAvgNext;
  }

  const CD = Iper / Amm2;

  // Max safe current
  let Imax_total = 0;
  if (dT_allow > 0) {
    if (computeImax) {
      Imax_total = solveMaxSafeCurrent(params, dT_allow);
    } else {
      let dT_for_imax = dT_allow;
      if (model === '2152' && corr.total > 0) dT_for_imax = dT_allow / corr.total;
      const Imax_per_ext = nExt > 0 ? ipc2221_Imax(K_EXT, WH, dT_for_imax, h) : 0;
      const Imax_per_int = nInt > 0 ? ipc2221_Imax(K_INT, WH, dT_for_imax, h) : 0;
      Imax_total = (Imax_per_ext * nExt) + (Imax_per_int * nInt);
    }
  }

  // Via thermal rise
  let dT_via = 0;
  if (vias_on && vRes && nvias > 0) {
    const I_via_each = Itot / nvias;
    const P_via_each = I_via_each * I_via_each * R_via_each;
    dT_via = P_via_each * vRes.R_th_via;
  }

  // Per-layer ΔT for visualization
  const dT_ext = (nExt > 0)
    ? ipc2221_dT(Iper, K_EXT, WH, h) * (model === '2152' ? corr.total : 1)
    : 0;
  const dT_int = (nInt > 0)
    ? ipc2221_dT(Iper, K_INT, WH, h) * (model === '2152' ? corr.total : 1)
    : 0;

  return {
    dT,
    dT_hs,
    dT_total,
    dT_ext, dT_int,
    dT_via,
    T_final: Ta + dT_total,
    Imax_total,
    Vdrop, Ploss,
    R_par, R_via_par, R_via_each, R_total,
    CD, Amm2, Amm2_tot: Amm2 * N, rho_T,
    t_avg: Ta + dT_total / 2,
    Iper, dT_allow,
    corr: model === '2152' ? corr : null,
    vRes,
    WH, Wmil, Hmil: Tmm * MM2MIL,
  };
}

// ─── Max Safe Current Solver ────────────────────────────────────────
export function solveMaxSafeCurrent(baseParams, dT_allow) {
  const maxI = 5000;
  const targetTmax = baseParams.Ta + dT_allow;
  const viasOn = !!baseParams.vias_on;

  function isSafeAt(currentA) {
    const r = iterativeSolve({ ...baseParams, Itot: currentA }, { computeImax: false });
    if (!r) return false;
    const traceOk = (baseParams.Ta + r.dT_total) <= targetTmax;
    const viaOk   = !viasOn || (r.dT_via <= VIA_SAFE_DT);
    return traceOk && viaOk;
  }

  if (!isSafeAt(0.001)) return 0;

  let lo = 0;
  let hi = Math.max(1, baseParams.Itot || 1);

  while (hi < maxI && isSafeAt(hi)) {
    lo = hi;
    hi = Math.min(maxI, hi * 2);
  }
  if (hi >= maxI && isSafeAt(maxI)) return maxI;

  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (isSafeAt(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ─── Recommendations Engine ─────────────────────────────────────────
function isSafeResult(r, Ta, Tmax_allow, viasOn) {
  if (!r) return false;
  const viaOk = !viasOn || r.dT_via <= VIA_SAFE_DT;
  return r.dT_total <= TRACE_SAFE_DT && r.CD <= CD_SAFE && (Ta + r.dT_total) <= Tmax_allow && viaOk;
}

function findMinContinuous(p, applyFn, lo, hi) {
  const rHi = iterativeSolve(applyFn(p, hi));
  if (!rHi || !isSafeResult(rHi, p.Ta, p.Tmax_allow, p.vias_on)) {
    return { delta: hi, solves: false, result: rHi };
  }
  let L = lo, H = hi;
  for (let i = 0; i < 25; i++) {
    const mid = (L + H) / 2;
    const r = iterativeSolve(applyFn(p, mid));
    if (r && isSafeResult(r, p.Ta, p.Tmax_allow, p.vias_on)) H = mid;
    else L = mid;
  }
  const rounded = Math.ceil(H * 10) / 10;
  return { delta: rounded, solves: true, result: iterativeSolve(applyFn(p, rounded)) };
}

export function computeRecommendations(params, result) {
  const reco = [];
  if (!result) return reco;

  const cdHigh   = result.CD > CD_SAFE;
  const tempHigh = result.dT_total > TRACE_SAFE_DT || (params.Ta + result.dT_total) > params.Tmax_allow;
  const viaHigh  = params.vias_on && result.dT_via > VIA_SAFE_DT;
  if (!cdHigh && !tempHigh && !viaHigh) return reco;

  const baseDT  = result.dT_total;
  const baseCD  = result.CD;
  const baseVia = result.dT_via;
  const p = { ...params };

  function score(r2) {
    if (!r2) return 0;
    const dTimp  = baseDT  > 0 ? clamp((baseDT - r2.dT_total) / baseDT, 0, 1) : 0;
    const CDimp  = baseCD  > 0 ? clamp((baseCD - r2.CD) / baseCD, 0, 1) : 0;
    const viaImp = (p.vias_on && baseVia > 0) ? clamp((baseVia - r2.dT_via) / baseVia, 0, 1) : 0;
    return dTimp + CDimp + viaImp;
  }

  function addItem(label, r2, solves) {
    if (!r2) return;
    const dTgain  = baseDT  - r2.dT_total;
    const cdGain  = baseCD  - r2.CD;
    const viaGain = baseVia - r2.dT_via;
    if (dTgain < 0.2 && cdGain < 0.2 && viaGain < 0.2) return;
    reco.push({
      action: label, deltaDT: dTgain, deltaCD: cdGain, deltaVia: viaGain,
      solves, score: score(r2),
    });
  }

  // 1. Trace Width
  {
    const f = findMinContinuous(p, (p2, d) => ({ ...p2, Wmm: p2.Wmm + d }), 0, 200);
    if (f.result) {
      const label = f.solves
        ? `Widen trace by +${f.delta.toFixed(1)} mm → ${(p.Wmm + f.delta).toFixed(1)} mm total`
        : `Widen trace by +${f.delta.toFixed(1)} mm → ${(p.Wmm + f.delta).toFixed(1)} mm (partial)`;
      addItem(label, f.result, f.solves);
    }
  }

  // 2. Copper Weight
  {
    const ozSteps = [1, 2, 3, 4, 6];
    const idx = ozSteps.indexOf(p.oz);
    if (idx >= 0 && idx < ozSteps.length - 1) {
      let bestR = null, bestOz = null, solved = false;
      for (let i = idx + 1; i < ozSteps.length; i++) {
        const ozVal = ozSteps[i];
        const r2 = iterativeSolve({ ...p, oz: ozVal });
        if (!r2) continue;
        bestR = r2; bestOz = ozVal;
        if (isSafeResult(r2, p.Ta, p.Tmax_allow, p.vias_on)) { solved = true; break; }
      }
      if (bestR && bestOz) {
        const label = solved
          ? `Increase copper to ${bestOz} oz/ft²`
          : `Increase copper to ${bestOz} oz/ft² (partial)`;
        addItem(label, bestR, solved);
      }
    }
  }

  // 3. External layers
  if (p.nExt < 2) {
    const r2 = iterativeSolve({ ...p, nExt: p.nExt + 1 });
    if (r2) {
      const solves = isSafeResult(r2, p.Ta, p.Tmax_allow, p.vias_on);
      addItem(`Add 1 external layer → ${p.nExt + 1} external${solves ? '' : ' (partial)'}`, r2, solves);
    }
  }

  // 4. Internal layers
  {
    let bestR = null, bestAdd = null, solved = false;
    for (const add of [2, 4, 6, 8, 10, 12, 14, 16]) {
      const r2 = iterativeSolve({ ...p, nInt: p.nInt + add });
      if (!r2) continue;
      bestR = r2; bestAdd = add;
      if (isSafeResult(r2, p.Ta, p.Tmax_allow, p.vias_on)) { solved = true; break; }
    }
    if (bestR && bestAdd) {
      const label = solved
        ? `Add ${bestAdd} internal layer${bestAdd > 1 ? 's' : ''} → ${p.nInt + bestAdd} internal`
        : `Add ${bestAdd} internal layer${bestAdd > 1 ? 's' : ''} → ${p.nInt + bestAdd} internal (partial)`;
      addItem(label, bestR, solved);
    }
  }

  // 5. Cooling upgrades
  {
    const currentMode = p.cooling ? p.cooling.mode : 'natural';

    if (currentMode === 'natural') {
      let bestR = null, bestV = null, solved = false;
      for (const v of [0.5, 1, 2, 5, 10, 20]) {
        const forcedCooling = { h: 10 + 12 * Math.pow(v, 0.8), mode: 'forced', v_ms: v, heatsink: null };
        const r2 = iterativeSolve({ ...p, cooling: forcedCooling });
        if (!r2) continue;
        bestR = r2; bestV = v;
        if (isSafeResult(r2, p.Ta, p.Tmax_allow, p.vias_on)) { solved = true; break; }
      }
      if (bestR && bestV != null) {
        const label = solved
          ? `Add forced airflow at ${bestV} m/s`
          : `Add forced airflow at ${bestV} m/s (partial)`;
        addItem(label, bestR, solved);
      }
    }

    if (currentMode === 'enhanced') {
      const currentSf = p.cooling?.sf || 1.5;
      if (currentSf < 3.0) {
        let bestR = null, bestSf = null, solved = false;
        for (const sf of [1.2, 1.5, 1.8, 2.0, 2.5, 3.0]) {
          if (sf <= currentSf + 1e-9) continue;
          const enhancedCooling = { h: 10 * sf, mode: 'enhanced', sf, heatsink: null };
          const r2 = iterativeSolve({ ...p, cooling: enhancedCooling });
          if (!r2) continue;
          bestR = r2; bestSf = sf;
          if (isSafeResult(r2, p.Ta, p.Tmax_allow, p.vias_on)) { solved = true; break; }
        }
        if (bestR && bestSf != null) {
          const label = solved
            ? `Increase thermal spreading to ${bestSf.toFixed(1)}×`
            : `Increase thermal spreading to ${bestSf.toFixed(1)}× (partial)`;
          addItem(label, bestR, solved);
        }
      }
    }

    if (currentMode === 'forced') {
      const currentV = p.cooling?.v_ms || 0.5;
      if (currentV < 20) {
        let bestR = null, bestV = null, solved = false;
        for (const v of [0.5, 1, 2, 5, 10, 20]) {
          if (v <= currentV + 1e-9) continue;
          const forcedCooling = { h: 10 + 12 * Math.pow(v, 0.8), mode: 'forced', v_ms: v, heatsink: null };
          const r2 = iterativeSolve({ ...p, cooling: forcedCooling });
          if (!r2) continue;
          bestR = r2; bestV = v;
          if (isSafeResult(r2, p.Ta, p.Tmax_allow, p.vias_on)) { solved = true; break; }
        }
        if (bestR && bestV != null) {
          const label = solved
            ? `Increase airflow to ${bestV} m/s`
            : `Increase airflow to ${bestV} m/s (partial)`;
          addItem(label, bestR, solved);
        }
      }
    }
  }

  // 6. Via count
  if (p.vias_on) {
    let bestR = null, bestAdd = null, solved = false;
    for (const add of [2, 5, 10, 20, 50, 100, 200]) {
      const r2 = iterativeSolve({ ...p, nvias: p.nvias + add });
      if (!r2) continue;
      bestR = r2; bestAdd = add;
      if (isSafeResult(r2, p.Ta, p.Tmax_allow, p.vias_on)) { solved = true; break; }
    }
    if (bestR && bestAdd) {
      const label = solved
        ? `Add ${bestAdd} vias → ${p.nvias + bestAdd} total`
        : `Add ${bestAdd} vias → ${p.nvias + bestAdd} total (partial)`;
      addItem(label, bestR, solved);
    }
  }

  reco.sort((a, b) => b.score - a.score);
  return reco;
}

// ─── Status Assessment ──────────────────────────────────────────────
/**
 * Determine the overall thermal status and message.
 * @returns {{ level: 'safe'|'warn'|'danger', icon: string, message: string }}
 */
export function assessStatus(result, params) {
  if (!result) return { level: 'safe', icon: '—', message: 'No data' };

  const { Ta, Tmax_allow, vias_on } = params;
  const dT = result.dT_total;
  const tmax_abs = Ta + dT;
  const margin = Tmax_allow - tmax_abs;
  const worstDt = Math.max(dT, vias_on ? result.dT_via : 0);

  const LAMINATE_FAIL_DT = 200;
  const COPPER_MELT_DT   = 1060;
  const traceFail = dT > LAMINATE_FAIL_DT;
  const traceMelt = dT > COPPER_MELT_DT;
  const viaDanger = vias_on && result.dT_via > 60;
  const viaWarn   = vias_on && result.dT_via > VIA_SAFE_DT;

  if (traceMelt) {
    return { level: 'danger', icon: '💀', message: `OVERCURRENT — copper melting point exceeded (ΔT = ${dT.toFixed(0)}°C). Redesign completely.` };
  }
  if (traceFail) {
    return { level: 'danger', icon: '🔴', message: `TRACE FAILURE — ΔT = ${dT.toFixed(0)}°C exceeds FR4 laminate limits (~200°C).` };
  }
  if (viaDanger) {
    return { level: 'danger', icon: '🔴', message: `Via overheating: via ΔT is ${result.dT_via.toFixed(1)}°C (critical > 60°C).` };
  }
  if (tmax_abs > Tmax_allow) {
    return { level: 'danger', icon: '🔴', message: `Over limit: conductor at ${tmax_abs.toFixed(1)}°C exceeds your ${Tmax_allow}°C maximum.` };
  }
  if (result.CD > 15) {
    return { level: 'danger', icon: '🔴', message: `Current density ${result.CD.toFixed(1)} A/mm² is critically high (limit ~15 A/mm²).` };
  }
  if (result.CD > 8) {
    return { level: 'warn', icon: '⚠️', message: `Current density ${result.CD.toFixed(1)} A/mm² is elevated. Temperature ${tmax_abs.toFixed(1)}°C (${margin.toFixed(0)}°C margin).` };
  }
  if (viaWarn) {
    return { level: 'warn', icon: '⚠️', message: `Via thermal rise elevated at ${result.dT_via.toFixed(1)}°C (> ${VIA_SAFE_DT}°C).` };
  }
  if (tmax_abs > Tmax_allow * 0.9 || margin < 10) {
    return { level: 'warn', icon: '⚠️', message: `Close to limit — conductor at ${tmax_abs.toFixed(1)}°C with only ${margin.toFixed(0)}°C margin.` };
  }
  if (dT > 30) {
    return { level: 'warn', icon: '⚠️', message: `Elevated temperature rise of ${dT.toFixed(1)}°C — ${tmax_abs.toFixed(1)}°C (${margin.toFixed(0)}°C margin).` };
  }
  return { level: 'safe', icon: '✓', message: `Within safe limits. Conductor at ${tmax_abs.toFixed(1)}°C — ${margin.toFixed(0)}°C margin to ${Tmax_allow}°C.` };
}

// ─── Wind Label Helper ──────────────────────────────────────────────
export function windLabelFromH(h) {
  if (h <= 12) return 'Very light airflow';
  if (h <= 22) return 'Light forced airflow';
  if (h <= 40) return 'Moderate forced airflow';
  if (h <= 70) return 'Strong forced airflow';
  return 'High-velocity airflow';
}

/**
 * Build full solver parameters from the user's panel state + system specs.
 * This is the "glue" between the UI state and the physics engine.
 */
export function buildSolverParams(panelParams, systemSpecs = {}) {
  const current = panelParams.current_a ?? systemSpecs.max_phase_current ?? 80;
  const ambient = panelParams.ambient_c ?? systemSpecs.ambient_temp_c ?? 30;

  const cooling = getCoolingParams(panelParams.cooling_mode || 'natural', {
    orientation:        panelParams.orientation || 'vertical',
    spreading_factor:   panelParams.spreading_factor ?? 1.5,
    air_velocity_ms:    panelParams.air_velocity_ms ?? 1,
    hs_theta_sa:        panelParams.hs_theta_sa ?? 5,
    hs_theta_int:       panelParams.hs_theta_int ?? 0.5,
    hs_contact_area_cm2: panelParams.hs_contact_area_cm2 ?? 10,
  });

  return {
    Itot:        Math.max(0.001, current),
    Ta:          ambient,
    Wmm:         Math.max(0.01, panelParams.trace_width_mm ?? 7),
    Lmm:         Math.max(0.1, panelParams.trace_length_mm ?? 20),
    oz:          panelParams.copper_oz ?? 2,
    nExt:        clamp(Math.round(panelParams.n_external_layers ?? 2), 0, 2),
    nInt:        clamp(Math.round(panelParams.n_internal_layers ?? 0), 0, 20),
    cooling,
    pcbThick:    Math.max(0.1, panelParams.pcb_thickness_mm ?? 1.6),
    Tmax_allow:  panelParams.max_conductor_temp_c ?? 105,
    vias_on:     panelParams.vias_on !== false,
    nvias:       clamp(Math.round(panelParams.n_vias ?? 10), 1, 500),
    vdrill:      Math.max(0.05, panelParams.via_drill_mm ?? 0.3),
    vplate_um:   Math.max(1, panelParams.via_plating_um ?? 25),
    planeDist:   panelParams.plane_dist_mm ?? 0,
    copperFill:  panelParams.copper_fill_pct ?? 0,
    model:       panelParams.model || '2221',
  };
}
