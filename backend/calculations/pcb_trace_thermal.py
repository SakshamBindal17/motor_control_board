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

    # Keys that belong to the 'common' (shared) parameter set
    _COMMON_KEYS = {
        "current_a", "ambient_c", "pcb_thickness_mm", "max_conductor_temp_c",
        "model", "cooling_mode", "orientation", "spreading_factor",
        "air_velocity_ms", "hs_theta_sa", "hs_theta_int", "hs_contact_area_cm2",
        "plane_dist_mm", "copper_fill_pct",
    }

    def _build_section_solver_params(self, section, common, cooling, model_mode,
                                      current_a, ambient_c, pcb_thick, tmax_allow):
        """Build solver params dict for a single section."""
        def _sf(key, def_val):
            v = section.get(key, def_val)
            return float(v) if v is not None and str(v).strip() != "" else float(def_val)

        trace_w_mm = _sf("trace_width_mm", 7)
        trace_l_mm = _sf("trace_length_mm", 20)
        copper_oz  = int(_sf("copper_oz", 2))
        n_ext      = _clamp(int(_sf("n_external_layers", 2)), 0, 2)
        n_int      = _clamp(int(_sf("n_internal_layers", 0)), 0, 20)
        vias_on    = bool(section.get("vias_on", True))
        n_vias     = _clamp(int(_sf("n_vias", 10)), 1, 500)
        via_drill  = _sf("via_drill_mm", 0.3)
        via_plate  = _sf("via_plating_um", 25)
        plane_dist = float(common.get("plane_dist_mm", 0) or 0)
        copper_fill = float(common.get("copper_fill_pct", 0) or 0)

        busbar_a = section.get("busbar_area_mm2")
        if busbar_a is not None:
            try:
                busbar_a = float(busbar_a)
                if busbar_a <= 0:
                    busbar_a = None
            except (TypeError, ValueError):
                busbar_a = None

        return {
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
            "busbar_area_mm2": busbar_a,
        }, {
            "trace_w_mm": trace_w_mm,
            "trace_l_mm": trace_l_mm,
            "copper_oz": copper_oz,
            "n_ext": n_ext,
            "n_int": n_int,
            "vias_on": vias_on,
            "n_vias": n_vias,
            "via_drill": via_drill,
        }

    def calc_pcb_trace_thermal(self) -> dict:
        """Full PCB trace thermal analysis with multi-section bus bar support.

        Supports two input formats:
        1. New: { common: {...}, sections: [...] }
        2. Legacy: flat params dict (auto-migrated to single section)
        """
        if "pcb_trace_thermal" in self._cached_results:
            return self._cached_results["pcb_trace_thermal"]

        self._current_module = "pcb_trace_thermal"

        p = getattr(self, "pcb_trace_params", {}) or {}

        # ── Detect format: new multi-section vs legacy flat ──
        sections_raw = p.get("sections", None)
        common_raw = p.get("common", None)

        if sections_raw is not None and common_raw is not None:
            # New multi-section format
            common = common_raw
            sections = sections_raw
        else:
            # Legacy flat format → auto-migrate to single section
            common = {}
            section_fields = {}
            for k, v in p.items():
                if k in self._COMMON_KEYS:
                    common[k] = v
                else:
                    section_fields[k] = v
            sections = [{"id": "sec_1", "name": "Section 1", **section_fields}]

        # ── Parse common parameters ──
        def _get_c(key, def_val):
            v = common.get(key, def_val)
            return float(v) if v is not None and str(v).strip() != "" else float(def_val)

        current_a  = float(common.get("current_a") or self.i_max)
        ambient_c  = float(common.get("ambient_c") or self.t_amb)
        pcb_thick  = _get_c("pcb_thickness_mm", 1.6)
        tmax_allow = _get_c("max_conductor_temp_c", 105)
        model_mode = _normalize_model(common.get("model", "2221"))
        cool_mode  = str(common.get("cooling_mode", "natural"))
        orient     = str(common.get("orientation", "vertical"))
        spread_f   = _get_c("spreading_factor", 1.5)
        air_vel    = _get_c("air_velocity_ms", 1)
        hs_theta   = _get_c("hs_theta_sa", 5)
        hs_tint    = _get_c("hs_theta_int", 0.5)
        hs_area    = _get_c("hs_contact_area_cm2", 10)

        cooling = _get_cooling_params(cool_mode, {
            "orientation": orient,
            "spreading_factor": spread_f,
            "air_velocity_ms": air_vel,
            "hs_theta_sa": hs_theta,
            "hs_theta_int": hs_tint,
            "hs_contact_area_cm2": hs_area,
        })

        # ── Solve each section independently ──
        per_section = []
        any_valid = False

        for sec in sections:
            solver_params, sec_info = self._build_section_solver_params(
                sec, common, cooling, model_mode,
                current_a, ambient_c, pcb_thick, tmax_allow
            )
            R = _iterative_solve(solver_params)

            if R is not None:
                any_valid = True
                sec_tmax = ambient_c + R["dT_total"]
                sec_margin = tmax_allow - sec_tmax
                worst_dt_sec = max(R["dT_total"], R["dT_via"] if sec_info["vias_on"] else 0)

                # Per-section status
                if R["dT_total"] > 200 or sec_tmax > tmax_allow or R["CD"] > 15:
                    sec_level = "danger"
                elif R["CD"] > CD_SAFE or R["dT_total"] > TRACE_SAFE_DT or \
                     (sec_info["vias_on"] and R["dT_via"] > VIA_SAFE_DT):
                    sec_level = "warn"
                else:
                    sec_level = "safe"

                per_section.append({
                    "name": sec.get("name", "Section"),
                    "id": sec.get("id", ""),
                    "has_data": True,
                    "level": sec_level,
                    "dT_total": round(R["dT_total"], 2),
                    "dT_via": round(R["dT_via"], 2),
                    "dT_ext": round(R["dT_ext"], 2),
                    "dT_int": round(R["dT_int"], 2),
                    "R_total": round(R["R_total"] * 1000, 4),   # mΩ
                    "Vdrop_mv": round(R["Vdrop"] * 1000, 2),
                    "Ploss_w": round(R["Ploss"], 3),
                    "CD": round(R["CD"], 2),
                    "Imax": round(R["Imax_total"], 1),
                    "tmax_abs": round(sec_tmax, 1),
                    "n_layers": sec_info["n_ext"] + sec_info["n_int"],
                    "trace_w_mm": sec_info["trace_w_mm"],
                    "trace_l_mm": sec_info["trace_l_mm"],
                    "copper_oz": sec_info["copper_oz"],
                    "Amm2": round(R["Amm2"], 4),
                    "Amm2_tot": round(R["Amm2_tot"], 4),
                    "rho_T": R["rho_T"],
                    "vRes": R.get("vRes"),
                    "R_par": R["R_par"],
                    "R_via_par": R["R_via_par"],
                    "_raw": R,
                })
            else:
                per_section.append({
                    "name": sec.get("name", "Section"),
                    "id": sec.get("id", ""),
                    "has_data": False,
                    "level": "danger",
                })

        if not any_valid:
            result = {
                "has_data": False,
                "error": "Invalid trace parameters — check layer count and geometry.",
                "_meta": self._module_meta.get("pcb_trace_thermal", {"hardcoded": [], "fallbacks": []}),
            }
            self._cached_results["pcb_trace_thermal"] = result
            return result

        # ── Aggregate across all sections (series chain) ──
        R_total_ohm = 0
        Vdrop_total = 0
        Ploss_total = 0
        dT_worst = 0
        dT_via_worst = 0
        CD_worst = 0
        Imax_min = float("inf")
        bottleneck_idx = 0
        total_length = 0

        # Track first valid section for fallback values
        first_valid = None
        first_valid_info = {}

        for i, sec_r in enumerate(per_section):
            if not sec_r.get("has_data"):
                continue
            if first_valid is None:
                first_valid = sec_r
                first_valid_info = {
                    "trace_w_mm": sec_r["trace_w_mm"],
                    "copper_oz": sec_r["copper_oz"],
                    "vias_on": sections[i].get("vias_on", True),
                    "n_vias": int(sections[i].get("n_vias", 0) or 0),
                    "via_drill": float(sections[i].get("via_drill_mm", 0.3) or 0.3),
                }

            R_total_ohm += sec_r["_raw"]["R_total"]
            Vdrop_total += sec_r["_raw"]["Vdrop"]
            Ploss_total += sec_r["_raw"]["Ploss"]
            total_length += sec_r["trace_l_mm"]

            if sec_r["dT_total"] > dT_worst:
                dT_worst = sec_r["dT_total"]
                bottleneck_idx = i
            if sec_r["dT_via"] > dT_via_worst:
                dT_via_worst = sec_r["dT_via"]
            if sec_r["CD"] > CD_worst:
                CD_worst = sec_r["CD"]
            if sec_r["Imax"] > 0 and sec_r["Imax"] < Imax_min:
                Imax_min = sec_r["Imax"]

        if Imax_min == float("inf"):
            Imax_min = 0

        worst_dt = max(dT_worst, dT_via_worst)
        tmax_abs = ambient_c + dT_worst
        margin = tmax_allow - tmax_abs

        # Combined status assessment
        if dT_worst > 1060:
            status = "MELT"
            status_level = "danger"
        elif dT_worst > 200:
            status = "TRACE FAILURE"
            status_level = "danger"
        elif tmax_abs > tmax_allow:
            status = f"Over limit: {tmax_abs:.1f}°C > {tmax_allow}°C"
            status_level = "danger"
        elif CD_worst > 15:
            status = f"Critical current density: {CD_worst:.1f} A/mm²"
            status_level = "danger"
        elif CD_worst > CD_SAFE or worst_dt > TRACE_SAFE_DT:
            status = f"Elevated: {tmax_abs:.1f}°C, {CD_worst:.1f} A/mm²"
            status_level = "warn"
        elif dT_via_worst > VIA_SAFE_DT:
            status = f"Via thermal elevated: {dT_via_worst:.1f}°C"
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

        # Strip internal _raw from per-section results before returning
        per_section_clean = []
        for s in per_section:
            s_clean = {k: v for k, v in s.items() if k != "_raw"}
            per_section_clean.append(s_clean)

        # Use first valid section's params for backward-compat coupling keys
        fv = first_valid_info

        result = {
            "has_data": True,
            "multi_section": len(sections) > 1,
            "section_count": len(sections),
            "bottleneck_idx": bottleneck_idx,
            "bottleneck_name": per_section[bottleneck_idx].get("name", ""),
            "per_section": per_section_clean,
            # Primary combined results
            "worst_dt_c":             round(worst_dt, 1),
            "max_conductor_temp_c":   round(tmax_abs, 1),
            "max_safe_current_a":     round(Imax_min, 1),
            "voltage_drop_v":         round(Vdrop_total, 6),
            "voltage_drop_mv":        round(Vdrop_total * 1000, 2),
            "power_dissipated_w":     round(Ploss_total, 3),
            "current_density_a_mm2":  round(CD_worst, 2),
            # Status
            "thermal_status":         status,
            "thermal_status_level":   status_level,
            "thermal_margin_c":       round(margin, 1),
            # Combined resistance
            "resistance_total_mohm":  round(R_total_ohm * 1000, 4),
            "total_trace_length_mm":  round(total_length, 1),
            # Parameters used (for audit)
            "input_current_a":        round(current_a, 2),
            "input_ambient_c":        round(ambient_c, 1),
            "input_pcb_thickness_mm": round(pcb_thick, 1),
            "input_max_temp_c":       round(tmax_allow, 0),
            "input_cooling_mode":     cool_mode,
            # Coupling outputs for other modules (backward compat)
            "min_trace_width_mm":     round(fv.get("trace_w_mm", 7), 1),
            "recommended_copper_oz":  fv.get("copper_oz", 2),
            "trace_power_loss_w":     round(Ploss_total, 3),
            "effective_h_w_m2k":      round(cooling["h"], 1),
            "copper_oz":              fv.get("copper_oz", 2),
            "vias_on":                fv.get("vias_on", True),
            "n_vias":                 fv.get("n_vias", 0),
            "via_drill_mm":           round(fv.get("via_drill", 0.3), 3),
            # Notes
            "notes": {
                "standard": f"{'IPC-2221B' if model_mode == '2221' else 'IPC-2221B + corrections'} — "
                            f"{'conservative, well-validated' if model_mode == '2221' else 'with board/plane/pour correction factors'}",
                "cooling":  f"{cool_mode.replace('_', ' ').title()} cooling — h_eff = {cooling['h']:.1f} W/m²K",
                "sections": f"{len(sections)} section{'s' if len(sections) > 1 else ''}, {total_length:.0f}mm total path",
            },
            "_meta": self._module_meta.get("pcb_trace_thermal", {"hardcoded": [], "fallbacks": []}),
        }

        self.audit_log.append(
            f"[PCB Trace Thermal] {model_mode.upper()}: {current_a:.1f}A across "
            f"{len(sections)} section{'s' if len(sections) > 1 else ''} "
            f"({total_length:.0f}mm total), {cool_mode} cooling → "
            f"ΔT_worst={worst_dt:.1f}°C (sect '{per_section[bottleneck_idx].get('name','')}'), "
            f"Tmax={tmax_abs:.1f}°C, Vdrop={Vdrop_total*1000:.2f}mV, "
            f"Ploss={Ploss_total:.3f}W, CD_worst={CD_worst:.2f}A/mm² — {status_level.upper()}"
        )


        self._cached_results["pcb_trace_thermal"] = result
        return result
