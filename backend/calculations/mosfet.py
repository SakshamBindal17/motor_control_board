"""Motor Controller Hardware Design — Mosfet Calculations"""
import math


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
        tr        = self._get(self.mosfet, "MOSFET", "tr",       30e-9)   # s
        tf        = self._get(self.mosfet, "MOSFET", "tf",       20e-9)   # s
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
        tr_ns     = tr   * 1e9
        tf_ns     = tf   * 1e9

        # RMS switch current
        # If motor Lph is available, refine with actual current ripple
        lph_uh = (self.motor or {}).get("lph_uh", "")
        try:
            lph = float(lph_uh) * 1e-6 if lph_uh not in ("", None) else 0.0
        except (TypeError, ValueError):
            lph = 0.0

        if lph > 0:
            # With known Lph, calculate peak-to-peak current ripple
            delta_i = (self.v_bus * 0.25) / (lph * self.fsw)  # ΔI at D=0.5
            # RMS includes both fundamental + ripple: I_rms² = I_fund² + I_ripple²
            i_fund_rms = self.i_max * math.sqrt(1/6 + (math.sqrt(3)/(4*math.pi)))
            i_ripple_rms = delta_i / (2 * math.sqrt(3))  # ripple component
            i_rms_sw = math.sqrt(i_fund_rms**2 + i_ripple_rms**2)
            rms_method = f"Lph={float(lph_uh):.1f}µH (fund+ripple)"
        else:
            # Standard 3-ph SPWM approximation
            i_rms_sw = self.i_max * math.sqrt(1/6 + (math.sqrt(3)/(4*math.pi)))
            rms_method = "3-ph SPWM approximation"

        # Conduction loss with temp derating
        rds_derating = self._dc("thermal.rds_derating")
        rds_hot = rds * rds_derating
        self.audit_log.append(f"[MOSFET] Applied {rds_derating}x thermal multiplier for Rds(on) at estimated ~100°C junction.")
        self._log_hc("mosfet_losses", "Rds(on) thermal derating", f"{rds_derating}x", "Worst-case at ~100°C junction temperature", "thermal.rds_derating")
        p_cond  = i_rms_sw**2 * rds_hot

        # Switching loss — enhanced model using Miller plateau if available
        rg_int = self._get(self.mosfet, "MOSFET", "rg_int", None)  # Ω

        if vgs_plateau is not None and qgd > 0 and rg_int is not None:
            # ─── Qgd-based switching loss (more accurate) ───
            # During Miller plateau, Vgs is clamped at Vplateau.
            # Gate current during plateau: I_g = (Vdrv - Vplateau) / (Rg_int + Rg_ext)
            # Use Rg_ext from design constants target rise time, estimate ~2Ω typical
            rg_ext_est = max(1.0, self._dc("gate.rise_time_target") * 1e-9 * (self.v_drv - vgs_plateau) / qgd if qgd > 0 else 2.0)
            rg_total = rg_int + rg_ext_est

            # Gate current during Miller plateau
            i_gate_on = (self.v_drv - vgs_plateau) / rg_total
            i_gate_off = vgs_plateau / rg_total  # discharge through Rg to GND

            # Voltage transition time during Miller plateau
            t_miller_on = qgd / i_gate_on if i_gate_on > 0 else tr
            t_miller_off = qgd / i_gate_off if i_gate_off > 0 else tf

            # Switching energy per event: E = 0.5 × V × I × t_miller
            e_on = 0.5 * self.v_peak * self.i_max * t_miller_on
            e_off = 0.5 * self.v_peak * self.i_max * t_miller_off
            p_sw = (e_on + e_off) * self.fsw

            # Also compute overlap model for comparison
            p_sw_overlap = 0.5 * self.v_peak * self.i_max * (tr + tf) * self.fsw
            sw_method = (
                f"Qgd-based model (Vplateau={vgs_plateau:.1f}V, Rg_int={rg_int:.2f}Ω, "
                f"t_miller_on={t_miller_on*1e9:.1f}ns, t_miller_off={t_miller_off*1e9:.1f}ns). "
                f"Simple overlap model would give {p_sw_overlap:.3f}W"
            )
            self.audit_log.append(
                f"[MOSFET] Using Qgd-based switching loss: Vplateau={vgs_plateau:.1f}V, "
                f"Ig_on={i_gate_on:.2f}A, Ig_off={i_gate_off:.2f}A, "
                f"t_miller_on={t_miller_on*1e9:.1f}ns, t_miller_off={t_miller_off*1e9:.1f}ns. "
                f"P_sw={p_sw:.3f}W vs overlap={p_sw_overlap:.3f}W."
            )
        else:
            # ─── Standard overlap model ───
            p_sw = 0.5 * self.v_peak * self.i_max * (tr + tf) * self.fsw
            sw_method = "overlap model (Vgs_plateau or Rg_int not available)"

        # Reverse recovery loss
        p_rr = qrr * self.v_peak * self.fsw

        # Gate drive charge loss
        p_gate = qg * self.v_drv * self.fsw

        # Output capacitance loss (Coss/Qoss energy dissipated each cycle)
        qoss = self._get(self.mosfet, "MOSFET", "qoss", None)  # C
        if qoss is not None:
            # Eoss ≈ Qoss × Vds / 2 per switching event, 2 events per cycle per FET
            p_coss_per_fet = qoss * self.v_peak * self.fsw
            self.audit_log.append(f"[MOSFET] Using Qoss={qoss*1e9:.0f}nC from datasheet for output capacitance loss.")
        else:
            p_coss_per_fet = 0

        p_total_1 = p_cond + p_sw + p_rr + p_gate + p_coss_per_fet
        p_total_6 = p_total_1 * 6

        # Junction temp estimate
        rth_cs_val = self._dc("thermal.rth_cs")
        rth_sa_val = self._dc("thermal.rth_sa")
        t_junc = self.t_amb + p_total_1 * (rth_jc + rth_cs_val + rth_sa_val)
        self.audit_log.append(f"[Thermal] Used TIM: {rth_cs_val}°C/W, PCB-to-ambient: {rth_sa_val}°C/W.")
        self._log_hc("mosfet_losses", "TIM resistance (Rth_CS)", f"{rth_cs_val} °C/W", "Thermal interface material between case and PCB", "thermal.rth_cs")
        self._log_hc("mosfet_losses", "PCB thermal resistance (Rth_SA)", f"{rth_sa_val} °C/W", "Natural convection, no heatsink assumed", "thermal.rth_sa")

        # Inverter switching losses only (excludes motor copper/core losses)
        eff = 0 if self.power == 0 else max(0, (1 - p_total_6 / self.power) * 100)

        result = {
            "conduction_loss_per_fet_w":  round(p_cond,    3),
            "switching_loss_per_fet_w":   round(p_sw,      3),
            "recovery_loss_per_fet_w":    round(p_rr,      3),
            "gate_charge_loss_per_fet_w": round(p_gate,    4),
            "coss_loss_per_fet_w":        round(p_coss_per_fet, 4),
            "total_loss_per_fet_w":       round(p_total_1, 3),
            "total_all_6_fets_w":         round(p_total_6, 3),
            "i_rms_switch_a":             round(i_rms_sw,  2),
            "rds_on_derated_mohm":        round(rds_mohm*rds_derating, 3),
            "junction_temp_est_c":        round(t_junc,    1),
            "efficiency_mosfet_pct":      round(eff,       2),
            "notes": {
                "rds_basis":    f"Rds(on)={rds_mohm}mΩ × {rds_derating} temp derating",
                "irms_method":  f"I_rms={round(i_rms_sw,2)}A — {rms_method}",
                "sw_basis":     f"tr={tr_ns}ns, tf={tf_ns}ns @ fsw={self.fsw/1e3:.0f}kHz — {sw_method}",
                "rr_basis":     f"Qrr={qrr_nc}nC × Vbus × fsw",
                "coss_basis":   f"Qoss={'%.0f' % (qoss*1e9) if qoss else 'N/A'}nC — {'from datasheet' if qoss else 'not extracted'}",
                "improvement":  "Increase fsw reduces motor ripple but increases switching losses",
            },
            "_meta": self._module_meta.get("mosfet_losses", {"hardcoded": [], "fallbacks": []}),
        }

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

        # ── Current rating check ──
        if id_cont is not None:
            i_margin_pct = ((id_cont - self.i_max) / id_cont) * 100 if id_cont > 0 else 0
            results["id_cont_a"] = round(id_cont, 1)
            results["i_max_a"] = self.i_max
            results["current_margin_pct"] = round(i_margin_pct, 1)
            results["current_ok"] = id_cont >= self.i_max

            if id_cont < self.i_max:
                warnings.append(
                    f"DANGER: Id_cont ({id_cont}A) < I_max ({self.i_max}A). "
                    f"MOSFET will overheat at maximum load. Choose a higher-current part or parallel MOSFETs."
                )
                self.audit_log.append(f"[MOSFET Rating] DANGER: Id_cont ({id_cont}A) < I_max ({self.i_max}A).")
            else:
                self.audit_log.append(f"[MOSFET Rating] Id_cont={id_cont}A vs I_max={self.i_max}A — OK ({i_margin_pct:.0f}% margin).")
        else:
            results["current_ok"] = None
            self.audit_log.append("[MOSFET Rating] Id_cont not extracted — cannot validate current rating.")

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
        vbs_uvlo = self._get(self.driver, "DRIVER", "vbs_uvlo", None)
        # Bootstrap voltage = Vdrv - diode_Vf
        boot_vf = self._dc("gate.bootstrap_vf")
        v_boot = self.v_drv - boot_vf
        self._log_hc("driver_compatibility", "Bootstrap diode Vf", f"{boot_vf} V", "Assumed Schottky diode forward drop", "gate.bootstrap_vf")
        results["v_bootstrap_v"] = round(v_boot, 2)

        if vbs_uvlo is not None:
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
        else:
            results["bootstrap_ok"] = None
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

