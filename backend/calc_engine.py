"""
Motor Controller Hardware Design — Calculation Engine v2
Backward-compatibility shim: re-exports from the calculations/ package.
"""
from calculations import CalculationEngine, DESIGN_CONSTANTS, REVERSE_MAP, E24, E12
from calculations.base import _nearest_e, _get

__all__ = ['CalculationEngine', 'DESIGN_CONSTANTS', 'REVERSE_MAP', 'E24', 'E12', '_nearest_e', '_get']
