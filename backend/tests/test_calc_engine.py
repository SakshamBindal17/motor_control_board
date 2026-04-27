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
    def test_run_all_returns_19_modules(self, engine):
        results = engine.run_all()
        modules = [k for k in results if k not in ("audit_log", "transparency")]
        assert len(modules) == 19

    def test_mosfet_losses_positive(self, engine):
        ml = engine.calc_mosfet_losses()
        assert ml["total_loss_per_fet_w"] > 0
        assert ml["total_all_6_fets_w"] > 0
        assert ml["junction_temp_est_c"] > engine.t_amb

    def test_mosfet_parallel_per_device_scaling(self, default_specs):
        """Per-device current/loss metadata should scale with parallel count."""
        from calc_engine import CalculationEngine

        mosfet = {
            "rds_on": 3.0, "rds_on__unit": "mΩ",
            "qg": 5.0, "qg__unit": "nC",
            "qgd": 1.0, "qgd__unit": "nC",
            "qrr": 1.0, "qrr__unit": "nC",
            "tr": 10.0, "tr__unit": "ns",
            "tf": 10.0, "tf__unit": "ns",
            "rth_jc": 0.4, "rth_jc__unit": "°C/W",
        }

        one_parallel = CalculationEngine(
            system_specs={**default_specs, "num_fets": 6, "pwm_freq_hz": 5000},
            mosfet_params=mosfet,
            driver_params={},
            mcu_params={},
            motor_specs={},
            overrides={},
            design_constants={"thermal.rds_derating": 1.0}
        ).calc_mosfet_losses()

        two_parallel = CalculationEngine(
            system_specs={**default_specs, "num_fets": 12, "pwm_freq_hz": 5000},
            mosfet_params=mosfet,
            driver_params={},
            mcu_params={},
            motor_specs={},
            overrides={},
            design_constants={"thermal.rds_derating": 1.0}
        ).calc_mosfet_losses()

        assert one_parallel["parallel_per_switch"] == pytest.approx(1.0)
        assert two_parallel["parallel_per_switch"] == pytest.approx(2.0)
        assert two_parallel["i_rms_per_device_a"] == pytest.approx(one_parallel["i_rms_per_device_a"] / 2.0, rel=0.03)

        cond_ratio = two_parallel["conduction_loss_per_fet_w"] / one_parallel["conduction_loss_per_fet_w"]
        # Conduction per FET should be close to quarter when current is split 2-way.
        assert 0.15 <= cond_ratio <= 0.35

    def test_dead_time_body_diode_total_independent_of_parallel_count(self, default_specs):
        """Dead-time body-diode total should scale with 3 phase legs, not device count."""
        from calc_engine import CalculationEngine

        dt_6 = CalculationEngine(
            system_specs={**default_specs, "num_fets": 6},
            mosfet_params={"body_diode_vf": 0.8, "body_diode_vf__unit": "V"},
            driver_params={},
            mcu_params={},
            motor_specs={},
            overrides={},
        ).calc_dead_time()

        dt_12 = CalculationEngine(
            system_specs={**default_specs, "num_fets": 12},
            mosfet_params={"body_diode_vf": 0.8, "body_diode_vf__unit": "V"},
            driver_params={},
            mcu_params={},
            motor_specs={},
            overrides={},
        ).calc_dead_time()

        assert dt_6["body_diode_loss_total_w"] == pytest.approx(dt_6["body_diode_loss_per_leg_w"] * 3, rel=1e-3)
        assert dt_12["body_diode_loss_total_w"] == pytest.approx(dt_6["body_diode_loss_total_w"], rel=1e-3)

    def test_mosfet_losses_cached(self, engine):
        """Bug fix: Second call should return cached result."""
        r1 = engine.calc_mosfet_losses()
        r2 = engine.calc_mosfet_losses()
        assert r1 is r2  # same object

    def test_gate_resistors(self, engine):
        gr = engine.calc_gate_resistors()
        assert gr["hs_rg_on_ohm"] > 0
        assert gr["ls_rg_off_ohm"] > 0
        assert gr["hs_gate_rise_time_ns"] > 0

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

    def test_thermal_uses_pcb_trace_copper_and_via_overrides(self, default_specs):
        from calc_engine import CalculationEngine

        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={},
            pcb_trace_thermal_params={
                "current_a": 80,
                "trace_width_mm": 8,
                "trace_length_mm": 25,
                "copper_oz": 4,
                "vias_on": True,
                "n_vias": 18,
                "via_drill_mm": 0.45,
            }
        )

        th = e.calc_thermal()
        assert th["copper_oz"] == 4
        assert th["thermal_vias_per_fet"] == 18
        assert th["via_drill_mm"] == pytest.approx(0.45)
        assert th["trace_conduction_loss_w"] > 0

    def test_thermal_keeps_default_vias_when_trace_vias_disabled(self, default_specs):
        from calc_engine import CalculationEngine

        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={},
            pcb_trace_thermal_params={
                "current_a": 80,
                "trace_width_mm": 8,
                "trace_length_mm": 25,
                "copper_oz": 2,
                "vias_on": False,
                "n_vias": 99,
                "via_drill_mm": 0.6,
            }
        )

        th = e.calc_thermal()
        assert th["copper_oz"] == 2
        assert th["thermal_vias_per_fet"] == int(e._dc("thermal.vias_per_fet"))
        assert th["via_drill_mm"] == pytest.approx(0.3)

    def test_pcb_trace_thermal_normalizes_ipc_2152_aliases(self, default_specs):
        from calc_engine import CalculationEngine

        e_alias = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={},
            pcb_trace_thermal_params={
                "model": "IPC-2152",
                "current_a": 80,
                "trace_width_mm": 6,
                "trace_length_mm": 30,
                "plane_dist_mm": 0.3,
                "copper_fill_pct": 60,
            }
        )
        r_alias = e_alias.calc_pcb_trace_thermal()

        e_2221 = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={},
            pcb_trace_thermal_params={
                "model": "2221",
                "current_a": 80,
                "trace_width_mm": 6,
                "trace_length_mm": 30,
                "plane_dist_mm": 0.3,
                "copper_fill_pct": 60,
            }
        )
        r_2221 = e_2221.calc_pcb_trace_thermal()

        # New multi-section format checks
        assert r_alias["has_data"] is True
        assert r_alias["notes"]["standard"].startswith("IPC-2221B + corrections")
        assert r_2221["notes"]["standard"].startswith("IPC-2221B")
        assert "correction" not in r_2221["notes"]["standard"].lower() or "corrections" not in r_2221["notes"]["standard"]

    def test_protection_dividers(self, engine):
        pd = engine.calc_protection_dividers()
        assert "ovp" in pd
        assert "ocp" in pd
        assert pd["ocp"]["hw_threshold_a"] > engine.i_max

    def test_reverse_gate_rise(self, engine):
        rev = engine.reverse_calculate({"gate_rise_time_ns": 50})
        assert "gate_rise_time_ns" in rev
        assert rev["gate_rise_time_ns"]["solved_value"] > 0

    def test_reverse_gate_rise_uses_miller_basis_when_available(self, default_specs):
        """Reverse rise-time solver should follow Miller-charge basis when Qgd is present."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={"qg": 92, "qg__unit": "nC", "qgd": 28, "qgd__unit": "nC", "vgs_plateau": 5.5, "rg_int": 1.2},
            driver_params={"io_source": 2.0},
            mcu_params={},
            motor_specs={},
            overrides={},
        )
        r = e.reverse_calculate({"gate_rise_time_ns": 45})["gate_rise_time_ns"]
        assert r["rg_sizing_basis"] == "miller_charge"
        assert abs(r["actual_output"] - 45) <= 12  # E24 quantization tolerance

    def test_snubber(self, engine):
        sn = engine.calc_snubber()
        assert sn["rs_recommended_ohm"] >= 1
        assert sn["cs_recommended_pf"] >= 100
        assert sn["num_fets"] == engine.num_fets

    def test_waveform_reported_overshoot_matches_sampled_peak(self, engine):
        wf = engine.calc_waveform()
        reported = wf["annotations"].get("v_overshoot_v")
        if reported is None:
            pytest.skip("Ringing disabled for this waveform configuration")
        sampled = max(0.0, max(wf["vds"]) - engine.v_peak)
        assert reported == pytest.approx(sampled, abs=0.1)
        assert wf["params_used"]["v_overshoot_v"] == pytest.approx(sampled, abs=0.1)

    def test_waveform_miller_times_increase_with_vds_swing(self, default_specs):
        from calc_engine import CalculationEngine

        mosfet = {
            "qgd": 29, "qgd__unit": "nC",
            "qrr": 110, "qrr__unit": "nC",
            "vds_max": 80, "vds_max__unit": "V",
            "vgs_plateau": 4.9,
            "vgs_th": 3.0,
            "rg_int": 1.4,
            "id_cont": 425, "id_cont__unit": "A",
            "crss": 84, "crss__unit": "pF",
            "ciss": 11000, "ciss__unit": "pF",
            "rds_on": 0.95, "rds_on__unit": "mΩ",
        }

        low_vds_specs = {**default_specs, "peak_voltage": 55}
        high_vds_specs = {**default_specs, "peak_voltage": 80}

        e_low = CalculationEngine(low_vds_specs, mosfet, {}, {}, {}, {})
        e_high = CalculationEngine(high_vds_specs, mosfet, {}, {}, {}, {})

        wf_low = e_low.calc_waveform()
        wf_high = e_high.calc_waveform()

        assert wf_high["annotations"]["turn_on"]["t_miller_on_ns"] > wf_low["annotations"]["turn_on"]["t_miller_on_ns"]
        assert wf_high["annotations"]["turn_off"]["t_miller_off_ns"] > wf_low["annotations"]["turn_off"]["t_miller_off_ns"]

    def test_waveform_turn_times_increase_with_load_current(self, default_specs):
        from calc_engine import CalculationEngine

        mosfet = {
            "qgd": 29, "qgd__unit": "nC",
            "qrr": 110, "qrr__unit": "nC",
            "vds_max": 80, "vds_max__unit": "V",
            "vgs_plateau": 4.9,
            "vgs_th": 3.0,
            "rg_int": 1.4,
            "id_cont": 425, "id_cont__unit": "A",
            "crss": 84, "crss__unit": "pF",
            "ciss": 11000, "ciss__unit": "pF",
            "rds_on": 0.95, "rds_on__unit": "mΩ",
        }

        low_i_specs = {**default_specs, "max_phase_current": 40}
        high_i_specs = {**default_specs, "max_phase_current": 120}

        e_low = CalculationEngine(low_i_specs, mosfet, {}, {}, {}, {})
        e_high = CalculationEngine(high_i_specs, mosfet, {}, {}, {}, {})

        wf_low = e_low.calc_waveform()
        wf_high = e_high.calc_waveform()

        assert wf_high["annotations"]["turn_on"]["total_on_ns"] > wf_low["annotations"]["turn_on"]["total_on_ns"]

    def test_gate_resistors_handles_nonpositive_rise_target_override(self, default_specs):
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={"gate_rise_time_ns": 0}
        )
        gr = e.calc_gate_resistors()
        assert gr["hs_rg_on_ohm"] > 0
        assert gr["hs_gate_rise_time_ns"] > 0

    def test_input_caps_handles_nonpositive_ripple_override(self, default_specs):
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={"delta_v_ripple": 0}
        )
        ic = e.calc_input_capacitors()
        assert ic["delta_v_target_v"] == pytest.approx(2.0)
        assert ic["c_bulk_required_uf"] > 0

    def test_snubber_forward_supports_large_e12_cap_range(self, default_specs):
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={"coss": 50000, "coss__unit": "pF"},
            driver_params={}, mcu_params={}, motor_specs={}, overrides={}
        )
        sn = e.calc_snubber()
        assert sn["cs_recommended_pf"] > 47000

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

    def test_bounds_clamp_too_low(self, default_specs):
        """Design constants below engineering minimum should be clamped."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={},
            design_constants={"thermal.rds_derating": 0.1}  # below min 1.0
        )
        assert e._dc("thermal.rds_derating") == 1.0

    def test_bounds_clamp_too_high(self, default_specs):
        """Design constants above engineering maximum should be clamped."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={},
            design_constants={"thermal.rth_sa": 999}  # above max 100
        )
        assert e._dc("thermal.rth_sa") == 100.0

    def test_input_spwm_mod_index_bounds_prevent_invalid_sqrt(self, default_specs):
        """SPWM modulation index above physical range should be clamped and not crash ripple math."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={}, motor_specs={}, overrides={},
            design_constants={"input.spwm_mod_index": 1.5}
        )
        ic = e.calc_input_capacitors()
        assert ic["i_ripple_rms_a"] >= 0
        assert any("input.spwm_mod_index" in msg for msg in e.audit_log)


# ── Unit Fuzz Tests (µ/μ/u symbol variants) ──────────────────────────────────

class TestUnitFuzz:
    """Verify all micro-symbol Unicode variants produce identical SI conversion."""

    def test_micro_sign_u00b5_farads(self):
        """U+00B5 MICRO SIGN: µF"""
        from unit_utils import to_si
        assert to_si(4.7, "\u00b5F") == pytest.approx(4.7e-6)

    def test_greek_mu_u03bc_farads(self):
        """U+03BC GREEK SMALL LETTER MU: μF"""
        from unit_utils import to_si
        assert to_si(4.7, "\u03bcF") == pytest.approx(4.7e-6)

    def test_ascii_u_farads(self):
        """ASCII fallback: uF"""
        from unit_utils import to_si
        assert to_si(4.7, "uF") == pytest.approx(4.7e-6)

    def test_micro_sign_seconds(self):
        """µs with U+00B5"""
        from unit_utils import to_si
        assert to_si(2.5, "\u00b5s") == pytest.approx(2.5e-6)

    def test_greek_mu_seconds(self):
        """μs with U+03BC"""
        from unit_utils import to_si
        assert to_si(2.5, "\u03bcs") == pytest.approx(2.5e-6)

    def test_ascii_u_seconds(self):
        """us with ASCII u"""
        from unit_utils import to_si
        assert to_si(2.5, "us") == pytest.approx(2.5e-6)

    def test_micro_sign_amps(self):
        """µA with U+00B5"""
        from unit_utils import to_si
        assert to_si(115, "\u00b5A") == pytest.approx(115e-6)

    def test_greek_mu_amps(self):
        """μA with U+03BC"""
        from unit_utils import to_si
        assert to_si(115, "\u03bcA") == pytest.approx(115e-6)

    def test_ascii_u_amps(self):
        """uA with ASCII u"""
        from unit_utils import to_si
        assert to_si(115, "uA") == pytest.approx(115e-6)

    def test_micro_sign_henries(self):
        """µH with U+00B5"""
        from unit_utils import to_si
        assert to_si(330, "\u00b5H") == pytest.approx(330e-6)

    def test_greek_mu_henries(self):
        """μH with U+03BC"""
        from unit_utils import to_si
        assert to_si(330, "\u03bcH") == pytest.approx(330e-6)

    def test_micro_coulombs(self):
        """µC with U+00B5"""
        from unit_utils import to_si
        assert to_si(1, "\u00b5C") == pytest.approx(1e-6)

    def test_mixed_case_micro(self):
        """Mixed case: µf, µS, µa should still normalize correctly."""
        from unit_utils import to_si
        assert to_si(100, "\u00b5f") == pytest.approx(100e-6)  # µf → µF

    def test_milliohm_variants(self):
        """mΩ with different omega symbols."""
        from unit_utils import to_si
        assert to_si(1.5, "m\u2126") == pytest.approx(1.5e-3)  # mΩ (OHM SIGN)
        assert to_si(1.5, "m\u03A9") == pytest.approx(1.5e-3)  # mΩ (GREEK OMEGA)
        assert to_si(1.5, "mohm") == pytest.approx(1.5e-3)       # mohm ASCII


# ── Parameter Sanity Bounds Tests ─────────────────────────────────────────────

class TestParamSanityBounds:
    """Verify that zero/negative extracted values are caught by sanity bounds."""

    def test_qg_zero_returns_fallback(self, default_specs):
        """Qg=0 from bad extraction should return fallback, not crash gate calc."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={"qg": "0", "qg__unit": "nC"},
            driver_params={}, mcu_params={},
            motor_specs={}, overrides={}
        )
        result = e._get(e.mosfet, "MOSFET", "qg", 92e-9)
        assert result == pytest.approx(92e-9)  # should get fallback, not 0

    def test_rds_on_zero_returns_fallback(self, default_specs):
        """Rds(on)=0 should return fallback."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={"rds_on": "0", "rds_on__unit": "mΩ"},
            driver_params={}, mcu_params={},
            motor_specs={}, overrides={}
        )
        result = e._get(e.mosfet, "MOSFET", "rds_on", 1.5e-3)
        assert result == pytest.approx(1.5e-3)

    def test_valid_value_passes_through(self, default_specs):
        """A legitimate extracted value should not be blocked."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={"vds_max": "80", "vds_max__unit": "V"},
            driver_params={}, mcu_params={},
            motor_specs={}, overrides={}
        )
        result = e._get(e.mosfet, "MOSFET", "vds_max", 100)
        assert result == pytest.approx(80.0)

    def test_out_of_range_warns_but_passes(self, default_specs):
        """A suspicious but non-zero value should warn but still return it."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={"vds_max": "5000", "vds_max__unit": "V"},
            driver_params={}, mcu_params={},
            motor_specs={}, overrides={}
        )
        result = e._get(e.mosfet, "MOSFET", "vds_max", 100)
        # Value passes through (could be exotic SiC), but audit log warns
        assert result == pytest.approx(5000.0)
        assert any("SANITY WARNING" in msg for msg in e.audit_log)


# -- Bootstrap Reverse-Calculation Tests --------------------------------------

class TestBootstrapReverse:
    def test_reverse_min_on_time_returns_c_boot(self, engine):
        """Reverse solver should map min on-time target to a practical C_boot."""
        rev = engine.reverse_calculate({"min_hs_on_time_ns": 4000})
        r = rev["min_hs_on_time_ns"]
        assert r["solved_key"] == "c_boot_recommended_nf"
        assert r["solved_value"] >= 100
        assert r["apply_bootstrap_droop_v"] > 0

    def test_reverse_min_on_time_snaps_down_to_meet_target(self, engine):
        """For feasible targets, reverse bootstrap solver should not choose a cap that exceeds the target min on-time."""
        rev = engine.reverse_calculate({"min_hs_on_time_ns": 4000})
        r = rev["min_hs_on_time_ns"]
        assert r["feasible"] is True
        assert r["actual_output"] <= 4000
        # With default R_boot=10Ω, 4us ideal is 133nF; E12 floor should be 120nF.
        assert r["solved_value"] == pytest.approx(120.0)

    def test_reverse_min_on_time_detects_unachievable_target(self, engine):
        """Very small target must be marked infeasible if min practical C_boot cannot meet it."""
        rev = engine.reverse_calculate({"min_hs_on_time_ns": 100})
        r = rev["min_hs_on_time_ns"]
        assert r["feasible"] is False
        assert "minimum achievable" in (r.get("constraint") or "").lower()

    def test_apply_bootstrap_droop_reproduces_solved_cap(self, default_specs):
        """Apply override from reverse result should reproduce solved C_boot in forward calculation."""
        from calc_engine import CalculationEngine

        base_engine = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={}, overrides={}
        )
        rev = base_engine.reverse_calculate({"min_hs_on_time_ns": 4000})
        solved = rev["min_hs_on_time_ns"]

        apply_engine = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={}, mcu_params={},
            motor_specs={},
            overrides={"bootstrap_droop_v": solved["apply_bootstrap_droop_v"]},
        )
        fwd = apply_engine.calc_bootstrap_cap()
        assert fwd["c_boot_recommended_nf"] == pytest.approx(solved["solved_value"])


class TestReverseAliasesAndConstraints:
    def test_reverse_snubber_power_accepts_total_alias(self, engine):
        """Frontend key p_total_all_snubbers_w should be accepted by reverse endpoint."""
        rev = engine.reverse_calculate({"p_total_all_snubbers_w": 2.0})
        assert "p_total_all_snubbers_w" in rev
        assert rev["p_total_all_snubbers_w"]["solved_key"] == "cs_recommended_pf"

    def test_reverse_snubber_power_respects_configured_fet_count(self, default_specs):
        """Reverse snubber power solver must use configured snubber count, not a hardcoded 6."""
        from calc_engine import CalculationEngine
        specs = {**default_specs, "num_fets": 12}
        e = CalculationEngine(
            system_specs=specs,
            mosfet_params={},
            driver_params={},
            mcu_params={},
            motor_specs={},
            overrides={},
        )
        r = e.reverse_calculate({"p_total_all_snubbers_w": 4.0})["p_total_all_snubbers_w"]
        assert r["solved_value"] == pytest.approx(10000.0)
        assert "N=12" in (r.get("note") or "")

    def test_reverse_snubber_power_flags_infeasible_when_target_above_supported_range(self, default_specs):
        """Targets requiring Cs above max supported E12 value must be marked infeasible."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={},
            driver_params={},
            mcu_params={},
            motor_specs={},
            overrides={},
        )
        r = e.reverse_calculate({"p_total_all_snubbers_w": 300.0})["p_total_all_snubbers_w"]
        assert r["feasible"] is False
        assert "maximum achievable" in (r.get("constraint") or "").lower()

    def test_reverse_dt_pct_marks_above_mcu_limit_infeasible(self, default_specs):
        """Dead-time percentage reverse solver should enforce MCU max dead-time limit."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={},
            driver_params={},
            mcu_params={"pwm_deadtime_max": 500, "pwm_deadtime_max__unit": "ns"},
            motor_specs={},
            overrides={},
        )
        r = e.reverse_calculate({"dt_pct_of_period": 5.0})["dt_pct_of_period"]
        assert r["feasible"] is False
        assert "Exceeds MCU max dead time" in (r.get("constraint") or "")


class TestCrossValidationConsistency:
    def test_cross_validation_deadtime_includes_driver_fall_time(self, default_specs):
        """Cross-validation dead-time check should include driver fall-time like dead_time module."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={"td_off": 50, "td_off__unit": "ns", "tf": 20, "tf__unit": "ns"},
            driver_params={"prop_delay_off": 60, "prop_delay_off__unit": "ns", "fall_time_out": 600, "fall_time_out__unit": "ns"},
            mcu_params={"pwm_deadtime_res": 10, "pwm_deadtime_res__unit": "ns", "pwm_deadtime_max": 500, "pwm_deadtime_max__unit": "ns"},
            motor_specs={}, overrides={}
        )
        cv = e.calc_cross_validation()
        dt_check = next(c for c in cv["checks"] if c["id"] == "mcu_dt_resolution")
        assert dt_check["status"] == "fail"

    def test_cross_validation_warns_when_bootstrap_uvlo_missing(self, default_specs):
        """Bootstrap UVLO quality gate should warn when vbs_uvlo is not extracted."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={},
            driver_params={},
            mcu_params={},
            motor_specs={},
            overrides={}
        )
        cv = e.calc_cross_validation()
        uvlo_q = next(c for c in cv["checks"] if c["id"] == "vbs_uvlo_data_quality")
        assert uvlo_q["status"] == "warn"

    def test_cross_validation_fails_on_suspicious_bootstrap_uvlo(self, default_specs):
        """Clearly implausible bootstrap UVLO extraction should fail data-quality check."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={},
            driver_params={"vbs_uvlo": 40, "vbs_uvlo__unit": "V"},
            mcu_params={},
            motor_specs={},
            overrides={}
        )
        cv = e.calc_cross_validation()
        uvlo_q = next(c for c in cv["checks"] if c["id"] == "vbs_uvlo_data_quality")
        assert uvlo_q["status"] == "fail"


class TestBootstrapUvloQuality:
    def test_bootstrap_downstream_includes_uvlo_data_quality_fields(self, default_specs):
        """Reverse bootstrap analysis should surface UVLO data trust metadata."""
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={},
            driver_params={"vbs_uvlo": 6.7, "vbs_uvlo__unit": "V"},
            mcu_params={},
            motor_specs={},
            overrides={}
        )
        rev = e.reverse_calculate({"min_hs_on_time_ns": 4000})["min_hs_on_time_ns"]
        ds = rev["downstream"]
        assert ds["uvlo_data_status"] == "verified"
        assert ds["uvlo_data_trusted"] is True
        assert ds["uvlo_data_source_key"] == "vbs_uvlo"


class TestPowerBypassParsing:
    def test_power_supply_bypass_parses_vdd_range_string(self, default_specs):
        from calc_engine import CalculationEngine
        e = CalculationEngine(
            system_specs=default_specs,
            mosfet_params={}, driver_params={},
            mcu_params={"vdd_range": "2.7-3.6"},
            motor_specs={}, overrides={}
        )
        ps = e.calc_power_supply_bypass()
        assert ps["vdd_mcu"]["voltage_v"] == pytest.approx(3.6)
