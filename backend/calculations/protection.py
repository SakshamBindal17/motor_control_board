"""Motor Controller Hardware Design — Protection Calculations"""
import math
from calculations.base import _nearest_e, E24, E12


class ProtectionMixin:
    """Mixin providing calculations for: protection_dividers, power_supply_bypass."""

    # ═══════════════════════════════════════════════════════════════════
    def calc_protection_dividers(self) -> dict:
        self._current_module = "protection_dividers"
        # Try to get ADC reference from MCU datasheet; fall back to design constant
        adc_ref_from_mcu = self._get(self.mcu, "MCU", "adc_ref", None)
        if adc_ref_from_mcu is not None and adc_ref_from_mcu > 0:
            v_ref = adc_ref_from_mcu
            self.audit_log.append(f"[Protection] Using ADC reference {v_ref}V from MCU datasheet.")
        else:
            v_ref = self._dc("prot.adc_ref")
            self._log_hc("protection_dividers", "ADC reference", f"{v_ref} V", "Comparator/ADC reference voltage (default — not extracted from MCU datasheet)", "prot.adc_ref")

        # ── OVP: trip at Vpeak × margin ──
        ovp_margin = self._dc("prot.ovp_margin")
        v_ovp_trip = round(self.v_peak * ovp_margin, 1)
        self._log_hc("protection_dividers", "OVP trip margin", f"Vpeak × {ovp_margin}", f"{round((ovp_margin-1)*100)}% above peak bus voltage", "prot.ovp_margin")
        # V_ref = V_trip × R2 / (R1 + R2)  →  R2/R1 = V_ref / (V_trip - V_ref)
        v_ovp_diff   = v_ovp_trip - v_ref
        r_ratio_ovp  = 0 if v_ovp_diff <= 0 else v_ref / v_ovp_diff
        # ── Configurable protection components ─────────────────────────────────────────
        def _flt(key, default):
            try: return float(self.ovr.get(key, default))
            except (TypeError, ValueError): return float(default)

        prot_r1_kohm   = _flt("prot_r1_kohm",   100.0)  # top divider resistor (user sets)
        prot_r2_kohm   = self.ovr.get("prot_r2_kohm")    # bottom resistor (optional override)
        ntc_r25_kohm   = _flt("ntc_r25_kohm",    10.0)  # NTC resistance @ 25°C
        ntc_b_coeff    = _flt("ntc_b_coeff",    3950.0)  # NTC B-coefficient
        ntc_pullup_kohm= _flt("ntc_pullup_kohm",  10.0)  # NTC pullup resistor

        r1_ovp  = prot_r1_kohm * 1e3
        r1_uvp  = prot_r1_kohm * 1e3
        ntc_r25 = ntc_r25_kohm * 1e3
        b_ntc   = ntc_b_coeff
        r_pullup= ntc_pullup_kohm * 1e3

        if prot_r1_kohm == 100.0:
            self._log_hc("protection_dividers", "OVP/UVP R1", "100 kΩ", "Fixed top divider resistor for low bias current")
        if ntc_r25_kohm == 10.0:
            self._log_hc("protection_dividers", "NTC specs", f"{ntc_r25_kohm:.0f}kΩ@25°C, B={int(ntc_b_coeff)}", "Standard NTC thermistor")

        self.audit_log.append(
            f"[Protection] OVP/UVP divider R1={prot_r1_kohm:.0f}kΩ. "
            f"NTC: {ntc_r25_kohm:.0f}kΩ@25°C, B={int(ntc_b_coeff)}, pullup={ntc_pullup_kohm:.0f}kΩ."
        )
        self.audit_log.append("[Protection] Hardcoded TVS power rating to 600W (SMBJ/P6KE style) for bus clamping.")
        self._log_hc("protection_dividers", "TVS power rating", "600 W", "SMBJ/P6KE style for bus clamping")

        # ── OVP R2 calculation ──────────────────────────────────────────────────
        r2_user_ohm = None
        if prot_r2_kohm is not None:
            try:
                r2_user_ohm = float(prot_r2_kohm) * 1e3
            except (TypeError, ValueError):
                r2_user_ohm = None

        if r2_user_ohm is not None:
            # Back-calculate mode: physical R2 on board → compute actual trip voltage
            # V_trip = V_ref × (R1 + R2) / R2
            r2_ovp_std = r2_user_ohm
            r2_ovp     = r2_user_ohm
            v_trip_ovp_actual = v_ref * (r1_ovp + r2_ovp_std) / r2_ovp_std
            self.audit_log.append(
                f"[Protection] OVP R2 user={r2_user_ohm/1e3:.2f}kΩ. "
                f"Back-calc trip = {v_trip_ovp_actual:.2f}V via V_ref×(R1+R2)/R2."
            )
        else:
            # Auto mode: R2 = R1 × V_ref / (V_trip - V_ref), snap to nearest E24
            r2_ovp     = r1_ovp * r_ratio_ovp
            r2_ovp_std = max(1e3, _nearest_e(r2_ovp / 1e3, E24) * 1e3)
            if r2_ovp < 1e3:
                self.audit_log.append(
                    f"[Protection] WARNING: OVP divider degenerate - V_trip ({v_ovp_trip}V) too close to V_ref ({v_ref}V). Clamped."
                )
            v_trip_ovp_actual = v_ref * (r1_ovp + r2_ovp_std) / r2_ovp_std

        r2_is_override   = r2_user_ohm is not None
        i_divider_ovp_ua = (self.v_peak / (r1_ovp + r2_ovp_std)) * 1e6

        # TVS Diode Sizing (Bus Clamping)
        # Snap standoff voltage to nearest standard TVS working voltage above trip point
        _TVS_STD_V = [5.1, 6.2, 6.8, 8.2, 9.1, 10, 12, 15, 18, 20, 22,
                      24, 27, 30, 33, 36, 43, 51, 58, 62, 68, 75, 82, 90, 100]
        v_rwm_ideal = v_ovp_trip * 1.05
        v_rwm_suggested = next((v for v in _TVS_STD_V if v >= v_rwm_ideal), _TVS_STD_V[-1])
        v_clamp_typ = round(v_rwm_suggested * 1.6, 1)

        # RC Filter Capacitor Sizing (Target Fc = 2kHz to reject 20kHz PWM)
        r_eq_ovp = (r1_ovp * r2_ovp_std) / (r1_ovp + r2_ovp_std) if (r1_ovp + r2_ovp_std) > 0 else 0
        c_ideal_ovp_nf = 1e9 / (2 * math.pi * r_eq_ovp * 2000) if r_eq_ovp > 0 else 0
        c_filter_ovp_nf = _nearest_e(c_ideal_ovp_nf, E12) if c_ideal_ovp_nf > 0 else 0
        f_cutoff_ovp_hz = round(1e9 / (2 * math.pi * r_eq_ovp * c_filter_ovp_nf), 0) if (r_eq_ovp * c_filter_ovp_nf) > 0 else 0

        # ── UVP ─────────────────────────────────────────────────────────────────
        uvp_trip_frac = self._dc("prot.uvp_trip")
        v_uvp_trip  = round(self.v_bus * uvp_trip_frac, 1)
        v_uvp_hyst  = round(self.v_bus * (uvp_trip_frac + 0.04), 1)
        self._log_hc("protection_dividers", "UVP trip", f"{round(uvp_trip_frac*100)}% of Vbus", "Under-voltage protection threshold", "prot.uvp_trip")
        self._log_hc("protection_dividers", "UVP hysteresis", f"{round((uvp_trip_frac+0.04)*100)}% of Vbus", "Re-enable threshold")
        v_uvp_diff  = v_uvp_trip - v_ref
        r_ratio_uvp = 0 if v_uvp_diff <= 0 else v_ref / v_uvp_diff

        if r2_user_ohm is not None:
            # Shared physical divider: same R2 used for UVP too
            r2_uvp_std = r2_user_ohm
            r2_uvp     = r2_user_ohm
        else:
            r2_uvp      = r1_uvp * r_ratio_uvp
            r2_uvp_std  = max(1e3, _nearest_e(r2_uvp / 1e3, E24) * 1e3)
            if r2_uvp < 1e3:
                self.audit_log.append(
                    f"[Protection] WARNING: UVP divider degenerate - V_trip ({v_uvp_trip}V) too close to V_ref ({v_ref}V). Clamped."
                )
        v_trip_uvp_actual = v_ref * (r1_uvp + r2_uvp_std) / r2_uvp_std
        i_divider_uvp_ua = (self.v_bus / (r1_uvp + r2_uvp_std)) * 1e6

        # RC Filter Capacitor Sizing
        r_eq_uvp = (r1_uvp * r2_uvp_std) / (r1_uvp + r2_uvp_std) if (r1_uvp + r2_uvp_std) > 0 else 0
        c_ideal_uvp_nf = 1e9 / (2 * math.pi * r_eq_uvp * 2000) if r_eq_uvp > 0 else 0
        c_filter_uvp_nf = _nearest_e(c_ideal_uvp_nf, E12) if c_ideal_uvp_nf > 0 else 0
        f_cutoff_uvp_hz = round(1e9 / (2 * math.pi * r_eq_uvp * c_filter_uvp_nf), 0) if (r_eq_uvp * c_filter_uvp_nf) > 0 else 0

        # ── OCP threshold (shunt-based) ─────────────────────────────────────────
        ocp_hw_mult = self._dc("prot.ocp_hw")
        ocp_sw_mult = self._dc("prot.ocp_sw")
        ocp_hw_a    = round(self.i_max * ocp_hw_mult, 0)
        ocp_sw_a    = round(self.i_max * ocp_sw_mult, 0)
        self._log_hc("protection_dividers", "OCP hardware", f"{ocp_hw_mult}x I_max", "Hardware overcurrent trip point", "prot.ocp_hw")
        self._log_hc("protection_dividers", "OCP software", f"{ocp_sw_mult}x I_max", "Software overcurrent trip point", "prot.ocp_sw")

        # ── OTP NTC divider ─────────────────────────────────────────────────────
        # R_NTC(T) = R25 × exp(B × (1/T_K - 1/T25_K))  [Steinhart-Hart simplified]
        otp_warn  = self._dc("prot.otp_warn")
        otp_shut  = self._dc("prot.otp_shutdown")
        self._log_hc("protection_dividers", "OTP warning", f"{otp_warn} °C", "Temperature warning threshold", "prot.otp_warn")
        self._log_hc("protection_dividers", "OTP shutdown", f"{otp_shut} °C", "Temperature shutdown threshold", "prot.otp_shutdown")
        t_25_k    = 298.15
        t_trip_k  = otp_warn + 273.15
        t_100_k   = otp_shut + 273.15
        r_ntc_80  = ntc_r25 * math.exp(b_ntc * (1.0/t_trip_k - 1.0/t_25_k))
        v_ntc_80  = v_ref * r_ntc_80 / (r_pullup + r_ntc_80)
        r_ntc_100 = ntc_r25 * math.exp(b_ntc * (1.0/t_100_k - 1.0/t_25_k))
        v_ntc_100 = v_ref * r_ntc_100 / (r_pullup + r_ntc_100)
        # Recommended pullup: geometric mean of NTC at warn and shutdown → midpoint sensing
        r_pullup_opt = math.sqrt(r_ntc_80 * r_ntc_100)  # geometric mean → ≈ Vref/2 midpoint
        r_pullup_std_kohm = _nearest_e(r_pullup_opt / 1e3, E24)

        return {
            "ovp": {
                "trip_voltage_v":           v_ovp_trip,
                "r1_kohm":                  round(r1_ovp / 1e3, 0),
                "r2_kohm":                  round(r2_ovp_std / 1e3, 2),
                "r2_standard_kohm":         round(r2_ovp_std / 1e3, 2),
                "r2_is_override":           r2_is_override,
                "actual_trip_v":            round(v_trip_ovp_actual, 2),
                "divider_current_ua":        round(i_divider_ovp_ua,  2),
                "c_filter_nf":              round(c_filter_ovp_nf, 1),
                "f_cutoff_hz":              f_cutoff_ovp_hz,
                "tvs_v_rwm_suggested":      v_rwm_suggested,
                "tvs_v_clamp_typ":          v_clamp_typ,
                "v_bus_monitored":           self.v_peak,
                "v_adc_ref":                v_ref,
                "divider_ratio":            round(self.v_peak / v_ref, 2) if v_ref > 0 else None,
                "comparator":               "LM393 / internal MCU comparator",
                "response":                 "Hardware → disable PWM gate signals within 1µs",
            },
            "uvp": {
                "trip_voltage_v":       v_uvp_trip,
                "hysteresis_voltage_v": v_uvp_hyst,
                "r1_kohm":              round(r1_uvp / 1e3, 0),
                "r2_kohm":              round(r2_uvp / 1e3, 2),
                "r2_standard_kohm":     round(r2_uvp_std / 1e3, 2),
                "r2_is_override":       r2_is_override,
                "actual_trip_v":        round(v_trip_uvp_actual, 2),
                "divider_current_ua":   round(i_divider_uvp_ua,  2),
                "c_filter_nf":          round(c_filter_uvp_nf, 1),
                "f_cutoff_hz":          f_cutoff_uvp_hz,
                "response":             "Disable gate drive, wait for recovery above hysteresis level",
            },
            "ocp": {
                "hw_threshold_a":       ocp_hw_a,
                "sw_threshold_a":       ocp_sw_a,
                "hw_response_us":       1.0,
                "sw_response_us":       10.0,
                "mechanism":            "Driver IC OCP (hw) + MCU comparator (sw)",
            },
            "otp": {
                "ntc_value_at_25c_kohm":   ntc_r25_kohm,
                "ntc_b_coefficient":        int(b_ntc),
                "r_pullup_kohm":            ntc_pullup_kohm,
                "r_pullup_recommended_kohm":r_pullup_std_kohm,
                "warning_temp_c":           otp_warn,
                "shutdown_temp_c":          otp_shut,
                "v_ntc_at_80c_v":           round(v_ntc_80,  3),
                "v_ntc_at_100c_v":          round(v_ntc_100, 3),
                "ntc_part":                 f"Murata NCP15 {ntc_r25_kohm:.0f}kΩ B{int(ntc_b_coeff)}, 0402",
            },
            "tvs": {
                "standoff_v":           v_rwm_suggested,
                "clamping_v":           v_clamp_typ,
                "power_rating_w":       600,
                "part":                 f"SMBJ{int(v_rwm_suggested)}A or P6KE{int(v_rwm_suggested)}A",
                "qty":                  2,
                "placement":            "Across bus capacitors, close to bridge",
            },
            "reverse_polarity": {
                "type":                 "P-ch MOSFET ideal diode",
                "part":                 "Si7617DN (60V, 50A) or LTC4366",
                "vds_rating_v":         60,
            },
            "_meta": self._module_meta.get("protection_dividers", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 8. Power Supply Bypassing
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_power_supply_bypass(self) -> dict:
        self._current_module = "power_supply_bypass"

        # Configurable bypass capacitor values
        def _flt(key, default):
            try: return float(self.ovr.get(key, default))
            except (TypeError, ValueError): return float(default)
        def _int(key, default):
            try: return int(float(self.ovr.get(key, default)))
            except (TypeError, ValueError): return int(default)

        vcc_bulk_uf    = _flt("vcc_bulk_uf",    10.0)
        vcc_bulk_v     = _flt("vcc_bulk_v",     25.0)
        vcc_bypass_nf  = _flt("vcc_bypass_nf",  100.0)
        mcu_bulk_uf    = _flt("mcu_bulk_uf",    10.0)
        mcu_bypass_nf  = _flt("mcu_bypass_nf",  100.0)
        mcu_bypass_qty = _int("mcu_bypass_qty",   4)

        self.audit_log.append(
            f"[Power Supply] Gate driver bypass: {vcc_bulk_uf:.0f}µF/{vcc_bulk_v:.0f}V bulk + {vcc_bypass_nf:.0f}nF HF. "
            f"MCU bypass: {mcu_bulk_uf:.0f}µF bulk + {mcu_bypass_qty}×{mcu_bypass_nf:.0f}nF."
        )

        # Use extracted MCU VDD range if available, otherwise fall back to 3.3V.
        mcu_vdd_raw = self.mcu.get("vdd_range") if self.mcu else None
        mcu_vdd_v = 3.3
        if mcu_vdd_raw not in (None, ""):
            try:
                vdd_str = str(mcu_vdd_raw).strip().replace("–", "-").lower().replace("to", "-")
                parts = [p.strip() for p in vdd_str.split("-") if p.strip()]
                if len(parts) >= 2:
                    mcu_vdd_v = float(parts[-1])
                else:
                    mcu_vdd_v = float(parts[0])
                self.audit_log.append(f"[Power Supply] Using extracted MCU VDD = {mcu_vdd_v}V for bypass sizing.")
            except (TypeError, ValueError, IndexError):
                self.audit_log.append("[Power Supply] WARNING: Could not parse MCU VDD range. Defaulting to 3.3V.")
        else:
            self.audit_log.append("[Power Supply] MCU VDD not extracted, defaulting to 3.3V.")

        return {
            "vcc_gate_driver": {
                "voltage_v":        self.v_drv,
                "bulk_cap_uf":      vcc_bulk_uf,
                "bulk_v_rating":    vcc_bulk_v,
                "bypass_cap_nf":    vcc_bypass_nf,
                "bypass_v_rating":  vcc_bulk_v,
                "bypass_qty":       2,
                "note":             "Place as close as possible to driver VCC pin",
            },
            "vdd_5v_logic": {
                "voltage_v":        5.0,
                "bulk_cap_uf":      10.0,
                "bypass_cap_nf":    100,
                "bypass_qty":       2,
                "note":             "If 5V rail used for level shifting or gate signal logic",
            },
            "vdd_mcu": {
                "voltage_v":        mcu_vdd_v,
                "bulk_cap_uf":      mcu_bulk_uf,
                "bypass_cap_nf":    mcu_bypass_nf,
                "bypass_qty":       mcu_bypass_qty,
                "note":             f"One {mcu_bypass_nf:.0f}nF per MCU power pin, one bulk per voltage domain ({mcu_vdd_v}V MCU)",
            },
            "adc_reference": {
                "cap_nf":           100,
                "note":             "Dedicated 100nF + 1µF on VREF pin, shortest possible trace to AGND",
            },
            "notes": {
                "decoupling_rule":  "Every IC power pin needs 100nF within 2mm + bulk 10µF within 10mm",
                "placement":        "Decoupling caps on same layer as IC — never on opposite side",
            },
            "_meta": self._module_meta.get("power_supply_bypass", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 9. EMI Filter
    # ═══════════════════════════════════════════════════════════════════

