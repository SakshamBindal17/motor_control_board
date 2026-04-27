"""Motor Controller Hardware Design — GateDrive Calculations"""
import math
from calculations.base import _nearest_e


class GateDriveMixin:
    """Mixin providing calculations for: gate_resistors, bootstrap_cap, dead_time."""

    # ═══════════════════════════════════════════════════════════════════
    def calc_gate_resistors(self) -> dict:
        self._current_module = "gate_resistors"
        qg      = self._get(self.mosfet, "MOSFET", "qg",     92e-9)   # C (SI)
        qgd     = self._get(self.mosfet, "MOSFET", "qgd",    None)    # C (SI)
        qgs     = self._get(self.mosfet, "MOSFET", "qgs",    None)    # C (SI)
        vgs_pl  = self._get(self.mosfet, "MOSFET", "vgs_plateau", None)  # V
        vgs_th  = self._get(self.mosfet, "MOSFET", "vgs_th",  3.0)    # V
        rg_int  = self._get(self.mosfet, "MOSFET", "rg_int",  0)      # Ω (0 = not extracted)

        io_src  = self._get(self.driver, "DRIVER", "io_source", 1.5)  # A (SI)
        io_snk  = self._get(self.driver, "DRIVER", "io_sink",   2.5)  # A (SI)

        # Driver output rise/fall times (used for dV/dt limiting)
        drv_tr  = self._get(self.driver, "DRIVER", "rise_time_out", None)  # s or None
        drv_tf  = self._get(self.driver, "DRIVER", "fall_time_out", None)  # s or None

        # Vgs_max validation
        vgs_max = self._get(self.mosfet, "MOSFET", "vgs_max", None)

        try:
            t_rise_target_ns = float(self.ovr.get("gate_rise_time_ns", self._dc("gate.rise_time_target")))
        except (TypeError, ValueError):
            t_rise_target_ns = float(self._dc("gate.rise_time_target"))
        if not math.isfinite(t_rise_target_ns) or t_rise_target_ns <= 0:
            self.audit_log.append(
                f"[Gate Drive] WARNING: Invalid gate_rise_time_ns override ({t_rise_target_ns}). "
                f"Using default {self._dc('gate.rise_time_target')}ns."
            )
            t_rise_target_ns = float(self._dc("gate.rise_time_target"))
        self._log_hc("gate_resistors", "Rise time target", f"{t_rise_target_ns} ns", "Gate rise time target", "gate.rise_time_target")
        t_rise = t_rise_target_ns * 1e-9
        vdrv   = self.v_drv

        # Guard against zero/negative extracted values that would cause division errors
        if qg <= 0:
            qg = 92e-9  # fallback to typical value
            self.audit_log.append(f"[Gate Drive] WARNING: Qg extracted as ≤0. Using fallback 92nC.")
        if io_src <= 0:
            io_src = 1.5
            self.audit_log.append(f"[Gate Drive] WARNING: Driver source current ≤0. Using fallback 1.5A.")
        if io_snk <= 0:
            io_snk = 2.5
            self.audit_log.append(f"[Gate Drive] WARNING: Driver sink current ≤0. Using fallback 2.5A.")

        if vdrv <= vgs_th:
            self.audit_log.append(f"[Gate Drive] WARNING: V_drive ({vdrv}V) <= Vgs_th ({vgs_th}V). MOSFET may not fully turn on. Using V_drive - Vgs_th = 1V minimum for calculations.")
            vgs_th = vdrv - 1.0  # clamp to avoid negative/zero resistance

        # Vgs_max safety check
        vgs_max_warning = None
        if vgs_max is not None and vdrv > vgs_max:
            vgs_max_warning = f"DANGER: Gate drive voltage ({vdrv}V) exceeds MOSFET Vgs_max ({vgs_max}V)! Reduce VCC or add gate clamping."
            self.audit_log.append(f"[Gate Drive] DANGER: V_drv ({vdrv}V) > Vgs_max ({vgs_max}V).")
        elif vgs_max is not None and vdrv > vgs_max * 0.8:
            vgs_max_warning = f"WARNING: Gate drive ({vdrv}V) is within 20% of Vgs_max ({vgs_max}V). Consider clamping Zener."
            self.audit_log.append(f"[Gate Drive] WARNING: V_drv ({vdrv}V) is {round(vdrv/vgs_max*100)}% of Vgs_max ({vgs_max}V).")

        # display units
        qg_nc     = qg * 1e9
        io_src_a  = io_src
        io_snk_a  = io_snk

        # Total Rg (internal + external) determines switching speed.
        # Prefer Miller-charge sizing when available:
        #   t_miller ≈ Qgd / Ig_on, Ig_on ≈ (Vdrv - Vplateau) / Rg_total.
        # Fallback to legacy total-Qg sizing if qgd/vplateau is unavailable.
        use_miller_basis = bool(qgd is not None and qgd > 0)
        vgs_pl_eff = vgs_pl if (vgs_pl is not None and vgs_th + 0.1 < vgs_pl < vdrv - 0.1) else (vgs_th + 1.0)
        vgs_pl_eff = max(vgs_th + 0.2, min(vgs_pl_eff, vdrv - 0.5))

        # ── Check for manual Rg overrides from system_specs ─────────────────
        def _parse_rg(raw):
            try:
                v = float(raw)
                return v if v > 0 else None
            except (TypeError, ValueError):
                return None

        # Fallback to older keys if user saved a project before this refactor
        legacy_rg_on  = _parse_rg((self.sys or {}).get("rg_on_override", ""))
        legacy_rg_off = _parse_rg((self.sys or {}).get("rg_off_override", ""))

        hs_rg_on_manual  = _parse_rg((self.sys or {}).get("hs_rg_on_override", "")) or legacy_rg_on
        hs_rg_off_manual = _parse_rg((self.sys or {}).get("hs_rg_off_override", "")) or legacy_rg_off
        ls_rg_on_manual  = _parse_rg((self.sys or {}).get("ls_rg_on_override", "")) or legacy_rg_on
        ls_rg_off_manual = _parse_rg((self.sys or {}).get("ls_rg_off_override", "")) or legacy_rg_off

        t_fall_target_ns = float(self.ovr.get("gate_fall_time_ns", 40))

        def _calc_leg(name, rg_on_manual, rg_off_manual, is_hs: bool):
            manual_input = rg_on_manual is not None and rg_off_manual is not None
            vgs_pl_eff = vgs_pl if (vgs_pl is not None and vgs_th + 0.1 < vgs_pl < vdrv - 0.1) else (vgs_th + 1.0)
            vgs_pl_eff = max(vgs_th + 0.2, min(vgs_pl_eff, vdrv - 0.5))

            if manual_input:
                sizing_basis = "manual_override"
                rg_on_std    = rg_on_manual
                rg_off_std   = rg_off_manual
                rg_on_raw    = rg_on_manual
                rg_off_raw   = rg_off_manual
                rg_on_total  = rg_on_std + rg_int
                rg_off_total = rg_off_std + rg_int
                
                # Calculate actual switching times based on forced Rg
                if use_miller_basis:
                    t_rise_actual_ns = (rg_on_total * qgd / max(vdrv - vgs_pl_eff, 0.2)) * 1e9
                    t_fall_actual_ns = (rg_off_total * qgd / max(vgs_pl_eff, 0.2)) * 1e9
                else:
                    t_rise_actual_ns = (rg_on_total * qg / max(vdrv - vgs_th, 0.2)) * 1e9
                    t_fall_actual_ns = (rg_off_total * qg / max(vgs_th, 0.2)) * 1e9
                    
                if is_hs:
                    self.audit_log.append(f"[Gate Drive] HS Manual override: Rg_on={rg_on_std}Ω, Rg_off={rg_off_std}Ω.")
            else:
                if use_miller_basis:
                    rg_total_from_time = (vdrv - vgs_pl_eff) / (qgd / t_rise)
                    sizing_basis = "miller_charge"
                else:
                    rg_total_from_time = (vdrv - vgs_th) / (qg / t_rise)
                    sizing_basis = "total_qg_fallback"

                # Peak turn-on driver current occurs at Vgs=0
                rg_drv_min  = vdrv / io_src
                rg_total_on = max(rg_total_from_time, rg_drv_min)
                rg_on_raw   = max(rg_total_on - rg_int, 0.1)
                rg_on_std   = _nearest_e(rg_on_raw)
                rg_on_total = rg_on_std + rg_int
                
                # Compute actual rise time and dV/dt to size Rg_off
                if use_miller_basis:
                    t_rise_actual_ns = (rg_on_total * qgd / max(vdrv - vgs_pl_eff, 0.2)) * 1e9
                else:
                    t_rise_actual_ns = (rg_on_total * qg / max(vdrv - vgs_th, 0.2)) * 1e9
                    
                dv_dt_v_ns = self.v_bus / t_rise_actual_ns if t_rise_actual_ns > 0 else 0
                
                # Auto-size Rg_off
                crss = self._get(self.mosfet, "MOSFET", "crss", None)
                if crss and dv_dt_v_ns > 0:
                    # Rigorous Shoot-through protection based on induced Miller current
                    # I_miller = Crss * dV/dt
                    # V_gs_induced = I_miller * Rg_off_total
                    # Constraint: V_gs_induced < V_th * 0.8 (20% safety margin for high Tj)
                    i_miller = crss * (dv_dt_v_ns * 1e9)
                    rg_off_max_total = (vgs_th * 0.8) / i_miller if i_miller > 0 else float('inf')
                    miller_limit_raw = rg_off_max_total - rg_int
                    
                    if use_miller_basis:
                        rg_off_target = (t_fall_target_ns * 1e-9) * vgs_pl_eff / qgd
                    else:
                        rg_off_target = (t_fall_target_ns * 1e-9) * vgs_th / qg
                    rg_off_target -= rg_int
                    
                    rg_off_raw = min(rg_on_std * 0.9, miller_limit_raw, max(0.1, rg_off_target))
                else:
                    rg_off_raw  = rg_on_std * 0.5
                
                rg_off_std  = _nearest_e(rg_off_raw)
                # Fast turn-off is limited by driver sink capability at Vgs=Vdrv
                rg_off_min  = vdrv / io_snk
                if (rg_off_std + rg_int) < rg_off_min:
                    rg_off_std = _nearest_e(rg_off_min - rg_int)
                    
                rg_off_total = rg_off_std + rg_int
                
                if use_miller_basis:
                    t_fall_actual_ns = (rg_off_total * qgd / max(vgs_pl_eff, 0.2)) * 1e9
                else:
                    t_fall_actual_ns = (rg_off_total * qg / max(vgs_th, 0.2)) * 1e9

            # Dual dV/dt Metrics
            dv_dt_bus = 0 if t_rise_actual_ns <= 0 else self.v_bus / (t_rise_actual_ns * 1e-9) / 1e6
            v_peak = getattr(self, "v_peak", self.v_bus * 1.5)
            dv_dt_peak = 0 if t_rise_actual_ns <= 0 else v_peak / (t_rise_actual_ns * 1e-9) / 1e6

            # Switching loss approximations for component trace analysis
            n_parallel = max(1.0, float(self.num_fets) / 6.0)
            i_load = self.i_max / n_parallel
            e_on = 0.5 * self.v_bus * i_load * (t_rise_actual_ns * 1e-9)
            e_off = 0.5 * self.v_bus * i_load * (t_fall_actual_ns * 1e-9)
            p_sw = (e_on + e_off) * self.fsw
            
            # Peak gate currents (Absolute Max at Start of Switching)
            i_peak_on = vdrv / rg_on_total
            i_peak_off = vdrv / rg_off_total

            # Gate Resistor Power Dissipation
            p_gate_total = qg * vdrv * self.fsw
            # Split power between On and Off paths based on relative resistance
            rg_path = ((rg_on_std + rg_off_std) / 2) + rg_int
            rg_fraction = ((rg_on_std + rg_off_std) / 2) / rg_path if rg_path > 0 else 0.5
            p_per_rg = p_gate_total * rg_fraction

            return {
                "rg_on_recommended_ohm": rg_on_std,
                "rg_off_recommended_ohm": rg_off_std,
                "gate_rise_time_ns": round(t_rise_actual_ns, 1),
                "gate_fall_time_ns": round(t_fall_actual_ns, 1),
                "dv_dt_bus": round(dv_dt_bus, 1),
                "dv_dt_peak": round(dv_dt_peak, 1),
                "e_on_uj": round(e_on * 1e6, 2),
                "e_off_uj": round(e_off * 1e6, 2),
                "p_sw_w": round(p_sw, 2),
                "i_peak_on_a": round(i_peak_on, 2),
                "i_peak_off_a": round(i_peak_off, 2),
                "rg_power_w": round(p_per_rg, 4),
                "manual_rg_input": manual_input,
                "sizing_basis": sizing_basis,
                "rg_on_total_ohm": round(rg_on_total, 2),
                "rg_off_total_ohm": round(rg_off_total, 2),
            }

        hs = _calc_leg("High-Side", hs_rg_on_manual, hs_rg_off_manual, True)
        ls = _calc_leg("Low-Side", ls_rg_on_manual, ls_rg_off_manual, False)

        rg_boot = float(self.ovr.get("rg_bootstrap_ohm", self._dc("gate.rg_bootstrap")))

        result = {
            "hs_rg_on_ohm": hs["rg_on_recommended_ohm"],
            "hs_rg_off_ohm": hs["rg_off_recommended_ohm"],
            "ls_rg_on_ohm": ls["rg_on_recommended_ohm"],
            "ls_rg_off_ohm": ls["rg_off_recommended_ohm"],
            
            "hs_gate_rise_time_ns": hs["gate_rise_time_ns"],
            "ls_gate_rise_time_ns": ls["gate_rise_time_ns"],
            "hs_gate_fall_time_ns": hs["gate_fall_time_ns"],
            "ls_gate_fall_time_ns": ls["gate_fall_time_ns"],
            
            "hs_dv_dt_bus": hs["dv_dt_bus"],
            "hs_dv_dt_peak": hs["dv_dt_peak"],
            "ls_dv_dt_bus": ls["dv_dt_bus"],
            "ls_dv_dt_peak": ls["dv_dt_peak"],
            
            "hs_p_sw_w": hs["p_sw_w"],
            "ls_p_sw_w": ls["p_sw_w"],
            
            "hs_i_peak_on_a": hs["i_peak_on_a"],
            "hs_i_peak_off_a": hs["i_peak_off_a"],
            "ls_i_peak_on_a": ls["i_peak_on_a"],
            "ls_i_peak_off_a": ls["i_peak_off_a"],
            
            "hs_rg_power_w": hs["rg_power_w"],
            "ls_rg_power_w": ls["rg_power_w"],
            
            "rg_internal_ohm": round(rg_int, 2) if rg_int > 0 else 0,
            "rg_bootstrap_ohm": rg_boot,
            "sizing_basis_hs": hs["sizing_basis"],
            "sizing_basis_ls": ls["sizing_basis"],
            "manual_rg_input": hs["manual_rg_input"] and ls["manual_rg_input"],
            "gate_resistor_rating": "0.1W minimum (0402/0603)",
            "bypass_diode_turn_off": "1N4148 or BAT54 in parallel with Rg_off",
            "notes": {
                "placement": "Mount within 10mm of gate pin, shortest possible trace",
            },
            "_meta": self._module_meta.get("gate_resistors", {"hardcoded": [], "fallbacks": []}),
        }

        if use_miller_basis:
            result["qgd_used_nc"] = round(qgd * 1e9, 2)
            result["vgs_plateau_used_v"] = round(vgs_pl, 2) if vgs_pl else None

        # Crss-based dV/dt (more accurate than Vbus/t_rise when Crss extracted)
        # dV/dt = i_gate / Crss — directly measures how fast gate current charges Crss
        crss_val = self._get(self.mosfet, "MOSFET", "crss", None)
        if crss_val is not None and crss_val > 0:
            hs_tr_s = hs["gate_rise_time_ns"] * 1e-9
            rg_on_total_hs = hs["rg_on_total_ohm"]
            vgs_pl_for_dv = vgs_pl_eff if vgs_pl_eff else (vgs_th + 1.0)
            i_gate_miller = (vdrv - vgs_pl_for_dv) / rg_on_total_hs if rg_on_total_hs > 0 else io_src
            dv_dt_crss = i_gate_miller / crss_val / 1e6  # V/µs
            result["dv_dt_crss_v_per_us"] = round(dv_dt_crss, 1)
            result["crss_pf"] = round(crss_val * 1e12, 1)
            self.audit_log.append(
                f"[Gate Drive] Crss-based dV/dt: Ig_miller={i_gate_miller:.2f}A / "
                f"Crss={crss_val*1e12:.0f}pF = {dv_dt_crss:.0f} V/µs."
            )

        # Add driver output timing info if available
        if drv_tr is not None:
            result["driver_rise_time_ns"] = round(drv_tr * 1e9, 1)
        if drv_tf is not None:
            result["driver_fall_time_ns"] = round(drv_tf * 1e9, 1)
        if vgs_max is not None:
            result["vgs_max_v"] = round(vgs_max, 1)
        if vgs_max_warning:
            result["vgs_max_warning"] = vgs_max_warning

        # ── Gate drive IC thermal (Item 13) ──────────────────────────────────
        # Split total gate charge power between driver IC and external resistors.
        # rg_ext_fraction = Rg_ext / (Rg_ext + Rg_int) — fraction dissipated in PCB resistor.
        # Driver IC dissipates the remainder.
        rth_ja_drv = self._get(self.driver, "DRIVER", "rth_ja", None)   # °C/W
        tj_max_drv = self._get(self.driver, "DRIVER", "tj_max", 150.0)  # °C
        p_gate_total = qg * vdrv * self.fsw   # total gate charge power both edges

        rg_on_hs  = result["hs_rg_on_ohm"]
        rg_off_hs = result["hs_rg_off_ohm"]

        # Power split: external Rg dissipates rg_ext/(rg_ext+rg_int) of gate charge power
        # Turn-on path
        rg_on_ext_frac  = rg_on_hs  / (rg_on_hs  + rg_int) if (rg_on_hs  + rg_int) > 0 else 0.5
        rg_off_ext_frac = rg_off_hs / (rg_off_hs + rg_int) if (rg_off_hs + rg_int) > 0 else 0.5
        # Gate charge splits 50/50 between turn-on and turn-off paths (Qg total).
        # Each half: external Rg dissipates rg_ext_frac of that half-cycle energy.
        p_rg_on_ext  = 0.5 * p_gate_total * rg_on_ext_frac
        p_rg_off_ext = 0.5 * p_gate_total * rg_off_ext_frac
        p_driver_gate = p_gate_total - p_rg_on_ext - p_rg_off_ext  # IC dissipation

        # Scale for all 6 FETs driven (3 HS + 3 LS, each with its own charge path)
        p_driver_total = p_driver_gate * self.num_fets

        result["driver_gate_power_w"]   = round(p_driver_gate, 4)
        result["driver_gate_power_total_w"] = round(p_driver_total, 3)
        result["p_rg_on_ext_w"]         = round(p_rg_on_ext,  4)
        result["p_rg_off_ext_w"]        = round(p_rg_off_ext, 4)

        if rth_ja_drv is not None:
            tj_driver = self.t_amb + p_driver_total * rth_ja_drv
            tj_driver_margin = tj_max_drv - tj_driver
            result["driver_tj_est_c"]     = round(tj_driver, 1)
            result["driver_tj_margin_c"]  = round(tj_driver_margin, 1)
            result["driver_tj_max_c"]     = round(tj_max_drv, 1)
            result["driver_tj_ok"]        = tj_driver_margin >= 20.0
            if tj_driver_margin < 20:
                result.setdefault("warnings", []).append(
                    f"WARNING: Driver Tj estimate {tj_driver:.0f}°C — only {tj_driver_margin:.0f}°C "
                    f"below Tj_max ({tj_max_drv:.0f}°C). Consider improving driver heatsinking or reducing fsw."
                )
            self.audit_log.append(
                f"[Gate Drive Thermal] P_driver={p_driver_total:.3f}W total "
                f"(P_gate={p_gate_total:.3f}W, Rth_JA={rth_ja_drv}°C/W) → "
                f"Tj_driver={tj_driver:.1f}°C (margin={tj_driver_margin:.1f}°C)."
            )
        else:
            self.audit_log.append(
                "[Gate Drive Thermal] Rth_JA not extracted — driver Tj cannot be estimated. "
                "Upload gate driver datasheet to enable driver thermal check."
            )

        # ── Simple dV/dt from MOSFET datasheet tr/tf (§12b) ─────────────────
        # Uses MOSFET-intrinsic switching times, independent of gate resistor choice.
        tr_s = self._get(self.mosfet, "MOSFET", "tr", None)
        tf_s = self._get(self.mosfet, "MOSFET", "tf", None)
        _EMC_LIMIT_V_PER_NS = 50.0
        dvdt_on = dvdt_off = None
        if tr_s and tr_s > 0:
            dvdt_on = self.v_bus / (tr_s * 1e9)  # V/ns
            result["dvdt_on_v_per_ns"] = round(dvdt_on, 2)
            result["dvdt_on_emc_ok"] = bool(dvdt_on < _EMC_LIMIT_V_PER_NS)
        if tf_s and tf_s > 0:
            dvdt_off = self.v_bus / (tf_s * 1e9)  # V/ns
            result["dvdt_off_v_per_ns"] = round(dvdt_off, 2)
            result["dvdt_off_emc_ok"] = bool(dvdt_off < _EMC_LIMIT_V_PER_NS)
        if dvdt_on is not None and dvdt_off is not None:
            result["dvdt_emc_limit_v_per_ns"] = _EMC_LIMIT_V_PER_NS
            result["dvdt_emc_pass"] = bool(max(dvdt_on, dvdt_off) < _EMC_LIMIT_V_PER_NS)

        return result

    # ═══════════════════════════════════════════════════════════════════
    # 3. Input Bus Capacitors
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_bootstrap_cap(self) -> dict:
        self._current_module = "bootstrap_cap"
        # _get already returns SI (Coulombs) — do NOT multiply by 1e-9 again
        qg    = self._get(self.mosfet, "MOSFET", "qg", 92e-9)   # C (SI)
        vdrv  = self.v_drv
        fsw   = self.fsw  # Hz — from system params

        # ── 1. Leakage budget (coupled from driver datasheet) ─────────────────
        idd_q_raw = self._get(self.driver, "DRIVER", "idd_quiescent", None)
        if idd_q_raw is not None and idd_q_raw > 0:
            driver_ua   = idd_q_raw * 1e6    # A → µA
            i_leakage_ua = driver_ua + 1.0   # +1µA for MOSFET gate leakage
            self.audit_log.append(f"[Bootstrap] Leakage: {i_leakage_ua:.1f}µA (driver {driver_ua:.1f}µA + 1µA gate).")
        else:
            i_leakage_ua = 3.0
            self.audit_log.append("[Bootstrap] WARNING: Driver quiescent current missing. Defaulting to 3µA.")
        i_leak_a = i_leakage_ua * 1e-6

        # ── 2. Total per-cycle charge requirement ─────────────────────────────
        # C_boot must supply: Qg (gate switching charge) + leakage over one switching period
        q_leak_per_cycle = i_leak_a / fsw   # leakage charge per PWM cycle (Coulombs)
        q_total          = qg + q_leak_per_cycle
        self.audit_log.append(
            f"[Bootstrap] Q_total = {q_total*1e9:.3f}nC  "
            f"(Qg={qg*1e9:.2f}nC + Q_leak={q_leak_per_cycle*1e12:.1f}pC/cycle @ {fsw/1000:.0f}kHz)"
        )

        # ── 3. User droop target ───────────────────────────────────────────────
        droop = float(self.ovr.get("bootstrap_droop_v", 0.5))
        if "bootstrap_droop_v" not in self.ovr:
            self._log_hc("bootstrap_cap", "Bootstrap droop target", f"{droop} V",
                         "Max allowable HS gate voltage sag per PWM cycle")
        if droop <= 0:
            self.audit_log.append("[Bootstrap] WARNING: droop ≤ 0. Using 0.5V default.")
            droop = 0.5

        # ── 4. Minimum capacitance (charge-budget limited) ────────────────────
        # C_min = Q_total / ΔV_droop — exact charge-balance equation
        c_boot_min_f  = q_total / droop      # Farads
        c_boot_min_nf = c_boot_min_f * 1e9  # nF (what is displayed as "required")

        # ── 5. E12 snap with configurable safety margin ───────────────────────
        boot_margin_mult = self._dc("boot.safety_margin")
        c_boot_with_margin = c_boot_min_nf * boot_margin_mult
        E12_nF = [1,1.2,1.5,1.8,2.2,2.7,3.3,3.9,4.7,5.6,6.8,8.2,
                  10,12,15,18,22,27,33,39,47,56,68,82,
                  100,120,150,180,220,270,330,470,680,1000]
        c_std_nf = float(next((v for v in E12_nF if v >= c_boot_with_margin), E12_nF[-1]))
        boot_min_cap = self._dc("boot.min_cap")
        c_std_nf = max(boot_min_cap, c_std_nf)
        c_std_f  = c_std_nf * 1e-9

        self._log_hc("bootstrap_cap", "Min practical boot cap", f"{boot_min_cap} nF",
                     "Floor for bootstrap capacitor value", "boot.min_cap")
        self._log_hc("bootstrap_cap", "Safety margin", f"{boot_margin_mult}x",
                     f"C_boot multiplied by {boot_margin_mult}x before E12 snap", "boot.safety_margin")

        # ── 6. Actual droop on the chosen E12 cap ────────────────────────────
        # With a larger cap than C_min, actual droop is smaller than target
        droop_actual = q_total / c_std_f if c_std_f > 0 else 999.0

        # ── 7. Bootstrap supply voltage ───────────────────────────────────────
        vf_diode = self._dc("gate.bootstrap_vf")
        self._log_hc("bootstrap_cap", "Schottky diode Vf", f"{vf_diode} V",
                     "Assumed forward drop for bootstrap diode", "gate.bootstrap_vf")
        v_boot     = vdrv - vf_diode
        v_boot_min = v_boot - droop_actual   # worst-case gate voltage at end of HS on-time

        # ── 8. Series resistor & RC time constant ─────────────────────────────
        r_boot = float(self.ovr.get("rg_bootstrap_ohm", self._dc("gate.rg_bootstrap")))
        self._log_hc("bootstrap_cap", "Series boot resistor", f"{r_boot} Ω",
                     "Limits peak bootstrap diode charging current", "gate.rg_bootstrap")
        tau_boot = r_boot * c_std_f   # seconds

        # ── 9. Pre-charge time (initial startup, cap from 0V → 95% V_boot) ───
        # Standard 3τ = 95% settling: V(t) = V_boot × (1 − exp(−t/τ))
        # At t = 3τ: V = V_boot × (1 − e⁻³) ≈ 0.950 × V_boot
        t_precharge_us = 3.0 * tau_boot * 1e6

        # ── 10. Per-cycle refresh time (min LS on-time) ──────────────────────
        # During LS on-time the cap charges from (V_boot − droop_actual) back toward V_boot.
        # The exponential recovery analysis:
        #   Q_restored = C × droop_actual × (1 − exp(−t / τ))
        #   Since C × droop_actual = Q_total exactly, solving for 95% recovery:
        #   0.95 × Q_total = Q_total × (1 − exp(−t / τ))
        #   → exp(−t / τ) = 0.05
        #   → t_refresh = −τ × ln(0.05) = τ × ln(20) ≈ 3τ
        # This result (3τ) is INDEPENDENT of capacitor size or droop target.
        # Physical meaning: you need 3 RC time constants per cycle to maintain 95% charge.
        t_refresh_s  = -tau_boot * math.log(0.05)   # = 3τ exactly for any C_std
        t_refresh_us = t_refresh_s * 1e6
        t_refresh_ns = t_refresh_s * 1e9
        self.audit_log.append(
            f"[Bootstrap] τ = {tau_boot*1e6:.2f}µs → t_precharge = t_refresh = 3τ = {t_refresh_us:.2f}µs"
        )

        # ── 11. Hold time (max continuous HS-ON duration before UVLO risk) ───
        # t_hold = C_boot × ΔV / I_leakage
        # Uses droop_actual (actual droop budget from chosen cap)
        t_hold_ms = (c_std_f * droop_actual / i_leak_a) * 1000 if i_leak_a > 0 else 99999.0

        return {
            "c_boot_calculated_nf":   round(c_boot_min_nf,  1),   # from Q_total/droop
            "c_boot_recommended_nf":  c_std_nf,                    # E12-snapped with margin
            "c_boot_v_rating_v":      int(self.ovr.get("cboot_v_rating_v", 25)),
            "c_boot_dielectric":      "X7R MLCC",
            "c_boot_qty":             int(self.num_fets // 2),      # 1 per HS switch; topology-fixed
            "safety_margin_x":        boot_margin_mult,
            "q_total_nc":             round(q_total * 1e9, 3),
            "q_leak_pc":              round(q_leak_per_cycle * 1e12, 2),
            "i_leakage_ua":           round(i_leakage_ua, 1),
            "droop_target_v":         droop,
            "droop_actual_v":         round(droop_actual, 3),      # actual droop on chosen E12 cap
            "v_bootstrap_v":          round(v_boot,       2),
            "v_boot_min_v":           round(v_boot_min,   2),      # worst-case gate voltage
            "r_boot_series_ohm":      r_boot,
            "tau_us":                 round(tau_boot * 1e6, 2),
            "boot_precharge_us":      round(t_precharge_us, 1),
            "min_refresh_us":         round(t_refresh_us,  2),     # kept for PassivesPanel compat
            "min_hs_on_time_ns":      round(t_refresh_ns,  1),     # for reverse solver & CalculationsPanel
            "bootstrap_hold_time_ms": round(t_hold_ms,     1),
            "notes": {
                "100pct_duty": "100% duty cycle requires external charge pump — passive bootstrap cannot sustain this.",
                "refresh":     f"Min LS on-time/cycle: {round(t_refresh_ns, 0):.0f}ns = 3τ (95% Q_total replenishment via exponential RC charging).",
                "derating":    f"Use ≥{int(vdrv*2)}V rated cap at {int(vdrv)}V drive for 50% voltage derating (combats MLCC DC-bias droop).",
            },
            "_meta": self._module_meta.get("bootstrap_cap", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 5. Shunt Resistors (Single + 3-phase)
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_dead_time(self) -> dict:
        self._current_module = "dead_time"
        # _get returns SI (seconds) — use SI fallbacks, then convert to ns for arithmetic
        # Turn-off path components
        td_off_s  = self._get(self.mosfet, "MOSFET", "td_off",       50e-9) or 50e-9   # seconds
        tf_s      = self._get(self.mosfet, "MOSFET", "tf",            20e-9) or 20e-9   # seconds
        t_prop_off_s = self._get(self.driver, "DRIVER", "prop_delay_off", 60e-9) or 60e-9  # seconds
        # Turn-on path components
        td_on_s   = self._get(self.mosfet, "MOSFET", "td_on",         15e-9) or 15e-9   # seconds
        tr_s      = self._get(self.mosfet, "MOSFET", "tr",            30e-9) or 30e-9   # seconds
        t_prop_on_s = self._get(self.driver, "DRIVER", "prop_delay_on", 60e-9) or 60e-9  # seconds

        # Body diode parameters (from MOSFET datasheet)
        body_diode_vf = self._get(self.mosfet, "MOSFET", "body_diode_vf", 0.7)  # V
        trr_s         = self._get(self.mosfet, "MOSFET", "trr", None)            # s or None

        # Driver output transition times (from driver datasheet)
        drv_rise_s = self._get(self.driver, "DRIVER", "rise_time_out", None)  # s or None
        drv_fall_s = self._get(self.driver, "DRIVER", "fall_time_out", None)  # s or None

        # Convert to nanoseconds for readable arithmetic
        td_off_ns    = td_off_s    * 1e9
        tf_ns        = tf_s        * 1e9
        t_prop_off_ns= t_prop_off_s* 1e9
        td_on_ns     = td_on_s     * 1e9
        tr_ns_val    = tr_s        * 1e9
        t_prop_on_ns = t_prop_on_s * 1e9

        drv_fall_ns = drv_fall_s * 1e9 if drv_fall_s is not None else 0.0
        drv_rise_ns = drv_rise_s * 1e9 if drv_rise_s is not None else 0.0

        dt_abs_margin  = self._dc("dt.abs_margin")
        dt_safety_mult = self._dc("dt.safety_mult")

        # ── Turn-off path: td_off + tf + prop_delay_off + drv_fall + margin ──
        dt_off_min = td_off_ns + tf_ns + t_prop_off_ns + drv_fall_ns + dt_abs_margin

        # ── Turn-on path: td_on + tr + prop_delay_on + drv_rise + margin ────
        # The complementary FET must fully turn off (td_on + tr of the new FET)
        # before the outgoing FET can be triggered on.
        dt_on_min  = td_on_ns + tr_ns_val + t_prop_on_ns + drv_rise_ns + dt_abs_margin

        # Take the worst-case path
        dt_min_path = "turn_off" if dt_off_min >= dt_on_min else "turn_on"
        dt_min = max(dt_off_min, dt_on_min)
        dt_rec = round(dt_min * dt_safety_mult)   # ns

        self.audit_log.append(
            f"[Dead Time] Turn-off path: {dt_off_min:.1f}ns "
            f"(td_off={td_off_ns:.0f} + tf={tf_ns:.0f} + prop_off={t_prop_off_ns:.0f} + drv_fall={drv_fall_ns:.0f} + margin={dt_abs_margin:.0f})."
        )
        self.audit_log.append(
            f"[Dead Time] Turn-on path: {dt_on_min:.1f}ns "
            f"(td_on={td_on_ns:.0f} + tr={tr_ns_val:.0f} + prop_on={t_prop_on_ns:.0f} + drv_rise={drv_rise_ns:.0f} + margin={dt_abs_margin:.0f})."
        )
        self.audit_log.append(
            f"[Dead Time] Limiting path: {dt_min_path} ({dt_min:.1f}ns). "
            f"Recommended: {dt_rec:.0f}ns ({dt_safety_mult}× safety margin)."
        )
        self._log_hc("dead_time", "Absolute margin", f"{dt_abs_margin} ns", "Baseline safety margin added to minimum", "dt.abs_margin")
        self._log_hc("dead_time", "Safety multiplier", f"{dt_safety_mult}x", "Recommended margin over minimum dead time", "dt.safety_mult")

        # MCU dead-time register resolution — key "pwm_deadtime_res" (matches extraction)
        dt_res_s  = self._get(self.mcu, "MCU", "pwm_deadtime_res", 8e-9) or 8e-9   # seconds
        dt_res_ns = dt_res_s * 1e9                                       # ns

        dt_reg    = math.ceil(dt_rec / dt_res_ns)
        dt_actual = dt_reg * dt_res_ns                   # ns (multiple of resolution)

        # Feasibility check vs MCU max dead time
        dt_max_s   = self._get(self.mcu, "MCU", "pwm_deadtime_max", 1000e-9) or 1000e-9
        dt_max_ns  = dt_max_s * 1e9
        dt_feasible = dt_actual <= dt_max_ns

        period_ns     = 1e9 / self.fsw
        dt_pct        = (dt_actual / period_ns) * 100
        duty_loss_pct = dt_pct

        # Body diode conduction loss during dead time (per phase leg, both transitions)
        # Sinusoidal average of |I(θ)| over electrical cycle = I_peak × 2/π
        # P_body = Vf × I_avg × dt_actual × fsw × 2 (two dead-time intervals per cycle)
        sin_avg = 2.0 / math.pi
        p_body_diode_per_leg = body_diode_vf * self.i_max * sin_avg * (dt_actual * 1e-9) * self.fsw * 2
        # Three physical phase legs are fixed; parallel MOSFET count should not change leg count.
        num_legs = 3
        p_body_diode_total = p_body_diode_per_leg * num_legs

        # Reverse recovery time check
        trr_warning = None
        if trr_s is not None:
            trr_ns = trr_s * 1e9
            if dt_actual < trr_ns:
                trr_warning = (
                    f"WARNING: Dead time ({dt_actual:.0f}ns) < reverse recovery time ({trr_ns:.0f}ns). "
                    f"Body diode may not fully recover — risk of shoot-through current spike."
                )
                self.audit_log.append(f"[Dead Time] WARNING: dt_actual ({dt_actual:.0f}ns) < trr ({trr_ns:.0f}ns).")

        result = {
            "dt_minimum_ns":          round(dt_min,        1),
            "dt_recommended_ns":      round(dt_rec,        1),
            "dt_register_count":      dt_reg,
            "dt_actual_ns":           round(dt_actual,     1),
            "dt_pct_of_period":       round(dt_pct,        3),
            "switching_period_ns":    round(period_ns,     1),
            "effective_duty_loss_pct":round(duty_loss_pct, 3),
            "dt_feasible":            dt_feasible,
            "dt_max_ns":              round(dt_max_ns,     1),
            # Turn-off path breakdown
            "dt_turnoff_path_ns":     round(dt_off_min,    1),
            "td_off_ns":              round(td_off_ns,     1),
            "tf_ns":                  round(tf_ns,         1),
            "prop_delay_off_ns":      round(t_prop_off_ns, 1),
            # Turn-on path breakdown
            "dt_turnon_path_ns":      round(dt_on_min,     1),
            "td_on_ns":               round(td_on_ns,      1),
            "tr_ns":                  round(tr_ns_val,     1),
            "prop_delay_on_ns":       round(t_prop_on_ns,  1),
            # Limiting path
            "dt_limiting_path":       dt_min_path,
            "dt_resolution_ns":       round(dt_res_ns,    2),
            "body_diode_vf_v":        round(body_diode_vf, 2),
            "body_diode_loss_per_leg_w": round(p_body_diode_per_leg, 3),
            "body_diode_loss_total_w":   round(p_body_diode_total,   3),
            "notes": {
                "foc":       "Dead-time compensation required in firmware for accurate FOC below ~10% mod index",
                "6step":     "6-step commutation: enforce same dead-time at each commutation event",
                "comp_algo": "Voltage feed-forward or current-sign-based dead-time compensation",
            },
            "_meta": self._module_meta.get("dead_time", {"hardcoded": [], "fallbacks": []}),
        }

        if drv_fall_ns > 0:
            result["driver_fall_time_ns"] = round(drv_fall_ns, 1)
        if drv_rise_ns > 0:
            result["driver_rise_time_ns"] = round(drv_rise_ns, 1)
        if trr_s is not None:
            result["trr_ns"] = round(trr_s * 1e9, 1)
        if trr_warning:
            result["trr_warning"] = trr_warning

        return result

    # ═══════════════════════════════════════════════════════════════════
    # 12. PCB Guidelines
    # ═══════════════════════════════════════════════════════════════════

