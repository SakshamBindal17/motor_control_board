"""
Motor Controller Hardware Design — Calculation Engine v2
All passives calculations: gate resistors, capacitors, snubbers,
protection dividers, shunts, thermal, dead time, bootstrap, EMI filter.
"""
import math
from unit_utils import to_si

# ─── E-series standard values ─────────────────────────────────────────────────
E24 = [1.0,1.1,1.2,1.3,1.5,1.6,1.8,2.0,2.2,2.4,2.7,3.0,
       3.3,3.6,3.9,4.3,4.7,5.1,5.6,6.2,6.8,7.5,8.2,9.1]
E12 = [1.0,1.2,1.5,1.8,2.2,2.7,3.3,3.9,4.7,5.6,6.8,8.2]


def _nearest_e(value: float, series=E24) -> float:
    if value <= 0: return 1.0
    decade = 10 ** math.floor(math.log10(value))
    norm = value / decade
    for e in series:
        if e >= norm:
            return round(e * decade, 4)
    return round(series[-1] * decade * 10, 4)


def _get(params: dict, key: str, fallback=None, expected_unit: str = None):
    """
    Get value from flat params dict and convert to SI.

    The frontend sends:
      params[key]           = raw numeric value (in datasheet units, e.g. 1.5 for mΩ)
      params[key + '__unit'] = unit string from datasheet (e.g. "mΩ")

    If expected_unit is provided (e.g. "mΩ"), the value is assumed to already
    be in that unit and is converted to SI automatically.
    If __unit key is present, that overrides expected_unit.
    """
    val = params.get(key)
    if val is None or val == "":
        return fallback
    try:
        fval = float(val)
    except (TypeError, ValueError):
        return fallback

    # Determine unit: prefer what frontend sent, fall back to expected_unit
    unit = params.get(key + '__unit', expected_unit or '')
    if unit:
        return to_si(fval, unit)
    return fval


# ─── Main Engine ──────────────────────────────────────────────────────────────

class CalculationEngine:
    def __init__(self, system_specs, mosfet_params, driver_params,
                 mcu_params, motor_specs, overrides):
        self.sys      = system_specs
        self.mosfet   = mosfet_params
        self.driver   = driver_params
        self.mcu      = mcu_params
        self.motor    = motor_specs
        self.ovr      = overrides or {}
        self.audit_log  = []

        try:
            self.v_bus      = float(system_specs.get("bus_voltage",      48))
            self.v_peak     = float(system_specs.get("peak_voltage",     60))
            self.power      = float(system_specs.get("power",          3000))
            self.i_max      = float(system_specs.get("max_phase_current", 80))
            self.fsw        = float(system_specs.get("pwm_freq_hz",   20000))
            self.t_amb      = float(system_specs.get("ambient_temp_c",   30))
            self.v_drv      = float(system_specs.get("gate_drive_voltage",12))
        except (TypeError, ValueError) as e:
            raise ValueError(f"Invalid numeric value in system specs: {e}")

        # Validate critical system parameters
        if self.fsw <= 0:
            raise ValueError("PWM frequency (pwm_freq_hz) must be > 0 Hz")
        if self.v_bus <= 0:
            raise ValueError("Bus voltage (bus_voltage) must be > 0 V")
        if self.i_max <= 0:
            raise ValueError("Max phase current (max_phase_current) must be > 0 A")
        if self.v_drv <= 0:
            raise ValueError("Gate drive voltage (gate_drive_voltage) must be > 0 V")

    def _get(self, params: dict, block_name: str, key: str, fallback=None, expected_unit: str = None):
        val = params.get(key)
        if val is None or val == "":
            if fallback is not None:
                self.audit_log.append(f"[{block_name}] Missing '{key}', using fallback {fallback}{expected_unit or ''}")
            return fallback
        try:
            fval = float(val)
        except (TypeError, ValueError):
            if fallback is not None:
                self.audit_log.append(f"[{block_name}] Invalid numeric value for '{key}', using fallback {fallback}{expected_unit or ''}")
            return fallback

        from unit_utils import to_si
        unit = params.get(key + '__unit', expected_unit or '')
        if unit:
            return to_si(fval, unit)
        return fval


    # ═══════════════════════════════════════════════════════════════════
    # 1. MOSFET Losses
    # ═══════════════════════════════════════════════════════════════════
    def calc_mosfet_losses(self) -> dict:
        # _get now returns SI values (Ω, C, s) automatically via unit_utils
        # fallbacks are SI values too
        rds       = self._get(self.mosfet, "MOSFET", "rds_on",  1.5e-3)   # Ω
        qg        = self._get(self.mosfet, "MOSFET", "qg",      92e-9)    # C
        qgd       = self._get(self.mosfet, "MOSFET", "qgd",     30e-9)    # C
        tr        = self._get(self.mosfet, "MOSFET", "tr",       30e-9)   # s
        tf        = self._get(self.mosfet, "MOSFET", "tf",       20e-9)   # s
        rth_jc    = self._get(self.mosfet, "MOSFET", "rth_jc",   0.5)     # °C/W
        qrr       = self._get(self.mosfet, "MOSFET", "qrr",      44e-9)   # C

        # Display units for notes
        rds_mohm  = rds  * 1e3
        qg_nc     = qg   * 1e9
        qrr_nc    = qrr  * 1e9
        tr_ns     = tr   * 1e9
        tf_ns     = tf   * 1e9

        # RMS switch current (3-ph SPWM, each switch 1/3 active period)
        i_rms_sw = self.i_max * math.sqrt(1/6 + (math.sqrt(3)/(4*math.pi)))

        # Conduction loss with temp derating (×1.5 @ ~100°C)
        rds_hot = rds * 1.5
        self.audit_log.append("[MOSFET] Applied worst-case 1.5x thermal multiplier for Rds(on) at estimated ~100°C junction.")
        p_cond  = i_rms_sw**2 * rds_hot

        # Switching loss (overlap model)
        p_sw = 0.5 * self.v_peak * self.i_max * (tr + tf) * self.fsw

        # Reverse recovery loss
        p_rr = qrr * self.v_peak * self.fsw

        # Gate drive charge loss
        p_gate = qg * self.v_drv * self.fsw

        p_total_1 = p_cond + p_sw + p_rr + p_gate
        p_total_6 = p_total_1 * 6

        # Junction temp estimate
        t_junc = self.t_amb + p_total_1 * (rth_jc + 0.5 + 20.0)
        self.audit_log.append("[Thermal] Used hardcoded assumption for PCB via thermal resistance: 20°C/W and TIM: 0.5°C/W.")

        # Inverter switching losses only (excludes motor copper/core losses)
        eff = 0 if self.power == 0 else max(0, (1 - p_total_6 / self.power) * 100)

        return {
            "conduction_loss_per_fet_w":  round(p_cond,    3),
            "switching_loss_per_fet_w":   round(p_sw,      3),
            "recovery_loss_per_fet_w":    round(p_rr,      3),
            "gate_charge_loss_per_fet_w": round(p_gate,    4),
            "total_loss_per_fet_w":       round(p_total_1, 3),
            "total_all_6_fets_w":         round(p_total_6, 3),
            "i_rms_switch_a":             round(i_rms_sw,  2),
            "rds_on_derated_mohm":        round(rds_mohm*1.5, 3),
            "junction_temp_est_c":        round(t_junc,    1),
            "efficiency_mosfet_pct":      round(eff,       2),
            "notes": {
                "rds_basis":    f"Rds(on)={rds_mohm}mΩ × 1.5 temp derating",
                "sw_basis":     f"tr={tr_ns}ns, tf={tf_ns}ns @ fsw={self.fsw/1e3:.0f}kHz",
                "rr_basis":     f"Qrr={qrr_nc}nC × Vbus × fsw",
                "improvement":  "Increase fsw reduces motor ripple but increases switching losses",
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 2. Gate Resistors
    # ═══════════════════════════════════════════════════════════════════
    def calc_gate_resistors(self) -> dict:
        qg      = self._get(self.mosfet, "MOSFET", "qg",     92e-9)   # C (SI)
        vgs_th  = self._get(self.mosfet, "MOSFET", "vgs_th",  3.0)    # V
        ciss    = self._get(self.mosfet, "MOSFET", "ciss", 3000e-12)  # F (SI)

        io_src  = self._get(self.driver, "DRIVER", "io_source", 1.5)  # A (SI)
        io_snk  = self._get(self.driver, "DRIVER", "io_sink",   2.5)  # A (SI)

        t_rise_target_ns = float(self.ovr.get("gate_rise_time_ns", 40))
        t_rise = t_rise_target_ns * 1e-9
        vdrv   = self.v_drv

        if vdrv <= vgs_th:
            self.audit_log.append(f"[Gate Drive] WARNING: V_drive ({vdrv}V) <= Vgs_th ({vgs_th}V). MOSFET may not fully turn on. Using V_drive - Vgs_th = 1V minimum for calculations.")
            vgs_th = vdrv - 1.0  # clamp to avoid negative/zero resistance

        # display units
        qg_nc     = qg * 1e9
        io_src_a  = io_src
        io_snk_a  = io_snk

        rg_from_time    = (vdrv - vgs_th) / (qg / t_rise)
        rg_drv_min      = (vdrv - vgs_th) / io_src
        rg_on_raw       = max(rg_from_time, rg_drv_min)
        rg_on_std       = _nearest_e(rg_on_raw)

        rg_off_raw  = rg_on_std * 0.47
        rg_off_std  = _nearest_e(rg_off_raw)
        rg_off_min  = (vdrv) / io_snk
        if rg_off_std < rg_off_min:
            rg_off_std = _nearest_e(rg_off_min)

        rg_boot = 10.0
        self.audit_log.append("[Gate Drive] Hardcoded bootstrap gate resistor (Rg_boot) to 10.0Ω.")

        t_rise_actual_ns = (rg_on_std * qg / (vdrv - vgs_th)) * 1e9
        t_fall_actual_ns = (rg_off_std * qg / vdrv) * 1e9
        dv_dt            = 0 if t_rise_actual_ns <= 0 else self.v_peak / (t_rise_actual_ns * 1e-9) / 1e6

        p_gate_rg = qg * vdrv * self.fsw
        p_gate_all_resistors = p_gate_rg * 0.5 * 6
        p_per_rg = p_gate_rg * 0.25

        return {
            "rg_on_calculated_ohm":     round(rg_on_raw,          2),
            "rg_on_recommended_ohm":    rg_on_std,
            "rg_off_calculated_ohm":    round(rg_off_raw,         2),
            "rg_off_recommended_ohm":   rg_off_std,
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
                "rg_on_basis":  f"Qg={qg_nc:.1f}nC, Vdrv={vdrv}V, Vth={vgs_th}V, t_rise={t_rise_target_ns}ns target",
                "rg_off_note":  "Place Schottky diode antiparallel with Rg_off for asymmetric drive",
                "placement":    "Mount within 10mm of gate pin, 0402/0603, shortest possible trace",
                "emi_note":     f"dV/dt={round(dv_dt,1)} V/µs — adjust Rg_on if EMI issues arise",
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 3. Input Bus Capacitors
    # ═══════════════════════════════════════════════════════════════════
    def calc_input_capacitors(self) -> dict:
        i_dc    = 0 if self.v_bus == 0 else self.power / self.v_bus
        delta_v = float(self.ovr.get("delta_v_ripple", 2.0))
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
            M = 0.9
            self.audit_log.append("[Motor] Phase Ripple Calculation: Used estimated SPWM modulation index M=0.9.")
            sq3 = math.sqrt(3)
            i_ripple_rms = (M * self.i_max / 2) * math.sqrt(
                sq3 / math.pi - 3 * sq3 / (4 * math.pi) * M
            )
            ripple_method = "3-phase SPWM estimate M=0.9 — enter motor Lph for accurate calc"

        # Required bulk capacitance
        c_req_uf = (i_ripple_rms / (8 * fsw * delta_v)) * 1e6

        # Parallel 100µF/100V electrolytics (standard choice)
        n_caps   = max(4, math.ceil(c_req_uf / 100.0))
        c_total  = n_caps * 100   # µF
        v_ripple_actual = (i_ripple_rms / (8 * fsw * c_total * 1e-6))

        # ESR budget
        esr_total_budget_mohm = 0 if i_ripple_rms == 0 else (delta_v / i_ripple_rms) * 1000
        esr_per_cap           = esr_total_budget_mohm * n_caps

        # Ripple current per cap (they share it)
        i_rip_per_cap = 0 if n_caps == 0 else i_ripple_rms / n_caps

        # Film cap (mid-freq 1kHz–1MHz)
        c_film_uf = 4.7

        # MLCC HF decoupling per switch node
        c_mlcc_nf = 100

        # Total capacitor dissipation (at rated ESR)
        esr_typ_mohm = 50.0    # typical electrolytic ESR
        p_cap_total  = i_ripple_rms**2 * (esr_typ_mohm/1000) / n_caps

        self.audit_log.append("[DC Bus] Hardcoded standard decoupling: 50mΩ ESR per electrolytic, 4.7µF film, 100nF MLCC.")

        return {
            "i_dc_a":                   round(i_dc,               2),
            "i_ripple_rms_a":           round(i_ripple_rms,       2),
            "ripple_method":            ripple_method,
            "delta_v_target_v":         delta_v,
            "c_bulk_required_uf":       round(c_req_uf,           1),
            "n_bulk_caps":              n_caps,
            "c_per_bulk_cap_uf":        100,
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
        }

    # ═══════════════════════════════════════════════════════════════════
    # 4. Bootstrap Capacitor
    # ═══════════════════════════════════════════════════════════════════
    def calc_bootstrap_cap(self) -> dict:
        # _get already returns SI (Coulombs) — do NOT multiply by 1e-9 again
        qg     = self._get(self.mosfet, "MOSFET", "qg", 92e-9)   # C  (SI)
        vgs_th = self._get(self.mosfet, "MOSFET", "vgs_th", 3.0)  # V
        vdrv   = self.v_drv

        # Allow 0.5V droop
        droop    = float(self.ovr.get("bootstrap_droop_v", 0.5))
        if droop <= 0:
            self.audit_log.append("[Bootstrap] WARNING: Bootstrap droop cannot be 0 or negative. Using 0.5V default.")
            droop = 0.5
        c_boot   = qg / droop          # exact required capacitance (Farads)
        c_boot_nf= c_boot * 1e9

        # Snap to nearest E12 standard cap value (nF), with 2× safety margin
        c_boot_with_margin = c_boot_nf * 2.0
        E12_nF = [1,1.2,1.5,1.8,2.2,2.7,3.3,3.9,4.7,5.6,6.8,8.2,
                  10,12,15,18,22,27,33,39,47,56,68,82,
                  100,120,150,180,220,270,330,470,680,1000]
        c_std_nf = float(next((v for v in E12_nF if v >= c_boot_with_margin), E12_nF[-1]))
        c_std_nf = max(100.0, c_std_nf)   # practical floor: 100nF

        # Bootstrap diode Vf
        vf_diode = 0.5
        v_boot   = vdrv - vf_diode

        # Minimum high-side on-time to refresh bootstrap
        # C_boot must recharge through R_boot(10Ω) from supply
        r_boot   = 10.0
        self.audit_log.append("[Bootstrap] Hardcoded series bootstrap diode resistor to 10.0Ω.")
        tau_boot = r_boot * c_std_nf * 1e-9   # RC time constant
        t_min_on_ns = 3 * tau_boot * 1e9       # 3τ to charge to ~95%

        # Bootstrap leakage budget
        # Assuming gate leakage 1µA and driver quiescent ~2µA
        i_leakage_ua = 3.0
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
        }

    # ═══════════════════════════════════════════════════════════════════
    # 5. Shunt Resistors (Single + 3-phase)
    # ═══════════════════════════════════════════════════════════════════
    def calc_shunt_resistors(self) -> dict:
        i_max    = self.i_max
        csa_gain = self._get(self.driver, "DRIVER", "current_sense_gain", 20) or 20

        # Target 1.65V at ADC (3.3V ref, 50% headroom)
        v_adc_target = 1.65
        self.audit_log.append("[Current Sensing] Assumed 3.3V ADC with 1.65V bias target for bidirectional FOC.")
        r_ideal_mohm = (v_adc_target / (i_max * csa_gain)) * 1000

        # Standard shunt values
        r1_mohm  = 0.5 if r_ideal_mohm <= 0.75 else 1.0   # single shunt
        r3_mohm  = 0.5                                      # 3-phase always 0.5

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
        lsb_mv   = 3300 / (2 ** int(adc_bits))   # mV per LSB
        bits_used = math.log2(v_adc1 * 1000 / lsb_mv) if v_adc1 > 0 else 0

        return {
            "csa_gain":            csa_gain,
            "adc_reference_v":     3.3,
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
        }

    # ═══════════════════════════════════════════════════════════════════
    # 6. RC Snubber (Drain-Source)
    # ═══════════════════════════════════════════════════════════════════
    def calc_snubber(self) -> dict:
        # Parasitic PCB trace inductance (target <5nH, assume 10nH worst case)
        l_stray_nh  = float(self.ovr.get("stray_inductance_nh", 10))
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

        # Snubber resistor: critical damping Rs = sqrt(L/C)
        rs_crit     = math.sqrt(l_stray / max(coss, 1e-15))
        rs_std      = _nearest_e(rs_crit)
        
        # Log the stray inductance hardcode
        if l_stray_nh == 10:
            self.audit_log.append("[Snubber] Stray layout inductance missing. Assumed 10nH default.")
        self.audit_log.append("[Snubber] Targeted critical damping factor (ζ = 1) for switching overshoot resistor calculation.")
        if rs_std < 1.0: rs_std = 1.0    # practical minimum
        if rs_std > 100: rs_std = 100.0  # practical maximum

        # Snubber capacitor: Cs ≈ 3× Coss, snapped to nearest E12 cap decade
        cs_pf_raw = coss_pf * 3 if coss_pf > 0 else 1000.0
        E12_pF = [100,120,150,180,220,270,330,390,470,560,680,820,
                  1000,1200,1500,1800,2200,2700,3300,4700]
        cs_pf_std = float(next((v for v in E12_pF if v >= cs_pf_raw), E12_pF[-1]))
        cs_pf_std = max(100.0, cs_pf_std)

        rs_recommend = max(1.0, min(100.0, round(rs_std, 0)))
        cs_recommend = cs_pf_std

        # Snubber power dissipation (per MOSFET)
        p_snubber = 0.5 * (cs_recommend * 1e-12) * (self.v_peak**2) * self.fsw
        p_snubber_total = p_snubber * 6

        return {
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
        }

    # ═══════════════════════════════════════════════════════════════════
    # 7. Protection Voltage Dividers
    # ═══════════════════════════════════════════════════════════════════
    def calc_protection_dividers(self) -> dict:
        v_ref = 3.3   # comparator reference

        # ── OVP: trip at Vpeak + 3% ──
        v_ovp_trip = round(self.v_peak * 1.03, 1)
        # V_ref = V_trip × R2 / (R1 + R2)  →  R2/R1 = V_ref / (V_trip - V_ref)
        v_ovp_diff   = v_ovp_trip - v_ref
        r_ratio_ovp  = 0 if v_ovp_diff <= 0 else v_ref / v_ovp_diff
        r1_ovp       = 100e3   # fix R1 = 100kΩ
        r2_ovp       = r1_ovp * r_ratio_ovp
        r2_ovp_std   = _nearest_e(r2_ovp / 1e3, E24) * 1e3
        v_trip_ovp_actual = v_ovp_trip * r2_ovp_std / (r1_ovp + r2_ovp_std)
        i_divider_ovp_ua  = (self.v_peak / (r1_ovp + r2_ovp_std)) * 1e6

        # ── UVP: trip at 75% of Vnom, re-enable at 78% (2V hyst) ──
        v_uvp_trip  = round(self.v_bus * 0.75, 1)
        v_uvp_hyst  = round(self.v_bus * 0.79, 1)
        v_uvp_diff  = v_uvp_trip - v_ref
        r_ratio_uvp = 0 if v_uvp_diff <= 0 else v_ref / v_uvp_diff
        r1_uvp      = 100e3
        r2_uvp      = r1_uvp * r_ratio_uvp
        r2_uvp_std  = _nearest_e(r2_uvp / 1e3, E24) * 1e3
        i_divider_uvp_ua = (self.v_bus / (r1_uvp + r2_uvp_std)) * 1e6

        # ── OCP threshold (shunt-based) ──
        ocp_hw_a    = round(self.i_max * 1.25, 0)
        ocp_sw_a    = round(self.i_max * 1.1,  0)

        # ── OTP NTC divider ──
        # NTC 10kΩ@25°C, B=3950, R@80°C = 10k × exp(B×(1/353 - 1/298))
        b_ntc       = 3950
        t_trip_k    = 80 + 273.15
        t_25_k      = 298.15
        r_ntc_80    = 10000 * math.exp(b_ntc * (1/t_trip_k - 1/t_25_k))
        # Pullup = 10kΩ, V_ntc at 80°C
        r_pullup    = 10000
        v_ntc_80    = 3.3 * r_ntc_80 / (r_pullup + r_ntc_80)
        # NTC at 100°C
        t_100_k     = 100 + 273.15
        r_ntc_100   = 10000 * math.exp(b_ntc * (1/t_100_k - 1/t_25_k))
        v_ntc_100   = 3.3 * r_ntc_100 / (r_pullup + r_ntc_100)
        
        self.audit_log.append("[Protection] Hardcoded TVS power rating to 600W (SMBJ/P6KE style) for bus clamping.")

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
                "warning_temp_c":       80,
                "shutdown_temp_c":      100,
                "v_ntc_at_80c_v":       round(v_ntc_80,  3),
                "v_ntc_at_100c_v":      round(v_ntc_100, 3),
                "ntc_part":             "Murata NCP15 10kΩ B3950, 0402",
            },
            "tvs": {
                "clamping_v":           round(self.v_peak * 0.97, 0),
                "power_rating_w":       600,
                "part":                 "SMBJ58A or P6KE62A",
                "qty":                  2,
                "placement":            "Across bus capacitors, close to bridge",
            },
            "reverse_polarity": {
                "type":                 "P-ch MOSFET ideal diode",
                "part":                 "Si7617DN (60V, 50A) or LTC4366",
                "vds_rating_v":         60,
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 8. Power Supply Bypassing
    # ═══════════════════════════════════════════════════════════════════
    def calc_power_supply_bypass(self) -> dict:
        self.audit_log.append("[Power Supply] Assumed 10µF bulk and 100nF bypass logic decoupling capacitors across all ICs.")
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
            "vdd_3v3_mcu": {
                "voltage_v":        3.3,
                "bulk_cap_uf":      10.0,
                "bypass_cap_nf":    100,
                "bypass_qty":       4,
                "note":             "One 100nF per MCU power pin, one bulk per voltage domain",
            },
            "adc_reference": {
                "cap_nf":           100,
                "note":             "Dedicated 100nF + 1µF on VREF pin, shortest possible trace to AGND",
            },
            "notes": {
                "decoupling_rule":  "Every IC power pin needs 100nF within 2mm + bulk 10µF within 10mm",
                "placement":        "Decoupling caps on same layer as IC — never on opposite side",
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 9. EMI Filter
    # ═══════════════════════════════════════════════════════════════════
    def calc_emi_filter(self) -> dict:
        i_dc    = 0 if self.v_bus == 0 else self.power / self.v_bus
        fsw  = self.fsw

        # Common mode choke: attenuation target -40dB at fsw
        # Typical values for 20-40kHz: 100–470µH CM inductance
        lcm_uh    = 330
        r_dc_choke= 5   # mΩ typical
        p_choke   = (i_dc**2) * r_dc_choke * 1e-3

        # X capacitor (bus differential): 0.1µF at motor cable entry
        cx_nf     = 100

        # Y capacitor (CM to chassis): 4.7nF max (leakage limits)
        cy_nf     = 4.7
        
        self.audit_log.append("[EMI] Hardcoded baseline CM choke (330µH), X-cap (100nF), and Y-cap (4.7nF) for conducted emissions filtering.")

        return {
            "cm_choke_uh":          lcm_uh,
            "cm_choke_current_a":   round(i_dc * 1.2, 1),
            "cm_choke_r_dc_mohm":   r_dc_choke,
            "cm_choke_power_w":     round(p_choke, 2),
            "cm_choke_part":        "Wurth 744235 or TDK ACM series, rated for DC current",
            "x_cap_nf":             cx_nf,
            "x_cap_v_rating":       100,
            "y_cap_nf":             cy_nf,
            "y_cap_v_rating":       100,
            "notes": {
                "cm_choke_place": "At power input connector, before bulk caps",
                "motor_output":   "Additional RC filter on motor phase outputs reduces bearing currents",
                "pcb_ground":     "Star ground topology — separate PGND and AGND, single join point",
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 10. Thermal Analysis
    # ═══════════════════════════════════════════════════════════════════
    def calc_thermal(self) -> dict:
        ml      = self.calc_mosfet_losses()
        p_fet   = ml["total_loss_per_fet_w"]
        rth_jc  = self._get(self.mosfet, "MOSFET", "rth_jc", 0.5)
        tj_max  = self._get(self.mosfet, "MOSFET", "tj_max", 175)

        rth_cs  = 0.5    # case-to-PCB (thermal pad + solder)
        rth_sa  = 20.0   # PCB copper natural convection

        t_case  = self.t_amb + p_fet * rth_sa
        t_junc  = t_case  + p_fet * (rth_jc + rth_cs)

        margin  = tj_max - t_junc
        safe    = margin > 30

        # IPC-2152 trace width (external layer, 3oz Cu, 30°C rise)
        i_trace = self.i_max
        # Simplified: A = (I / (0.048 × ΔT^0.44))^(1/0.725) for 1oz
        # For 3oz: divide area by ~2.2
        area_mil2 = ((i_trace / (0.048 * (30**0.44))) ** (1/0.725))
        width_mm  = (area_mil2 / 39.37) / (3 * 1.4)  # 3oz = 3×1.4mil thick, convert mil² to mm width
        trace_w   = max(3.0, round(width_mm, 1))

        # Copper pour area for MOSFET pad (for 30°C rise from junction)
        cu_area_mm2 = p_fet * 645 / 30

        return {
            "p_per_fet_w":              round(p_fet,          3),
            "p_total_6_fets_w":         round(p_fet * 6,      3),
            "rth_jc_c_per_w":           rth_jc,
            "rth_cs_c_per_w":           rth_cs,
            "rth_sa_pcb_c_per_w":       rth_sa,
            "t_case_est_c":             round(t_case,         1),
            "t_junction_est_c":         round(t_junc,         1),
            "tj_max_rated_c":           tj_max,
            "thermal_margin_c":         round(margin,         1),
            "thermal_safe":             safe,
            "power_trace_width_mm":     trace_w,
            "copper_area_per_fet_mm2":  round(cu_area_mm2,    0),
            "thermal_vias_per_fet":     16,
            "via_drill_mm":             0.3,
            "notes": {
                "package":   "D2PAK (TO-263-7) — use thermal slug pad with solder mask opening",
                "vias":      "16× 0.3mm drilled, 0.2mm annular ring thermal vias per MOSFET",
                "copper_oz": "3oz L1/L6, thermal slug pads open to both sides",
                "warning":   "⚠ CRITICAL: Tj > 150°C — add heatsink or reduce fsw" if not safe
                              else "✓ Thermal design safe for natural convection",
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 11. Dead Time
    # ═══════════════════════════════════════════════════════════════════
    def calc_dead_time(self) -> dict:
        # _get returns SI (seconds) — use SI fallbacks, then convert to ns for arithmetic
        td_off_s  = self._get(self.mosfet, "MOSFET", "td_off",       50e-9) or 50e-9   # seconds
        tf_s      = self._get(self.mosfet, "MOSFET", "tf",            20e-9) or 20e-9   # seconds
        t_prop_s  = self._get(self.driver, "DRIVER", "prop_delay_off", 60e-9) or 60e-9  # seconds
        t_drv_s   = self._get(self.driver, "DRIVER", "prop_delay_on",  60e-9) or 60e-9  # seconds

        # Convert to nanoseconds for readable arithmetic
        td_off_ns = td_off_s * 1e9
        tf_ns     = tf_s     * 1e9
        t_prop_ns = t_prop_s * 1e9

        # Minimum: td_off + tf + propagation + 20ns margin
        dt_min    = td_off_ns + tf_ns + t_prop_ns + 20   # ns
        dt_rec    = round(dt_min * 1.5)                  # ns, 50% safety margin
        
        self.audit_log.append("[Dead Time] Added hardcoded 20ns absolute margin and 1.5x (50%) recommended safety margin to switching times.")

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

        return {
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
            "notes": {
                "foc":       "Dead-time compensation required in firmware for accurate FOC below ~10% mod index",
                "6step":     "6-step commutation: enforce same dead-time at each commutation event",
                "comp_algo": "Voltage feed-forward or current-sign-based dead-time compensation",
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 12. PCB Guidelines
    # ═══════════════════════════════════════════════════════════════════
    def calc_pcb_guidelines(self) -> dict:
        th = self.calc_thermal()
        trace_w = th["power_trace_width_mm"]

        return {
            "layer_stack": [
                {"layer":"L1 (Top)",    "copper_oz":3, "purpose":"Power traces, MOSFET pads, gate traces"},
                {"layer":"L2",          "copper_oz":1, "purpose":"Solid GND plane"},
                {"layer":"L3",          "copper_oz":1, "purpose":"Signal: gate drive, SPI, UART"},
                {"layer":"L4",          "copper_oz":1, "purpose":"Power planes: 12V, 5V, 3.3V"},
                {"layer":"L5",          "copper_oz":1, "purpose":"Signal: analog, sensing, encoder"},
                {"layer":"L6 (Bottom)", "copper_oz":3, "purpose":"Power returns, thermal spreading"},
            ],
            "power_trace_w_mm":        trace_w,
            "gate_trace_w_mm":         0.3,
            "signal_trace_w_mm":       0.15,
            "power_clearance_mm":      1.0,
            "signal_clearance_mm":     0.15,
            "via_drill_thermal_mm":    0.3,
            "via_drill_power_mm":      0.4,
            "via_drill_signal_mm":     0.2,
            "half_bridge_loop_nh":     5,
            "shunt_kelvin_trace":      "Route sense traces INSIDE power trace pair (Kelvin connection)",
            "notes": {
                "analog_gnd":    "AGND star point at ADC VREF, single bridge to PGND",
                "gate_loop":     "Gate drive loop < 50mm² to minimize Lgate parasitic",
                "bridge_loop":   "Half-bridge Drain-Source-GND loop < 100mm² for low di/dt",
                "copper_pour":   "Thermal pour on both L1 and L6 under each MOSFET",
            },
        }

    # ═══════════════════════════════════════════════════════════════════
    # 13. Motor Parameter Validation & Sanity Checks
    # ═══════════════════════════════════════════════════════════════════
    def calc_motor_validation(self) -> dict:
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

        results["warnings"] = warnings
        results["has_motor_data"] = any(v is not None for v in [rpm, pole_pairs, ke, kt, rph_mohm])

        return results

    # ═══════════════════════════════════════════════════════════════════
    # 14. MOSFET Rating Validation
    # ═══════════════════════════════════════════════════════════════════
    def calc_mosfet_rating_check(self) -> dict:
        """Validate that the selected MOSFET can handle system voltage and current."""
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
        return results

    # ═══════════════════════════════════════════════════════════════════
    # 15. Driver Compatibility Check
    # ═══════════════════════════════════════════════════════════════════
    def calc_driver_compatibility(self) -> dict:
        """Validate gate driver is compatible with system specs and MCU."""
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
        v_boot = self.v_drv - 0.5  # typical Schottky diode drop
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
        return results

    # ═══════════════════════════════════════════════════════════════════
    # 16. ADC Timing Validation
    # ═══════════════════════════════════════════════════════════════════
    def calc_adc_timing(self) -> dict:
        """Validate ADC can sample within center-aligned PWM window."""
        warnings = []
        results = {}

        # PWM period and available sampling window
        t_pwm_us = (1.0 / self.fsw) * 1e6         # full PWM period in µs
        # Center-aligned: sample at PWM center, need at least ~10% of half-period
        t_half_us = t_pwm_us / 2.0
        t_window_us = t_half_us * 0.1              # conservative: 10% of half-period
        results["pwm_period_us"] = round(t_pwm_us, 2)
        results["sampling_window_us"] = round(t_window_us, 2)

        # ADC sample rate → conversion time
        adc_rate_raw = self._get(self.mcu, "MCU", "adc_sample_rate", None)
        if adc_rate_raw is not None:
            try:
                adc_rate = float(adc_rate_raw)
                # adc_rate could be in MSPS, KSPS, or SPS — heuristic
                if adc_rate > 1e6:
                    adc_sps = adc_rate               # already in SPS
                elif adc_rate > 1000:
                    adc_sps = adc_rate * 1e3          # was in KSPS
                else:
                    adc_sps = adc_rate * 1e6          # was in MSPS
                t_conv_us = (1.0 / adc_sps) * 1e6    # conversion time in µs
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
        return results

    # ═══════════════════════════════════════════════════════════════════
    # Run All
    # ═══════════════════════════════════════════════════════════════════
    def run_all(self) -> dict:
        results = {
            "mosfet_losses":        self.calc_mosfet_losses(),
            "gate_resistors":       self.calc_gate_resistors(),
            "input_capacitors":     self.calc_input_capacitors(),
            "bootstrap_cap":        self.calc_bootstrap_cap(),
            "shunt_resistors":      self.calc_shunt_resistors(),
            "snubber":              self.calc_snubber(),
            "protection_dividers":  self.calc_protection_dividers(),
            "power_supply_bypass":  self.calc_power_supply_bypass(),
            "emi_filter":           self.calc_emi_filter(),
            "thermal":              self.calc_thermal(),
            "dead_time":            self.calc_dead_time(),
            "pcb_guidelines":       self.calc_pcb_guidelines(),
            "motor_validation":     self.calc_motor_validation(),
            "mosfet_rating_check":  self.calc_mosfet_rating_check(),
            "driver_compatibility": self.calc_driver_compatibility(),
            "adc_timing":           self.calc_adc_timing(),
        }
        # Attach logs after calculations have fully populated them
        results["audit_log"] = list(dict.fromkeys(self.audit_log))
        return results
