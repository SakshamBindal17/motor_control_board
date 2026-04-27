"""Motor Controller Hardware Design — Mosfet Calculations"""
import math
import re

class MosfetMixin:
    """Mixin providing calculations for: mosfet_losses, mosfet_rating_check, driver_compatibility."""

    # ═══════════════════════════════════════════════════════════════════
    def calc_mosfet_losses(self) -> dict:
        if "mosfet_losses" in self._cached_results:
            return self._cached_results["mosfet_losses"]
        self._current_module = "mosfet_losses"
        # _get now returns SI values (Ω, C, s) automatically via unit_utils
        # fallbacks are SI values too
        rds       = self._get(self.mosfet, "MOSFET", "rds_on",  1.5e-3)   # Ω
        qg        = self._get(self.mosfet, "MOSFET", "qg",      92e-9)    # C
        qgd       = self._get(self.mosfet, "MOSFET", "qgd",     30e-9)    # C
        # Get datasheet testing switching times as fallback
        tr_ds     = self._get(self.mosfet, "MOSFET", "tr",       30e-9)   # s
        tf_ds     = self._get(self.mosfet, "MOSFET", "tf",       20e-9)   # s
        
        # Pull actual circuit switching times from gate drive physics based on user's Rg
        gate_res  = self._cached_results.get("gate_resistors", {})
        tr_ns     = gate_res.get("hs_gate_rise_time_ns", gate_res.get("gate_rise_time_ns", tr_ds * 1e9))
        tf_ns     = gate_res.get("hs_gate_fall_time_ns", gate_res.get("gate_fall_time_ns", tf_ds * 1e9))
        tr        = tr_ns * 1e-9
        tf        = tf_ns * 1e-9
        
        rth_jc    = self._get(self.mosfet, "MOSFET", "rth_jc",   0.5)     # °C/W
        qrr       = self._get(self.mosfet, "MOSFET", "qrr",      44e-9)   # C

        # Additional params from datasheet (Section A: extracted but previously unused)
        vgs_plateau = self._get(self.mosfet, "MOSFET", "vgs_plateau", None)  # V
        body_diode_vf = self._get(self.mosfet, "MOSFET", "body_diode_vf", 0.7)  # V
        trr_s     = self._get(self.mosfet, "MOSFET", "trr", None)  # s
        ciss      = self._get(self.mosfet, "MOSFET", "ciss", None)  # F
        crss      = self._get(self.mosfet, "MOSFET", "crss", None)  # F

        # Display units for notes
        rds_mohm  = rds  * 1e3
        qg_nc     = qg   * 1e9
        qrr_nc    = qrr  * 1e9
        # ─── RMS switch current ───────────────────────────────────────
        # If motor Lph is available, refine with actual current ripple
        lph_uh = (self.motor or {}).get("lph_uh", "")
        try:
            lph = float(lph_uh) * 1e-6 if lph_uh not in ("", None) else 0.0
        except (TypeError, ValueError):
            lph = 0.0

        # Parallel MOSFET count per switch position (upper or lower device in each limb).
        # num_fets=6 means 1x parallel, 12 means 2x, etc.
        n_parallel = max(1.0, float(self.num_fets) / 6.0)
        i_max_dev = self.i_max / n_parallel

        # 3-phase SPWM per-switch RMS (Mohan textbook):
        # I_sw_rms = I_peak × sqrt(1/8 + M/(3π)), M = modulation index ≈ 0.9
        # This formula ALREADY accounts for duty-cycle weighting — do NOT divide by 2 again
        M_spwm = self._dc("input.spwm_mod_index")
        k_rms = math.sqrt(1/8 + M_spwm / (3 * math.pi))

        # Always compute fundamental-only RMS
        i_fund_rms = self.i_max * k_rms

        ripple_warning = None
        if lph > 0:
            # With known Lph, calculate peak-to-peak current ripple
            # ΔI = V_bus / (4 × Lph × f_sw) — worst-case at D=0.5 (low speed / stall)
            delta_i = (self.v_bus * 0.25) / (lph * self.fsw)  # ΔI at D=0.5
            i_ripple_rms = delta_i / (2 * math.sqrt(3))  # triangular wave RMS
            ripple_ratio = delta_i / self.i_max if self.i_max > 0 else 0
            
            # ── CORRECT RIPPLE WEIGHTING ──
            # Ripple flows through top or bottom switch depending on PWM state.
            # On average across the fundamental cycle, the ripple current is shared
            # 50/50 between the high-side and low-side FETs in the phase leg.
            # Therefore, the effective (RMS) ripple passing through ONE switch is I_ripple / √2.
            i_ripple_sw_rms = i_ripple_rms / math.sqrt(2.0)

            # Total Switch RMS includes both uncorrelated frequencies: I_rms² = I_fund² + I_ripple²
            i_rms_sw = math.sqrt(i_fund_rms**2 + i_ripple_sw_rms**2)
            rms_method = (
                f"Lph={float(lph_uh):.1f}µH — fund={i_fund_rms:.1f}A + ripple_sw={i_ripple_sw_rms:.1f}A "
                f"(ΔI={delta_i:.1f}A, {ripple_ratio*100:.0f}% of I_load, M={M_spwm})"
            )

            # Flag high-ripple designs
            if ripple_ratio > 0.30:
                ripple_warning = (
                    f"⚠ HIGH RIPPLE: ΔI_pp={delta_i:.1f}A is {ripple_ratio*100:.0f}% of I_load={self.i_max}A. "
                    f"This is a worst-case (stall/low-speed) estimate. At rated speed, back-EMF reduces "
                    f"effective ripple significantly. Consider: (1) verify Lph value, "
                    f"(2) increase f_sw, (3) check if motor back-EMF reduces actual ripple."
                )
                self.audit_log.append(f"[MOSFET] WARNING: Ripple current ΔI={delta_i:.1f}A is {ripple_ratio*100:.0f}% of I_load — very high for motor drive.")
        else:
            i_ripple_rms = 0.0
            delta_i = 0.0
            # Standard 3-ph SPWM approximation (no ripple info)
            i_rms_sw = i_fund_rms
            rms_method = f"3-ph SPWM (Mohan, M={M_spwm}), no Lph for ripple"

        i_rms_sw_dev = i_rms_sw / n_parallel

        # ─── Conduction loss with temperature-dependent Rds(on) derating ──
        # Silicon MOSFET Rds(on) scales roughly as (Tj/Tref)^α where α ≈ 2.0-2.3
        # We iterate: guess Tj → compute Rds(Tj) → compute loss → new Tj → converge
        rds_derating_override = self._dc("thermal.rds_derating")
        rth_cs_val = self._dc("thermal.rth_cs")
        rth_sa_val = self._effective_rth_sa()
        rth_total = rth_jc + rth_cs_val + rth_sa_val

        # Check if user manually overrode the derating (non-default value)
        user_overrode_derating = "thermal.rds_derating" in (self.design_constants or {})

        if user_overrode_derating:
            # Respect user's explicit override
            rds_derating = rds_derating_override
            rds_hot = rds * rds_derating
            tj_for_rds = 25 + (rds_derating - 1) * 50  # rough estimate of what Tj this corresponds to
            self.audit_log.append(f"[MOSFET] User-overridden Rds(on) derating: {rds_derating}x.")
        else:
            # Iterative Tj-dependent derating (user-overridable: Si≈2.1, SiC≈0.4)
            alpha_rds = self._dc("thermal.rds_alpha")
            t_ref = 300.0  # 27°C in Kelvin (datasheet Rds(on) reference)
            tj_est = 100.0  # initial guess in °C
            tj_iters = 0
            for _ in range(20):
                tj_iters += 1
                rds_derating = (((tj_est + 273.15) / t_ref) ** alpha_rds)
                rds_hot = rds * rds_derating
                # Power ∝ I² — if current splits N ways, per-device power drops by N².
                p_cond_est_dev = i_rms_sw_dev ** 2 * rds_hot
                p_other_est_dev = (self.v_bus * self.i_max * (tr + tf) * self.fsw / math.pi + qg * self.v_drv * self.fsw + qrr * self.v_bus * self.fsw) / n_parallel
                p_total_est_dev = p_cond_est_dev + p_other_est_dev
                tj_new = self.t_amb + p_total_est_dev * rth_total
                if tj_new > 500: tj_new = 500  # cap prevents divergence for impossible designs
                if abs(tj_new - tj_est) < 0.1:
                    tj_est = tj_new
                    break
                tj_est = tj_new
            else:
                self.audit_log.append(
                    f"[MOSFET] WARNING: Tj iteration did not converge in 20 iterations "
                    f"(Tj={tj_est:.1f}°C). Possible thermal runaway — verify heatsinking."
                )
            rds_derating = round(rds_derating, 3)
            tj_for_rds = round(tj_est, 1)
            self.audit_log.append(
                f"[MOSFET] Iterative Rds(on) derating: {rds_derating}x at estimated Tj={tj_for_rds}°C "
                f"(α={alpha_rds}, Tref={t_ref-273.15:.0f}°C, converged in {tj_iters} iterations). "
                f"Override via design constant 'thermal.rds_derating'."
            )

        _alpha_label = "User override" if user_overrode_derating else f"Iterative model at Tj≈{tj_for_rds}°C (α={alpha_rds})"
        self._log_hc("mosfet_losses", "Rds(on) thermal derating", f"{rds_derating}x", _alpha_label, "thermal.rds_derating")
        # P_cond(per-device) = I_device_rms² × Rds(on)
        p_cond  = i_rms_sw_dev**2 * rds_hot

        # ─── Temperature Derating for Switching Parameters ───
        # Switching charges increase with temperature (Vth drop, carrier mobility)
        qrr_coeff = self._dc("waveform.qrr_temp_coeff")
        qgd_coeff = self._dc("waveform.qgd_temp_coeff")
        tj_rise = max(0, tj_for_rds - 25.0)
        qrr_hot = qrr * (1.0 + qrr_coeff * tj_rise)
        qgd_hot = qgd * (1.0 + qgd_coeff * tj_rise)

        # ─── Switching loss — use actual Rg from gate_resistors if available ───
        rg_int = self._get(self.mosfet, "MOSFET", "rg_int", None)  # Ω
        io_src = self._get(self.driver, "DRIVER", "io_source", None)  # A
        io_snk = self._get(self.driver, "DRIVER", "io_sink", None)    # A

        # Sinusoidal averaging factor: over a half-cycle, avg(sin θ) = 2/π
        sin_avg = 2.0 / math.pi

        if vgs_plateau is not None and qgd_hot > 0 and rg_int is not None:
            # ─── Qgd-based switching loss (most accurate) ───
            # Try to use actual calculated Rg from gate_resistors module
            try:
                gr = self.calc_gate_resistors()
                self._current_module = "mosfet_losses"  # restore after subroutine
                rg_on_ext = gr.get("rg_on_recommended_ohm", None)
                rg_off_ext = gr.get("rg_off_recommended_ohm", None)
                rg_source = "gate_resistors module"
            except Exception:
                rg_on_ext = None
                rg_off_ext = None
                rg_source = None

            if rg_on_ext is not None and rg_off_ext is not None:
                # Use actual calculated gate resistors
                rg_total_on = rg_int + rg_on_ext
                rg_total_off = rg_int + rg_off_ext
                self.audit_log.append(
                    f"[MOSFET] Using calculated Rg from gate_resistors: "
                    f"Rg_on={rg_on_ext}Ω + Rg_int={rg_int:.1f}Ω = {rg_total_on:.2f}Ω, "
                    f"Rg_off={rg_off_ext}Ω + Rg_int={rg_int:.1f}Ω = {rg_total_off:.2f}Ω."
                )
            else:
                # Fallback: estimate from rise-time target
                rg_ext_est = max(1.0, self._dc("gate.rise_time_target") * 1e-9 * (self.v_drv - vgs_plateau) / qgd_hot if qgd_hot > 0 else 2.0)
                rg_total_on = rg_int + rg_ext_est
                rg_total_off = rg_total_on  # symmetric fallback
                rg_source = f"estimated (40ns rise target → Rg_ext={rg_ext_est:.1f}Ω)"
                self.audit_log.append(
                    f"[MOSFET] Gate resistors not available, using estimated Rg_ext={rg_ext_est:.1f}Ω "
                    f"from {self._dc('gate.rise_time_target')}ns rise-time target."
                )

            # Gate current during Miller plateau — CLAMPED to driver capability
            i_gate_on_ideal = (self.v_drv - vgs_plateau) / rg_total_on
            i_gate_off_ideal = vgs_plateau / rg_total_off

            # Driver current limiting: gate current cannot exceed source/sink capability
            driver_limited = False
            if io_src is not None and i_gate_on_ideal > io_src:
                i_gate_on = io_src
                driver_limited = True
                self.audit_log.append(
                    f"[MOSFET] Turn-on gate current clamped by driver: "
                    f"ideal={i_gate_on_ideal:.2f}A > io_source={io_src:.2f}A."
                )
            else:
                i_gate_on = i_gate_on_ideal

            if io_snk is not None and i_gate_off_ideal > io_snk:
                i_gate_off = io_snk
                driver_limited = True
                self.audit_log.append(
                    f"[MOSFET] Turn-off gate current clamped by driver: "
                    f"ideal={i_gate_off_ideal:.2f}A > io_sink={io_snk:.2f}A."
                )
            else:
                i_gate_off = i_gate_off_ideal

            # Voltage transition time during Miller plateau
            t_miller_on = qgd_hot / i_gate_on if i_gate_on > 0 else tr
            t_miller_off = qgd_hot / i_gate_off if i_gate_off > 0 else tf

            # Sinusoidally-averaged switching energy: E = 0.5 × V × I_avg × t
            e_on = 0.5 * self.v_bus * i_max_dev * sin_avg * t_miller_on
            e_off = 0.5 * self.v_bus * i_max_dev * sin_avg * t_miller_off
            p_sw = (e_on + e_off) * self.fsw

            # Also compute overlap model for comparison
            p_sw_overlap = self.v_bus * i_max_dev * (tr + tf) * self.fsw / math.pi
            sw_method = (
                f"Qgd-based ({rg_source}): Vplateau={vgs_plateau:.1f}V, "
                f"Rg_on_total={rg_total_on:.2f}Ω, Rg_off_total={rg_total_off:.2f}Ω, "
                f"Ig_on={i_gate_on:.2f}A{'(driver-limited)' if driver_limited else ''}, "
                f"t_miller_on={t_miller_on*1e9:.1f}ns, t_miller_off={t_miller_off*1e9:.1f}ns. "
                f"Overlap model: {p_sw_overlap:.3f}W"
            )
            self.audit_log.append(
                f"[MOSFET] Qgd switching loss (derated to {tj_for_rds}°C): "
                f"Ig_on={i_gate_on:.2f}A, Ig_off={i_gate_off:.2f}A, "
                f"t_miller_on={t_miller_on*1e9:.1f}ns, t_miller_off={t_miller_off*1e9:.1f}ns. "
                f"P_sw={p_sw:.3f}W vs overlap={p_sw_overlap:.3f}W."
            )
        else:
            # ─── Standard overlap model (sinusoidally averaged) ───
            # P_sw = V_bus × I_peak × (tr + tf) × fsw / π
            p_sw = self.v_bus * i_max_dev * (tr + tf) * self.fsw / math.pi
            sw_method = "overlap model, sin-averaged (Vgs_plateau or Rg_int not available)"
            driver_limited = False

        # ─── Reverse recovery loss ────────────────────────────────────
        # Body diode recovers against V_bus (not peak with transients)
        p_rr = qrr_hot * self.v_bus * self.fsw
        
        self.audit_log.append(
            f"[MOSFET] Qrr temperature derating: raw Qrr={qrr*1e9:.0f}nC, "
            f"hot Qrr({tj_for_rds}°C)={qrr_hot*1e9:.0f}nC (+{qrr_coeff*100}%/°C). "
            f"P_rr = {p_rr:.3f}W."
        )

        # ─── Gate drive charge loss ───────────────────────────────────
        p_gate = qg * self.v_drv * self.fsw

        # ─── Output capacitance loss (Coss/Qoss) ─────────────────────
        # Coss energy is stored at turn-off (from bus), dissipated at turn-on → 1 event/cycle
        # E_oss ≈ 0.5 × Qoss × V_bus (charge-equivalent for nonlinear Coss)
        qoss = self._get(self.mosfet, "MOSFET", "qoss", None)  # C
        if qoss is not None:
            p_coss_per_fet = 0.5 * qoss * self.v_bus * self.fsw
            self.audit_log.append(f"[MOSFET] Coss: Qoss={qoss*1e9:.0f}nC, E_oss=0.5*Qoss*Vbus, 1 event/cycle → {p_coss_per_fet:.4f}W.")
        else:
            p_coss_per_fet = 0

        # ─── Dead-time body diode conduction loss (per FET) ───────────
        # During dead time, load current flows through body diode of the complementary FET.
        # Per phase leg: P = Vf × I × dt × fsw × 2 (two dead-time intervals per cycle)
        # Sinusoidal average of |I(θ)| over a cycle = I_peak × 2/π
        # Per FET (half the leg): divide by 2
        # Net: P_body_per_FET = Vf × I_peak × (2/π) × dt × fsw
        dt_ns = float(self.ovr.get("dead_time_ns", 200))  # ns, default 200ns
        try:
            dt_module = self.calc_dead_time()
            self._current_module = "mosfet_losses"  # restore
            dt_ns = dt_module.get("dt_actual_ns", dt_ns)
        except Exception:
            pass
        dt_s = dt_ns * 1e-9
        # Two dead-time events per PWM cycle, sin-averaged current, per FET = half a leg
        p_body_diode = body_diode_vf * i_max_dev * sin_avg * dt_s * self.fsw * 2 / 2
        self.audit_log.append(
            f"[MOSFET] Body diode loss: Vf={body_diode_vf:.1f}V × I_avg × "
            f"dt={dt_ns:.0f}ns × fsw × 2 events / 2 FETs = {p_body_diode:.3f}W/FET."
        )

        # ─── Total loss per FET ───────────────────────────────────────
        p_total_1 = p_cond + p_sw + p_rr + p_gate + p_coss_per_fet + p_body_diode
        p_total_6 = p_total_1 * self.num_fets

        # Junction temp estimate — use cooling-method-aware Rth_SA (consistent with thermal module)
        rth_cs_val = self._dc("thermal.rth_cs")
        rth_sa_val = self._effective_rth_sa()
        t_junc = self.t_amb + p_total_1 * (rth_jc + rth_cs_val + rth_sa_val)
        self.audit_log.append(f"[Thermal] Used TIM: {rth_cs_val}°C/W, PCB-to-ambient: {rth_sa_val}°C/W.")
        self._log_hc("mosfet_losses", "TIM resistance (Rth_CS)", f"{rth_cs_val} °C/W", "Thermal interface material between case and PCB", "thermal.rth_cs")
        self._log_hc("mosfet_losses", "PCB thermal resistance (Rth_SA)", f"{rth_sa_val} °C/W",
                      f"From cooling method selection (see thermal module)", "thermal.rth_sa")

        # Inverter switching losses only (excludes motor copper/core losses)
        eff = 0 if self.power == 0 else max(0, (1 - p_total_6 / self.power) * 100)

        result = {
            "conduction_loss_per_fet_w":  round(p_cond,    3),
            "switching_loss_per_fet_w":   round(p_sw,      3),
            "recovery_loss_per_fet_w":    round(p_rr,      3),
            "gate_charge_loss_per_fet_w": round(p_gate,    4),
            "coss_loss_per_fet_w":        round(p_coss_per_fet, 4),
            "body_diode_loss_per_fet_w":  round(p_body_diode, 3),
            "total_loss_per_fet_w":       round(p_total_1, 3),
            "total_all_fets_w":           round(p_total_6, 3),
            "total_all_6_fets_w":         round(p_total_6, 3),  # backward compat
            "num_fets":                   self.num_fets,
            "i_rms_switch_a":             round(i_rms_sw,  2),
            "i_rms_per_device_a":         round(i_rms_sw_dev, 2),
            "i_rms_fundamental_a":        round(i_fund_rms, 2),
            "i_rms_ripple_a":             round(i_ripple_rms, 2) if lph > 0 else None,
            "ripple_delta_i_a":           round(delta_i, 1) if lph > 0 else None,
            "parallel_per_switch":        round(n_parallel, 3),
            "rds_on_derated_mohm":        round(rds_mohm*rds_derating, 3),
            "junction_temp_est_c":        round(t_junc,    1),
            "efficiency_mosfet_pct":      round(eff,       2),
            "dead_time_used_ns":          round(dt_ns, 1),
            "notes": {
                "rds_basis":    f"Rds(on)={rds_mohm}mΩ × {rds_derating} temp derating",
                "irms_method":  f"I_rms(total switch)={round(i_rms_sw,2)}A, I_rms/device={round(i_rms_sw_dev,2)}A (N={round(n_parallel,3)}) — {rms_method}",
                "sw_basis":     f"tr={tr_ns}ns, tf={tf_ns}ns @ fsw={self.fsw/1e3:.0f}kHz, Vbus={self.v_bus}V — {sw_method}",
                "rr_basis":     f"Qrr={qrr_nc}nC × Vbus × fsw",
                "coss_basis":   f"Qoss={'%.0f' % (qoss*1e9) if qoss else 'N/A'}nC — {'from datasheet' if qoss else 'not extracted'}",
                "body_diode":   f"Vf={body_diode_vf:.1f}V, dt={dt_ns:.0f}ns, 2 events/cycle",
                "improvement":  "Increase fsw reduces motor ripple but increases switching losses",
            },
            "_meta": self._module_meta.get("mosfet_losses", {"hardcoded": [], "fallbacks": []}),
        }

        # Add warnings
        if ripple_warning:
            result["ripple_warning"] = ripple_warning
        if driver_limited:
            result["driver_current_limited"] = True

        # Add extracted-but-informational parameters
        if vgs_plateau is not None:
            result["vgs_plateau_v"] = round(vgs_plateau, 2)
        if body_diode_vf is not None:
            result["body_diode_vf_v"] = round(body_diode_vf, 2)
        if ciss is not None:
            result["ciss_pf"] = round(ciss * 1e12, 0)
        if crss is not None:
            result["crss_pf"] = round(crss * 1e12, 0)

        self._cached_results["mosfet_losses"] = result
        return result

    # ═══════════════════════════════════════════════════════════════════
    # 2. Gate Resistors
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_mosfet_rating_check(self) -> dict:
        """Validate that the selected MOSFET can handle system voltage and current."""
        self._current_module = "mosfet_rating_check"
        vds_max = self._get(self.mosfet, "MOSFET", "vds_max", None)
        id_cont = self._get(self.mosfet, "MOSFET", "id_cont", None)

        warnings = []
        results = {}

        # ── Voltage rating check ──
        if vds_max is not None:
            v_margin_pct = ((vds_max - self.v_peak) / vds_max) * 100 if vds_max > 0 else 0
            results["vds_max_v"] = round(vds_max, 1)
            results["v_peak_v"] = self.v_peak
            results["voltage_margin_pct"] = round(v_margin_pct, 1)
            results["voltage_ok"] = vds_max >= self.v_peak * 1.2

            if vds_max < self.v_peak:
                warnings.append(
                    f"DANGER: Vds_max ({vds_max}V) < V_peak ({self.v_peak}V). "
                    f"MOSFET WILL FAIL under normal operation. Choose a higher-voltage part."
                )
                self.audit_log.append(f"[MOSFET Rating] DANGER: Vds_max ({vds_max}V) is below bus peak voltage ({self.v_peak}V).")
            elif vds_max < self.v_peak * 1.2:
                warnings.append(
                    f"WARNING: Vds_max ({vds_max}V) has < 20% margin over V_peak ({self.v_peak}V). "
                    f"Industry standard is ≥ 1.2× derating. Risk of avalanche breakdown with transients."
                )
                self.audit_log.append(f"[MOSFET Rating] WARNING: Vds_max margin is only {v_margin_pct:.0f}% (need ≥ 20%).")
            else:
                self.audit_log.append(f"[MOSFET Rating] Vds_max={vds_max}V vs V_peak={self.v_peak}V — OK ({v_margin_pct:.0f}% margin).")
        else:
            results["voltage_ok"] = None
            self.audit_log.append("[MOSFET Rating] Vds_max not extracted — cannot validate voltage rating.")

        # ── Current rating check (with 25% derating, matching voltage check rigor) ──
        if id_cont is not None:
            i_margin_pct = ((id_cont - self.i_max) / id_cont) * 100 if id_cont > 0 else 0
            results["id_cont_a"] = round(id_cont, 1)
            results["i_max_a"] = self.i_max
            results["current_margin_pct"] = round(i_margin_pct, 1)
            results["current_ok"] = id_cont >= self.i_max * 1.25  # 25% derating (Tc=25°C rating vs real PCB)

            if id_cont < self.i_max:
                warnings.append(
                    f"DANGER: Id_cont ({id_cont}A) < I_max ({self.i_max}A). "
                    f"MOSFET will overheat at maximum load. Choose a higher-current part or parallel MOSFETs."
                )
                self.audit_log.append(f"[MOSFET Rating] DANGER: Id_cont ({id_cont}A) < I_max ({self.i_max}A).")
            elif id_cont < self.i_max * 1.25:
                warnings.append(
                    f"WARNING: Id_cont ({id_cont}A) has < 25% margin over I_max ({self.i_max}A). "
                    f"Datasheet Id_cont is rated at Tc=25°C — on a real PCB, effective current "
                    f"capacity is significantly lower. Recommend ≥ 1.25× derating."
                )
                self.audit_log.append(f"[MOSFET Rating] WARNING: Id_cont margin is only {i_margin_pct:.0f}% (need ≥ 25%).")
            else:
                self.audit_log.append(f"[MOSFET Rating] Id_cont={id_cont}A vs I_max={self.i_max}A — OK ({i_margin_pct:.0f}% margin).")
        else:
            results["current_ok"] = None
            self.audit_log.append("[MOSFET Rating] Id_cont not extracted — cannot validate current rating.")

        # ── Avalanche Check (Inductive Kickback) ──
        eas_mj = self._get(self.mosfet, "MOSFET", "avalanche_energy", None)
        ias_a = self._get(self.mosfet, "MOSFET", "avalanche_current", None)
        
        # If IAS is missing, check if it's buried in the EAS test conditions
        if ias_a is None and eas_mj is not None:
            cond_text = self.mosfet.get("avalanche_energy__cond_text", "")
            match = re.search(r'(?:IAS|I_AS)\s*=\s*([\d\.]+)\s*A', cond_text, re.IGNORECASE)
            if match:
                ias_a = float(match.group(1))
                self.audit_log.append(f"[MOSFET Rating] Extracted Ias={ias_a}A from EAS test condition: {cond_text}")
        
        if ias_a is not None:
            # Option B: Datasheet
            results["ias_av_a"] = round(ias_a, 1)
            results["avalanche_energy_mj"] = round(eas_mj, 1) if eas_mj is not None else None
            results["ias_source"] = "📄 Datasheet"
        elif eas_mj is not None:
            # Option A: Formula with Motor Lph
            eas_j = eas_mj * 1e-3  # Convert mJ to Joules mathematically required by physics formula
            lph_uh = (self.motor or {}).get("lph_uh", "")
            try:
                lph = float(lph_uh) * 1e-6 if lph_uh not in ("", None) else None
            except (TypeError, ValueError):
                lph = None

            if lph is not None and lph <= 0:
                raise ValueError("Inductance must be greater than zero.")

            if lph is not None and lph > 0:
                vds_max_raw = self._get(self.mosfet, "MOSFET", "vds_max", None)
                v_bus_raw = self.sys.get("bus_voltage", 48)
                idm_a = self._get(self.mosfet, "MOSFET", "id_pulsed", None)
                
                vds_max = float(vds_max_raw) if vds_max_raw is not None else None
                v_bus = float(v_bus_raw) if v_bus_raw is not None else None

                if vds_max is not None and v_bus is not None and v_bus >= vds_max:
                    self.audit_log.append("[MOSFET Rating] Bus voltage >= Vds max. Avalanche physics invalid.")
                    results["ias_av_a"] = None
                    results["avalanche_energy_mj"] = round(eas_mj, 1)
                    results["ias_source"] = "⚠️ Disabled (Vbus >= Vds limit)"
                    warnings.append("WARNING: Bus voltage is too close to Vds breakdown to safely calculate avalanche physics.")
                else:
                    if vds_max is not None and v_bus is not None:
                        # Voltage-Corrected Formula
                        calc_ias = math.sqrt( (2 * eas_j * (vds_max - v_bus)) / (lph * vds_max) )
                        calc_note = f"Estimated at {calc_ias:.1f}A using motor Lph ({lph_uh}µH) and Voltage-Correction."
                    else:
                        # Fallback to Simple Formula if Voltage is missing
                        calc_ias = math.sqrt(2 * eas_j / lph)
                        calc_note = f"Estimated at {calc_ias:.1f}A using motor Lph ({lph_uh}µH)."

                    # Clamp at Idm if extracted
                    if idm_a is not None:
                        idm_f = float(idm_a)
                        if calc_ias > idm_f:
                            calc_ias = idm_f
                            calc_note = f"Estimate exceeded Pulsed Drain Current. Hard-clamped to {idm_f}A."

                    results["ias_av_a"] = round(calc_ias, 1)
                    results["avalanche_energy_mj"] = round(eas_mj, 1)
                    results["ias_source"] = "✨ Estimated"
                    results.setdefault("notes", {})["avalanche"] = f"Avalanche Current (Ias) missing. {calc_note}"
            else:
                self.audit_log.append("[MOSFET Rating] Avalanche current estimate disabled: missing Motor Lph.")
                results["ias_av_a"] = None
                results["avalanche_energy_mj"] = round(eas_mj, 1)
                results["ias_source"] = "⚠️ Disabled (Missing Lph)"
                warnings.append("NOTICE: Avalanche rating disabled. Enter 'Lph' (Motor Phase Inductance) in the Motor tab to estimate it.")
        else:
            self.audit_log.append("[MOSFET Rating] Avalanche energy/current not extracted.")
            results["ias_av_a"] = None
            results["avalanche_energy_mj"] = None
            results["ias_source"] = None

        if results.get("ias_av_a") is not None:
            ias_val = results["ias_av_a"]
            av_margin_pct = ((ias_val - self.i_max) / ias_val) * 100 if ias_val > 0 else 0
            results["avalanche_margin_pct"] = round(av_margin_pct, 1)
            
            if ias_val < self.i_max:
                warnings.append(
                    f"DANGER: Avalanche Current limit ({ias_val:.1f}A) < I_max ({self.i_max}A). "
                    f"MOSFET will fail under severe inductive kickback. Choose a more rugged MOSFET."
                )
                self.audit_log.append(f"[MOSFET Rating] DANGER: Avalanche Current ({ias_val:.1f}A) < I_max ({self.i_max}A).")
            elif ias_val < self.i_max * 1.25:
                warnings.append(
                    f"WARNING: Avalanche Current ({ias_val:.1f}A) has < 25% margin over I_max ({self.i_max}A). "
                    f"High risk of failure during motor faults or dead-time reverse recovery."
                )
                self.audit_log.append(f"[MOSFET Rating] WARNING: Avalanche margin is only {av_margin_pct:.0f}%.")
            else:
                self.audit_log.append(f"[MOSFET Rating] Avalanche Ias={ias_val:.1f}A vs I_max={self.i_max}A — OK ({av_margin_pct:.0f}% margin).")

        results["warnings"] = warnings
        results["_meta"] = self._module_meta.get("mosfet_rating_check", {"hardcoded": [], "fallbacks": []})
        return results

    # ═══════════════════════════════════════════════════════════════════
    # 15. Driver Compatibility Check
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_driver_compatibility(self) -> dict:
        """Validate gate driver is compatible with system specs and MCU."""
        self._current_module = "driver_compatibility"
        warnings = []
        results = {}

        # ── VCC range vs gate drive voltage ──
        vcc_range_raw = self.driver.get("vcc_range")
        if vcc_range_raw is not None:
            # vcc_range might be a string like "4.5-45" or a single value
            try:
                vcc_str = str(vcc_range_raw)
                if '-' in vcc_str or '–' in vcc_str or 'to' in vcc_str.lower():
                    parts = vcc_str.replace('–', '-').lower().replace('to', '-').split('-')
                    parts = [p.strip() for p in parts if p.strip()]
                    vcc_min = float(parts[0])
                    vcc_max = float(parts[-1]) if len(parts) > 1 else 100
                else:
                    vcc_min = float(vcc_str)
                    vcc_max = 100  # unknown max
                results["vcc_min_v"] = vcc_min
                results["vcc_max_v"] = vcc_max
                results["gate_drive_v"] = self.v_drv
                results["vcc_ok"] = vcc_min <= self.v_drv <= vcc_max

                if self.v_drv < vcc_min:
                    warnings.append(
                        f"DANGER: Gate drive voltage ({self.v_drv}V) < driver VCC_min ({vcc_min}V). "
                        f"Driver will not operate. Increase VCC supply."
                    )
                    self.audit_log.append(f"[Driver] DANGER: V_drv ({self.v_drv}V) below VCC min ({vcc_min}V).")
                elif self.v_drv > vcc_max:
                    warnings.append(
                        f"DANGER: Gate drive voltage ({self.v_drv}V) > driver VCC_max ({vcc_max}V). "
                        f"Driver will be damaged. Reduce VCC supply."
                    )
                else:
                    self.audit_log.append(f"[Driver] VCC range [{vcc_min}-{vcc_max}V] includes V_drv={self.v_drv}V — OK.")
            except (ValueError, IndexError):
                results["vcc_ok"] = None
                self.audit_log.append(f"[Driver] Could not parse VCC range '{vcc_range_raw}' — skipping VCC check.")
        else:
            results["vcc_ok"] = None
            self.audit_log.append("[Driver] VCC range not extracted — cannot validate supply compatibility.")

        # ── Bootstrap UVLO check ──
        uvlo_info = self._bootstrap_uvlo_info()
        vbs_uvlo = uvlo_info["value_v"]
        # Bootstrap voltage = Vdrv - diode_Vf
        boot_vf = self._dc("gate.bootstrap_vf")
        v_boot = self.v_drv - boot_vf
        self._log_hc("driver_compatibility", "Bootstrap diode Vf", f"{boot_vf} V", "Assumed Schottky diode forward drop", "gate.bootstrap_vf")
        results["v_bootstrap_v"] = round(v_boot, 2)
        results["vbs_uvlo_data_status"] = uvlo_info["status"]
        results["vbs_uvlo_data_trusted"] = uvlo_info["trusted"]
        results["vbs_uvlo_source_key"] = uvlo_info["source_key"]
        results["vbs_uvlo_data_note"] = uvlo_info["note"]

        if vbs_uvlo is not None and uvlo_info["trusted"]:
            results["vbs_uvlo_v"] = round(vbs_uvlo, 2)
            boot_margin = v_boot - vbs_uvlo
            results["bootstrap_margin_v"] = round(boot_margin, 2)
            results["bootstrap_ok"] = boot_margin > 0.5  # need > 0.5V margin

            if boot_margin <= 0:
                warnings.append(
                    f"DANGER: Bootstrap voltage ({v_boot:.1f}V) ≤ VBS_UVLO ({vbs_uvlo:.1f}V). "
                    f"High-side gate will NOT turn on. Increase VCC or use lower-Vf diode."
                )
                self.audit_log.append(f"[Driver] DANGER: Bootstrap voltage ({v_boot:.1f}V) ≤ UVLO ({vbs_uvlo:.1f}V).")
            elif boot_margin <= 0.5:
                warnings.append(
                    f"WARNING: Bootstrap margin is only {boot_margin:.1f}V (Vboot={v_boot:.1f}V, UVLO={vbs_uvlo:.1f}V). "
                    f"May UVLO during fast duty cycle transitions."
                )
            else:
                self.audit_log.append(f"[Driver] Bootstrap: Vboot={v_boot:.1f}V vs UVLO={vbs_uvlo:.1f}V — OK ({boot_margin:.1f}V margin).")
        elif vbs_uvlo is not None:
            results["vbs_uvlo_v"] = round(vbs_uvlo, 2)
            results["bootstrap_ok"] = None
            warnings.append(
                f"WARNING: Bootstrap UVLO extracted as {vbs_uvlo:.2f}V is marked suspicious. "
                "Bootstrap margin check is not trusted until datasheet extraction is confirmed."
            )
            self.audit_log.append(
                f"[Driver] WARNING: Bootstrap UVLO value {vbs_uvlo:.2f}V failed data-quality checks. "
                "Skipping trusted UVLO margin decision."
            )
        else:
            results["bootstrap_ok"] = None
            warnings.append(
                "WARNING: Bootstrap UVLO (vbs_uvlo) not extracted. Bootstrap UVLO margin cannot be validated."
            )
            self.audit_log.append("[Driver] VBS UVLO not extracted — cannot validate bootstrap margin.")

        # ── Logic level compatibility (MCU → Driver) ──
        vil = self._get(self.driver, "DRIVER", "vil", None)
        vih = self._get(self.driver, "DRIVER", "vih", None)
        vdd_mcu_raw = self.mcu.get("vdd_range") if self.mcu else None

        # Try to get MCU output voltage (assume 3.3V if not available)
        mcu_voh = 3.3  # default MCU output high
        if not vdd_mcu_raw:
            self._log_hc("driver_compatibility", "MCU output voltage", "3.3 V", "Assumed default when VDD range not available")
        if vdd_mcu_raw:
            try:
                vdd_str = str(vdd_mcu_raw)
                parts = vdd_str.replace('–', '-').lower().replace('to', '-').split('-')
                parts = [p.strip() for p in parts if p.strip()]
                mcu_voh = float(parts[-1]) if parts else 3.3
            except (ValueError, IndexError):
                mcu_voh = 3.3

        results["mcu_voh_v"] = mcu_voh

        if vih is not None:
            results["vih_v"] = round(vih, 2)
            results["logic_ok"] = mcu_voh >= vih

            if mcu_voh < vih:
                warnings.append(
                    f"WARNING: MCU output ({mcu_voh}V) may be below driver VIH ({vih}V). "
                    f"Add level shifter or verify open-drain with pullup to VCC."
                )
                self.audit_log.append(f"[Driver] WARNING: MCU Voh ({mcu_voh}V) < driver VIH ({vih}V) — logic level mismatch.")
            else:
                self.audit_log.append(f"[Driver] Logic levels: MCU Voh={mcu_voh}V ≥ VIH={vih}V — OK.")
        else:
            results["logic_ok"] = None
            self.audit_log.append("[Driver] VIH not extracted — cannot validate logic level compatibility.")

        if vil is not None:
            results["vil_v"] = round(vil, 2)

        results["warnings"] = warnings
        results["_meta"] = self._module_meta.get("driver_compatibility", {"hardcoded": [], "fallbacks": []})
        return results

    # ═══════════════════════════════════════════════════════════════════
    # 16. ADC Timing Validation
    # ═══════════════════════════════════════════════════════════════════

