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


# ─── User-configurable design constants ──────────────────────────────────────
# Each entry: (default, unit, category, label, description)
# These are the ~28 most impactful constants engineers want to tweak.
# The rest stay inline as they are standard values that rarely change.
DESIGN_CONSTANTS = {
    # Thermal
    "thermal.rds_derating":    (1.5,  "x",    "Thermal",     "Rds(on) thermal derating",     "Worst-case multiplier at ~100°C junction"),
    "thermal.rth_cs":          (0.5,  "°C/W", "Thermal",     "TIM resistance (case-to-PCB)", "Thermal interface material resistance"),
    "thermal.rth_sa":          (20.0, "°C/W", "Thermal",     "PCB-to-ambient Rth",           "Natural convection, no heatsink"),
    "thermal.safe_margin":     (30,   "°C",   "Thermal",     "Safe margin threshold",        "Minimum acceptable Tj headroom"),
    "thermal.vias_per_fet":    (16,   "pcs",  "Thermal",     "Thermal vias per FET",         "0.3mm vias under thermal pad"),
    # Gate Drive
    "gate.rise_time_target":   (40,   "ns",   "Gate Drive",  "Rise time target",             "Default target for Rg_on sizing"),
    "gate.rg_off_ratio":       (0.47, "x",    "Gate Drive",  "Rg_off ratio",                 "Rg_off as fraction of Rg_on (faster turn-off)"),
    "gate.rg_bootstrap":       (10.0, "Ω",    "Gate Drive",  "Bootstrap series R",           "Limits bootstrap diode charging current"),
    "gate.bootstrap_vf":       (1.0,  "V",    "Gate Drive",  "Bootstrap diode Vf",           "Default for integrated boot diode (~1V). Set to 0.5V if using external Schottky."),
    # Bootstrap
    "boot.min_cap":            (100,  "nF",   "Bootstrap",   "Min practical boot cap",       "Floor for bootstrap capacitor value"),
    "boot.safety_margin":      (2.0,  "x",    "Bootstrap",   "Safety margin multiplier",     "Applied before E12 snap"),
    "boot.leakage_ua":         (115,  "µA",   "Bootstrap",   "Leakage current budget",       "Gate 1µA + driver quiescent ~110µA + FET leakage ~4µA"),
    # Input Capacitors
    "input.spwm_mod_index":    (0.9,  "",     "Input Caps",  "SPWM modulation index",        "3-phase SPWM approx when Lph unavailable"),
    "input.min_bulk_count":    (4,    "pcs",  "Input Caps",  "Min bulk cap count",           "Minimum parallel caps for ESR distribution"),
    "input.bulk_cap_uf":       (100,  "µF",   "Input Caps",  "Bulk cap size",                "Standard electrolytic per-cap value"),
    "input.esr_per_cap":       (50,   "mΩ",   "Input Caps",  "Typical ESR per cap",          "Electrolytic ESR estimate for thermal calc"),
    # Protection
    "prot.adc_ref":            (3.3,  "V",    "Protection",  "ADC reference voltage",        "MCU ADC full-scale reference"),
    "prot.ovp_margin":         (1.05, "x",    "Protection",  "OVP trip margin",              "Multiplier above peak bus voltage"),
    "prot.uvp_trip":           (0.75, "x",    "Protection",  "UVP trip threshold",           "Fraction of nominal bus voltage"),
    "prot.ocp_hw":             (1.25, "x",    "Protection",  "OCP hardware threshold",       "Hardware overcurrent trip multiplier"),
    "prot.ocp_sw":             (1.1,  "x",    "Protection",  "OCP software threshold",       "Software overcurrent limit multiplier"),
    "prot.otp_warn":           (80,   "°C",   "Protection",  "OTP warning temp",             "Temperature at which to warn user"),
    "prot.otp_shutdown":       (100,  "°C",   "Protection",  "OTP shutdown temp",            "Temperature at which to shut down"),
    # Dead Time
    "dt.abs_margin":           (20,   "ns",   "Dead Time",   "Absolute margin",              "Fixed safety margin added to minimum DT"),
    "dt.safety_mult":          (1.5,  "x",    "Dead Time",   "Safety multiplier",            "Recommended margin over minimum DT"),
    # Waveform
    "waveform.common_source_inductance_nh": (1.5,   "nH",   "Waveform",    "Common-source inductance",      "Source loop inductance feeding back into effective Vgs"),
    "waveform.qrr_miller_coupling":         (0.30,  "x",    "Waveform",    "Qrr-to-Miller coupling",        "Fraction of diode recovery charge reflected into turn-on Miller charge"),
    "waveform.qgd_temp_coeff":              (0.0015,"1/C",  "Waveform",    "Qgd temperature coefficient",   "Per-degree increase of effective Qgd above 25C"),
    "waveform.qrr_temp_coeff":              (0.005, "1/C",  "Waveform",    "Qrr temperature coefficient",   "Per-degree increase of effective Qrr above 25C"),
    "waveform.driver_temp_derate_per_c":    (0.001, "1/C",  "Waveform",    "Driver current temp derate",    "Per-degree reduction of effective gate-driver source/sink current above 25C"),
    # Snubber
    "snub.coss_mult":          (3,    "x",    "Snubber",     "Coss multiplier",              "Snubber cap = N × Coss for overdamped response"),
    "snub.stray_l_default":    (10,   "nH",   "Snubber",     "Default stray inductance",     "Assumed PCB power loop inductance"),
    # EMI Filter
    "emi.cm_choke_uh":         (330,  "µH",   "EMI Filter",  "CM choke inductance",          "Common-mode choke baseline value"),
}

# ─── Reverse calculation map ──────────────────────────────────────────────────
# Maps output keys → (module, label, unit, solved_key)
REVERSE_MAP = {
    "gate_rise_time_ns":     ("gate_resistors", "Rise time",     "ns",   "rg_on_recommended_ohm"),
    "gate_fall_time_ns":     ("gate_resistors", "Fall time",     "ns",   "rg_off_recommended_ohm"),
    "dv_dt_v_per_us":        ("gate_resistors", "dV/dt",         "V/µs", "rg_on_recommended_ohm"),
    "c_boot_recommended_nf": ("bootstrap_cap",  "Boot cap",      "nF",   "bootstrap_droop_v"),
    "min_hs_on_time_ns":     ("bootstrap_cap",  "Min on-time",   "ns",   "c_boot_recommended_nf"),
    "v_adc_v":               ("shunt_resistors","ADC voltage",   "V",    "value_mohm"),
    "dt_pct_of_period":      ("dead_time",      "DT duty loss",  "%",    "dt_actual_ns"),
    "dt_actual_ns":          ("dead_time",      "Dead time",     "ns",   "dt_register_count"),
    "voltage_overshoot_v":   ("snubber",        "V overshoot",   "V",    "cs_recommended_pf"),
    "p_total_all_snubbers_w":("snubber",        "Snubber power", "W",    "cs_recommended_pf"),
    "p_total_6_snubbers_w":  ("snubber",        "Snubber power", "W",    "cs_recommended_pf"),
}


def _nearest_e(value: float, series=E24) -> float:
    if value <= 0: return 1.0
    decade = 10 ** math.floor(math.log10(value))
    norm = value / decade
    for e in series:
        if e >= norm:
            return round(e * decade, 4)
    # All series values < norm → snap to first value of NEXT decade
    return round(series[0] * decade * 10, 4)


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


# Import mixins
from calculations.mosfet import MosfetMixin
from calculations.gate_drive import GateDriveMixin
from calculations.passives import PassivesMixin
from calculations.protection import ProtectionMixin
from calculations.thermal import ThermalMixin
from calculations.validation import ValidationMixin
from calculations.waveform import WaveformMixin
from calculations.pcb_trace_thermal import PcbTraceThermalMixin


class CalculationEngine(MosfetMixin, GateDriveMixin, PassivesMixin, ProtectionMixin, ThermalMixin, ValidationMixin, WaveformMixin, PcbTraceThermalMixin):
    def __init__(self, system_specs, mosfet_params, driver_params,
                 mcu_params, motor_specs, overrides, design_constants=None,
                 pcb_trace_thermal_params=None):
        self.sys      = system_specs
        self.mosfet   = mosfet_params
        self.driver   = driver_params
        self.mcu      = mcu_params
        self.motor    = motor_specs
        self.ovr      = overrides or {}
        self.design_constants = design_constants or {}
        self.pcb_trace_params = pcb_trace_thermal_params or {}
        self.audit_log  = []
        self._module_meta = {}  # {module_name: {"hardcoded": [...], "fallbacks": [...]}}
        self._cached_results = {}  # cache for sub-calcs called by multiple modules

        try:
            self.v_bus      = float(system_specs.get("bus_voltage",      48))
            self.v_peak     = float(system_specs.get("peak_voltage",     60))
            self.power      = float(system_specs.get("power",          3000))
            self.i_max      = float(system_specs.get("max_phase_current", 80))
            self.fsw        = float(system_specs.get("pwm_freq_hz",   20000))
            self.t_amb      = float(system_specs.get("ambient_temp_c",   30))
            self.v_drv      = float(system_specs.get("gate_drive_voltage",12))
            self.num_fets   = int(float(system_specs.get("num_fets",      6)))
        except (TypeError, ValueError) as e:
            raise ValueError(f"Invalid numeric value in system specs: {e}")

        # Motor pole pairs from motor specs
        self.pole_pairs = 4  # default
        if motor_specs:
            try:
                self.pole_pairs = int(float(motor_specs.get("pole_pairs", 4)))
            except (TypeError, ValueError):
                pass

        # Validate critical system parameters
        if self.fsw <= 0:
            raise ValueError("PWM frequency (pwm_freq_hz) must be > 0 Hz")
        if self.v_bus <= 0:
            raise ValueError("Bus voltage (bus_voltage) must be > 0 V")
        if self.i_max <= 0:
            raise ValueError("Max phase current (max_phase_current) must be > 0 A")
        if self.v_drv <= 0:
            raise ValueError("Gate drive voltage (gate_drive_voltage) must be > 0 V")
        if self.v_peak < self.v_bus:
            raise ValueError(
                f"Peak voltage ({self.v_peak}V) cannot be less than bus voltage ({self.v_bus}V). "
                f"V_peak should account for regenerative braking overshoot and transient spikes."
            )

    # Engineering bounds for safety-critical design constants: {key: (min, max)}
    _DC_BOUNDS = {
        "thermal.rds_derating":  (1.0,  5.0),
        "thermal.rth_cs":        (0.01, 10.0),
        "thermal.rth_sa":        (0.5,  100.0),
        "thermal.safe_margin":   (1,    100),
        "thermal.vias_per_fet":  (0,    100),
        "gate.rise_time_target": (5,    500),
        "gate.rg_off_ratio":     (0.1,  2.0),
        "gate.rg_bootstrap":     (0.1,  100),
        "gate.bootstrap_vf":     (0.1,  2.0),
        "boot.min_cap":          (10,   10000),
        "boot.safety_margin":    (1.0,  10.0),
        "boot.leakage_ua":       (1,    10000),
        "input.spwm_mod_index":  (0.1,  1.0),
        "input.min_bulk_count":  (1,    64),
        "input.bulk_cap_uf":     (1,    10000),
        "input.esr_per_cap":     (0.1,  1000),
        "dt.abs_margin":         (0,    500),
        "dt.safety_mult":        (1.0,  5.0),
        "waveform.common_source_inductance_nh": (0.0, 20.0),
        "waveform.qrr_miller_coupling":         (0.0, 1.5),
        "waveform.qgd_temp_coeff":              (0.0, 0.01),
        "waveform.qrr_temp_coeff":              (0.0, 0.02),
        "waveform.driver_temp_derate_per_c":    (0.0, 0.01),
        "snub.coss_mult":        (1,    20),
        "snub.stray_l_default":  (1,    500),
        "emi.cm_choke_uh":       (1,    10000),
        "prot.adc_ref":          (1.0,  5.0),
        "prot.ovp_margin":       (1.0,  2.0),
        "prot.uvp_trip":         (0.3,  0.95),
        "prot.ocp_hw":           (1.0,  5.0),
        "prot.ocp_sw":           (1.0,  3.0),
        "prot.otp_warn":         (40,   200),
        "prot.otp_shutdown":     (50,   250),
    }

    def _dc(self, key: str) -> float:
        """Get a design constant — user override if set, else default.
        Clamps to engineering bounds if defined, logging a warning if clamped."""
        default = float(DESIGN_CONSTANTS[key][0])
        val = default
        if key in self.design_constants:
            try:
                val = float(self.design_constants[key])
            except (TypeError, ValueError):
                val = default

        # Enforce engineering bounds
        bounds = self._DC_BOUNDS.get(key)
        if bounds:
            lo, hi = bounds
            if val < lo:
                self.audit_log.append(f"[Bounds] Design constant '{key}' = {val} clamped to minimum {lo}.")
                val = lo
            elif val > hi:
                self.audit_log.append(f"[Bounds] Design constant '{key}' = {val} clamped to maximum {hi}.")
                val = hi

        return val

    def _effective_rth_sa(self) -> float:
        """Get effective Rth_SA based on cooling method selection.
        Used by both mosfet_losses (Tj iteration) and thermal module."""
        from calculations.thermal import ThermalMixin
        cooling = str(self.sys.get("cooling", "natural")).strip().lower()
        tier = ThermalMixin.COOLING_TIERS.get(cooling)
        if tier is None:
            tier = ThermalMixin.COOLING_TIERS["natural"]
        tier_rth, _ = tier
        if cooling == "custom" or tier_rth is None:
            return self._dc("thermal.rth_sa")
        return tier_rth

    def _log_hc(self, module: str, name: str, value: str, reason: str, dc_key: str = None):
        """Log a hardcoded constant used in a calculation module."""
        if module not in self._module_meta:
            self._module_meta[module] = {"hardcoded": [], "fallbacks": []}
        if not any(h["name"] == name for h in self._module_meta[module]["hardcoded"]):
            entry = {"name": name, "value": value, "reason": reason}
            if dc_key and dc_key in self.design_constants:
                entry["overridden"] = True
                entry["user_value"] = str(self.design_constants[dc_key])
            self._module_meta[module]["hardcoded"].append(entry)

    # Engineering sanity bounds for extracted parameters (in SI units after conversion).
    # If a value falls outside these bounds, it's almost certainly a bad extraction.
    # Format: "param_id": (min_si, max_si, fallback_si, display_unit)
    _PARAM_BOUNDS = {
        # MOSFET parameters
        "vds_max":       (10,       1200,     100,     "V"),
        "id_cont":       (0.5,      500,      None,    "A"),
        "rds_on":        (0.1e-3,   10,       1.5e-3,  "Ω"),
        "vgs_th":        (0.5,      10,       3.0,     "V"),
        "qg":            (1e-9,     5000e-9,  92e-9,   "C"),
        "qgd":           (0.1e-9,   2000e-9,  30e-9,   "C"),
        "qrr":           (0.1e-9,   5000e-9,  44e-9,   "C"),
        "coss":          (1e-12,    100e-9,   200e-12, "F"),
        "rth_jc":        (0.01,     20,       0.5,     "°C/W"),
        "tr":            (0.1e-9,   10e-6,    30e-9,   "s"),
        "tf":            (0.1e-9,   10e-6,    20e-9,   "s"),
        "td_on":         (0.1e-9,   10e-6,    15e-9,   "s"),
        "td_off":        (0.1e-9,   10e-6,    50e-9,   "s"),
        # Driver parameters
        "io_source":     (0.01,     30,       1.5,     "A"),
        "io_sink":       (0.01,     30,       2.5,     "A"),
        "vcc_uvlo":      (1.0,      20.0,     None,    "V"),
        "vbs_uvlo":      (1.0,      20.0,     None,    "V"),
        "prop_delay_on": (1e-9,     10e-6,    60e-9,   "s"),
        "prop_delay_off":(1e-9,     10e-6,    60e-9,   "s"),
        # MCU parameters
        "adc_resolution":(6,        24,       12,      "bits"),
        "pwm_deadtime_res":(0.1e-9, 1e-6,     8e-9,    "s"),
    }

    def _get(self, params: dict, block_name: str, key: str, fallback=None, expected_unit: str = None):
        val = params.get(key)
        if val is None or val == "":
            if fallback is not None:
                self.audit_log.append(f"[{block_name}] Missing '{key}', using fallback {fallback}{expected_unit or ''}")
                mod = getattr(self, '_current_module', block_name)
                if mod not in self._module_meta:
                    self._module_meta[mod] = {"hardcoded": [], "fallbacks": []}
                if not any(f["param"] == key for f in self._module_meta[mod]["fallbacks"]):
                    self._module_meta[mod]["fallbacks"].append({"param": key, "value": str(fallback), "block": block_name})
            return fallback
        try:
            fval = float(val)
        except (TypeError, ValueError):
            if fallback is not None:
                self.audit_log.append(f"[{block_name}] Invalid numeric value for '{key}', using fallback {fallback}{expected_unit or ''}")
                mod = getattr(self, '_current_module', block_name)
                if mod not in self._module_meta:
                    self._module_meta[mod] = {"hardcoded": [], "fallbacks": []}
                if not any(f["param"] == key for f in self._module_meta[mod]["fallbacks"]):
                    self._module_meta[mod]["fallbacks"].append({"param": key, "value": str(fallback), "block": block_name})
            return fallback

        from unit_utils import to_si
        unit = params.get(key + '__unit', expected_unit or '')
        si_val = to_si(fval, unit) if unit else fval

        # Sanity-check extracted values against engineering bounds
        bounds = self._PARAM_BOUNDS.get(key)
        if bounds is not None:
            lo, hi, bound_fallback, disp_unit = bounds
            if si_val <= 0 and lo > 0:
                # Zero or negative for a parameter that must be positive
                fb = bound_fallback if bound_fallback is not None else fallback
                self.audit_log.append(
                    f"[{block_name}] SANITY: '{key}' extracted as {si_val} {disp_unit} "
                    f"(≤ 0). Using fallback {fb}. Check datasheet extraction."
                )
                return fb if fb is not None else si_val
            if si_val < lo or si_val > hi:
                self.audit_log.append(
                    f"[{block_name}] SANITY WARNING: '{key}' = {si_val} {disp_unit} "
                    f"is outside expected range [{lo}–{hi}]. "
                    f"Verify datasheet extraction is correct."
                )
                # Don't override — just warn. The value might be legitimate for exotic parts.

        return si_val

    def _bootstrap_uvlo_info(self) -> dict:
        """Resolve bootstrap UVLO from extracted driver params and assess data quality.

        Returns:
          {
            "value_v": float|None,
            "source_key": str|None,
            "status": "verified"|"missing"|"suspicious",
            "trusted": bool,
            "note": str
          }
        """
        alias_keys = ("vbs_uvlo", "vboot_uvlo", "vb_uvlo", "vbst_uvlo")

        source_key = None
        vbs_uvlo = None
        for key in alias_keys:
            val = self._get(self.driver, "DRIVER", key, None, expected_unit="V")
            if val is not None:
                source_key = key
                vbs_uvlo = float(val)
                break

        def _log_once(msg: str):
            if msg not in self.audit_log:
                self.audit_log.append(msg)

        if vbs_uvlo is None:
            msg = "[Driver] Bootstrap UVLO parameter missing (expected vbs_uvlo). Bootstrap UVLO margin remains unverified."
            _log_once(msg)
            return {
                "value_v": None,
                "source_key": None,
                "status": "missing",
                "trusted": False,
                "note": "VBS UVLO not extracted",
            }

        if source_key != "vbs_uvlo":
            _log_once(
                f"[Driver] Bootstrap UVLO resolved via alias '{source_key}'. "
                "Verify extraction mapping to canonical id 'vbs_uvlo'."
            )

        # Practical high-side UVLO windows are typically in a few-volts range.
        # Values far outside this usually indicate extraction/unit mistakes.
        if vbs_uvlo < 2.0 or vbs_uvlo > 15.0:
            _log_once(
                f"[Driver] SANITY WARNING: Bootstrap UVLO={vbs_uvlo:.3g}V looks suspicious "
                "(expected ~2V to 15V). Confirm datasheet extraction/units."
            )
            return {
                "value_v": vbs_uvlo,
                "source_key": source_key,
                "status": "suspicious",
                "trusted": False,
                "note": "VBS UVLO outside practical range (2V..15V)",
            }

        return {
            "value_v": vbs_uvlo,
            "source_key": source_key,
            "status": "verified",
            "trusted": True,
            "note": "VBS UVLO extracted and plausible",
        }


    # ═══════════════════════════════════════════════════════════════════
    # 1. MOSFET Losses
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════

    def reverse_calculate(self, targets: dict) -> dict:
        """
        Given target output values, compute what component values achieve them.
        Each result is re-verified through the forward formula.
        """
        results = {}
        for target_key, target_value in targets.items():
            try:
                target_value = float(target_value)
            except (TypeError, ValueError):
                continue
            if target_key == 'gate_rise_time_ns':
                results[target_key] = self._rev_gate_rise(target_value)
            elif target_key == 'gate_fall_time_ns':
                results[target_key] = self._rev_gate_fall(target_value)
            elif target_key == 'dv_dt_v_per_us':
                results[target_key] = self._rev_dv_dt(target_value)
            elif target_key == 'c_boot_recommended_nf':
                results[target_key] = self._rev_boot_cap(target_value)
            elif target_key == 'min_hs_on_time_ns':
                results[target_key] = self._rev_boot_on_time(target_value)
            elif target_key == 'v_adc_v':
                results[target_key] = self._rev_shunt_adc(target_value)
            elif target_key == 'dt_pct_of_period':
                results[target_key] = self._rev_dt_pct(target_value)
            elif target_key == 'dt_actual_ns':
                results[target_key] = self._rev_dt_actual(target_value)
            elif target_key == 'voltage_overshoot_v':
                results[target_key] = self._rev_snub_overshoot(target_value)
            elif target_key in ('p_total_6_snubbers_w', 'p_total_all_snubbers_w'):
                solved = self._rev_snub_power(target_value)
                solved["target_key"] = target_key
                results[target_key] = solved
        return results

    def _gate_reverse_context(self) -> dict:
        """Shared reverse-solver context matching calc_gate_resistors physics."""
        qg      = self._get(self.mosfet, "MOSFET", "qg", 92e-9)
        qgd     = self._get(self.mosfet, "MOSFET", "qgd", None)
        vgs_pl  = self._get(self.mosfet, "MOSFET", "vgs_plateau", None)
        vgs_th  = self._get(self.mosfet, "MOSFET", "vgs_th", 3.0)
        rg_int  = self._get(self.mosfet, "MOSFET", "rg_int", 0) or 0.0
        io_src  = self._get(self.driver, "DRIVER", "io_source", 1.5)
        io_snk  = self._get(self.driver, "DRIVER", "io_sink", 2.5)
        vdrv    = self.v_drv

        if qg <= 0:
            qg = 92e-9
        if io_src <= 0:
            io_src = 1.5
        if io_snk <= 0:
            io_snk = 2.5

        if vdrv <= vgs_th:
            vgs_th = vdrv - 1.0

        rg_int = max(float(rg_int), 0.0)
        use_miller_basis = bool(qgd is not None and qgd > 0)
        vgs_pl_eff = vgs_pl if (vgs_pl is not None and vgs_th + 0.1 < vgs_pl < vdrv - 0.1) else (vgs_th + 1.0)
        vgs_pl_eff = max(vgs_th + 0.2, min(vgs_pl_eff, vdrv - 0.5))

        if use_miller_basis:
            rise_charge = qgd
            fall_charge = qgd
            rise_v = max(vdrv - vgs_pl_eff, 0.2)
            fall_v = max(vgs_pl_eff, 0.2)
            rg_on_min_total = max((vdrv - vgs_pl_eff) / io_src, 0.0)
            rg_off_min_total = max(vgs_pl_eff / io_snk, 0.0)
            sizing_basis = "miller_charge"
        else:
            rise_charge = qg
            fall_charge = qg
            rise_v = max(vdrv - vgs_th, 0.2)
            fall_v = max(vdrv, 0.2)
            rg_on_min_total = max((vdrv - vgs_th) / io_src, 0.0)
            rg_off_min_total = max(vdrv / io_snk, 0.0)
            sizing_basis = "total_qg_fallback"

        return {
            "rise_charge": rise_charge,
            "fall_charge": fall_charge,
            "rise_v": rise_v,
            "fall_v": fall_v,
            "rg_int": rg_int,
            "rg_on_min_total": rg_on_min_total,
            "rg_off_min_total": rg_off_min_total,
            "sizing_basis": sizing_basis,
        }

    # ── Gate Rise Time → Rg_on ─────────────────────────────────────
    def _rev_gate_rise(self, target_ns: float) -> dict:
        if target_ns <= 0:
            return {
                "target_key": "gate_rise_time_ns",
                "target_value": target_ns,
                "feasible": False,
                "constraint": "Rise time target must be > 0 ns",
            }

        ctx = self._gate_reverse_context()
        t_rise_s = target_ns * 1e-9

        rg_total_ideal = t_rise_s * ctx["rise_v"] / ctx["rise_charge"]
        feasible = rg_total_ideal >= ctx["rg_on_min_total"]
        rg_total_clamped = max(rg_total_ideal, ctx["rg_on_min_total"])
        rg_ext_raw = max(rg_total_clamped - ctx["rg_int"], 0.1)
        rg_std = _nearest_e(rg_ext_raw)

        rg_total_actual = rg_std + ctx["rg_int"]
        t_actual_ns = (rg_total_actual * ctx["rise_charge"] / ctx["rise_v"]) * 1e9

        return {
            "target_key": "gate_rise_time_ns",
            "target_value": target_ns,
            "solved_key": "rg_on_recommended_ohm",
            "solved_value": rg_std,
            "solved_unit": "\u03a9",
            "ideal_value": round(rg_ext_raw, 3),
            "actual_output": round(t_actual_ns, 1),
            "actual_output_unit": "ns",
            "feasible": feasible,
            "constraint": (
                f"Driver source current limits total Rg_on \u2265 {round(ctx['rg_on_min_total'], 2)}\u03a9"
                if not feasible else None
            ),
            "note": (
                f"E24 Rg_ext={round(rg_ext_raw, 2)}\u03a9 \u2192 {rg_std}\u03a9 "
                f"(Rg_int={round(ctx['rg_int'], 2)}\u03a9) gives {round(t_actual_ns, 1)}ns actual"
            ),
            "rg_sizing_basis": ctx["sizing_basis"],
        }

    # ── Gate Fall Time → Rg_off ────────────────────────────────────
    def _rev_gate_fall(self, target_ns: float) -> dict:
        if target_ns <= 0:
            return {
                "target_key": "gate_fall_time_ns",
                "target_value": target_ns,
                "feasible": False,
                "constraint": "Fall time target must be > 0 ns",
            }

        ctx = self._gate_reverse_context()
        t_fall_s = target_ns * 1e-9

        rg_total_ideal = t_fall_s * ctx["fall_v"] / ctx["fall_charge"]
        feasible = rg_total_ideal >= ctx["rg_off_min_total"]
        rg_total_clamped = max(rg_total_ideal, ctx["rg_off_min_total"])
        rg_ext_raw = max(rg_total_clamped - ctx["rg_int"], 0.1)
        rg_std = _nearest_e(rg_ext_raw)

        rg_total_actual = rg_std + ctx["rg_int"]
        t_actual_ns = (rg_total_actual * ctx["fall_charge"] / ctx["fall_v"]) * 1e9

        return {
            "target_key": "gate_fall_time_ns",
            "target_value": target_ns,
            "solved_key": "rg_off_recommended_ohm",
            "solved_value": rg_std,
            "solved_unit": "\u03a9",
            "ideal_value": round(rg_ext_raw, 3),
            "actual_output": round(t_actual_ns, 1),
            "actual_output_unit": "ns",
            "feasible": feasible,
            "constraint": (
                f"Driver sink current limits total Rg_off \u2265 {round(ctx['rg_off_min_total'], 2)}\u03a9"
                if not feasible else None
            ),
            "note": (
                f"E24 Rg_ext={round(rg_ext_raw, 2)}\u03a9 \u2192 {rg_std}\u03a9 "
                f"(Rg_int={round(ctx['rg_int'], 2)}\u03a9) gives {round(t_actual_ns, 1)}ns actual"
            ),
            "rg_sizing_basis": ctx["sizing_basis"],
        }

    # ── dV/dt → Rg_on (via rise time) ─────────────────────────────
    def _rev_dv_dt(self, target_v_per_us: float) -> dict:
        if target_v_per_us <= 0:
            return {"target_key": "dv_dt_v_per_us", "target_value": target_v_per_us,
                    "feasible": False, "constraint": "dV/dt must be > 0"}
        # t_rise = V_peak / (dv_dt × 1e6)  [seconds]
        t_rise_s = self.v_peak / (target_v_per_us * 1e6)
        t_rise_ns = t_rise_s * 1e9
        # Now solve for Rg_on from this rise time
        result = self._rev_gate_rise(t_rise_ns)
        result["target_key"] = "dv_dt_v_per_us"
        result["target_value"] = target_v_per_us
        # Re-compute actual dV/dt from actual rise time
        if result.get("actual_output", 0) > 0:
            actual_dvdt = self.v_peak / (result["actual_output"] * 1e-9) / 1e6
            result["actual_output"] = round(actual_dvdt, 1)
            result["actual_output_unit"] = "V/\u00b5s"
        result["note"] = f"Target dV/dt={target_v_per_us} V/\u00b5s \u2192 t_rise={round(t_rise_ns, 1)}ns \u2192 Rg_on={result.get('solved_value', '?')}\u03a9"
        return result

    # ── Bootstrap: shared downstream analysis ─────────────────────
    def _boot_downstream(self, c_std_nf: float) -> dict:
        """Compute all downstream bootstrap parameters for a given C_boot value.
        Used by both _rev_boot_cap and _rev_boot_on_time to provide
        comprehensive what-if analysis."""
        qg       = self._get(self.mosfet, "MOSFET", "qg", 92e-9)
        vdrv     = self.v_drv
        r_boot   = self._dc("gate.rg_bootstrap")
        vf_diode = self._dc("gate.bootstrap_vf")
        i_leak   = self._dc("boot.leakage_ua")

        c_boot_f = c_std_nf * 1e-9

        # ── Downstream values ──
        droop_v      = qg / c_boot_f if c_boot_f > 0 else 999
        v_boot       = vdrv - vf_diode
        tau_boot     = r_boot * c_boot_f
        t_min_on_ns  = 3.0 * tau_boot * 1e9            # 3τ → ~95% charge
        hold_time_ms = (c_boot_f * droop_v / (i_leak * 1e-6)) * 1000 if i_leak > 0 else 999

        # ── UVLO margin check ──
        uvlo_info = self._bootstrap_uvlo_info()
        vbs_uvlo = uvlo_info["value_v"]
        uvlo_margin  = None
        uvlo_ok      = None
        uvlo_status  = "unknown"
        if vbs_uvlo is not None:
            # Effective gate voltage after droop
            v_gate_after_droop = v_boot - droop_v
            uvlo_margin = round(v_gate_after_droop - vbs_uvlo, 2)
            uvlo_ok = uvlo_margin > 0.5
            if uvlo_margin <= 0:
                uvlo_status = "danger"
            elif uvlo_margin <= 0.5:
                uvlo_status = "warning"
            else:
                uvlo_status = "ok"

        return {
            "c_boot_nf":        c_std_nf,
            "droop_v":          round(droop_v, 3),
            "v_bootstrap_v":    round(v_boot, 2),
            "min_on_time_ns":   round(t_min_on_ns, 1),
            "hold_time_ms":     round(hold_time_ms, 1),
            "r_boot_ohm":       r_boot,
            "tau_ns":           round(tau_boot * 1e9, 1),
            "uvlo_margin_v":    uvlo_margin,
            "uvlo_ok":          uvlo_ok,
            "uvlo_status":      uvlo_status,
            "uvlo_data_status": uvlo_info["status"],
            "uvlo_data_trusted": uvlo_info["trusted"],
            "uvlo_data_source_key": uvlo_info["source_key"],
            "uvlo_data_note":   uvlo_info["note"],
            "vbs_uvlo_v":       round(vbs_uvlo, 2) if vbs_uvlo is not None else None,
            "v_gate_min_v":     round(v_boot - droop_v, 2),
        }

    # ── Bootstrap Cap (target nF → implied droop) ──────────────────
    def _rev_boot_cap(self, target_nf: float) -> dict:
        qg = self._get(self.mosfet, "MOSFET", "qg", 92e-9)

        # Forward: C_boot = Qg / droop → droop = Qg / C_target
        c_target_f = target_nf * 1e-9
        if c_target_f <= 0:
            return {"target_key": "c_boot_recommended_nf", "target_value": target_nf,
                    "feasible": False, "constraint": "Capacitance must be > 0"}

        droop_implied = qg / c_target_f
        feasible = 0.05 <= droop_implied <= 2.0  # reasonable droop range

        # Snap target to E12
        E12_nF = [1,1.2,1.5,1.8,2.2,2.7,3.3,3.9,4.7,5.6,6.8,8.2,
                  10,12,15,18,22,27,33,39,47,56,68,82,
                  100,120,150,180,220,270,330,470,680,1000]
        boot_min_cap = self._dc("boot.min_cap")
        c_std_nf = float(next((v for v in E12_nF if v >= target_nf), E12_nF[-1]))
        c_std_nf = max(boot_min_cap, c_std_nf)

        # Actual droop with snapped value
        actual_droop = qg / (c_std_nf * 1e-9)

        # Droop override that reproduces this snapped value in forward calc.
        # Forward flow applies boot.safety_margin before E12 snap, so we invert that here.
        boot_margin_mult = max(self._dc("boot.safety_margin"), 1.0)
        c_pre_margin_nf = max(c_std_nf / boot_margin_mult, 0.1)
        apply_droop_v = qg / (c_pre_margin_nf * 1e-9)
        # Small upward bias prevents floating/JSON rounding from snapping to the next E12 value.
        apply_droop_v *= 1.0 + 1e-6

        # Comprehensive downstream analysis
        downstream = self._boot_downstream(c_std_nf)

        # Also get current forward-calc values for comparison
        try:
            current_fwd = self.calc_bootstrap_cap()
            current_vals = {
                "c_boot_nf":      current_fwd.get("c_boot_recommended_nf"),
                "droop_v":        round(qg / (current_fwd.get("c_boot_recommended_nf", 220) * 1e-9), 3),
                "min_on_time_ns": current_fwd.get("min_hs_on_time_ns"),
                "hold_time_ms":   current_fwd.get("bootstrap_hold_time_ms"),
            }
        except Exception:
            current_vals = None

        return {
            "target_key": "c_boot_recommended_nf",
            "target_value": target_nf,
            "solved_key": "bootstrap_droop_v",
            "solved_value": round(actual_droop, 3),
            "solved_unit": "V",
            "apply_bootstrap_droop_v": round(apply_droop_v, 9),
            "ideal_value": round(droop_implied, 3),
            "actual_output": c_std_nf,
            "actual_output_unit": "nF",
            "feasible": feasible,
            "constraint": f"Droop {round(droop_implied, 2)}V is {'too high (>2V)' if droop_implied > 2 else 'too low (<0.05V)'}" if not feasible else None,
            "note": f"C_boot={c_std_nf}nF (E12) implies {round(actual_droop, 2)}V droop",
            "downstream": downstream,
            "current_vals": current_vals,
        }

    # ── Min HS On-Time → C_boot ────────────────────────────────────
    def _rev_boot_on_time(self, target_ns: float) -> dict:
        if target_ns <= 0:
            return {
                "target_key": "min_hs_on_time_ns",
                "target_value": target_ns,
                "feasible": False,
                "constraint": "Minimum on-time target must be > 0 ns",
            }

        qg     = self._get(self.mosfet, "MOSFET", "qg", 92e-9)
        r_boot = self._dc("gate.rg_bootstrap")

        # Forward: t_min = 3 × R_boot × C_boot → C = t / (3 × R)
        t_s = target_ns * 1e-9
        c_ideal_f = t_s / (3.0 * r_boot)
        c_ideal_nf = c_ideal_f * 1e9

        E12_nF = [1,1.2,1.5,1.8,2.2,2.7,3.3,3.9,4.7,5.6,6.8,8.2,
                  10,12,15,18,22,27,33,39,47,56,68,82,
                  100,120,150,180,220,270,330,470,680,1000]
        boot_min_cap = self._dc("boot.min_cap")

        # For a max-allowed min-on-time target, choose the largest practical C_boot
        # that does not exceed the target (snap DOWN to E12).
        if c_ideal_nf < boot_min_cap:
            c_std_nf = float(boot_min_cap)
            timing_feasible = False
        else:
            floor_candidates = [v for v in E12_nF if v <= c_ideal_nf]
            c_std_nf = float(floor_candidates[-1] if floor_candidates else E12_nF[0])
            timing_feasible = True

        # Forward verify
        t_actual_ns = 3.0 * r_boot * c_std_nf * 1e-9 * 1e9

        # Droop override that reproduces this snapped value in forward calc.
        boot_margin_mult = max(self._dc("boot.safety_margin"), 1.0)
        c_pre_margin_nf = max(c_std_nf / boot_margin_mult, 0.1)
        apply_droop_v = qg / (c_pre_margin_nf * 1e-9)
        # Small upward bias prevents floating/JSON rounding from snapping to the next E12 value.
        apply_droop_v *= 1.0 + 1e-6

        # Comprehensive downstream analysis — the full what-if picture
        downstream = self._boot_downstream(c_std_nf)

        # Get current forward-calc values for before/after comparison
        try:
            current_fwd = self.calc_bootstrap_cap()
            current_vals = {
                "c_boot_nf":      current_fwd.get("c_boot_recommended_nf"),
                "droop_v":        round(qg / (current_fwd.get("c_boot_recommended_nf", 220) * 1e-9), 3),
                "min_on_time_ns": current_fwd.get("min_hs_on_time_ns"),
                "hold_time_ms":   current_fwd.get("bootstrap_hold_time_ms"),
            }
        except Exception:
            current_vals = None

        # Feasibility: C_boot must be positive, timing target met, and UVLO must be OK
        boot_feasible = c_ideal_nf > 0
        uvlo_feasible = downstream.get("uvlo_ok") is not False  # True or None (unknown) is OK

        constraint = None
        if not timing_feasible:
            constraint = (
                f"Target {round(target_ns, 1)}ns is below minimum achievable "
                f"{round(t_actual_ns, 1)}ns with practical C_boot={c_std_nf}nF."
            )
        if not uvlo_feasible:
            constraint = (
                f"Bootstrap voltage after droop ({downstream['v_gate_min_v']}V) "
                f"is below UVLO ({downstream['vbs_uvlo_v']}V) - gate driver will shut down!"
            )

        return {
            "target_key": "min_hs_on_time_ns",
            "target_value": target_ns,
            "solved_key": "c_boot_recommended_nf",
            "solved_value": c_std_nf,
            "solved_unit": "nF",
            "apply_bootstrap_droop_v": round(apply_droop_v, 9),
            "ideal_value": round(c_ideal_nf, 1),
            "actual_output": round(t_actual_ns, 1),
            "actual_output_unit": "ns",
            "feasible": boot_feasible and uvlo_feasible and timing_feasible,
            "constraint": constraint,
            "note": f"C_boot={c_std_nf}nF (E12) gives t_min={round(t_actual_ns, 0):.0f}ns @ R_boot={r_boot}\u03a9",
            "downstream": downstream,
            "current_vals": current_vals,
        }

    # ── Shunt: Target ADC Voltage → R_shunt ────────────────────────
    def _rev_shunt_adc(self, target_v: float) -> dict:
        i_max    = self.i_max
        csa_gain = self._get(self.driver, "DRIVER", "current_sense_gain", 20) or 20
        adc_ref  = self._dc("prot.adc_ref")

        # Inverse: R = V_adc / (I_max × gain) × 1000 [mΩ]
        if i_max <= 0 or csa_gain <= 0:
            return {"target_key": "v_adc_v", "target_value": target_v,
                    "feasible": False, "constraint": "Invalid I_max or CSA gain"}

        r_ideal_mohm = (target_v / (i_max * csa_gain)) * 1000

        # Snap to standard shunt values
        if r_ideal_mohm <= 0.75:
            r_std_mohm = 0.5
        elif r_ideal_mohm <= 1.5:
            r_std_mohm = 1.0
        elif r_ideal_mohm <= 3.0:
            r_std_mohm = 2.0
        else:
            r_std_mohm = 5.0

        # Forward verify
        v_actual = i_max * r_std_mohm * 1e-3 * csa_gain
        feasible = v_actual <= adc_ref  # must not exceed ADC reference

        return {
            "target_key": "v_adc_v",
            "target_value": target_v,
            "solved_key": "value_mohm",
            "solved_value": r_std_mohm,
            "solved_unit": "m\u03a9",
            "ideal_value": round(r_ideal_mohm, 3),
            "actual_output": round(v_actual, 3),
            "actual_output_unit": "V",
            "feasible": feasible,
            "constraint": f"ADC output {round(v_actual, 2)}V exceeds {adc_ref}V reference" if not feasible else None,
            "note": f"R_shunt={r_std_mohm}m\u03a9 @ I_max={i_max}A, gain={csa_gain}\u00d7 \u2192 {round(v_actual, 3)}V at ADC",
        }

    # ── Dead Time % → dt_actual ────────────────────────────────────
    def _rev_dt_pct(self, target_pct: float) -> dict:
        period_ns = 1e9 / self.fsw
        dt_target_ns = target_pct * period_ns / 100.0

        # Get minimum dead time components
        td_off_s  = self._get(self.mosfet, "MOSFET", "td_off",       50e-9) or 50e-9
        tf_s      = self._get(self.mosfet, "MOSFET", "tf",            20e-9) or 20e-9
        t_prop_s  = self._get(self.driver, "DRIVER", "prop_delay_off", 60e-9) or 60e-9
        drv_fall_s = self._get(self.driver, "DRIVER", "fall_time_out", None) or 0.0
        dt_abs_margin = self._dc("dt.abs_margin")
        dt_min_ns = (td_off_s + tf_s + t_prop_s + drv_fall_s) * 1e9 + dt_abs_margin

        dt_max_s  = self._get(self.mcu, "MCU", "pwm_deadtime_max", 1000e-9) or 1000e-9
        dt_max_ns = dt_max_s * 1e9
        feasible_min = dt_target_ns >= dt_min_ns
        feasible_max = dt_target_ns <= dt_max_ns

        # Snap to MCU resolution
        dt_res_s  = self._get(self.mcu, "MCU", "pwm_deadtime_res", 8e-9) or 8e-9
        dt_res_ns = dt_res_s * 1e9
        dt_effective = min(max(dt_target_ns, dt_min_ns), dt_max_ns)
        dt_reg = math.ceil(dt_effective / dt_res_ns)
        max_dt_reg = max(1, math.floor(dt_max_ns / dt_res_ns))
        dt_reg = min(max(dt_reg, 1), max_dt_reg)
        dt_actual = dt_reg * dt_res_ns
        dt_actual_pct = (dt_actual / period_ns) * 100

        constraint = None
        if not feasible_min:
            constraint = f"Minimum dead time is {round(dt_min_ns, 0):.0f}ns ({round(dt_min_ns/period_ns*100, 3):.3f}%)"
        elif not feasible_max:
            constraint = f"Exceeds MCU max dead time {round(dt_max_ns, 0):.0f}ns"

        return {
            "target_key": "dt_pct_of_period",
            "target_value": target_pct,
            "solved_key": "dt_actual_ns",
            "solved_value": round(dt_actual, 1),
            "solved_unit": "ns",
            "ideal_value": round(dt_target_ns, 1),
            "actual_output": round(dt_actual_pct, 3),
            "actual_output_unit": "%",
            "feasible": feasible_min and feasible_max,
            "constraint": constraint,
            "note": f"DT={round(dt_actual, 0):.0f}ns (reg={dt_reg} \u00d7 {dt_res_ns:.1f}ns) = {round(dt_actual_pct, 3)}% of period",
        }

    # ── Dead Time Actual → register count ──────────────────────────
    def _rev_dt_actual(self, target_ns: float) -> dict:
        td_off_s  = self._get(self.mosfet, "MOSFET", "td_off",       50e-9) or 50e-9
        tf_s      = self._get(self.mosfet, "MOSFET", "tf",            20e-9) or 20e-9
        t_prop_s  = self._get(self.driver, "DRIVER", "prop_delay_off", 60e-9) or 60e-9
        drv_fall_s = self._get(self.driver, "DRIVER", "fall_time_out", None) or 0.0
        dt_abs_margin = self._dc("dt.abs_margin")
        dt_min_ns = (td_off_s + tf_s + t_prop_s + drv_fall_s) * 1e9 + dt_abs_margin

        dt_res_s  = self._get(self.mcu, "MCU", "pwm_deadtime_res", 8e-9) or 8e-9
        dt_res_ns = dt_res_s * 1e9
        dt_max_s  = self._get(self.mcu, "MCU", "pwm_deadtime_max", 1000e-9) or 1000e-9
        dt_max_ns = dt_max_s * 1e9

        feasible_min = target_ns >= dt_min_ns
        feasible_max = target_ns <= dt_max_ns

        target_ns = max(target_ns, 0.0)
        dt_reg    = math.ceil(target_ns / dt_res_ns)
        max_dt_reg = max(1, math.floor(dt_max_ns / dt_res_ns))
        dt_reg = min(max(dt_reg, 1), max_dt_reg)
        dt_actual = dt_reg * dt_res_ns

        period_ns = 1e9 / self.fsw
        dt_pct    = (dt_actual / period_ns) * 100

        constraint = None
        if not feasible_min:
            constraint = f"Below minimum {round(dt_min_ns, 0):.0f}ns (td_off + tf + prop + margin)"
        elif not feasible_max:
            constraint = f"Exceeds MCU max dead time {round(dt_max_ns, 0):.0f}ns"

        return {
            "target_key": "dt_actual_ns",
            "target_value": target_ns,
            "solved_key": "dt_register_count",
            "solved_value": dt_reg,
            "solved_unit": "counts",
            "ideal_value": round(target_ns / dt_res_ns, 2),
            "actual_output": round(dt_actual, 1),
            "actual_output_unit": "ns",
            "feasible": feasible_min and feasible_max,
            "constraint": constraint,
            "note": f"Register={dt_reg} \u00d7 {dt_res_ns:.1f}ns = {round(dt_actual, 0):.0f}ns ({round(dt_pct, 3)}% period)",
        }

    # ── Snubber: Target Overshoot → Cs, Rs ─────────────────────────
    def _rev_snub_overshoot(self, target_v: float) -> dict:
        l_stray_nh = float(self.ovr.get("stray_inductance_nh", self._dc("snub.stray_l_default")))
        l_stray    = l_stray_nh * 1e-9
        coss       = self._get(self.mosfet, "MOSFET", "coss", 200e-12)
        i_max      = self.i_max

        if target_v <= 0:
            return {"target_key": "voltage_overshoot_v", "target_value": target_v,
                    "feasible": False, "constraint": "Target overshoot must be > 0"}

        # Inverse: V_ov = I × √(L/C) → C = L × (I/V)²
        c_required_f = l_stray * (i_max / target_v) ** 2
        c_required_pf = c_required_f * 1e12

        # Snap to E12 pF (extended for reverse calc — snubber caps can be large)
        E12_pF = [100,120,150,180,220,270,330,390,470,560,680,820,
                  1000,1200,1500,1800,2200,2700,3300,4700,
                  5600,6800,8200,10000,12000,15000,18000,22000,27000,33000,47000,
                  56000,68000,82000,100000,120000,150000,180000,220000,270000,330000,470000,
                  560000,680000,820000,1000000]
        cs_std = float(next((v for v in E12_pF if v >= c_required_pf), E12_pF[-1]))
        cs_std = max(100.0, cs_std)

        # Rs = √(L/Cs) for critical damping
        rs_crit = math.sqrt(l_stray / (cs_std * 1e-12))
        rs_std  = _nearest_e(rs_crit)
        rs_std  = max(1.0, min(100.0, rs_std))

        # Forward verify
        v_actual = i_max * math.sqrt(l_stray / max(cs_std * 1e-12, 1e-15))

        return {
            "target_key": "voltage_overshoot_v",
            "target_value": target_v,
            "solved_key": "cs_recommended_pf",
            "solved_value": cs_std,
            "solved_unit": "pF",
            "ideal_value": round(c_required_pf, 1),
            "actual_output": round(v_actual, 1),
            "actual_output_unit": "V",
            "feasible": True,
            "constraint": None,
            "note": f"Cs={cs_std}pF + Rs={rs_std}\u03a9 gives {round(v_actual, 1)}V overshoot (L_stray={l_stray_nh}nH)",
        }

    # ── Snubber: Target Power → Cs ─────────────────────────────────
    def _rev_snub_power(self, target_w: float) -> dict:
        if target_w <= 0:
            return {"target_key": "p_total_6_snubbers_w", "target_value": target_w,
                    "feasible": False, "constraint": "Target power must be > 0"}

        n_snubbers = max(1, int(self.num_fets))

        # Forward: P_total = N × 0.5 × Cs × V² × fsw → Cs = 2P / (N × V² × fsw)
        cs_ideal_f  = (2 * target_w) / (n_snubbers * self.v_peak ** 2 * self.fsw)
        cs_ideal_pf = cs_ideal_f * 1e12

        E12_pF = [100,120,150,180,220,270,330,390,470,560,680,820,
                  1000,1200,1500,1800,2200,2700,3300,4700,
                  5600,6800,8200,10000,12000,15000,18000,22000,27000,33000,47000,
                  56000,68000,82000,100000,120000,150000,180000,220000,270000,330000,470000,
                  560000,680000,820000,1000000]
        cs_min_pf = float(E12_pF[0])
        cs_max_pf = float(E12_pF[-1])
        cs_std = float(next((v for v in E12_pF if v >= cs_ideal_pf), cs_max_pf))
        cs_std = max(cs_min_pf, cs_std)

        feasible_low = cs_ideal_pf >= cs_min_pf
        feasible_high = cs_ideal_pf <= cs_max_pf

        # Forward verify
        p_actual = n_snubbers * 0.5 * (cs_std * 1e-12) * (self.v_peak ** 2) * self.fsw

        constraint = None
        if not feasible_low:
            p_min = n_snubbers * 0.5 * (cs_min_pf * 1e-12) * (self.v_peak ** 2) * self.fsw
            constraint = (
                f"Target is below minimum achievable total snubber power "
                f"{round(p_min, 3)}W with minimum practical Cs={int(cs_min_pf)}pF and N={n_snubbers}."
            )
        elif not feasible_high:
            p_max = n_snubbers * 0.5 * (cs_max_pf * 1e-12) * (self.v_peak ** 2) * self.fsw
            constraint = (
                f"Target exceeds maximum achievable total snubber power "
                f"{round(p_max, 3)}W with maximum supported Cs={int(cs_max_pf)}pF and N={n_snubbers}."
            )

        return {
            "target_key": "p_total_6_snubbers_w",
            "target_value": target_w,
            "solved_key": "cs_recommended_pf",
            "solved_value": cs_std,
            "solved_unit": "pF",
            "ideal_value": round(cs_ideal_pf, 1),
            "actual_output": round(p_actual, 3),
            "actual_output_unit": "W",
            "feasible": feasible_low and feasible_high,
            "constraint": constraint,
            "note": (
                f"Cs={cs_std}pF \u2192 P_total={round(p_actual, 3)}W @ Vpeak={self.v_peak}V, "
                f"fsw={self.fsw/1e3:.0f}kHz, N={n_snubbers}"
            ),
        }

    # ═══════════════════════════════════════════════════════════════════
    # Run All
    # ═══════════════════════════════════════════════════════════════════


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
            "cross_validation":     self.calc_cross_validation(),
            "waveform":             self.calc_waveform(),
            "pcb_trace_thermal":    self.calc_pcb_trace_thermal(),
        }
        # Attach logs after calculations have fully populated them
        results["audit_log"] = list(dict.fromkeys(self.audit_log))

        # Build transparency summary
        transparency = {"total_hardcoded": 0, "total_fallbacks": 0, "by_module": {}}
        for mod_name, meta in self._module_meta.items():
            hc_count = len(meta.get("hardcoded", []))
            fb_count = len(meta.get("fallbacks", []))
            transparency["total_hardcoded"] += hc_count
            transparency["total_fallbacks"] += fb_count
            if hc_count > 0 or fb_count > 0:
                transparency["by_module"][mod_name] = meta
        results["transparency"] = transparency

        return results

