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

        rg_on_manual  = _parse_rg((self.sys or {}).get("gate_rg_on_ohm", ""))
        rg_off_manual = _parse_rg((self.sys or {}).get("gate_rg_off_ohm", ""))
        manual_input  = rg_on_manual is not None and rg_off_manual is not None

        if manual_input:
            sizing_basis = "manual_override"
            rg_on_std    = rg_on_manual
            rg_on_raw    = rg_on_manual
            rg_off_std   = rg_off_manual
            rg_off_raw   = rg_off_manual
            vgs_pl_eff   = vgs_pl if (vgs_pl is not None and vgs_th + 0.1 < vgs_pl < vdrv - 0.1) else (vgs_th + 1.0)
            vgs_pl_eff   = max(vgs_th + 0.2, min(vgs_pl_eff, vdrv - 0.5))
            self.audit_log.append(f"[Gate Drive] Manual override: Rg_on={rg_on_std}Ω, Rg_off={rg_off_std}Ω entered by user. Physics-based Rg sizing bypassed.")
        else:
            if use_miller_basis:
                rg_total_from_time = (vdrv - vgs_pl_eff) / (qgd / t_rise)
                rg_drv_min         = (vdrv - vgs_pl_eff) / io_src
                sizing_basis = "miller_charge"
            else:
                rg_total_from_time = (vdrv - vgs_th) / (qg / t_rise)
                rg_drv_min         = (vdrv - vgs_th) / io_src
                sizing_basis = "total_qg_fallback"

            rg_total_on        = max(rg_total_from_time, rg_drv_min)
            rg_on_raw          = max(rg_total_on - rg_int, 0.1)  # external Rg = total - internal
            rg_on_std          = _nearest_e(rg_on_raw)
            if rg_int > 0:
                self.audit_log.append(f"[Gate Drive] Accounted for Rg_int={rg_int:.1f}Ω from MOSFET datasheet. Rg_ext = Rg_total - Rg_int.")

            # Auto-size Rg_off using Miller shoot-through prevention (Cgd/Cgs ratio)
            crss = self._get(self.mosfet, "MOSFET", "crss", None)
            ciss = self._get(self.mosfet, "MOSFET", "ciss", None)
            cgs  = ciss - crss if ciss and crss and ciss > crss else None

            if crss and cgs:
                # Shoot-through criteria: Rg_off_total < Vth / (Cgd * dV/dt)
                # Standard physical heuristic limit: Rg_off < (Cgs / Cgd) * Rgon
                miller_ratio_limit = (cgs / crss) * rg_on_std * 0.7  # 30% margin
                rg_off_raw = min(rg_on_std * 0.9, miller_ratio_limit)
                self.audit_log.append(f"[Gate Drive] Sized Rg_off ({rg_off_raw:.1f}Ω) dynamically using Miller ratio Cgs/Cgd ({cgs*1e12:.0f}pF/{crss*1e12:.0f}pF) to prevent dV/dt shoot-through.")
            else:
                rg_off_ratio = 0.5
                rg_off_raw  = rg_on_std * rg_off_ratio
                self.audit_log.append("[Gate Drive] Miller capacitances missing. Assumed Rg_off = 0.5 × Rg_on ratio.")
            
            rg_off_std  = _nearest_e(rg_off_raw)
            rg_off_min  = (vgs_pl_eff / io_snk) if use_miller_basis else (vdrv / io_snk)
            if rg_off_std < rg_off_min:
                rg_off_std = _nearest_e(rg_off_min)

        rg_boot = self._dc("gate.rg_bootstrap")
        self.audit_log.append(f"[Gate Drive] Bootstrap gate resistor (Rg_boot) = {rg_boot}Ω.")
        self._log_hc("gate_resistors", "Rg_bootstrap", f"{rg_boot} Ω", "Limits peak bootstrap diode charging current", "gate.rg_bootstrap")

        # Actual switching times use total Rg (external + internal)
        rg_on_total  = rg_on_std + rg_int
        rg_off_total = rg_off_std + rg_int

        if use_miller_basis:
            t_rise_actual_ns = (rg_on_total * qgd / max(vdrv - vgs_pl_eff, 0.2)) * 1e9
            t_fall_actual_ns = (rg_off_total * qgd / max(vgs_pl_eff, 0.2)) * 1e9
        else:
            t_rise_actual_ns = (rg_on_total * qg / max(vdrv - vgs_th, 0.2)) * 1e9
            t_fall_actual_ns = (rg_off_total * qg / max(vdrv, 0.2)) * 1e9

        dv_dt            = 0 if t_rise_actual_ns <= 0 else self.v_peak / (t_rise_actual_ns * 1e-9) / 1e6

        p_gate_total = qg * vdrv * self.fsw   # total gate drive power per MOSFET
        # Power split: Rg_ext / (Rg_ext + Rg_int) — driver output impedance lumped into Rg_int
        rg_ext_avg  = (rg_on_std + rg_off_std) / 2
        rg_path     = rg_ext_avg + rg_int
        rg_fraction = rg_ext_avg / rg_path if rg_path > 0 else 0.5
        p_per_rg = p_gate_total * rg_fraction

        result = {
            "rg_on_calculated_ohm":     round(rg_on_raw,          2),
            "rg_on_recommended_ohm":    rg_on_std,
            "rg_off_calculated_ohm":    round(rg_off_raw,         2),
            "rg_off_recommended_ohm":   rg_off_std,
            "rg_internal_ohm":          round(rg_int, 2) if rg_int > 0 else None,
            "rg_on_total_ohm":          round(rg_on_total, 2),
            "rg_off_total_ohm":         round(rg_off_total, 2),
            "rg_bootstrap_ohm":         rg_boot,
            "gate_rise_time_ns":        round(t_rise_actual_ns,   1),
            "gate_fall_time_ns":        round(t_fall_actual_ns,   1),
            "dv_dt_v_per_us":           round(dv_dt,              1),
            "driver_source_current_a":  round(io_src_a,           2),
            "driver_sink_current_a":    round(io_snk_a,           2),
            "gate_resistor_power_w":    round(p_per_rg,           4),
            "gate_resistor_rating":     "0.1W minimum (0402/0603)",
            "bypass_diode_turn_off":    "1N4148 or BAT54 in parallel with Rg_off",
            "notes": {
                "rg_on_basis":  (
                    f"Qgd={qgd*1e9:.1f}nC, Vdrv={vdrv}V, Vpl={vgs_pl_eff:.2f}V, t_rise={t_rise_target_ns}ns target"
                    if use_miller_basis else
                    f"Qg={qg_nc:.1f}nC, Vdrv={vdrv}V, Vth={vgs_th}V, t_rise={t_rise_target_ns}ns target"
                ) + (f", Rg_int={rg_int:.1f}Ω subtracted" if rg_int > 0 else ""),
                "rg_off_note":  "Place Schottky diode antiparallel with Rg_off for asymmetric drive",
                "placement":    "Mount within 10mm of gate pin, 0402/0603, shortest possible trace",
                "emi_note":     f"dV/dt={round(dv_dt,1)} V/µs — adjust Rg_on if EMI issues arise",
            },
            "_meta": self._module_meta.get("gate_resistors", {"hardcoded": [], "fallbacks": []}),
        }

        result["rg_sizing_basis"] = sizing_basis
        if use_miller_basis:
            result["qgd_used_nc"] = round(qgd * 1e9, 2)
            result["vgs_plateau_used_v"] = round(vgs_pl_eff, 2)
            if qgs is not None and qgs > 0:
                result["qgs_extracted_nc"] = round(qgs * 1e9, 2)

        # Add driver output timing info if available
        if drv_tr is not None:
            result["driver_rise_time_ns"] = round(drv_tr * 1e9, 1)
        if drv_tf is not None:
            result["driver_fall_time_ns"] = round(drv_tf * 1e9, 1)
        if vgs_max is not None:
            result["vgs_max_v"] = round(vgs_max, 1)
        if vgs_max_warning:
            result["vgs_max_warning"] = vgs_max_warning

        return result

    # ═══════════════════════════════════════════════════════════════════
    # 3. Input Bus Capacitors
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_bootstrap_cap(self) -> dict:
        self._current_module = "bootstrap_cap"
        # _get already returns SI (Coulombs) — do NOT multiply by 1e-9 again
        qg     = self._get(self.mosfet, "MOSFET", "qg", 92e-9)   # C  (SI)
        vgs_th = self._get(self.mosfet, "MOSFET", "vgs_th", 3.0)  # V
        vdrv   = self.v_drv

        # Allow 0.5V droop
        droop    = float(self.ovr.get("bootstrap_droop_v", 0.5))
        if "bootstrap_droop_v" not in self.ovr:
            self._log_hc("bootstrap_cap", "Bootstrap droop target", f"{droop} V", "Acceptable voltage sag during HS on-time")
        if droop <= 0:
            self.audit_log.append("[Bootstrap] WARNING: Bootstrap droop cannot be 0 or negative. Using 0.5V default.")
            droop = 0.5
        c_boot   = qg / droop          # exact required capacitance (Farads)
        c_boot_nf= c_boot * 1e9

        # Snap to nearest E12 standard cap value (nF), with safety margin
        boot_margin_mult = self._dc("boot.safety_margin")
        c_boot_with_margin = c_boot_nf * boot_margin_mult
        E12_nF = [1,1.2,1.5,1.8,2.2,2.7,3.3,3.9,4.7,5.6,6.8,8.2,
                  10,12,15,18,22,27,33,39,47,56,68,82,
                  100,120,150,180,220,270,330,470,680,1000]
        c_std_nf = float(next((v for v in E12_nF if v >= c_boot_with_margin), E12_nF[-1]))
        boot_min_cap = self._dc("boot.min_cap")
        c_std_nf = max(boot_min_cap, c_std_nf)
        self._log_hc("bootstrap_cap", "Min practical boot cap", f"{boot_min_cap} nF", "Floor for bootstrap capacitor value", "boot.min_cap")
        self._log_hc("bootstrap_cap", "Safety margin", f"{boot_margin_mult}x", f"C_boot multiplied by {boot_margin_mult}x before E12 snap", "boot.safety_margin")

        # Bootstrap diode Vf
        vf_diode = self._dc("gate.bootstrap_vf")
        self._log_hc("bootstrap_cap", "Schottky diode Vf", f"{vf_diode} V", "Assumed forward drop for bootstrap diode", "gate.bootstrap_vf")
        v_boot   = vdrv - vf_diode

        # Minimum high-side on-time to refresh bootstrap
        # C_boot must recharge through R_boot(10Ω) from supply
        r_boot   = self._dc("gate.rg_bootstrap")
        self.audit_log.append(f"[Bootstrap] Series bootstrap resistor = {r_boot}Ω.")
        self._log_hc("bootstrap_cap", "Series boot resistor", f"{r_boot} Ω", "Limits peak charging current", "gate.rg_bootstrap")
        tau_boot = r_boot * c_std_nf * 1e-9   # RC time constant
        t_min_on_ns = 3 * tau_boot * 1e9       # 3τ to charge to ~95%

        # Bootstrap leakage budget
        # Try extracting Idd(quiescent) from driver datasheet, plus physical gate leakage (~1µA)
        # Driver quiescent current is often the primary leakage path for the bootstrap cap
        idd_q_raw = self._get(self.driver, "DRIVER", "idd_quiescent", None)
        if hasattr(self, 'audit_log') and getattr(self, 'audit_log', None) is not None:
            pass # safe
            
        if idd_q_raw is not None and idd_q_raw > 0:
            driver_ua = idd_q_raw * 1e6  # convert from A to µA
            i_leakage_ua = driver_ua + 1.0  # +1µA for MOSFET gate limit
            self.audit_log.append(f"[Bootstrap] Computed leakage ({i_leakage_ua:.1f}µA) using driver quiescent current ({driver_ua:.1f}µA) + 1µA FET gate leakage.")
        else:
            i_leakage_ua = 3.0
            self.audit_log.append("[Bootstrap] WARNING: Driver Quiescent Current missing. Assumed 3µA standard default for bootstrap leakage.")

        # Time until droop = C_boot × ΔV / I_leak
        t_hold_ms = (c_std_nf * 1e-9 * droop / (i_leakage_ua * 1e-6)) * 1000

        return {
            "c_boot_calculated_nf":     round(c_boot_nf,    1),
            "c_boot_recommended_nf":    c_std_nf,
            "c_boot_v_rating_v":        25,
            "c_boot_dielectric":        "X7R MLCC",
            "c_boot_qty":               3,
            "v_bootstrap_v":            round(v_boot,       2),
            "bootstrap_diode":          "B0540W (40V/500mA Schottky)",
            "r_boot_series_ohm":        r_boot,
            "min_hs_on_time_ns":        round(t_min_on_ns,  1),
            "bootstrap_hold_time_ms":   round(t_hold_ms,    1),
            "notes": {
                "100pct_duty":   "100% duty cycle requires external charge pump or VCC regulator",
                "refresh":       f"High-side must turn ON ≥ {round(t_min_on_ns,0):.0f}ns per PWM cycle",
                "derating":      "Use 25V cap at 12V drive — only 50% voltage derating",
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
        td_off_s  = self._get(self.mosfet, "MOSFET", "td_off",       50e-9) or 50e-9   # seconds
        tf_s      = self._get(self.mosfet, "MOSFET", "tf",            20e-9) or 20e-9   # seconds
        t_prop_s  = self._get(self.driver, "DRIVER", "prop_delay_off", 60e-9) or 60e-9  # seconds
        t_drv_s   = self._get(self.driver, "DRIVER", "prop_delay_on",  60e-9) or 60e-9  # seconds

        # Body diode parameters (from MOSFET datasheet)
        body_diode_vf = self._get(self.mosfet, "MOSFET", "body_diode_vf", 0.7)  # V
        trr_s         = self._get(self.mosfet, "MOSFET", "trr", None)            # s or None

        # Driver output transition times (from driver datasheet)
        drv_rise_s = self._get(self.driver, "DRIVER", "rise_time_out", None)  # s or None
        drv_fall_s = self._get(self.driver, "DRIVER", "fall_time_out", None)  # s or None

        # Convert to nanoseconds for readable arithmetic
        td_off_ns = td_off_s * 1e9
        tf_ns     = tf_s     * 1e9
        t_prop_ns = t_prop_s * 1e9

        # Include driver output fall time in dead-time budget if available
        # (driver fall time adds to turn-off propagation)
        drv_fall_ns = drv_fall_s * 1e9 if drv_fall_s is not None else 0

        # Minimum: td_off + tf + propagation + driver_fall + margin
        dt_abs_margin = self._dc("dt.abs_margin")
        dt_safety_mult = self._dc("dt.safety_mult")
        dt_min    = td_off_ns + tf_ns + t_prop_ns + drv_fall_ns + dt_abs_margin   # ns
        dt_rec    = round(dt_min * dt_safety_mult)                  # ns

        self.audit_log.append(f"[Dead Time] Added {dt_abs_margin}ns absolute margin and {dt_safety_mult}x safety margin to switching times.")
        self._log_hc("dead_time", "Absolute margin", f"{dt_abs_margin} ns", "Baseline safety margin added to minimum", "dt.abs_margin")
        self._log_hc("dead_time", "Safety multiplier", f"{dt_safety_mult}x", "Recommended margin over minimum dead time", "dt.safety_mult")
        if drv_fall_ns > 0:
            self.audit_log.append(f"[Dead Time] Included driver output fall time ({drv_fall_ns:.1f}ns) in dead-time budget.")

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
            "dt_minimum_ns":          round(dt_min,       1),
            "dt_recommended_ns":      round(dt_rec,       1),
            "dt_register_count":      dt_reg,
            "dt_actual_ns":           round(dt_actual,    1),
            "dt_pct_of_period":       round(dt_pct,       3),
            "switching_period_ns":    round(period_ns,    1),
            "effective_duty_loss_pct":round(duty_loss_pct,3),
            "dt_feasible":            dt_feasible,
            "dt_max_ns":              round(dt_max_ns,    1),
            "td_off_ns":              round(td_off_ns,    1),
            "tf_ns":                  round(tf_ns,        1),
            "prop_delay_off_ns":      round(t_prop_ns,    1),
            "dt_resolution_ns":       round(dt_res_ns,    2),
            "body_diode_vf_v":        round(body_diode_vf, 2),
            "body_diode_loss_per_leg_w": round(p_body_diode_per_leg, 3),
            "body_diode_loss_total_w":   round(p_body_diode_total, 3),
            "notes": {
                "foc":       "Dead-time compensation required in firmware for accurate FOC below ~10% mod index",
                "6step":     "6-step commutation: enforce same dead-time at each commutation event",
                "comp_algo": "Voltage feed-forward or current-sign-based dead-time compensation",
            },
            "_meta": self._module_meta.get("dead_time", {"hardcoded": [], "fallbacks": []}),
        }

        if drv_fall_ns > 0:
            result["driver_fall_time_ns"] = round(drv_fall_ns, 1)
        if trr_s is not None:
            result["trr_ns"] = round(trr_s * 1e9, 1)
        if trr_warning:
            result["trr_warning"] = trr_warning

        return result

    # ═══════════════════════════════════════════════════════════════════
    # 12. PCB Guidelines
    # ═══════════════════════════════════════════════════════════════════

