"""PCB Trace Thermal Calculator — IPC-2221B / IPC-2152 Backend Mixin

Mirrors the frontend thermalTraceCalc.js physics engine so that backend
`run_all()` can include trace thermal results for cross-module coupling.
"""
import math

# ─── Constants (SI: mm, Ω·mm, °C) ────────────────────────────────────────────
RHO_20   = 1.72e-5   # Ω·mm at 20°C
ALPHA_CU = 0.00393   # /°C
MM2MIL   = 39.3701
OZ2MM    = {1: 0.035, 2: 0.070, 3: 0.105, 4: 0.140, 6: 0.210}
K_EXT    = 0.048
K_INT    = 0.024
K_CU_mm  = 0.385     # W/(mm·K)

H_NATURAL = {"horizontal": 7, "vertical": 10, "enclosed": 5}

TRACE_SAFE_DT = 30
VIA_SAFE_DT   = 30
CD_SAFE       = 8


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _normalize_model(model_value):
    """Normalize model input to canonical tokens: '2221' or '2152'."""
    token = str(model_value if model_value is not None else "2221").strip().lower()
    token = token.replace("_", "").replace("-", "").replace(" ", "")
    return "2152" if "2152" in token else "2221"


def _get_cooling_params(mode, opts):
    """Compute effective convective coefficient h and heatsink network params."""
    if mode == "natural":
        orient = opts.get("orientation", "vertical")
        h = H_NATURAL.get(orient, 10)
        return {"h": h, "mode": "natural", "heatsink": None}
    elif mode == "enhanced":
        sf = _clamp(float(opts.get("spreading_factor", 1.5)), 1.0, 3.0)
        return {"h": 10 * sf, "mode": "enhanced", "sf": sf, "heatsink": None}
    elif mode == "forced":
        v = max(0.1, float(opts.get("air_velocity_ms", 1)))
        h = 10 + 12 * (v ** 0.8)
        return {"h": h, "mode": "forced", "v_ms": v, "heatsink": None}
    elif mode == "heatsink":
        theta_sa  = max(0.1, float(opts.get("hs_theta_sa", 5)))
        theta_int = max(0.05, float(opts.get("hs_theta_int", 0.5)))
        A_contact = max(0.5, float(opts.get("hs_contact_area_cm2", 10)))
        R_hs      = theta_sa + theta_int / A_contact
        A_m2      = A_contact * 1e-4
        h_equiv   = max(10, 1 / (R_hs * A_m2))
        return {
            "h": h_equiv, "mode": "heatsink",
            "heatsink": {"theta_sa": theta_sa, "theta_int": theta_int,
                         "A_contact": A_contact, "R_hs": R_hs},
        }
    else:
        return {"h": 10, "mode": "natural", "heatsink": None}


def _ipc2221_dT(I_per_layer, K, WH_mil2, h):
    h_nat = 10
    if WH_mil2 <= 0 or K <= 0 or I_per_layer <= 0:
        return 0
    dT_still = (I_per_layer / (K * (WH_mil2 ** 0.725))) ** (1 / 0.44)
    return dT_still * (h_nat / h)


def _ipc2221_Imax(K, WH_mil2, dT_allow, h):
    h_nat = 10
    if dT_allow <= 0 or WH_mil2 <= 0:
        return 0
    dT_still = dT_allow * (h / h_nat)
    return K * (dT_still ** 0.44) * (WH_mil2 ** 0.725)


def _ipc2152_corrections(pcb_thick_mm, plane_dist_mm, copper_fill_pct):
    Cf_board = 1.0
    if pcb_thick_mm > 0:
        Cf_board = 1.0 + 0.05 * (1.6 - pcb_thick_mm) / 1.6
        Cf_board = _clamp(Cf_board, 0.85, 1.15)

    Cf_plane = 1.0
    if plane_dist_mm > 0:
        Cf_plane = 1.0 - 0.55 * math.exp(-plane_dist_mm / 0.6)
        Cf_plane = _clamp(Cf_plane, 0.40, 1.0)

    Cf_pour = 1.0
    if copper_fill_pct > 0:
        Cf_pour = 1.0 - 0.22 * (copper_fill_pct / 100)
        Cf_pour = _clamp(Cf_pour, 0.75, 1.0)

    return {
        "Cf_board": Cf_board, "Cf_plane": Cf_plane, "Cf_pour": Cf_pour,
        "total": Cf_board * Cf_plane * Cf_pour,
    }


def _via_geometry(drill_mm, plating_um, pcb_thick_mm):
    t_plate = plating_um / 1000
    OD = drill_mm + 2 * t_plate
    A_barrel = math.pi / 4 * (OD ** 2 - drill_mm ** 2)
    if A_barrel < 1e-6:
        return None
    R_barrel  = pcb_thick_mm / (K_CU_mm * A_barrel)
    R_th_via  = R_barrel / 2
    R_el_via  = (RHO_20 * pcb_thick_mm) / A_barrel
    return {"OD": OD, "A_barrel": A_barrel, "R_barrel": R_barrel,
            "R_th_via": R_th_via, "R_el_via": R_el_via}


def _iterative_solve(params):
    """Full electro-thermal solve matching frontend iterativeSolve()."""
    Itot     = params["Itot"]
    Ta       = params["Ta"]
    Wmm      = params["Wmm"]
    Lmm      = params["Lmm"]
    oz       = params["oz"]
    nExt     = params["nExt"]
    nInt     = params["nInt"]
    cooling  = params["cooling"]
    pcbThick = params["pcbThick"]
    Tmax_allow = params["Tmax_allow"]
    vias_on  = params["vias_on"]
    nvias    = params["nvias"]
    vdrill   = params["vdrill"]
    vplate_um = params["vplate_um"]
    planeDist = params["planeDist"]
    copperFill = params["copperFill"]
    model    = _normalize_model(params.get("model", "2221"))

    N = nExt + nInt
    if N == 0:
        return None

    Tmm = OZ2MM.get(oz)
    if Tmm is None:
        return None

    Wmil = Wmm * MM2MIL
    Hmil = Tmm * MM2MIL
    WH   = Wmil * Hmil
    Amm2 = Wmm * Tmm

    if Wmm <= 0 or Tmm <= 0 or WH <= 0 or Amm2 <= 0:
        return None

    h = cooling["h"]
    corr = _ipc2152_corrections(pcbThick, planeDist, copperFill)
    Iper = Itot / N
    K_worst = K_INT if nInt > 0 else K_EXT

    dT = _ipc2221_dT(Iper, K_worst, WH, h)
    if model == "2152":
        dT *= corr["total"]

    dT_allow = _clamp(Tmax_allow - Ta, 0, 200)
    vRes = _via_geometry(vdrill, vplate_um, pcbThick) if (vias_on and nvias > 0) else None

    T_avg = Ta + dT / 2
    rho_T = RHO_20 * (1 + ALPHA_CU * (T_avg - 20))
    R_via_par = 0
    R_via_each = 0
    dT_hs = 0
    dT_total = dT

    for _ in range(4):
        R_layer = (rho_T * Lmm) / Amm2
        R_par   = R_layer / N

        R_via_par = 0
        R_via_each = 0
        if vias_on and vRes:
            R_via_each = vRes["R_el_via"] * (rho_T / RHO_20)
            R_via_par  = R_via_each / nvias

        R_total = R_par + R_via_par
        Vdrop   = Itot * R_total
        Ploss   = Itot ** 2 * R_total

        dT_hs    = Ploss * cooling["heatsink"]["R_hs"] if cooling.get("heatsink") else 0
        dT_total = (dT + dT_hs) if cooling.get("heatsink") else dT

        tAvgNext = Ta + dT_total / 2
        rho_next = RHO_20 * (1 + ALPHA_CU * (tAvgNext - 20))
        if abs(rho_next - rho_T) / max(rho_T, 1e-12) < 1e-4:
            rho_T = rho_next
            T_avg = tAvgNext
            break
        rho_T = rho_next
        T_avg = tAvgNext

    CD = Iper / Amm2

    # Max safe current (fast estimate)
    Imax_total = 0
    if dT_allow > 0:
        dT_for_imax = dT_allow
        if model == "2152" and corr["total"] > 0:
            dT_for_imax = dT_allow / corr["total"]
        Imax_per_ext = _ipc2221_Imax(K_EXT, WH, dT_for_imax, h) if nExt > 0 else 0
        Imax_per_int = _ipc2221_Imax(K_INT, WH, dT_for_imax, h) if nInt > 0 else 0
        Imax_total = Imax_per_ext * nExt + Imax_per_int * nInt

    # Via thermal rise
    dT_via = 0
    if vias_on and vRes and nvias > 0:
        I_via_each = Itot / nvias
        P_via_each = I_via_each ** 2 * R_via_each
        dT_via = P_via_each * vRes["R_th_via"]

    # Per-layer ΔT
    dT_ext = _ipc2221_dT(Iper, K_EXT, WH, h) * (corr["total"] if model == "2152" else 1) if nExt > 0 else 0
    dT_int = _ipc2221_dT(Iper, K_INT, WH, h) * (corr["total"] if model == "2152" else 1) if nInt > 0 else 0

    return {
        "dT": dT, "dT_hs": dT_hs, "dT_total": dT_total,
        "dT_ext": dT_ext, "dT_int": dT_int, "dT_via": dT_via,
        "T_final": Ta + dT_total,
        "Imax_total": Imax_total,
        "Vdrop": Vdrop, "Ploss": Ploss,
        "R_par": R_par, "R_via_par": R_via_par, "R_via_each": R_via_each,
        "R_total": R_total,
        "CD": CD, "Amm2": Amm2, "Amm2_tot": Amm2 * N, "rho_T": rho_T,
        "t_avg": Ta + dT_total / 2,
        "Iper": Iper, "dT_allow": dT_allow,
        "corr": corr if model == "2152" else None,
        "vRes": vRes,
        "WH": WH, "Wmil": Wmil, "Hmil": Hmil,
    }


class PcbTraceThermalMixin:
    """Mixin providing IPC-2221B / IPC-2152 PCB trace thermal calculations."""

    def calc_pcb_trace_thermal(self) -> dict:
        """Full PCB trace thermal analysis — mirrors the standalone artifact."""
        if "pcb_trace_thermal" in self._cached_results:
            return self._cached_results["pcb_trace_thermal"]

        self._current_module = "pcb_trace_thermal"

        p = getattr(self, "pcb_trace_params", {}) or {}

        # Build solver params with fallback to system specs
        def _get_f(key, def_val):
            v = p.get(key, def_val)
            return float(v) if v is not None and str(v).strip() != "" else float(def_val)

        current_a  = float(p.get("current_a") or self.i_max)
        ambient_c  = float(p.get("ambient_c") or self.t_amb)
        trace_w_mm = _get_f("trace_width_mm", 7)
        trace_l_mm = _get_f("trace_length_mm", 20)
        copper_oz  = int(_get_f("copper_oz", 2))
        pcb_thick  = _get_f("pcb_thickness_mm", 1.6)
        tmax_allow = _get_f("max_conductor_temp_c", 105)
        model_mode = _normalize_model(p.get("model", "2221"))
        cool_mode  = str(p.get("cooling_mode", "natural"))
        orient     = str(p.get("orientation", "vertical"))
        spread_f   = _get_f("spreading_factor", 1.5)
        air_vel    = _get_f("air_velocity_ms", 1)
        hs_theta   = _get_f("hs_theta_sa", 5)
        hs_tint    = _get_f("hs_theta_int", 0.5)
        hs_area    = _get_f("hs_contact_area_cm2", 10)
        n_ext      = _clamp(int(_get_f("n_external_layers", 2)), 0, 2)
        n_int      = _clamp(int(_get_f("n_internal_layers", 0)), 0, 20)
        vias_on    = bool(p.get("vias_on", True))
        n_vias     = _clamp(int(_get_f("n_vias", 10)), 1, 500)
        via_drill  = _get_f("via_drill_mm", 0.3)
        via_plate  = _get_f("via_plating_um", 25)
        plane_dist = _get_f("plane_dist_mm", 0)
        copper_fill = _get_f("copper_fill_pct", 0)

        cooling = _get_cooling_params(cool_mode, {
            "orientation": orient,
            "spreading_factor": spread_f,
            "air_velocity_ms": air_vel,
            "hs_theta_sa": hs_theta,
            "hs_theta_int": hs_tint,
            "hs_contact_area_cm2": hs_area,
        })

        solver_params = {
            "Itot": max(0.001, current_a),
            "Ta": ambient_c,
            "Wmm": max(0.01, trace_w_mm),
            "Lmm": max(0.1, trace_l_mm),
            "oz": copper_oz if copper_oz in OZ2MM else 2,
            "nExt": n_ext,
            "nInt": n_int,
            "cooling": cooling,
            "pcbThick": max(0.1, pcb_thick),
            "Tmax_allow": tmax_allow,
            "vias_on": vias_on,
            "nvias": n_vias,
            "vdrill": via_drill,
            "vplate_um": via_plate,
            "planeDist": plane_dist,
            "copperFill": copper_fill,
            "model": model_mode,
        }

        R = _iterative_solve(solver_params)

        if R is None:
            result = {
                "has_data": False,
                "error": "Invalid trace parameters — check layer count and geometry.",
                "_meta": self._module_meta.get("pcb_trace_thermal", {"hardcoded": [], "fallbacks": []}),
            }
            self._cached_results["pcb_trace_thermal"] = result
            return result

        worst_dt = max(R["dT_total"], R["dT_via"] if vias_on else 0)
        tmax_abs = ambient_c + R["dT_total"]
        margin   = tmax_allow - tmax_abs

        # Status assessment
        if R["dT_total"] > 1060:
            status = "MELT"
            status_level = "danger"
        elif R["dT_total"] > 200:
            status = "TRACE FAILURE"
            status_level = "danger"
        elif tmax_abs > tmax_allow:
            status = f"Over limit: {tmax_abs:.1f}°C > {tmax_allow}°C"
            status_level = "danger"
        elif R["CD"] > 15:
            status = f"Critical current density: {R['CD']:.1f} A/mm²"
            status_level = "danger"
        elif R["CD"] > CD_SAFE or worst_dt > TRACE_SAFE_DT:
            status = f"Elevated: {tmax_abs:.1f}°C, {R['CD']:.1f} A/mm²"
            status_level = "warn"
        elif vias_on and R["dT_via"] > VIA_SAFE_DT:
            status = f"Via thermal elevated: {R['dT_via']:.1f}°C"
            status_level = "warn"
        else:
            status = f"Safe: {tmax_abs:.1f}°C ({margin:.0f}°C margin)"
            status_level = "safe"

        # Log hardcoded values
        self._log_hc("pcb_trace_thermal", "IPC standard",
                      model_mode.upper(), f"{'IPC-2221B' if model_mode == '2221' else 'IPC-2221B + corrections'}")
        self._log_hc("pcb_trace_thermal", "Copper ρ₂₀",
                      f"{RHO_20} Ω·mm", "Copper resistivity at 20°C")
        self._log_hc("pcb_trace_thermal", "α_Cu",
                      f"{ALPHA_CU} /°C", "Copper resistivity temperature coefficient")

        result = {
            "has_data": True,
            # Primary results
            "worst_dt_c":             round(worst_dt, 1),
            "max_conductor_temp_c":   round(tmax_abs, 1),
            "max_safe_current_a":     round(R["Imax_total"], 1),
            "voltage_drop_v":         round(R["Vdrop"], 6),
            "voltage_drop_mv":        round(R["Vdrop"] * 1000, 2),
            "power_dissipated_w":     round(R["Ploss"], 3),
            "current_density_a_mm2":  round(R["CD"], 2),
            # Status
            "thermal_status":         status,
            "thermal_status_level":   status_level,
            "thermal_margin_c":       round(margin, 1),
            # Detailed breakdown
            "dt_trace_c":             round(R["dT_total"], 2),
            "dt_via_c":               round(R["dT_via"], 2),
            "dt_ext_c":               round(R["dT_ext"], 2),
            "dt_int_c":               round(R["dT_int"], 2),
            "dt_heatsink_c":          round(R["dT_hs"], 2),
            "rho_operating":          round(R["rho_T"] * 1e5, 3),  # ×10⁻⁵ Ω·mm
            "resistance_trace_mohm":  round(R["R_par"] * 1000, 4),
            "resistance_via_mohm":    round(R["R_via_par"] * 1000, 4),
            "resistance_total_mohm":  round(R["R_total"] * 1000, 4),
            "cross_section_mm2":      round(R["Amm2"], 4),
            "cross_section_total_mm2": round(R["Amm2_tot"], 4),
            "current_per_layer_a":    round(R["Iper"], 2),
            # Parameters used (for audit)
            "input_current_a":        round(current_a, 2),
            "input_ambient_c":        round(ambient_c, 1),
            "input_trace_width_mm":   round(trace_w_mm, 1),
            "input_trace_length_mm":  round(trace_l_mm, 1),
            "input_copper_oz":        copper_oz,
            "input_pcb_thickness_mm": round(pcb_thick, 1),
            "input_max_temp_c":       round(tmax_allow, 0),
            "input_cooling_mode":     cool_mode,
            "input_n_layers":         n_ext + n_int,
            "input_vias_on":          vias_on,
            "input_n_vias":           n_vias if vias_on else 0,
            "input_via_drill_mm":     round(via_drill, 3) if vias_on else None,
            # Coupling outputs for other modules
            "min_trace_width_mm":     round(trace_w_mm, 1),  # user's actual trace width
            "recommended_copper_oz":  copper_oz,
            "trace_power_loss_w":     round(R["Ploss"], 3),
            "effective_h_w_m2k":      round(cooling["h"], 1),
            # Backward-compatible aliases consumed by thermal.py
            "copper_oz":              copper_oz,
            "vias_on":                vias_on,
            "n_vias":                 n_vias if vias_on else 0,
            "via_drill_mm":           round(via_drill, 3) if vias_on else None,
            # Correction factors (if IPC-2152)
            "ipc2152_corrections": R["corr"] if R["corr"] else None,
            # Via details
            "via_thermal_resistance_c_per_w": round(R["vRes"]["R_th_via"], 1) if R.get("vRes") else None,
            "via_electrical_resistance_mohm": round(R["vRes"]["R_el_via"] * 1000, 3) if R.get("vRes") else None,
            # Notes
            "notes": {
                "standard": f"{'IPC-2221B' if model_mode == '2221' else 'IPC-2221B + corrections'} — "
                            f"{'conservative, well-validated' if model_mode == '2221' else 'with board/plane/pour correction factors'}",
                "cooling":  f"{cool_mode.replace('_', ' ').title()} cooling — h_eff = {cooling['h']:.1f} W/m²K",
                "rho_T":    f"ρ(T) applied to R, Vdrop, Ploss — operating at +{((R['rho_T']/RHO_20 - 1)*100):.1f}% above 20°C baseline",
            },
            "_meta": self._module_meta.get("pcb_trace_thermal", {"hardcoded": [], "fallbacks": []}),
        }

        self.audit_log.append(
            f"[PCB Trace Thermal] {model_mode.upper()}: {current_a:.1f}A in {trace_w_mm:.1f}mm×{copper_oz}oz trace, "
            f"{n_ext}E+{n_int}I layers, {cool_mode} cooling → "
            f"ΔT={worst_dt:.1f}°C, Tmax={tmax_abs:.1f}°C, "
            f"Vdrop={R['Vdrop']*1000:.2f}mV, Ploss={R['Ploss']:.3f}W, "
            f"J={R['CD']:.2f}A/mm² — {status_level.upper()}"
        )

        self._cached_results["pcb_trace_thermal"] = result
        return result
