"""
Automated tests for the calculation engine and unit utilities.
Run: pytest tests/ -v
"""
import sys
import os
import math
import pytest

# Ensure backend dir is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def default_specs():
    """Default system specs for a typical 48V motor controller."""
    return {
        "bus_voltage": 48, "peak_voltage": 60, "power": 3000,
        "max_phase_current": 80, "pwm_freq_hz": 20000,
        "ambient_temp_c": 30, "gate_drive_voltage": 12,
    }

@pytest.fixture
def engine(default_specs):
    """A CalculationEngine with all-default parameters."""
    from calc_engine import CalculationEngine
    return CalculationEngine(
        system_specs=default_specs,
        mosfet_params={}, driver_params={}, mcu_params={},
        motor_specs={}, overrides={}
    )


# ── Unit Utils ────────────────────────────────────────────────────────────────

class TestUnitUtils:
    def test_milliohm_to_si(self):
        from unit_utils import to_si
        assert to_si(1.5, "mΩ") == pytest.approx(1.5e-3)

    def test_nanofarad_to_si(self):
        from unit_utils import to_si
        assert to_si(100, "nF") == pytest.approx(100e-9)

    def test_picofarad_to_si(self):
        from unit_utils import to_si
        assert to_si(200, "pF") == pytest.approx(200e-12)

    def test_nanosecond_to_si(self):
        from unit_utils import to_si
        assert to_si(30, "ns") == pytest.approx(30e-9)

    def test_kilohertz_to_si(self):
        from unit_utils import to_si
        assert to_si(20, "kHz") == pytest.approx(20e3)

    def test_unicode_omega_normalization(self):
        """#11: Both Ω variants should be treated as ohms."""
        from unit_utils import to_si
        # U+2126 OHM SIGN
        assert to_si(10, "\u2126") == pytest.approx(10.0)
        # U+03A9 GREEK CAPITAL LETTER OMEGA
        assert to_si(10, "\u03A9") == pytest.approx(10.0)

    def test_celsius_no_collision(self):
        """Bug fix: 'c' should NOT be treated as Celsius."""
        from unit_utils import to_si
        # Plain 'c' should be Coulombs, not Celsius
        result = to_si(1, "c")
        assert result == pytest.approx(1.0)  # No conversion or coulombs

    def test_degree_celsius(self):
        from unit_utils import to_si
        assert to_si(80, "°c") == pytest.approx(80.0)


# ── Calculation Engine ────────────────────────────────────────────────────────

class TestCalculationEngine:
    def test_run_all_returns_16_modules(self, engine):
        results = engine.run_all()
        modules = [k for k in results if k not in ("audit_log", "transparency")]
        assert len(modules) == 16

    def test_mosfet_losses_positive(self, engine):
        ml = engine.calc_mosfet_losses()
        assert ml["total_loss_per_fet_w"] > 0
        assert ml["total_all_6_fets_w"] > 0
        assert ml["junction_temp_est_c"] > engine.t_amb

    def test_mosfet_losses_cached(self, engine):
        """Bug fix: Second call should return cached result."""
        r1 = engine.calc_mosfet_losses()
        r2 = engine.calc_mosfet_losses()
        assert r1 is r2  # same object

    def test_gate_resistors(self, engine):
        gr = engine.calc_gate_resistors()
        assert gr["rg_on_recommended_ohm"] > 0
        assert gr["rg_off_recommended_ohm"] > 0
        assert gr["gate_rise_time_ns"] > 0

    def test_input_caps(self, engine):
        ic = engine.calc_input_capacitors()
        assert ic["n_bulk_caps"] >= 4  # min_bulk_count default
        assert ic["c_total_uf"] > 0

    def test_bootstrap_cap(self, engine):
        bc = engine.calc_bootstrap_cap()
        assert bc["c_boot_recommended_nf"] >= 100  # min_cap default
        assert bc["v_bootstrap_v"] > 0

    def test_dead_time(self, engine):
        dt = engine.calc_dead_time()
        assert dt["dt_recommended_ns"] > 0
        assert dt["dt_actual_ns"] >= dt["dt_recommended_ns"]

    def test_thermal(self, engine):
        th = engine.calc_thermal()
        assert th["t_junction_est_c"] > engine.t_amb
        assert th["power_trace_width_mm"] > 0

    def test_thermal_cached(self, engine):
        r1 = engine.calc_thermal()
        r2 = engine.calc_thermal()
        assert r1 is r2

    def test_protection_dividers(self, engine):
        pd = engine.calc_protection_dividers()
        assert "ovp" in pd
        assert "ocp" in pd
        assert pd["ocp"]["hw_threshold_a"] > engine.i_max

    def test_reverse_gate_rise(self, engine):
        rev = engine.reverse_calculate({"gate_rise_time_ns": 50})
        assert "gate_rise_time_ns" in rev
        assert rev["gate_rise_time_ns"]["solved_value"] > 0

    def test_snubber(self, engine):
        sn = engine.calc_snubber()
        assert sn["rs_recommended_ohm"] >= 1
        assert sn["cs_recommended_pf"] >= 100

    def test_audit_log_populated(self, engine):
        results = engine.run_all()
        assert len(results["audit_log"]) > 0

    def test_transparency_tracking(self, engine):
        results = engine.run_all()
        t = results["transparency"]
        assert t["total_hardcoded"] > 0
        assert t["total_fallbacks"] > 0

    def test_invalid_specs_raises(self):
        from calc_engine import CalculationEngine
        with pytest.raises(ValueError):
            CalculationEngine(
                system_specs={"bus_voltage": 48, "peak_voltage": 60, "power": 3000,
                              "max_phase_current": 80, "pwm_freq_hz": 0,  # invalid
                              "ambient_temp_c": 30, "gate_drive_voltage": 12},
                mosfet_params={}, driver_params={}, mcu_params={},
                motor_specs={}, overrides={}
            )


# ── Design Constants ──────────────────────────────────────────────────────────

class TestDesignConstants:
    def test_override_applied(self, default_specs):
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={},
            design_constants={"thermal.rds_derating": 2.0}
        )
        assert e._dc("thermal.rds_derating") == 2.0

    def test_default_used_when_no_override(self, engine):
        assert engine._dc("thermal.rds_derating") == 1.5
