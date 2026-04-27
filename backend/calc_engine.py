"""
Motor Controller Hardware Design — Calculation Engine v2
Backward-compatibility shim: re-exports from the calculations/ package.
"""
from calculations import CalculationEngine, DESIGN_CONSTANTS, REVERSE_MAP, E24, E12
from calculations.base import _nearest_e, _get

# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  MANDATORY MAINTENANCE — READ BEFORE EDITING calculations/*.py              ║
# ╠══════════════════════════════════════════════════════════════════════════════╣
# ║  CALC_DEPS is the single source of truth for which extracted datasheet      ║
# ║  parameters feed directly into formulas.  It drives two critical systems:   ║
# ║                                                                              ║
# ║  1. Pass 2 targeting  — these params are ALWAYS re-verified by the AI,      ║
# ║     even if Pass 1 found a value, to catch column-mapping and unit errors.  ║
# ║                                                                              ║
# ║  2. Cache invalidation — the set is hashed into the cache key, so adding   ║
# ║     or removing a param here automatically busts stale cached extractions   ║
# ║     for that block type (no manual cache clearing needed).                  ║
# ║                                                                              ║
# ║  WHEN YOU ADD OR REMOVE A PARAM FROM ANY calculations/*.py FILE:            ║
# ║    → Update the correct block set below.                                    ║
# ║    → No other files need changing — the two systems above auto-propagate.   ║
# ║                                                                              ║
# ║  Failure to update CALC_DEPS means Pass 2 will NOT re-verify the new       ║
# ║  param, leaving wrong AI-extracted values silently corrupting results.      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
CALC_DEPS = {
    # Verified against calculations/mosfet.py, calculations/thermal.py,
    # calculations/passives.py, calculations/protection.py (2026-04-24)
    "mosfet": {
        "rds_on", "qg", "qgd", "qgs", "qrr", "trr", "coss",
        "td_on", "tr", "td_off", "tf",
        "rth_jc", "body_diode_vf", "vds_max", "tj_max",
        "vgs_th", "vgs_max", "vgs_plateau",
        "ciss", "crss", "rg_int", "qoss",
        "id_cont", "id_pulsed", "avalanche_energy", "avalanche_current",
    },
    # Verified against calculations/gate_drive.py, calculations/thermal.py,
    # calculations/protection.py, calculations/passives.py (2026-04-24)
    "driver": {
        "io_source", "io_sink",
        "prop_delay_on", "prop_delay_off",
        "rise_time_out", "fall_time_out",
        "rth_ja", "tj_max",
        "vbs_uvlo", "vcc_range", "vil", "vih",
        "current_sense_gain", "idd_quiescent",
        "thermal_shutdown",  # used in protection/thermal threshold checks
    },
    # Verified against calculations/waveform.py, calculations/pcb_trace_thermal.py (2026-04-24)
    "mcu": {
        "adc_resolution", "adc_ref",
        "pwm_deadtime_res", "pwm_deadtime_max",
        "pwm_timers", "complementary_outputs",
    },
}

__all__ = ['CalculationEngine', 'DESIGN_CONSTANTS', 'REVERSE_MAP', 'E24', 'E12', '_nearest_e', '_get', 'CALC_DEPS']
