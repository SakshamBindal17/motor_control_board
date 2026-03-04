"""
unit_utils.py — Robust unit normalization for motor controller calculations.

Claude returns values in datasheet units (e.g. nC, mΩ, ns, pF, °C/W).
This module converts any value + unit string to SI base units so the
calculation engine always works in SI regardless of what the datasheet uses.

Usage:
    from unit_utils import to_si, fmt_unit_info
    rds_si = to_si(1.5, "mΩ")   # → 0.0015  (Ohms)
    qg_si  = to_si(92, "nC")    # → 9.2e-8  (Coulombs)
"""

# Multiplier table: unit string (lowercase, stripped) → SI multiplier
_MULTIPLIERS = {
    # Resistance
    "mω": 1e-3, "mohm": 1e-3, "mΩ": 1e-3,
    "kω": 1e3,  "kohm": 1e3,  "kΩ": 1e3,
    "mω": 1e-3,
    "ω":  1.0,  "ohm":  1.0,  "Ω": 1.0,

    # Capacitance
    "pf": 1e-12, "nf": 1e-9, "µf": 1e-6, "uf": 1e-6, "mf": 1e-3, "f": 1.0,

    # Charge
    "nc": 1e-9, "µc": 1e-6, "uc": 1e-6, "mc": 1e-3, "c": 1.0,
    "pc": 1e-12,

    # Time
    "ns": 1e-9, "µs": 1e-6, "us": 1e-6, "ms": 1e-3, "s": 1.0,

    # Current
    "µa": 1e-6, "ua": 1e-6, "ma": 1e-3, "a": 1.0, "ka": 1e3,

    # Voltage
    "mv": 1e-3, "v": 1.0, "kv": 1e3,

    # Power
    "mw": 1e-3, "w": 1.0, "kw": 1e3,

    # Frequency
    "hz": 1.0, "khz": 1e3, "mhz": 1e6, "ghz": 1e9,

    # Thermal resistance
    "°c/w": 1.0, "c/w": 1.0,

    # Temperature
    "°c": 1.0, "c": 1.0,

    # Memory
    "kb": 1024, "mb": 1024**2, "gb": 1024**3,
    "k": 1024,  # for flash size "4K"

    # Bits
    "bit": 1.0, "bits": 1.0,

    # Percentage
    "%": 1.0,

    # Dimensionless / counts
    "": 1.0,
}

# Human-readable SI descriptions for tooltips
UNIT_TOOLTIPS = {
    # Resistance
    "mΩ": "milliohm  (1 mΩ = 1×10⁻³ Ω)",
    "mohm": "milliohm  (1 mΩ = 1×10⁻³ Ω)",
    "kΩ": "kilohm  (1 kΩ = 1×10³ Ω)",
    "kohm": "kilohm  (1 kΩ = 1×10³ Ω)",
    "Ω": "ohm (SI base unit for resistance)",
    "ohm": "ohm (SI base unit for resistance)",
    # Capacitance
    "pF": "picofarad  (1 pF = 1×10⁻¹² F)",
    "nF": "nanofarad  (1 nF = 1×10⁻⁹ F)",
    "µF": "microfarad  (1 µF = 1×10⁻⁶ F)",
    "uF": "microfarad  (1 µF = 1×10⁻⁶ F)",
    # Charge
    "nC": "nanocoulomb  (1 nC = 1×10⁻⁹ C)",
    "µC": "microcoulomb  (1 µC = 1×10⁻⁶ C)",
    "pC": "picocoulomb  (1 pC = 1×10⁻¹² C)",
    # Time
    "ns": "nanosecond  (1 ns = 1×10⁻⁹ s)",
    "µs": "microsecond  (1 µs = 1×10⁻⁶ s)",
    "us": "microsecond  (1 µs = 1×10⁻⁶ s)",
    "ms": "millisecond  (1 ms = 1×10⁻³ s)",
    # Current
    "µA": "microampere  (1 µA = 1×10⁻⁶ A)",
    "mA": "milliampere  (1 mA = 1×10⁻³ A)",
    "A": "ampere (SI base unit for current)",
    # Voltage
    "mV": "millivolt  (1 mV = 1×10⁻³ V)",
    "V": "volt (SI base unit for voltage)",
    # Power
    "mW": "milliwatt  (1 mW = 1×10⁻³ W)",
    "W": "watt (SI base unit for power)",
    # Frequency
    "Hz": "hertz (SI unit for frequency)",
    "kHz": "kilohertz  (1 kHz = 1×10³ Hz)",
    "MHz": "megahertz  (1 MHz = 1×10⁶ Hz)",
    # Thermal
    "°C/W": "degrees Celsius per Watt (thermal resistance)",
    "°C": "degrees Celsius",
    # Memory
    "KB": "kilobyte  (1 KB = 1024 bytes)",
    "MB": "megabyte  (1 MB = 1024² bytes)",
    "K": "kilobyte  (1 K = 1024 bytes, flash size)",
}


def to_si(value: float, unit: str) -> float:
    """Convert value in given unit to SI base unit value."""
    if value is None:
        return None
    key = unit.strip().lower().replace("ω", "ω")
    mult = _MULTIPLIERS.get(key)
    if mult is None:
        # Try without unicode normalisation issues
        key2 = unit.strip().lower()
        mult = _MULTIPLIERS.get(key2, 1.0)
    return float(value) * mult


def get_tooltip(unit: str) -> str:
    """Return human-readable tooltip string for a unit."""
    return UNIT_TOOLTIPS.get(unit.strip(), f"Unit: {unit}")
