"""Motor Controller Hardware Design — Validation Calculations"""
import math


class ValidationMixin:
    """Mixin providing calculations for: motor_validation, adc_timing."""

    # ═══════════════════════════════════════════════════════════════════
    def calc_motor_validation(self) -> dict:
        self._current_module = "motor_validation"
        m = self.motor or {}

        # Parse motor specs (all optional — skip checks if not provided)
        def _f(key):
            v = m.get(key, "")
            if v == "" or v is None:
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        rpm       = _f("max_speed_rpm")
        pole_pairs = _f("pole_pairs")
        rph_mohm  = _f("rph_mohm")
        lph_uh    = _f("lph_uh")
        kt        = _f("kt_nm_per_a")
        ke        = _f("back_emf_v_per_krpm")
        rated_tq  = _f("rated_torque_nm")

        warnings = []
        results  = {}

        # ── 1. Electrical frequency vs PWM frequency ──────────────
        if rpm is not None and pole_pairs is not None and pole_pairs > 0:
            f_e = (rpm * pole_pairs) / 60.0
            fsw_ratio = self.fsw / f_e if f_e > 0 else float('inf')
            results["f_electrical_hz"] = round(f_e, 1)
            results["fsw_to_fe_ratio"] = round(fsw_ratio, 1)
            results["fsw_ratio_ok"] = fsw_ratio >= 10

            if fsw_ratio < 10:
                warnings.append(
                    f"CRITICAL: f_sw/f_e = {fsw_ratio:.1f}x (need >= 10x). "
                    f"PWM at {self.fsw/1e3:.0f}kHz is too slow for {rpm}RPM × {int(pole_pairs)}p "
                    f"(f_e={f_e:.0f}Hz). Increase f_sw or reduce max RPM."
                )
                self.audit_log.append(f"[Motor] WARNING: PWM frequency ratio f_sw/f_e = {fsw_ratio:.1f}x is below 10x minimum for FOC/SPWM.")
            else:
                self.audit_log.append(f"[Motor] PWM frequency ratio f_sw/f_e = {fsw_ratio:.1f}x — OK (>= 10x).")

        # ── 2. Back-EMF vs Bus Voltage ────────────────────────────
        if ke is not None and rpm is not None and ke > 0:
            v_bemf = ke * (rpm / 1000.0)
            bemf_margin_pct = ((self.v_bus - v_bemf) / self.v_bus) * 100 if self.v_bus > 0 else 0
            results["v_bemf_peak_v"] = round(v_bemf, 1)
            results["bemf_margin_pct"] = round(bemf_margin_pct, 1)
            results["bemf_ok"] = v_bemf < self.v_bus

            if v_bemf >= self.v_bus:
                warnings.append(
                    f"DANGER: Back-EMF ({v_bemf:.1f}V) >= Bus voltage ({self.v_bus}V). "
                    f"Motor will act as generator during freewheel — risk of MOSFET/capacitor overvoltage damage."
                )
                self.audit_log.append(f"[Motor] DANGER: V_BEMF={v_bemf:.1f}V exceeds V_bus={self.v_bus}V at {rpm}RPM.")
            elif v_bemf >= self.v_bus * 0.9:
                warnings.append(
                    f"WARNING: Back-EMF ({v_bemf:.1f}V) is within 10% of bus voltage ({self.v_bus}V). "
                    f"Very limited voltage headroom for current control."
                )
                self.audit_log.append(f"[Motor] WARNING: V_BEMF={v_bemf:.1f}V is within 10% of V_bus={self.v_bus}V — limited headroom.")

        # ── 3. Kt current cross-check ────────────────────────────
        if kt is not None and kt > 0 and rated_tq is not None:
            i_rated = rated_tq / kt
            results["i_rated_from_kt_a"] = round(i_rated, 1)
            results["i_max_system_a"] = self.i_max
            results["current_headroom_ok"] = self.i_max >= i_rated

            if i_rated > self.i_max:
                warnings.append(
                    f"WARNING: Rated torque ({rated_tq}Nm) requires {i_rated:.1f}A "
                    f"(from Kt={kt}Nm/A), but system max is {self.i_max}A. "
                    f"Motor cannot reach rated torque — increase I_max or use a higher-Kt motor."
                )
                self.audit_log.append(f"[Motor] WARNING: Rated current {i_rated:.1f}A > system I_max={self.i_max}A.")
            elif i_rated > self.i_max * 0.9:
                warnings.append(
                    f"NOTE: Rated current ({i_rated:.1f}A) is within 10% of system max ({self.i_max}A). "
                    f"No headroom for transients or acceleration."
                )

        # ── 4. Copper loss (winding I²R) ──────────────────────────
        if rph_mohm is not None and rph_mohm > 0:
            rph = rph_mohm * 1e-3  # convert mΩ → Ω
            # 3-phase RMS copper loss: 3 × I_rms² × Rph, I_rms ≈ I_max/√2
            i_rms = self.i_max / math.sqrt(2)
            p_copper_3ph = 3 * (i_rms ** 2) * rph
            # Thermal derating: copper resistance rises ~0.4%/°C
            p_copper_hot = p_copper_3ph * 1.5  # worst-case at ~150°C winding temp
            copper_pct = (p_copper_3ph / self.power * 100) if self.power > 0 else 0
            results["copper_loss_3ph_w"] = round(p_copper_3ph, 1)
            results["copper_loss_hot_w"] = round(p_copper_hot, 1)
            results["copper_loss_pct"] = round(copper_pct, 1)
            results["copper_loss_ok"] = copper_pct < 5

            if copper_pct >= 5:
                warnings.append(
                    f"WARNING: Motor copper loss ({p_copper_3ph:.1f}W) is {copper_pct:.1f}% of rated power. "
                    f"Winding thermal limit may be reached. Consider forced cooling."
                )
                self.audit_log.append(f"[Motor] WARNING: Copper loss is {copper_pct:.1f}% of rated power ({p_copper_3ph:.1f}W / {self.power}W).")

        # ── 5. L/R time constant ──────────────────────────────────
        if rph_mohm is not None and rph_mohm > 0 and lph_uh is not None and lph_uh > 0:
            rph = rph_mohm * 1e-3
            lph = lph_uh * 1e-6
            tau_ms = (lph / rph) * 1000
            results["phase_time_const_ms"] = round(tau_ms, 2)

        # ── 6. Power-Torque-Speed cross-check ────────────────────
        if rpm is not None and rpm > 0 and kt is not None and kt > 0:
            omega = 2 * math.pi * rpm / 60.0  # rad/s
            # Mechanical power from rated torque
            if rated_tq is not None and rated_tq > 0:
                p_mech_from_torque = rated_tq * omega
                results["p_mechanical_from_motor_w"] = round(p_mech_from_torque, 0)
                results["p_system_rated_w"] = self.power
                mismatch_pct = abs(p_mech_from_torque - self.power) / self.power * 100 if self.power > 0 else 0
                results["power_mismatch_pct"] = round(mismatch_pct, 1)

                if mismatch_pct > 50:
                    warnings.append(
                        f"WARNING: Motor mechanical power ({p_mech_from_torque:.0f}W = "
                        f"{rated_tq}Nm × {omega:.0f}rad/s) differs from system rating "
                        f"({self.power}W) by {mismatch_pct:.0f}%. Verify motor specs match design target."
                    )
                    self.audit_log.append(f"[Motor] WARNING: Power mismatch — motor yields {p_mech_from_torque:.0f}W vs system {self.power}W ({mismatch_pct:.0f}% diff).")

            # Max current from system power: I = P / (V_bus × efficiency × √3/2 for 3-phase)
            i_from_power = self.power / (self.v_bus * 0.95 * 0.866) if self.v_bus > 0 else 0
            results["i_max_from_power_a"] = round(i_from_power, 1)
            if i_from_power > 0 and abs(i_from_power - self.i_max) / self.i_max > 0.5:
                warnings.append(
                    f"NOTE: System max current ({self.i_max}A) vs calculated from "
                    f"power ({i_from_power:.1f}A = {self.power}W / ({self.v_bus}V × 0.95 × 0.866)). "
                    f"Verify max_phase_current setting."
                )

        results["warnings"] = warnings
        results["has_motor_data"] = any(v is not None for v in [rpm, pole_pairs, ke, kt, rph_mohm])
        results["_meta"] = self._module_meta.get("motor_validation", {"hardcoded": [], "fallbacks": []})

        return results

    # ═══════════════════════════════════════════════════════════════════
    # 14. MOSFET Rating Validation
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_adc_timing(self) -> dict:
        """Validate ADC can sample within center-aligned PWM window."""
        self._current_module = "adc_timing"
        warnings = []
        results = {}

        # PWM period and available sampling window
        t_pwm_us = (1.0 / self.fsw) * 1e6         # full PWM period in µs
        # Center-aligned: sample at PWM center, need at least ~10% of half-period
        t_half_us = t_pwm_us / 2.0
        t_window_us = t_half_us * 0.1              # conservative: 10% of half-period
        self._log_hc("adc_timing", "Sampling window", "10% of half-period", "Conservative center-aligned sampling")
        results["pwm_period_us"] = round(t_pwm_us, 2)
        results["sampling_window_us"] = round(t_window_us, 2)

        # ADC sample rate → conversion time
        adc_rate_raw = self._get(self.mcu, "MCU", "adc_sample_rate", None)
        # Also grab the raw unit string to detect if value is a TIME or RATE
        adc_unit = (self.mcu or {}).get("adc_sample_rate__unit", "") or ""
        if adc_rate_raw is not None:
            try:
                adc_val = float(adc_rate_raw)
                # Determine if this is a TIME (µs, ns, ms, s) or a RATE (SPS, MSPS, KSPS)
                unit_lower = adc_unit.lower().strip()

                # Check if unit indicates a time duration
                is_time_unit = any(u in unit_lower for u in ['s', 'µs', 'us', 'ns', 'ms', 'sec'])
                # Exclude SPS/MSPS/KSPS which contain 's' but are rates
                if any(u in unit_lower for u in ['sps', 'msps', 'ksps', '/s', 'samples']):
                    is_time_unit = False

                if is_time_unit:
                    # Value is already a time — to_si() already converted to seconds
                    # adc_val is in seconds (e.g. 2.5µs → 2.5e-6)
                    t_conv_us = adc_val * 1e6  # convert seconds to µs
                    if t_conv_us < 0.001:
                        # Likely already in µs (raw value without to_si conversion)
                        t_conv_us = adc_val
                    adc_sps = 1e6 / t_conv_us  # convert time to rate
                    self.audit_log.append(f"[ADC Timing] ADC conversion time = {t_conv_us:.1f}µs (from datasheet unit: '{adc_unit}').")
                else:
                    # Value is a rate — apply heuristic for units
                    if adc_val > 1e6:
                        adc_sps = adc_val               # already in SPS
                    elif adc_val > 1000:
                        adc_sps = adc_val * 1e3          # was in KSPS
                    else:
                        adc_sps = adc_val * 1e6          # was in MSPS
                    t_conv_us = (1.0 / adc_sps) * 1e6    # conversion time in µs
                    self.audit_log.append(f"[ADC Timing] ADC sample rate = {adc_sps/1e6:.2f} MSPS (from datasheet unit: '{adc_unit}').")

                results["adc_conversion_us"] = round(t_conv_us, 3)
                results["adc_rate_msps"] = round(adc_sps / 1e6, 2)

                # For 3-shunt FOC: need 3 sequential conversions in the window
                t_3ch_us = t_conv_us * 3
                results["t_3_channel_us"] = round(t_3ch_us, 3)
                results["timing_ok"] = t_3ch_us < t_window_us

                if t_3ch_us >= t_window_us:
                    warnings.append(
                        f"WARNING: 3-channel ADC conversion ({t_3ch_us:.1f}µs) exceeds available "
                        f"sampling window ({t_window_us:.1f}µs at {self.fsw/1e3:.0f}kHz). "
                        f"Consider DMA+injected channels, reducing fsw, or using simultaneous sampling."
                    )
                    self.audit_log.append(f"[ADC Timing] WARNING: 3-ch conversion ({t_3ch_us:.1f}µs) > window ({t_window_us:.1f}µs).")
                else:
                    self.audit_log.append(f"[ADC Timing] 3-ch conversion ({t_3ch_us:.1f}µs) fits in window ({t_window_us:.1f}µs) — OK.")
            except (ValueError, TypeError):
                results["timing_ok"] = None
                self.audit_log.append(f"[ADC Timing] Could not parse ADC sample rate '{adc_rate_raw}'.")
        else:
            results["timing_ok"] = None
            self.audit_log.append("[ADC Timing] ADC sample rate not extracted — cannot validate timing.")

        # ADC channel count check
        adc_ch = self._get(self.mcu, "MCU", "adc_channels", None)
        if adc_ch is not None:
            try:
                n_ch = int(float(adc_ch))
                # FOC needs: 3 phase currents + bus voltage + 2 NTC + 1 BEMF = 7 minimum
                results["adc_channels"] = n_ch
                results["channels_needed"] = 7
                results["channels_ok"] = n_ch >= 7
                self._log_hc("adc_timing", "FOC channel requirement", "≥ 7 channels", "3 current + bus V + 2 NTC + 1 BEMF")

                if n_ch < 7:
                    warnings.append(
                        f"WARNING: Only {n_ch} ADC channels available, FOC needs ≥7 "
                        f"(3 current + bus V + 2 NTC + 1 BEMF/pot). Use external MUX or reduce sensing."
                    )
                else:
                    self.audit_log.append(f"[ADC Timing] {n_ch} ADC channels available, need ≥7 — OK.")
            except (ValueError, TypeError):
                results["channels_ok"] = None
        else:
            results["channels_ok"] = None

        results["warnings"] = warnings
        results["_meta"] = self._module_meta.get("adc_timing", {"hardcoded": [], "fallbacks": []})
        return results

    # ═══════════════════════════════════════════════════════════════════
    # 17. Cross-Datasheet Validation
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_cross_validation(self) -> dict:
        """
        Cross-check compatibility between all uploaded component datasheets.
        Runs 12 rule-based checks spanning MOSFET, Gate Driver, and MCU.
        Each check produces a status: 'pass', 'warn', 'fail', or 'skip'.
        """
        self._current_module = "cross_validation"
        checks = []

        def _add(rule_id, title, status, detail, advice=None):
            entry = {"id": rule_id, "title": title, "status": status, "detail": detail}
            if advice:
                entry["advice"] = advice
            checks.append(entry)
            tag = {"pass": "OK", "warn": "WARNING", "fail": "FAIL", "skip": "SKIP"}[status]
            self.audit_log.append(f"[Cross-Check] {tag}: {title} -- {detail}")

        # ── 1. Driver Io_source vs MOSFET Qg (gate charge drive capability) ──
        io_src = self._get(self.driver, "DRIVER", "io_source", None)
        qg = self._get(self.mosfet, "MOSFET", "qg", None)
        if io_src is not None and qg is not None and io_src > 0:
            t_charge_ns = (qg / io_src) * 1e9
            target_ns = self._dc("gate.rise_time_target")
            if t_charge_ns > target_ns * 2:
                _add("drv_qg_charge", "Driver vs MOSFET Qg",
                     "fail",
                     f"Driver needs {t_charge_ns:.0f}ns to charge Qg={qg*1e9:.0f}nC (Io={io_src:.1f}A). Target is {target_ns}ns.",
                     "Choose a driver with higher source current, or a MOSFET with lower Qg.")
            elif t_charge_ns > target_ns:
                _add("drv_qg_charge", "Driver vs MOSFET Qg",
                     "warn",
                     f"Gate charge time {t_charge_ns:.0f}ns is above target {target_ns}ns but within 2x. Rg_on will be near minimum.",
                     "Consider increasing rise time target or using a stronger driver.")
            else:
                _add("drv_qg_charge", "Driver vs MOSFET Qg",
                     "pass",
                     f"Driver can charge Qg={qg*1e9:.0f}nC in {t_charge_ns:.0f}ns (target: {target_ns}ns). Headroom for external Rg.")
        else:
            _add("drv_qg_charge", "Driver vs MOSFET Qg", "skip",
                 "Missing io_source or Qg -- cannot validate gate drive capability.")

        # ── 2. Driver VBS_max vs bootstrap supply voltage ──
        vbs_max = self._get(self.driver, "DRIVER", "vbs_max", None)
        boot_vf = self._dc("gate.bootstrap_vf")
        v_boot = self.v_drv - boot_vf
        if vbs_max is not None:
            if v_boot > vbs_max:
                _add("vbs_max_check", "Bootstrap vs VBS max",
                     "fail",
                     f"Bootstrap voltage ({v_boot:.1f}V) exceeds VBS_max ({vbs_max:.1f}V). Driver IC will be damaged.",
                     "Reduce VCC supply or add Zener clamp on bootstrap pin.")
            elif v_boot > vbs_max * 0.9:
                _add("vbs_max_check", "Bootstrap vs VBS max",
                     "warn",
                     f"Bootstrap ({v_boot:.1f}V) is within 10% of VBS_max ({vbs_max:.1f}V). Limited headroom for transients.",
                     "Consider adding a bootstrap Zener clamp for safety.")
            else:
                margin_pct = ((vbs_max - v_boot) / vbs_max) * 100
                _add("vbs_max_check", "Bootstrap vs VBS max",
                     "pass",
                     f"Bootstrap {v_boot:.1f}V vs VBS_max {vbs_max:.1f}V -- {margin_pct:.0f}% margin.")
        else:
            _add("vbs_max_check", "Bootstrap vs VBS max", "skip",
                 "VBS_max not extracted -- cannot validate bootstrap voltage limit.")

        # ── 3. Driver UVLO vs gate drive voltage ──
        vcc_uvlo = self._get(self.driver, "DRIVER", "vcc_uvlo", None)
        if vcc_uvlo is not None:
            uvlo_margin = self.v_drv - vcc_uvlo
            if uvlo_margin < 0:
                _add("vcc_uvlo_margin", "VCC vs UVLO threshold",
                     "fail",
                     f"Gate drive ({self.v_drv}V) is BELOW VCC UVLO ({vcc_uvlo:.1f}V). Driver will remain locked out.",
                     "Increase VCC supply voltage above UVLO threshold.")
            elif uvlo_margin < 1.0:
                _add("vcc_uvlo_margin", "VCC vs UVLO threshold",
                     "warn",
                     f"Only {uvlo_margin:.1f}V above UVLO ({vcc_uvlo:.1f}V). May brown out during load transients.",
                     "Increase VCC or improve supply regulation.")
            else:
                _add("vcc_uvlo_margin", "VCC vs UVLO threshold",
                     "pass",
                     f"VCC {self.v_drv}V is {uvlo_margin:.1f}V above UVLO ({vcc_uvlo:.1f}V). Adequate margin.")
        else:
            _add("vcc_uvlo_margin", "VCC vs UVLO threshold", "skip",
                 "VCC UVLO not extracted -- cannot validate supply margin.")

        # ── 4. MCU dead-time resolution vs calculated minimum dead time ──
        dt_res_s = self._get(self.mcu, "MCU", "pwm_deadtime_res", None)
        td_off_s = self._get(self.mosfet, "MOSFET", "td_off", None)
        tf_s = self._get(self.mosfet, "MOSFET", "tf", None)
        t_prop_s = self._get(self.driver, "DRIVER", "prop_delay_off", None)
        if dt_res_s is not None and td_off_s is not None and tf_s is not None and t_prop_s is not None:
            dt_min_ns = (td_off_s + tf_s + t_prop_s) * 1e9 + self._dc("dt.abs_margin")
            dt_res_ns = dt_res_s * 1e9
            dt_reg = math.ceil(dt_min_ns / dt_res_ns) if dt_res_ns > 0 else 0
            dt_actual_ns = dt_reg * dt_res_ns
            quantization_error_ns = dt_actual_ns - dt_min_ns

            dt_max_s = self._get(self.mcu, "MCU", "pwm_deadtime_max", None)
            dt_rec_ns = dt_min_ns * self._dc("dt.safety_mult")

            if dt_max_s is not None and dt_rec_ns > dt_max_s * 1e9:
                _add("mcu_dt_resolution", "MCU dead-time vs design",
                     "fail",
                     f"Recommended DT ({dt_rec_ns:.0f}ns) exceeds MCU max ({dt_max_s*1e9:.0f}ns).",
                     "Use a faster MOSFET/driver, reduce safety margin, or choose MCU with wider DT range.")
            elif dt_res_ns > dt_min_ns * 0.25:
                _add("mcu_dt_resolution", "MCU dead-time vs design",
                     "warn",
                     f"DT resolution ({dt_res_ns:.1f}ns) is coarse vs minimum DT ({dt_min_ns:.0f}ns). Quantization adds {quantization_error_ns:.0f}ns.",
                     "Acceptable, but limits fine-tuning. Consider MCU with finer DT resolution.")
            else:
                _add("mcu_dt_resolution", "MCU dead-time vs design",
                     "pass",
                     f"DT resolution {dt_res_ns:.1f}ns, minimum DT {dt_min_ns:.0f}ns, register={dt_reg}. Good precision.")
        else:
            _add("mcu_dt_resolution", "MCU dead-time vs design", "skip",
                 "Missing DT resolution or MOSFET/driver timing -- cannot validate dead-time programming.")

        # ── 5. MCU ADC reference vs protection divider design ──
        adc_ref_mcu = self._get(self.mcu, "MCU", "adc_ref", None)
        adc_ref_dc = self._dc("prot.adc_ref")
        if adc_ref_mcu is not None and adc_ref_mcu > 0:
            diff_pct = abs(adc_ref_mcu - adc_ref_dc) / adc_ref_dc * 100 if adc_ref_dc > 0 else 0
            if diff_pct > 10:
                _add("adc_ref_consistency", "ADC reference consistency",
                     "warn",
                     f"MCU ADC ref ({adc_ref_mcu:.2f}V) differs from design constant ({adc_ref_dc:.2f}V) by {diff_pct:.0f}%. Using MCU value in calculations.",
                     "Update the ADC reference design constant to match your MCU, or verify the extracted value.")
            else:
                _add("adc_ref_consistency", "ADC reference consistency",
                     "pass",
                     f"MCU ADC ref ({adc_ref_mcu:.2f}V) matches design constant ({adc_ref_dc:.2f}V). Consistent.")
        else:
            _add("adc_ref_consistency", "ADC reference consistency", "skip",
                 "ADC reference not extracted from MCU -- using design constant default.")

        # ── 6. MOSFET Vds_max vs system peak voltage (with ringing margin) ──
        vds_max = self._get(self.mosfet, "MOSFET", "vds_max", None)
        coss = self._get(self.mosfet, "MOSFET", "coss", None)
        l_stray_nh = float(self.ovr.get("stray_inductance_nh", self._dc("snub.stray_l_default")))
        if vds_max is not None:
            if coss is not None and coss > 0:
                v_overshoot = self.i_max * math.sqrt(l_stray_nh * 1e-9 / coss)
                v_worst = self.v_peak + v_overshoot
            else:
                v_overshoot = self.v_peak * 0.15
                v_worst = self.v_peak + v_overshoot

            margin_pct = ((vds_max - v_worst) / vds_max) * 100 if vds_max > 0 else 0
            if v_worst > vds_max:
                _add("vds_ringing", "Vds vs peak + ringing",
                     "fail",
                     f"Peak + ringing ({v_worst:.0f}V) exceeds Vds_max ({vds_max:.0f}V). Avalanche breakdown risk!",
                     "Use higher-voltage MOSFET, reduce stray inductance, or add snubber.")
            elif margin_pct < 10:
                _add("vds_ringing", "Vds vs peak + ringing",
                     "warn",
                     f"Only {margin_pct:.0f}% margin: peak+ring={v_worst:.0f}V vs Vds_max={vds_max:.0f}V.",
                     "Tight margin. Ensure snubber is properly designed and PCB layout is low-inductance.")
            else:
                _add("vds_ringing", "Vds vs peak + ringing",
                     "pass",
                     f"Vds_max={vds_max:.0f}V vs peak+ring={v_worst:.0f}V -- {margin_pct:.0f}% margin.")
        else:
            _add("vds_ringing", "Vds vs peak + ringing", "skip",
                 "Vds_max not extracted -- cannot validate voltage headroom with ringing.")

        # ── 7. MOSFET Vgs_max vs gate drive voltage ──
        vgs_max = self._get(self.mosfet, "MOSFET", "vgs_max", None)
        if vgs_max is not None:
            if self.v_drv > vgs_max:
                _add("vgs_max_safety", "Gate drive vs Vgs max",
                     "fail",
                     f"Gate drive ({self.v_drv}V) > Vgs_max ({vgs_max:.0f}V). GATE OXIDE WILL FAIL.",
                     "Reduce VCC or add gate clamp Zener. This is a critical safety issue.")
            elif self.v_drv > vgs_max * 0.8:
                _add("vgs_max_safety", "Gate drive vs Vgs max",
                     "warn",
                     f"Gate drive ({self.v_drv}V) is {self.v_drv/vgs_max*100:.0f}% of Vgs_max ({vgs_max:.0f}V). Add clamping Zener recommended.",
                     "A 15V Zener + resistor clamp protects against transient overshoot.")
            else:
                _add("vgs_max_safety", "Gate drive vs Vgs max",
                     "pass",
                     f"Vgs_max={vgs_max:.0f}V, V_drive={self.v_drv}V -- {((vgs_max-self.v_drv)/vgs_max*100):.0f}% headroom.")
        else:
            _add("vgs_max_safety", "Gate drive vs Vgs max", "skip",
                 "Vgs_max not extracted -- cannot validate gate oxide safety.")

        # ── 8. Gate drive headroom vs Vgs_th ──
        vgs_th = self._get(self.mosfet, "MOSFET", "vgs_th", None)
        if vgs_th is not None:
            headroom = self.v_drv - vgs_th
            if headroom < 2:
                _add("vgs_headroom", "V_drive headroom vs Vgs_th",
                     "fail" if headroom < 0 else "warn",
                     f"V_drive ({self.v_drv}V) - Vgs_th ({vgs_th:.1f}V) = {headroom:.1f}V. Need >=3V for full enhancement.",
                     "Increase VCC or choose MOSFET with lower Vgs_th (logic-level FET).")
            else:
                _add("vgs_headroom", "V_drive headroom vs Vgs_th",
                     "pass",
                     f"V_drive - Vgs_th = {headroom:.1f}V headroom. MOSFET will fully enhance.")
        else:
            _add("vgs_headroom", "V_drive headroom vs Vgs_th", "skip",
                 "Vgs_th not extracted -- cannot validate drive headroom.")

        # ── 9. Driver thermal shutdown vs estimated driver Tj ──
        rth_ja_drv = self._get(self.driver, "DRIVER", "rth_ja", None)
        thermal_shutdown = self._get(self.driver, "DRIVER", "thermal_shutdown", None)
        if rth_ja_drv is not None and qg is not None:
            p_driver = qg * self.v_drv * self.fsw * 2 + 0.05
            tj_drv = self.t_amb + p_driver * rth_ja_drv
            if thermal_shutdown is not None:
                margin = thermal_shutdown - tj_drv
                if margin < 0:
                    _add("drv_thermal_shutdown", "Driver thermal shutdown margin",
                         "fail",
                         f"Driver Tj ({tj_drv:.0f}C) exceeds thermal shutdown ({thermal_shutdown:.0f}C)!",
                         "Reduce fsw, use lower-Qg MOSFET, or add driver heatsinking.")
                elif margin < 20:
                    _add("drv_thermal_shutdown", "Driver thermal shutdown margin",
                         "warn",
                         f"Only {margin:.0f}C margin before driver thermal shutdown (Tj={tj_drv:.0f}C, TSD={thermal_shutdown:.0f}C).",
                         "Consider thermal pad exposure or reduced switching frequency.")
                else:
                    _add("drv_thermal_shutdown", "Driver thermal shutdown margin",
                         "pass",
                         f"Driver Tj={tj_drv:.0f}C, shutdown at {thermal_shutdown:.0f}C -- {margin:.0f}C margin.")
            else:
                _add("drv_thermal_shutdown", "Driver thermal shutdown margin", "skip",
                     f"Thermal shutdown not extracted. Driver Tj estimated at {tj_drv:.0f}C.")
        else:
            _add("drv_thermal_shutdown", "Driver thermal shutdown margin", "skip",
                 "Missing driver Rth_ja or MOSFET Qg -- cannot estimate driver temperature.")

        # ── 10. MCU PWM frequency capability ──
        cpu_freq = self._get(self.mcu, "MCU", "cpu_freq_max", None)
        pwm_res = self._get(self.mcu, "MCU", "pwm_resolution", None)
        if cpu_freq is not None and pwm_res is not None:
            try:
                cpu_hz = float(cpu_freq)
                if cpu_hz < 1e6:
                    cpu_hz = cpu_hz * 1e6
                bits = int(float(pwm_res))
                counts_per_period = cpu_hz / (2 * self.fsw)
                effective_bits = math.log2(counts_per_period) if counts_per_period > 0 else 0
                if effective_bits < 8:
                    _add("mcu_pwm_capability", "MCU PWM resolution at fsw",
                         "fail",
                         f"Only {effective_bits:.1f} effective bits at {self.fsw/1e3:.0f}kHz (CPU={cpu_hz/1e6:.0f}MHz). Need >=8 bits.",
                         "Reduce fsw or use MCU with higher clock frequency.")
                elif effective_bits < 10:
                    _add("mcu_pwm_capability", "MCU PWM resolution at fsw",
                         "warn",
                         f"{effective_bits:.1f} effective bits at {self.fsw/1e3:.0f}kHz. Acceptable but limits current ripple control.",
                         "10+ bits recommended for smooth FOC operation.")
                else:
                    _add("mcu_pwm_capability", "MCU PWM resolution at fsw",
                         "pass",
                         f"{effective_bits:.1f} effective bits at {self.fsw/1e3:.0f}kHz (CPU={cpu_hz/1e6:.0f}MHz). Excellent resolution.")
            except (ValueError, TypeError):
                _add("mcu_pwm_capability", "MCU PWM resolution at fsw", "skip",
                     "Could not parse CPU frequency or PWM resolution.")
        else:
            _add("mcu_pwm_capability", "MCU PWM resolution at fsw", "skip",
                 "CPU frequency or PWM resolution not extracted.")

        # ── 11. MCU complementary outputs (3-phase capability) ──
        comp_out = self._get(self.mcu, "MCU", "complementary_outputs", None)
        if comp_out is not None:
            try:
                n_comp = int(float(comp_out))
                if n_comp < 3:
                    _add("mcu_complementary", "MCU complementary outputs",
                         "fail" if n_comp == 0 else "warn",
                         f"MCU has {n_comp} complementary pairs, need >=3 for 3-phase inverter.",
                         "Use MCU with 3+ complementary PWM outputs (e.g., STM32 TIM1/TIM8)." if n_comp < 3 else None)
                else:
                    _add("mcu_complementary", "MCU complementary outputs",
                         "pass",
                         f"MCU has {n_comp} complementary PWM pairs -- sufficient for 3-phase control.")
            except (ValueError, TypeError):
                _add("mcu_complementary", "MCU complementary outputs", "skip",
                     f"Could not parse complementary output count: {comp_out}")
        else:
            _add("mcu_complementary", "MCU complementary outputs", "skip",
                 "Complementary output count not extracted.")

        # ── 12. Overall system thermal budget ──
        rth_jc = self._get(self.mosfet, "MOSFET", "rth_jc", None)
        tj_max = self._get(self.mosfet, "MOSFET", "tj_max", None)
        rds_on = self._get(self.mosfet, "MOSFET", "rds_on", None)
        if rth_jc is not None and tj_max is not None and rds_on is not None:
            rds_hot = rds_on * self._dc("thermal.rds_derating")
            i_rms = self.i_max / math.sqrt(2)
            p_cond = i_rms**2 * rds_hot
            rth_total = rth_jc + self._dc("thermal.rth_cs") + self._effective_rth_sa()
            tj_est = self.t_amb + p_cond * rth_total
            thermal_budget_pct = ((tj_max - tj_est) / (tj_max - self.t_amb)) * 100 if (tj_max - self.t_amb) > 0 else 0

            if tj_est > tj_max:
                _add("thermal_budget", "System thermal budget",
                     "fail",
                     f"Conduction loss alone pushes Tj to {tj_est:.0f}C (max {tj_max:.0f}C). Design is not viable.",
                     "Use lower Rds(on) MOSFET, add heatsink, or reduce current.")
            elif thermal_budget_pct < 20:
                _add("thermal_budget", "System thermal budget",
                     "warn",
                     f"Thermal budget only {thermal_budget_pct:.0f}% remaining (Tj~{tj_est:.0f}C, switching losses not included).",
                     "Adding switching + gate losses will push Tj higher. Consider thermal improvements.")
            else:
                _add("thermal_budget", "System thermal budget",
                     "pass",
                     f"Thermal budget {thermal_budget_pct:.0f}% remaining. Tj~{tj_est:.0f}C from conduction alone (max {tj_max:.0f}C).")
        else:
            _add("thermal_budget", "System thermal budget", "skip",
                 "Missing Rth_jc, Tj_max, or Rds_on -- cannot estimate thermal budget.")

        # ── Summary ──
        n_pass = sum(1 for c in checks if c["status"] == "pass")
        n_warn = sum(1 for c in checks if c["status"] == "warn")
        n_fail = sum(1 for c in checks if c["status"] == "fail")
        n_skip = sum(1 for c in checks if c["status"] == "skip")
        total = len(checks)

        scored = [c for c in checks if c["status"] != "skip"]
        if scored:
            score_sum = sum({"pass": 100, "warn": 50, "fail": 0}[c["status"]] for c in scored)
            health_score = round(score_sum / len(scored))
        else:
            health_score = None

        return {
            "checks": checks,
            "summary": {
                "total": total,
                "pass": n_pass,
                "warn": n_warn,
                "fail": n_fail,
                "skip": n_skip,
                "health_score": health_score,
            },
            "_meta": self._module_meta.get("cross_validation", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # REVERSE CALCULATIONS — work backwards from target outputs
    # ═══════════════════════════════════════════════════════════════════

