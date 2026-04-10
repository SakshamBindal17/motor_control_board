"""Motor Controller Hardware Design — Passives Calculations"""
import math
from calculations.base import _nearest_e


class PassivesMixin:
    """Mixin providing calculations for: input_capacitors, shunt_resistors, snubber."""

    # ═══════════════════════════════════════════════════════════════════
    def calc_input_capacitors(self) -> dict:
        self._current_module = "input_capacitors"
        i_dc    = 0 if self.v_bus == 0 else self.power / self.v_bus
        try:
            delta_v = float(self.ovr.get("delta_v_ripple", 2.0))
        except (TypeError, ValueError):
            delta_v = 2.0
        if delta_v <= 0:
            self.audit_log.append(f"[DC Bus] WARNING: Invalid ripple target ΔV={delta_v}V. Using 2.0V default.")
            delta_v = 2.0
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
            spwm_term = sq3 / math.pi - 3 * sq3 / (4 * math.pi) * M
            if spwm_term <= 0:
                # Should not happen with bounded M, but keep robust against malformed inputs.
                self.audit_log.append(
                    f"[DC Bus] WARNING: Invalid SPWM term ({spwm_term:.4f}) at M={M}. "
                    "Clamping to 0 for ripple estimate."
                )
                spwm_term = 0.0
            i_ripple_rms = (M * self.i_max / 2) * math.sqrt(spwm_term)
            ripple_method = f"3-phase SPWM estimate M={M} — enter motor Lph for accurate calc"

        # Required bulk capacitance for 3-phase inverter DC bus
        # C = I_ripple / (2 * fsw * delta_V) — standard formula for VSI DC-link
        c_req_uf = (i_ripple_rms / (2 * fsw * delta_v)) * 1e6

        # Parallel electrolytics (standard choice)
        min_bulk = int(self._dc("input.min_bulk_count"))
        bulk_uf  = self._dc("input.bulk_cap_uf")
        self._log_hc("input_capacitors", "Minimum bulk cap count", f"{min_bulk} pcs", "Minimum parallel caps for ESR and thermal distribution", "input.min_bulk_count")
        self._log_hc("input_capacitors", "Bulk cap size", f"{bulk_uf} µF each", "Standard electrolytic value for bus decoupling", "input.bulk_cap_uf")
        n_caps   = max(min_bulk, math.ceil(c_req_uf / bulk_uf))
        c_total  = n_caps * bulk_uf   # µF
        v_ripple_actual = (i_ripple_rms / (2 * fsw * c_total * 1e-6))

        # ESR budget
        esr_total_budget_mohm = 0 if i_ripple_rms == 0 else (delta_v / i_ripple_rms) * 1000
        esr_per_cap           = esr_total_budget_mohm * n_caps

        # Ripple current per cap (they share it)
        i_rip_per_cap = 0 if n_caps == 0 else i_ripple_rms / n_caps

        # ── Film + MLCC overrides ──────────────────────────────────────────────
        def _flt(key, default):
            try: return float(self.ovr.get(key, default))
            except (TypeError, ValueError): return float(default)
        def _int(key, default):
            try: return int(float(self.ovr.get(key, default)))
            except (TypeError, ValueError): return int(default)

        bulk_v_rating  = _int("bulk_v_rating_v",  100)
        film_qty       = _int("film_qty",           2)
        film_size_uf   = _flt("film_size_uf",       4.7)
        film_v_rating  = _int("film_v_rating_v",   100)
        mlcc_qty       = _int("mlcc_qty",            6)
        mlcc_size_nf   = _flt("mlcc_size_nf",      100.0)
        mlcc_esr_mohm  = _flt("mlcc_esr_mohm",       5.0)
        bulk_esl_nh    = _flt("bulk_esl_nh", 15.0)
        film_esl_nh    = _flt("film_esl_nh", 5.0)
        mlcc_esl_nh    = _flt("mlcc_esl_nh", 1.0)
        
        esr_typ_mohm = self._dc("input.esr_per_cap")
        self._log_hc("input_capacitors", "Typical ESR per bulk cap", f"{esr_typ_mohm} mΩ", "Electrolytic ESR estimate for thermal calc", "input.esr_per_cap")

        # ── Parallel Impedance Network Splitting ────────────────────────────────
        w = 2 * math.pi * max(fsw, 1000)
        def _z(c_uf, esr_mohm, esl_nh, qty):
            if qty <= 0 or c_uf <= 0: return complex(1e9, 0)
            c_f = c_uf * 1e-6 * qty
            esr_ohm = (esr_mohm * 1e-3) / qty
            esl_h = (esl_nh * 1e-9) / qty
            return complex(esr_ohm, w * esl_h - 1 / (w * c_f))

        Z_bulk = _z(bulk_uf, esr_typ_mohm, bulk_esl_nh, n_caps)
        Z_film = _z(film_size_uf, 5.0, film_esl_nh, film_qty) # 5mΩ typical film ESR
        Z_mlcc = _z(mlcc_size_nf * 1e-3, mlcc_esr_mohm, mlcc_esl_nh, mlcc_qty)

        Y_total = (1/Z_bulk) + (1/Z_film) + (1/Z_mlcc)
        Z_eq = 1 / Y_total

        # Split ripple current
        I_bulk = i_ripple_rms * abs(Z_eq / Z_bulk)
        I_film = i_ripple_rms * abs(Z_eq / Z_film)
        I_mlcc = i_ripple_rms * abs(Z_eq / Z_mlcc)

        p_cap_total = (I_bulk**2) * Z_bulk.real
        p_per_cap   = 0 if n_caps == 0 else p_cap_total / n_caps
        mlcc_power_loss_w = (I_mlcc**2) * Z_mlcc.real

        mlcc_parallel_esr_mohm = round(mlcc_esr_mohm / mlcc_qty, 3) if mlcc_qty > 0 else mlcc_esr_mohm
        i_rip_per_cap = 0 if n_caps == 0 else I_bulk / n_caps

        self.audit_log.append(
            f"[DC Bus] Parallel high-frequency impedance split at {fsw/1000:.0f}kHz: "
            f"I_bulk={I_bulk:.1f}A, I_film={I_film:.1f}A, I_mlcc={I_mlcc:.1f}A."
        )

        return {
            "i_dc_a":                    round(i_dc,               2),
            "i_ripple_rms_a":            round(i_ripple_rms,       2),
            "ripple_method":             ripple_method,
            "delta_v_target_v":          delta_v,
            "c_bulk_required_uf":        round(c_req_uf,           1),
            "n_bulk_caps":               n_caps,
            "c_per_bulk_cap_uf":         bulk_uf,
            "c_total_uf":                c_total,
            "v_rating_bulk_v":           bulk_v_rating,
            "v_ripple_actual_v":         round(v_ripple_actual,    4),
            "esr_budget_total_mohm":     round(esr_total_budget_mohm, 1),
            "esr_budget_per_cap_mohm":   round(esr_per_cap,        1),
            "i_ripple_per_cap_a":        round(i_rip_per_cap,      2),
            "cap_dissipation_w":         round(p_cap_total,        3),
            "cap_dissipation_per_cap_w": round(p_per_cap,          4),
            "c_film_uf":                 film_size_uf,
            "c_film_v_rating":           film_v_rating,
            "c_film_qty":                film_qty,
            "c_mlcc_nf":                 mlcc_size_nf,
            "c_mlcc_esr_per_cap_mohm":   mlcc_esr_mohm,
            "c_mlcc_parallel_esr_mohm":  mlcc_parallel_esr_mohm,
            "c_mlcc_power_loss_w":       mlcc_power_loss_w,
            "c_mlcc_v_rating":           100,
            "c_mlcc_qty":                mlcc_qty,
            "c_mlcc_dielectric":         "X7R",
            "recommended_bulk_part":     f"Panasonic EEU-FC2A101 ({bulk_uf:.0f}µF/{bulk_v_rating}V, 1.94A ripple)",
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

        # ── Topology selection ─────────────────────────────────────────────
        topology = str(self.ovr.get("shunt_topology", "three_phase")).strip().lower()
        if topology not in ("single", "three_phase"):
            topology = "three_phase"
        self.audit_log.append(f"[Current Sensing] Topology: {topology}.")

        # ── CSA gain ────────────────────────────────────────────────────────
        csa_gain_ds = self._get(self.driver, "DRIVER", "current_sense_gain", None)
        csa_gain_override_raw = self.ovr.get("csa_gain_override")
        if csa_gain_override_raw is not None:
            try:
                csa_gain = float(csa_gain_override_raw)
                self.audit_log.append(f"[Current Sensing] CSA gain manually overridden to {csa_gain}.")
            except (TypeError, ValueError):
                csa_gain = csa_gain_ds if (csa_gain_ds and csa_gain_ds > 0) else 20
        else:
            csa_gain = csa_gain_ds if (csa_gain_ds and csa_gain_ds > 0) else 20

        # ── ADC reference ───────────────────────────────────────────────────
        adc_ref_from_mcu = self._get(self.mcu, "MCU", "adc_ref", None)
        if adc_ref_from_mcu is not None and adc_ref_from_mcu > 0:
            adc_ref = adc_ref_from_mcu
            self.audit_log.append(f"[Current Sensing] Using ADC reference {adc_ref}V from MCU datasheet.")
        else:
            adc_ref = self._dc("prot.adc_ref")
            self._log_hc("shunt_resistors", "ADC reference", f"{adc_ref} V", "MCU ADC reference voltage (default)", "prot.adc_ref")

        adc_bits = self._get(self.mcu, "MCU", "adc_resolution", 12) or 12
        lsb_mv   = (adc_ref * 1000) / (2 ** int(adc_bits))

        def _mohm_ovr(key, default_val):
            try:
                v = float(self.ovr.get(key, default_val))
                return v if v > 0 else float(default_val)
            except (TypeError, ValueError):
                return float(default_val)

        # ── SINGLE SHUNT ────────────────────────────────────────────────────
        if topology == "single":
            # Bidirectional sensing: target 50% ADC ref so ±Imax maps to 0..Vref
            v_adc_target = adc_ref * 0.5
            self._log_hc("shunt_resistors", "ADC target (single, bidir)",
                         f"{v_adc_target} V", "50% of ADC ref — bidirectional FOC")
            r_ideal_mohm = (v_adc_target / (i_max * csa_gain)) * 1000
            r1_mohm_auto = 0.5 if r_ideal_mohm <= 0.75 else 1.0
            r1_mohm = _mohm_ovr("shunt_single_mohm", r1_mohm_auto)
            if "shunt_single_mohm" not in self.ovr:
                self._log_hc("shunt_resistors", "Single shunt auto-select", f"{r1_mohm} mOhm",
                             "Snapped to 0.5 or 1.0 mOhm standard value")
            v_sh_mv  = i_max * r1_mohm * 1e-3 * 1000
            v_adc    = v_sh_mv * 1e-3 * csa_gain
            p_dc_w   = i_max**2 * r1_mohm * 1e-3
            p_rms_w  = (i_max / math.sqrt(2))**2 * r1_mohm * 1e-3
            bits_used = math.log2(v_adc * 1000 / lsb_mv) if v_adc > 0 else 0
            active = {
                "topology":       "single",
                "quantity":       1,
                "location":       "DC bus low-side return (between GND and bottom FETs)",
                "value_mohm":     r1_mohm,
                "v_shunt_mv":     round(v_sh_mv,  2),
                "v_adc_v":        round(v_adc,    3),
                "v_adc_target_v": round(v_adc_target, 3),
                "adc_utilisation_pct": round(v_adc / adc_ref * 100, 1),
                "adc_bits_used":  round(bits_used, 1),
                "power_dc_w":     round(p_dc_w,   3),
                "power_rms_w":    round(p_rms_w,  3),
                "total_power_w":  round(p_dc_w,   3),
                "recommended":    "Isabellenhutte PMR / Vishay WSL 4-terminal Kelvin, 0.5 or 1 mOhm",
                "note":           "Single shunt requires ADC sample timing synchronised to PWM cycle.",
            }

        # ── THREE-PHASE SHUNTS ──────────────────────────────────────────────
        else:
            # Unidirectional: target 80% ADC ref to maximise dynamic range
            v_adc_target = adc_ref * 0.8
            self._log_hc("shunt_resistors", "ADC target (3-ph, unidir)",
                         f"{v_adc_target} V", "80% of ADC ref — unidirectional per-phase sensing")
            r_ideal_mohm = (v_adc_target / (i_max * csa_gain)) * 1000
            r3_mohm_auto = 0.5 if r_ideal_mohm <= 0.75 else 1.0
            r3_mohm = _mohm_ovr("shunt_three_mohm", r3_mohm_auto)
            if "shunt_three_mohm" not in self.ovr:
                self._log_hc("shunt_resistors", "3-phase shunt auto-select", f"{r3_mohm} mOhm",
                             "Snapped to 0.5 or 1.0 mOhm standard value")
            v_sh_mv  = i_max * r3_mohm * 1e-3 * 1000
            v_adc    = v_sh_mv * 1e-3 * csa_gain
            p_rms_ea = (i_max / math.sqrt(2))**2 * r3_mohm * 1e-3
            bits_used = math.log2(v_adc * 1000 / lsb_mv) if v_adc > 0 else 0
            active = {
                "topology":       "three_phase",
                "quantity":       3,
                "location":       "Each phase low-side MOSFET source return (U, V, W)",
                "value_mohm":     r3_mohm,
                "v_shunt_mv":     round(v_sh_mv,  2),
                "v_adc_v":        round(v_adc,    3),
                "v_adc_target_v": round(v_adc_target, 3),
                "adc_utilisation_pct": round(v_adc / adc_ref * 100, 1),
                "adc_bits_used":  round(bits_used, 1),
                "power_rms_per_shunt_w": round(p_rms_ea, 3),
                "total_power_w":  round(p_rms_ea * 3, 3),
                "recommended":    "Isabellenhutte PMR 0.5 mOhm x3, Kelvin 4-terminal",
                "note":           "3-phase topology allows simultaneous phase current sampling. Best for FOC.",
            }

        return {
            "topology_mode":   topology,
            "csa_gain":        csa_gain,
            "csa_gain_source": "manual_override" if csa_gain_override_raw is not None
                               else ("datasheet" if csa_gain_ds else "default"),
            "adc_reference_v": adc_ref,
            "ideal_r_mohm":    round(r_ideal_mohm, 3),
            "active":          active,
            # Legacy keys kept for backward compatibility
            "single_shunt":    active if topology == "single" else {
                                   "value_mohm": None, "v_shunt_mv": None,
                                   "v_adc_v": None, "power_dc_w": None, "power_rms_w": None},
            "three_shunt":     active if topology == "three_phase" else {
                                   "value_mohm": None, "v_shunt_mv": None,
                                   "v_adc_v": None, "total_3_shunt_power_w": None},
            "notes": {
                "kelvin":    "MANDATORY 4-wire Kelvin sensing — sense traces inside power traces",
                "tc":        "Use <50 ppm/C temperature coefficient shunt",
                "tolerance": "+/-1% or better for accurate FOC",
                "topology":  "Populate EITHER single shunt OR 3-phase shunts — never both simultaneously",
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
        try:
            l_stray_nh = float(self.ovr.get("stray_inductance_nh", 10.0))
        except (TypeError, ValueError):
            l_stray_nh = 10.0
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
        if l_stray_nh == 10.0:
            self.audit_log.append("[Snubber] Stray layout inductance not specified. Assumed 10nH default.")
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
              5600,6800,8200,10000,12000,15000,18000,22000,27000,33000,47000,
              56000,68000,82000,100000,120000,150000,180000,220000,270000,330000,470000,
              560000,680000,820000,1000000]
        cs_pf_std = float(next((v for v in E12_pF if v >= cs_pf_raw), E12_pF[-1]))
        cs_pf_std = max(100.0, cs_pf_std)

        # ── Snubber value overrides ──────────────────────────────────────────────
        snub_rs_raw  = self.ovr.get("snubber_rs_ohm")
        snub_cs_raw  = self.ovr.get("snubber_cs_pf")
        snub_v_mult  = 2.0
        try: snub_v_mult = float(self.ovr.get("snubber_v_mult", 2.0))
        except (TypeError, ValueError): pass

        manual_snubber = False
        try:
            rs_man = float(snub_rs_raw)
            cs_man = float(snub_cs_raw)
            if rs_man > 0 and cs_man > 0:
                rs_recommend = rs_man
                cs_recommend = cs_man
                manual_snubber = True
                self.audit_log.append(
                    f"[Snubber] Manual override: Rs={rs_man}Ω, Cs={cs_man:.0f}pF entered by user."
                )
        except (TypeError, ValueError):
            pass

        if not manual_snubber:
            rs_recommend = max(1.0, min(100.0, round(rs_std, 0)))
            cs_recommend = cs_pf_std

        cap_v_rating = int(self.v_peak * snub_v_mult)
        # Dynamic snubber cap label
        if cs_recommend >= 1000:
            cs_label = f"{cs_recommend/1000:.0f}nF / {cap_v_rating}V X7R MLCC"
        else:
            cs_label = f"{cs_recommend:.0f}pF / {cap_v_rating}V X7R MLCC"

        # Snubber power dissipation (per MOSFET)
        p_snubber = 0.5 * (cs_recommend * 1e-12) * (self.v_peak**2) * self.fsw
        p_snubber_total = p_snubber * self.num_fets

        # Qoss energy validation — compare snubber energy with Coss stored energy
        qoss = self._get(self.mosfet, "MOSFET", "qoss", None)  # C (SI)
        qoss_info = {}
        if qoss is not None:
            e_oss_uj  = qoss * self.v_peak / 2 * 1e6  # µJ
            e_snub_uj = 0.5 * (cs_recommend * 1e-12) * (self.v_peak ** 2) * 1e6  # µJ
            qoss_info = {
                "qoss_nC":              round(qoss * 1e9, 0),
                "e_oss_uj":             round(e_oss_uj, 2),
                "e_snubber_uj":         round(e_snub_uj, 2),
                "snubber_absorbs_oss":  e_snub_uj >= e_oss_uj,
            }
            self.audit_log.append(f"[Snubber] Qoss={qoss*1e9:.0f}nC from datasheet. E_oss={e_oss_uj:.1f}µJ, E_snub={e_snub_uj:.1f}µJ.")

        result = {
            "num_fets":                   self.num_fets,
            "stray_inductance_nh":        l_stray_nh,
            "coss_pf":                    coss_pf,
            "resonant_freq_mhz":          round(f_res_mhz,    1),
            "voltage_overshoot_v":        round(v_overshoot,   1),
            "v_sw_peak_v":                round(v_sw_peak,     1),
            "rs_critical_ohm":            round(rs_crit,       2),
            "rs_recommended_ohm":         rs_recommend,
            "cs_recommended_pf":          cs_recommend,
            "cs_recommended_label":       cs_label,
            "snubber_cap_v_rating":       cap_v_rating,
            "manual_snubber_values":      manual_snubber,
            "p_per_snubber_w":            round(p_snubber,     4),
            "p_total_all_snubbers_w":     round(p_snubber_total, 3),
            "p_total_6_snubbers_w":       round(p_snubber_total, 3),  # backward compat
            "rs_power_rating":            "0.1W minimum (0402)",
            "notes": {
                "rs_placement":   "Place Cs physically closest to MOSFET D-S pins",
                "v_rating":       f"Snubber cap voltage rating: {cap_v_rating}V minimum ({snub_v_mult:.1f}×Vpeak)",
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

