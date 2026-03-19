"""Motor Controller Hardware Design — Passives Calculations"""
import math
from calculations.base import _nearest_e


class PassivesMixin:
    """Mixin providing calculations for: input_capacitors, shunt_resistors, snubber."""

    # ═══════════════════════════════════════════════════════════════════
    def calc_input_capacitors(self) -> dict:
        self._current_module = "input_capacitors"
        i_dc    = 0 if self.v_bus == 0 else self.power / self.v_bus
        delta_v = float(self.ovr.get("delta_v_ripple", 2.0))
        if "delta_v_ripple" not in self.ovr:
            self._log_hc("input_capacitors", "Ripple voltage target", f"{delta_v} V", "User-configurable override (default 2.0V)")
        fsw     = self.fsw

        # Phase current ripple — use motor inductance if available, else worst-case D=0.5
        lph_uh = self.motor.get("lph_uh", "") if self.motor else ""
        try:
            lph = float(lph_uh) * 1e-6 if lph_uh not in ("", None) else 0.0
        except (TypeError, ValueError):
            lph = 0.0

        if lph > 0:
            # Accurate: ΔI = Vbus × D(1-D) / (Lph × fsw), worst-case D=0.5
            delta_i_phase = 0 if (lph == 0 or fsw == 0) else (self.v_bus * 0.25) / (lph * fsw)
            # RMS ripple on DC bus for 3-phase SPWM (phase interleaving reduces it)
            i_ripple_rms  = delta_i_phase / (2 * math.sqrt(3))
            ripple_method = f"Motor Lph={float(lph_uh):.1f}µH (accurate)"
        else:
            # 3-phase SPWM formula at M=0.9 (better than single-phase D=0.5 estimate)
            # I_cap_rms ≈ (M × I_pk / 2) × √(√3/π − 3√3/(4π) × M)
            M = self._dc("input.spwm_mod_index")
            self.audit_log.append(f"[Motor] Phase Ripple Calculation: Used estimated SPWM modulation index M={M}.")
            self._log_hc("input_capacitors", "SPWM modulation index", f"M = {M}", "Standard 3-phase SPWM approximation", "input.spwm_mod_index")
            sq3 = math.sqrt(3)
            i_ripple_rms = (M * self.i_max / 2) * math.sqrt(
                sq3 / math.pi - 3 * sq3 / (4 * math.pi) * M
            )
            ripple_method = f"3-phase SPWM estimate M={M} — enter motor Lph for accurate calc"

        # Required bulk capacitance
        c_req_uf = (i_ripple_rms / (8 * fsw * delta_v)) * 1e6

        # Parallel electrolytics (standard choice)
        min_bulk = int(self._dc("input.min_bulk_count"))
        bulk_uf  = self._dc("input.bulk_cap_uf")
        self._log_hc("input_capacitors", "Minimum bulk cap count", f"{min_bulk} pcs", "Minimum parallel caps for ESR and thermal distribution", "input.min_bulk_count")
        self._log_hc("input_capacitors", "Bulk cap size", f"{bulk_uf} µF each", "Standard electrolytic value for bus decoupling", "input.bulk_cap_uf")
        n_caps   = max(min_bulk, math.ceil(c_req_uf / bulk_uf))
        c_total  = n_caps * bulk_uf   # µF
        v_ripple_actual = (i_ripple_rms / (8 * fsw * c_total * 1e-6))

        # ESR budget
        esr_total_budget_mohm = 0 if i_ripple_rms == 0 else (delta_v / i_ripple_rms) * 1000
        esr_per_cap           = esr_total_budget_mohm * n_caps

        # Ripple current per cap (they share it)
        i_rip_per_cap = 0 if n_caps == 0 else i_ripple_rms / n_caps

        # Film cap (mid-freq 1kHz–1MHz)
        c_film_uf = 4.7
        self._log_hc("input_capacitors", "Film cap", "4.7 µF", "Mid-frequency decoupling")

        # MLCC HF decoupling per switch node
        c_mlcc_nf = 100
        self._log_hc("input_capacitors", "MLCC per switch node", "100 nF", "High-frequency decoupling")

        # Total capacitor dissipation (at rated ESR)
        esr_typ_mohm = self._dc("input.esr_per_cap")
        self._log_hc("input_capacitors", "Typical ESR per cap", f"{esr_typ_mohm} mΩ", "Electrolytic ESR estimate for thermal calc", "input.esr_per_cap")
        p_cap_total  = i_ripple_rms**2 * (esr_typ_mohm/1000) / n_caps

        self.audit_log.append("[DC Bus] Hardcoded standard decoupling: 50mΩ ESR per electrolytic, 4.7µF film, 100nF MLCC.")

        return {
            "i_dc_a":                   round(i_dc,               2),
            "i_ripple_rms_a":           round(i_ripple_rms,       2),
            "ripple_method":            ripple_method,
            "delta_v_target_v":         delta_v,
            "c_bulk_required_uf":       round(c_req_uf,           1),
            "n_bulk_caps":              n_caps,
            "c_per_bulk_cap_uf":        bulk_uf,
            "c_total_uf":               c_total,
            "v_rating_bulk_v":          100,
            "v_ripple_actual_v":        round(v_ripple_actual,    4),
            "esr_budget_total_mohm":    round(esr_total_budget_mohm, 1),
            "esr_budget_per_cap_mohm":  round(esr_per_cap,        1),
            "i_ripple_per_cap_a":       round(i_rip_per_cap,      2),
            "cap_dissipation_w":        round(p_cap_total,        3),
            "c_film_uf":                c_film_uf,
            "c_film_v_rating":          100,
            "c_film_qty":               2,
            "c_mlcc_nf":                c_mlcc_nf,
            "c_mlcc_v_rating":          100,
            "c_mlcc_qty":               6,
            "c_mlcc_dielectric":        "X7R",
            "recommended_bulk_part":    "Panasonic EEU-FC2A101 (100µF/100V, 1.94A ripple)",
            "notes": {
                "placement_bulk":  "Within 30mm of H-bridge, low-impedance bus bar",
                "placement_film":  "Within 20mm of each half-bridge section",
                "placement_mlcc":  "One per MOSFET switch node, as close as possible",
                "polarity":        "Electrolytic — verify polarity before power-on",
            },
            "_meta": self._module_meta.get("input_capacitors", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 4. Bootstrap Capacitor
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_shunt_resistors(self) -> dict:
        self._current_module = "shunt_resistors"
        i_max    = self.i_max
        csa_gain = self._get(self.driver, "DRIVER", "current_sense_gain", 20) or 20

        # Try to get ADC reference from MCU datasheet; fall back to design constant
        adc_ref_from_mcu = self._get(self.mcu, "MCU", "adc_ref", None)
        if adc_ref_from_mcu is not None and adc_ref_from_mcu > 0:
            adc_ref = adc_ref_from_mcu
            self.audit_log.append(f"[Current Sensing] Using ADC reference {adc_ref}V from MCU datasheet.")
        else:
            adc_ref = self._dc("prot.adc_ref")
            self._log_hc("shunt_resistors", "ADC reference", f"{adc_ref} V", "MCU ADC reference voltage (default — not extracted from MCU datasheet)", "prot.adc_ref")

        # Target 50% of ADC ref for bidirectional FOC
        v_adc_target = adc_ref / 2.0
        self._log_hc("shunt_resistors", "ADC target voltage", f"{v_adc_target} V", f"50% of {adc_ref}V ref for bidirectional FOC")
        self.audit_log.append(f"[Current Sensing] Assumed {adc_ref}V ADC with {v_adc_target}V bias target for bidirectional FOC.")
        r_ideal_mohm = (v_adc_target / (i_max * csa_gain)) * 1000

        # Standard shunt values
        r1_mohm  = 0.5 if r_ideal_mohm <= 0.75 else 1.0   # single shunt
        r3_mohm  = 0.5                                      # 3-phase always 0.5
        self._log_hc("shunt_resistors", "3-phase shunt value", "0.5 mΩ", "Standard low-side current sense resistor")

        # Single shunt
        v_sh1_mv   = i_max * r1_mohm * 1e-3 * 1000        # mV at Imax
        v_adc1     = v_sh1_mv * 1e-3 * csa_gain            # V at ADC
        p_sh1      = i_max**2 * r1_mohm * 1e-3             # W at Imax (DC)
        p_sh1_rms  = (i_max/math.sqrt(2))**2 * r1_mohm * 1e-3  # W RMS

        # 3-phase shunts
        v_sh3_mv   = i_max * r3_mohm * 1e-3 * 1000
        v_adc3     = v_sh3_mv * 1e-3 * csa_gain
        p_sh3_ea   = (i_max/math.sqrt(2))**2 * r3_mohm * 1e-3  # RMS per phase

        # ADC SNR budget — use extracted MCU ADC resolution, default 12-bit
        adc_bits = self._get(self.mcu, "MCU", "adc_resolution", 12) or 12
        lsb_mv   = (adc_ref * 1000) / (2 ** int(adc_bits))   # mV per LSB
        bits_used = math.log2(v_adc1 * 1000 / lsb_mv) if v_adc1 > 0 else 0

        return {
            "csa_gain":            csa_gain,
            "adc_reference_v":     adc_ref,
            "single_shunt": {
                "value_mohm":      r1_mohm,
                "location":        "DC bus low-side return (between GND and bottom FETs)",
                "v_shunt_mv":      round(v_sh1_mv,    2),
                "v_adc_v":         round(v_adc1,      3),
                "adc_bits_used":   round(bits_used,   1),
                "power_dc_w":      round(p_sh1,       3),
                "power_rms_w":     round(p_sh1_rms,   3),
                "recommended":     "Isabellenhutte PMR 4-terminal Kelvin, 0.5 or 1mΩ",
            },
            "three_shunt": {
                "value_mohm":      r3_mohm,
                "location":        "Each phase low-side MOSFET source return",
                "v_shunt_mv":      round(v_sh3_mv,    2),
                "v_adc_v":         round(v_adc3,      3),
                "power_rms_per_shunt_w": round(p_sh3_ea, 3),
                "total_3_shunt_power_w": round(p_sh3_ea * 3, 3),
                "recommended":     "Isabellenhutte PMR 0.5mΩ × 3",
            },
            "notes": {
                "kelvin":   "MANDATORY 4-wire Kelvin sensing — sense traces inside power traces",
                "tc":       "Use <50 ppm/°C temperature coefficient shunt",
                "tolerance":"±1% or better for accurate FOC",
                "jumper":   "Populate EITHER single shunt OR 3-phase shunts — use 0Ω jumper to select mode",
            },
            "_meta": self._module_meta.get("shunt_resistors", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 6. RC Snubber (Drain-Source)
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_snubber(self) -> dict:
        self._current_module = "snubber"
        # Parasitic PCB trace inductance (target <5nH, assume 10nH worst case)
        l_stray_nh  = float(self.ovr.get("stray_inductance_nh", self._dc("snub.stray_l_default")))
        l_stray     = l_stray_nh * 1e-9

        # _get returns SI value (Farads if unit is pF/nF/etc), fallback is raw value.
        # fallback 200e-12 = 200pF in SI (Farads)
        coss = self._get(self.mosfet, "MOSFET", "coss", 200e-12)   # Farads (SI)
        coss_pf = coss * 1e12  # convert back to pF for display and E12 snapping

        # Resonant frequency of stray L and Coss
        # f_res = 1 / (2π√(L×C))
        if l_stray > 0 and coss > 0:
            f_res_mhz = 1.0 / (2 * math.pi * math.sqrt(l_stray * coss)) / 1e6
        else:
            f_res_mhz = 50.0

        # Voltage overshoot: V_ov = I × sqrt(L/C)
        v_overshoot = self.i_max * math.sqrt(l_stray / max(coss, 1e-15))
        v_sw_peak   = self.v_peak + v_overshoot

        # Snubber resistor: critical damping Rs = sqrt(L/Cs) where Cs = snubber cap
        coss_mult_for_rs = int(self._dc("snub.coss_mult"))
        cs_for_rs   = max(coss * coss_mult_for_rs, 1e-15)
        rs_crit     = math.sqrt(l_stray / cs_for_rs)
        rs_std      = _nearest_e(rs_crit)
        
        # Log the stray inductance hardcode
        stray_default = self._dc("snub.stray_l_default")
        if l_stray_nh == stray_default:
            self.audit_log.append(f"[Snubber] Stray layout inductance missing. Assumed {stray_default}nH default.")
            self._log_hc("snubber", "Stray inductance", f"{stray_default} nH", "Assumed PCB loop inductance (worst case)", "snub.stray_l_default")
        self.audit_log.append("[Snubber] Targeted critical damping factor (ζ = 1) for switching overshoot resistor calculation.")
        if rs_std < 1.0: rs_std = 1.0    # practical minimum
        if rs_std > 100: rs_std = 100.0  # practical maximum

        coss_mult = int(self._dc("snub.coss_mult"))
        self._log_hc("snubber", "Snubber cap formula", f"{coss_mult}x Coss", "Overdamped RC snubber design rule", "snub.coss_mult")
        self._log_hc("snubber", "Rs practical limits", "1-100 Ω", "Physical resistor sizing constraints")
        # Snubber capacitor: Cs ≈ N× Coss, snapped to nearest E12 cap decade
        cs_pf_raw = coss_pf * coss_mult if coss_pf > 0 else 1000.0
        E12_pF = [100,120,150,180,220,270,330,390,470,560,680,820,
                  1000,1200,1500,1800,2200,2700,3300,4700,
                  5600,6800,8200,10000,12000,15000,18000,22000,27000,33000,47000]
        cs_pf_std = float(next((v for v in E12_pF if v >= cs_pf_raw), E12_pF[-1]))
        cs_pf_std = max(100.0, cs_pf_std)

        rs_recommend = max(1.0, min(100.0, round(rs_std, 0)))
        cs_recommend = cs_pf_std

        # Snubber power dissipation (per MOSFET)
        p_snubber = 0.5 * (cs_recommend * 1e-12) * (self.v_peak**2) * self.fsw
        p_snubber_total = p_snubber * 6

        # Qoss energy validation — compare snubber energy with Coss stored energy
        qoss = self._get(self.mosfet, "MOSFET", "qoss", None)  # C (SI)
        qoss_info = {}
        if qoss is not None:
            # Energy stored in Coss: E_oss ≈ Qoss × Vds / 2
            e_oss_uj = qoss * self.v_peak / 2 * 1e6  # µJ
            # Snubber cap stored energy: E_snub = 0.5 × Cs × V²
            e_snub_uj = 0.5 * (cs_recommend * 1e-12) * (self.v_peak ** 2) * 1e6  # µJ
            qoss_info = {
                "qoss_nC":           round(qoss * 1e9, 0),
                "e_oss_uj":          round(e_oss_uj, 2),
                "e_snubber_uj":      round(e_snub_uj, 2),
                "snubber_absorbs_oss": e_snub_uj >= e_oss_uj,
            }
            self.audit_log.append(f"[Snubber] Qoss={qoss*1e9:.0f}nC from datasheet. E_oss={e_oss_uj:.1f}µJ, E_snub={e_snub_uj:.1f}µJ.")

        result = {
            "stray_inductance_nh":      l_stray_nh,
            "coss_pf":                  coss_pf,
            "resonant_freq_mhz":        round(f_res_mhz,   1),
            "voltage_overshoot_v":      round(v_overshoot,  1),
            "v_sw_peak_v":              round(v_sw_peak,    1),
            "rs_critical_ohm":          round(rs_crit,      2),
            "rs_recommended_ohm":       rs_recommend,
            "cs_recommended_pf":        cs_recommend,
            "cs_recommended_label":     "1nF / 100V X7R MLCC",
            "p_per_snubber_w":          round(p_snubber,    4),
            "p_total_6_snubbers_w":     round(p_snubber_total, 3),
            "rs_power_rating":          "0.1W minimum (0402)",
            "notes": {
                "rs_placement":   "Place Cs physically closest to MOSFET D-S pins",
                "v_rating":       f"Snubber cap voltage rating: {int(self.v_peak * 2)}V minimum (2×Vpeak)",
                "reduce_stray":   "Reducing PCB stray inductance is more effective than snubbers",
                "pcb_technique":  "Use mirrored top/bottom copper pours for low-inductance half-bridge",
            },
            "_meta": self._module_meta.get("snubber", {"hardcoded": [], "fallbacks": []}),
        }
        if qoss_info:
            result["qoss_validation"] = qoss_info

        return result

    # ═══════════════════════════════════════════════════════════════════
    # 7. Protection Voltage Dividers
    # ═══════════════════════════════════════════════════════════════════

