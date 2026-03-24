"""Motor Controller Hardware Design — Protection Calculations"""
import math
from calculations.base import _nearest_e, E24


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
        r1_ovp       = 100e3   # fix R1 = 100kΩ
        self._log_hc("protection_dividers", "OVP/UVP R1", "100 kΩ", "Fixed top divider resistor for low bias current")
        r2_ovp       = r1_ovp * r_ratio_ovp
        r2_ovp_std   = max(1e3, _nearest_e(r2_ovp / 1e3, E24) * 1e3)  # clamp min 1kΩ to avoid div-by-zero
        if r2_ovp < 1e3:
            self.audit_log.append(
                f"[Protection] WARNING: OVP divider is degenerate — V_trip ({v_ovp_trip}V) is too close to "
                f"V_ref ({v_ref}V). R2 clamped to 1kΩ minimum. Verify system voltages."
            )
        v_trip_ovp_actual = v_ref * (r1_ovp + r2_ovp_std) / r2_ovp_std
        i_divider_ovp_ua  = (self.v_peak / (r1_ovp + r2_ovp_std)) * 1e6

        # ── UVP ──
        uvp_trip_frac = self._dc("prot.uvp_trip")
        v_uvp_trip  = round(self.v_bus * uvp_trip_frac, 1)
        v_uvp_hyst  = round(self.v_bus * (uvp_trip_frac + 0.04), 1)
        self._log_hc("protection_dividers", "UVP trip", f"{round(uvp_trip_frac*100)}% of Vbus", "Under-voltage protection threshold", "prot.uvp_trip")
        self._log_hc("protection_dividers", "UVP hysteresis", f"{round((uvp_trip_frac+0.04)*100)}% of Vbus", "Re-enable threshold")
        v_uvp_diff  = v_uvp_trip - v_ref
        r_ratio_uvp = 0 if v_uvp_diff <= 0 else v_ref / v_uvp_diff
        r1_uvp      = 100e3
        r2_uvp      = r1_uvp * r_ratio_uvp
        r2_uvp_std  = max(1e3, _nearest_e(r2_uvp / 1e3, E24) * 1e3)  # clamp min 1kΩ
        if r2_uvp < 1e3:
            self.audit_log.append(
                f"[Protection] WARNING: UVP divider is degenerate — V_trip ({v_uvp_trip}V) is too close to "
                f"V_ref ({v_ref}V). R2 clamped to 1kΩ minimum."
            )
        i_divider_uvp_ua = (self.v_bus / (r1_uvp + r2_uvp_std)) * 1e6

        # ── OCP threshold (shunt-based) ──
        ocp_hw_mult = self._dc("prot.ocp_hw")
        ocp_sw_mult = self._dc("prot.ocp_sw")
        ocp_hw_a    = round(self.i_max * ocp_hw_mult, 0)
        ocp_sw_a    = round(self.i_max * ocp_sw_mult, 0)
        self._log_hc("protection_dividers", "OCP hardware", f"{ocp_hw_mult}x I_max", "Hardware overcurrent trip point", "prot.ocp_hw")
        self._log_hc("protection_dividers", "OCP software", f"{ocp_sw_mult}x I_max", "Software overcurrent trip point", "prot.ocp_sw")

        # ── OTP NTC divider ──
        # NTC 10kΩ@25°C, B=3950, R@80°C = 10k × exp(B×(1/353 - 1/298))
        b_ntc       = 3950
        otp_warn = self._dc("prot.otp_warn")
        otp_shut = self._dc("prot.otp_shutdown")
        self._log_hc("protection_dividers", "NTC specs", "10kΩ@25°C, B=3950", "Standard NTC thermistor")
        self._log_hc("protection_dividers", "OTP warning", f"{otp_warn} °C", "Temperature warning threshold", "prot.otp_warn")
        self._log_hc("protection_dividers", "OTP shutdown", f"{otp_shut} °C", "Temperature shutdown threshold", "prot.otp_shutdown")
        t_trip_k    = otp_warn + 273.15
        t_25_k      = 298.15
        r_ntc_80    = 10000 * math.exp(b_ntc * (1/t_trip_k - 1/t_25_k))
        # Pullup = 10kΩ, V_ntc at 80°C
        r_pullup    = 10000
        v_ntc_80    = v_ref * r_ntc_80 / (r_pullup + r_ntc_80)
        # NTC at shutdown temp
        t_100_k     = otp_shut + 273.15
        r_ntc_100   = 10000 * math.exp(b_ntc * (1/t_100_k - 1/t_25_k))
        v_ntc_100   = v_ref * r_ntc_100 / (r_pullup + r_ntc_100)
        
        self.audit_log.append("[Protection] Hardcoded TVS power rating to 600W (SMBJ/P6KE style) for bus clamping.")
        self._log_hc("protection_dividers", "TVS power rating", "600 W", "SMBJ/P6KE style for bus clamping")

        return {
            "ovp": {
                "trip_voltage_v":       v_ovp_trip,
                "r1_kohm":              round(r1_ovp / 1e3, 0),
                "r2_kohm":              round(r2_ovp_std / 1e3, 2),
                "r2_standard_kohm":     round(r2_ovp_std / 1e3, 2),
                "actual_trip_v":        round(v_trip_ovp_actual, 2),
                "divider_current_ua":   round(i_divider_ovp_ua,  2),
                "comparator":           "LM393 / internal MCU comparator",
                "response":             "Hardware → disable PWM gate signals within 1µs",
            },
            "uvp": {
                "trip_voltage_v":       v_uvp_trip,
                "hysteresis_voltage_v": v_uvp_hyst,
                "r1_kohm":              round(r1_uvp / 1e3, 0),
                "r2_kohm":              round(r2_uvp / 1e3, 2),
                "r2_standard_kohm":     round(r2_uvp_std / 1e3, 2),
                "divider_current_ua":   round(i_divider_uvp_ua,  2),
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
                "ntc_value_at_25c_kohm": 10,
                "ntc_b_coefficient":    b_ntc,
                "r_pullup_kohm":        round(r_pullup / 1e3, 0),
                "warning_temp_c":       otp_warn,
                "shutdown_temp_c":      otp_shut,
                "v_ntc_at_80c_v":       round(v_ntc_80,  3),
                "v_ntc_at_100c_v":      round(v_ntc_100, 3),
                "ntc_part":             "Murata NCP15 10kΩ B3950, 0402",
            },
            "tvs": {
                "standoff_v":           round(self.v_peak * 1.0, 0),
                "clamping_v":           round(self.v_peak * 1.35, 0),
                "power_rating_w":       600,
                "part":                 f"SMBJ{round(self.v_peak * 1.0)}A or P6KE{round(self.v_peak * 1.1)}A",
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
        self.audit_log.append("[Power Supply] Assumed 10µF bulk and 100nF bypass logic decoupling capacitors across all ICs.")
        self._log_hc("power_supply_bypass", "Gate driver VCC bulk", "10 µF / 25V", "Standard bulk decoupling")
        self._log_hc("power_supply_bypass", "Bypass cap", "100 nF / 25V", "Standard HF decoupling per IC")
        self._log_hc("power_supply_bypass", "MCU bypass count", "4 pcs", "One per MCU power pin")

        # Use extracted MCU VDD range if available, otherwise fall back to 3.3V
        mcu_vdd = self._get(self.mcu, "MCU", "vdd_range", None, expected_unit="V")
        if mcu_vdd is not None:
            try:
                mcu_vdd_v = float(mcu_vdd)
            except (TypeError, ValueError):
                mcu_vdd_v = 3.3
            self.audit_log.append(f"[Power Supply] Using extracted MCU VDD = {mcu_vdd_v}V for bypass sizing.")
        else:
            mcu_vdd_v = 3.3
            self.audit_log.append("[Power Supply] MCU VDD not extracted, defaulting to 3.3V for bypass sizing.")

        return {
            "vcc_gate_driver": {
                "voltage_v":        self.v_drv,
                "bulk_cap_uf":      10.0,
                "bulk_v_rating":    25,
                "bypass_cap_nf":    100,
                "bypass_v_rating":  25,
                "bypass_qty":       2,
                "note":             f"Place as close as possible to driver VCC pin",
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
                "bulk_cap_uf":      10.0,
                "bypass_cap_nf":    100,
                "bypass_qty":       4,
                "note":             f"One 100nF per MCU power pin, one bulk per voltage domain ({mcu_vdd_v}V MCU)",
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

