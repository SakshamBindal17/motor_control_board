"""Motor Controller Hardware Design — Waveform Generator

Generates time-domain switching waveforms for MOSFET gate-drive circuit.
Uses the 4-region analytical model for turn-on and turn-off transitions.

References:
  - TI SLUA618: "Understanding MOSFET Parameters"
  - Infineon AN-1001: "MOSFET Basics"
  - Erickson & Maksimovic, "Fundamentals of Power Electronics", Ch. 4

Physics model:
  Region 1 (Pre-threshold):  Vgs charges 0→Vth via RC(Ciss), Id=0, Vds=Vbus
  Region 2 (Linear/Active):  Vgs charges Vth→Vplateau, Id rises 0→Iload
  Region 3 (Miller plateau): Vgs=Vplateau, Qgd charges, Vds falls Vbus→Vds_on
  Region 4 (Post-plateau):   Vgs charges Vplateau→Vdrv, Id=Iload, Vds=Vds_on

Turn-off is the exact reverse: Region 4'→3'→2'→1'
"""

import math


class WaveformMixin:
    """Mixin providing switching waveform generation for oscilloscope display."""

    def calc_waveform(self) -> dict:
        """Generate one full PWM switching cycle of waveform data.

        Returns dict with time-series arrays for Vgs, Vds, Id, Ig, Pd
        and timing annotations for each switching region.
        """
        self._current_module = "waveform"

        # ── Extract parameters (all in SI units) ──────────────────────
        ciss   = self._get(self.mosfet, "MOSFET", "ciss",        3000e-12)  # F
        qg     = self._get(self.mosfet, "MOSFET", "qg",          92e-9)     # C
        qgd    = self._get(self.mosfet, "MOSFET", "qgd",         30e-9)     # C
        rds_on = self._get(self.mosfet, "MOSFET", "rds_on",      1.5e-3)    # Ω
        vgs_th = self._get(self.mosfet, "MOSFET", "vgs_th",      3.0)       # V
        vgs_pl = self._get(self.mosfet, "MOSFET", "vgs_plateau", None)      # V
        rg_int = self._get(self.mosfet, "MOSFET", "rg_int",      1.0)       # Ω
        crss   = self._get(self.mosfet, "MOSFET", "crss",        None)      # F
        td_on  = self._get(self.mosfet, "MOSFET", "td_on",       None)      # s
        td_off = self._get(self.mosfet, "MOSFET", "td_off",      None)      # s

        # Driver propagation delays
        t_prop_on  = self._get(self.driver, "DRIVER", "prop_delay_on",  15e-9)  # s
        t_prop_off = self._get(self.driver, "DRIVER", "prop_delay_off", 15e-9)  # s
        io_source  = self._get(self.driver, "DRIVER", "io_source", 4.0)        # A
        io_sink    = self._get(self.driver, "DRIVER", "io_sink",   4.0)        # A

        # Gate resistors from existing calculation (or fallback)
        try:
            gate_calc = self.calc_gate_resistors()
            rg_on_ext  = gate_calc.get("rg_on_recommended_ohm", 4.7)
            rg_off_ext = gate_calc.get("rg_off_recommended_ohm", 2.2)
        except Exception:
            rg_on_ext  = 4.7
            rg_off_ext = 2.2

        # System parameters
        v_drv  = self.v_drv       # Gate drive voltage (V)
        v_bus  = self.v_peak      # DC bus peak voltage (V)
        i_load = self.i_max       # Load current (A)
        fsw    = self.fsw         # Switching frequency (Hz)

        # ── Derived values ────────────────────────────────────────────
        rg_on  = rg_int + rg_on_ext
        rg_off = rg_int + rg_off_ext

        # Miller plateau voltage estimate (if not extracted)
        if vgs_pl is None:
            # Estimate: Vplateau ≈ Vth + Iload/gfs
            # Typical gfs for power MOSFETs: 20-200 S
            # Rough estimate: Vplateau ≈ Vth + 1.0V
            vgs_pl = vgs_th + 1.0
            self.audit_log.append(
                f"[Waveform] Vgs_plateau not extracted, estimated as Vth+1.0 = {vgs_pl:.1f}V."
            )

        # Clamp plateau to be between Vth and Vdrv
        vgs_pl = max(vgs_th + 0.2, min(vgs_pl, v_drv - 0.5))

        # Vds when fully on
        vds_on = i_load * rds_on * self._dc("thermal.rds_derating")

        # Transconductance (used for Region 2 Id ramp)
        gfs = i_load / (vgs_pl - vgs_th) if (vgs_pl - vgs_th) > 0.1 else i_load / 0.5

        # Cgd from Qgd and voltage swing
        v_ds_swing = v_bus - vds_on
        cgd = qgd / v_ds_swing if v_ds_swing > 0 else crss or 100e-12

        # RC time constants
        tau_on  = rg_on * ciss      # Turn-on charging
        tau_off = rg_off * ciss     # Turn-off discharging

        # ── Generate turn-on waveform ─────────────────────────────────
        dt = 0.1e-9  # 0.1ns resolution
        max_points = 5000

        # Region 1: Pre-threshold (0 → Vth)
        # Vgs(t) = Vdrv × (1 - e^(-t/τ)), solve for t when Vgs = Vth
        if v_drv > vgs_th and tau_on > 0:
            t_r1 = -tau_on * math.log(1 - vgs_th / v_drv)
        else:
            t_r1 = 10e-9  # fallback 10ns

        # Region 2: Active (Vth → Vplateau)
        # Vgs continues charging, Id ramps linearly with Vgs
        if v_drv > vgs_pl and tau_on > 0:
            t_r1_r2 = -tau_on * math.log(1 - vgs_pl / v_drv)
            t_r2 = t_r1_r2 - t_r1
        else:
            t_r2 = 5e-9

        # Region 3: Miller plateau
        # Gate current charges Cgd, Vgs stays at Vplateau
        ig_miller_on = (v_drv - vgs_pl) / rg_on if rg_on > 0 else io_source
        ig_miller_on = min(ig_miller_on, io_source)  # limited by driver
        t_r3 = qgd / ig_miller_on if ig_miller_on > 0 else 20e-9

        # Region 4: Post-plateau (Vplateau → Vdrv)
        # Remaining Ciss charging from Vplateau to Vdrv
        # t = -τ × ln((Vdrv - Vdrv) / (Vdrv - Vplateau))  →  we stop at 99%
        t_r4 = -tau_on * math.log(0.02) if tau_on > 0 else 20e-9  # ~4τ to 98%
        t_r4 = min(t_r4, 200e-9)  # cap at 200ns

        # Total turn-on time
        t_turn_on = t_r1 + t_r2 + t_r3 + t_r4

        # ── Generate turn-off waveform (reverse) ─────────────────────
        # Region 4': Post-plateau discharge (Vdrv → Vplateau)
        t_r4_off = -tau_off * math.log(vgs_pl / v_drv) if (v_drv > 0 and tau_off > 0) else 20e-9
        t_r4_off = min(t_r4_off, 200e-9)

        # Region 3': Miller plateau (Vgs = Vplateau, Vds rises)
        ig_miller_off = vgs_pl / rg_off if rg_off > 0 else io_sink
        ig_miller_off = min(ig_miller_off, io_sink)
        t_r3_off = qgd / ig_miller_off if ig_miller_off > 0 else 20e-9

        # Region 2': Active (Vplateau → Vth, Id falls)
        if vgs_pl > 0 and tau_off > 0:
            t_r2_off_total = -tau_off * math.log(vgs_th / vgs_pl) if vgs_th < vgs_pl else 5e-9
            t_r2_off = min(t_r2_off_total, 50e-9)
        else:
            t_r2_off = 5e-9

        # Region 1': Sub-threshold discharge (Vth → 0)
        if vgs_th > 0 and tau_off > 0:
            t_r1_off = -tau_off * math.log(0.02 / vgs_th) if vgs_th > 0.02 else 20e-9
            t_r1_off = min(t_r1_off, 200e-9)
        else:
            t_r1_off = 20e-9

        t_turn_off = t_r4_off + t_r3_off + t_r2_off + t_r1_off

        # ── Dead time ─────────────────────────────────────────────────
        dt_prop = float(t_prop_on) if t_prop_on else 15e-9
        dt_calc = self._dc("dt.abs_margin") * 1e-9       # margin in ns → s
        dt_safety = self._dc("dt.safety_mult")
        dead_time = max(50e-9, (t_turn_off + dt_prop) * dt_safety + dt_calc)
        dead_time = min(dead_time, 2e-6)  # cap at 2µs

        # ── Build the full cycle time array ───────────────────────────
        # Layout: [dead_time | turn_on | on_time | turn_off | dead_time]
        period = 1.0 / fsw
        on_time_total = period * 0.5  # 50% duty cycle for visualization
        # Flat on-time after turn-on completes
        flat_on = max(0, on_time_total - t_turn_on - dead_time)
        # Flat off-time
        flat_off = max(0, period - on_time_total - t_turn_off - dead_time)

        # For display, only show ~2× the transition region (not the full period)
        # This gives a clear view of the switching events
        margin = max(t_turn_on, t_turn_off) * 0.3
        view_on_flat = min(flat_on, max(t_turn_on * 2, 200e-9))
        view_off_flat = min(flat_off, max(t_turn_off * 2, 200e-9))
        total_view = dead_time + t_turn_on + view_on_flat + t_turn_off + dead_time + margin

        # Determine time step for ~800 points
        n_points = 800
        dt_step = total_view / n_points if total_view > 0 else 1e-9

        # ── Sample the waveform ───────────────────────────────────────
        times = []
        vgs_arr = []
        vds_arr = []
        id_arr = []
        ig_arr = []
        pd_arr = []

        t = 0
        while t <= total_view and len(times) < max_points:
            vgs, vds, i_d, i_g = self._sample_waveform(
                t, v_drv, v_bus, i_load, vgs_th, vgs_pl, vds_on,
                gfs, rg_on, rg_off, tau_on, tau_off,
                ig_miller_on, ig_miller_off,
                t_r1, t_r2, t_r3, t_r4,
                t_r4_off, t_r3_off, t_r2_off, t_r1_off,
                dead_time, t_turn_on, view_on_flat, t_turn_off,
            )

            times.append(round(t * 1e9, 2))       # ns
            vgs_arr.append(round(vgs, 3))          # V
            vds_arr.append(round(vds, 2))          # V
            id_arr.append(round(i_d, 2))           # A
            ig_arr.append(round(i_g, 3))           # A
            pd_arr.append(round(vds * i_d, 1))     # W

            t += dt_step

        # ── Timing annotations ────────────────────────────────────────
        annotations = {
            "turn_on": {
                "t_dead_start_ns":  0,
                "t_dead_end_ns":    round(dead_time * 1e9, 1),
                "t_r1_ns":          round(t_r1 * 1e9, 1),
                "t_r2_ns":          round(t_r2 * 1e9, 1),
                "t_miller_on_ns":   round(t_r3 * 1e9, 1),
                "t_r4_ns":          round(t_r4 * 1e9, 1),
                "total_on_ns":      round(t_turn_on * 1e9, 1),
                "ig_miller_on_a":   round(ig_miller_on, 2),
            },
            "turn_off": {
                "t_r4_off_ns":      round(t_r4_off * 1e9, 1),
                "t_miller_off_ns":  round(t_r3_off * 1e9, 1),
                "t_r2_off_ns":      round(t_r2_off * 1e9, 1),
                "t_r1_off_ns":      round(t_r1_off * 1e9, 1),
                "total_off_ns":     round(t_turn_off * 1e9, 1),
                "ig_miller_off_a":  round(ig_miller_off, 2),
            },
            "dead_time_ns":     round(dead_time * 1e9, 1),
            "vgs_plateau_v":    round(vgs_pl, 2),
            "vgs_threshold_v":  round(vgs_th, 2),
        }

        # ── Key parameters used (for display) ─────────────────────────
        params_used = {
            "ciss_pf":      round(ciss * 1e12, 0),
            "qg_nc":        round(qg * 1e9, 1),
            "qgd_nc":       round(qgd * 1e9, 1),
            "rds_on_mohm":  round(rds_on * 1e3, 2),
            "vgs_th_v":     round(vgs_th, 2),
            "vgs_pl_v":     round(vgs_pl, 2),
            "rg_int_ohm":   round(rg_int, 2),
            "rg_on_ext_ohm": round(rg_on_ext, 1),
            "rg_off_ext_ohm": round(rg_off_ext, 1),
            "v_drv_v":      round(v_drv, 1),
            "v_bus_v":      round(v_bus, 1),
            "i_load_a":     round(i_load, 1),
            "fsw_khz":      round(fsw / 1e3, 1),
        }

        self.audit_log.append(
            f"[Waveform] Generated switching waveform: "
            f"turn-on={t_turn_on*1e9:.0f}ns, Miller={t_r3*1e9:.0f}ns, "
            f"turn-off={t_turn_off*1e9:.0f}ns, dead-time={dead_time*1e9:.0f}ns."
        )

        return {
            "time_ns":       times,
            "vgs":           vgs_arr,
            "vds":           vds_arr,
            "id":            id_arr,
            "ig":            ig_arr,
            "pd":            pd_arr,
            "annotations":   annotations,
            "params_used":   params_used,
            "model_note":    (
                "Analytical 4-region MOSFET switching model. Assumes linear Ciss/Cgd, "
                "constant load current, and ideal gate driver current limiting. "
                "Note: In reality, Ciss varies ~5× over the Vds range — actual "
                "pre-threshold (Region 1) time may be ~2× longer than modeled, and "
                "post-plateau (Region 4) time may be shorter. "
                "Waveform shapes and timing are representative — for exact behavior, "
                "validate with oscilloscope measurement."
            ),
            "_meta": self._module_meta.get("waveform", {"hardcoded": [], "fallbacks": []}),
        }

    def _sample_waveform(
        self, t, v_drv, v_bus, i_load, vgs_th, vgs_pl, vds_on,
        gfs, rg_on, rg_off, tau_on, tau_off,
        ig_miller_on, ig_miller_off,
        t_r1, t_r2, t_r3, t_r4,
        t_r4_off, t_r3_off, t_r2_off, t_r1_off,
        dead_time, t_turn_on, flat_on, t_turn_off,
    ):
        """Sample Vgs, Vds, Id, Ig at time t within one switching cycle.

        Timeline:
          [0, dead_time)                              → Dead time (FET off)
          [dead_time, dead_time+t_turn_on)            → Turn-on transition
          [dead_time+t_turn_on, ... +flat_on)         → Fully on (flat)
          [... +flat_on, ... +t_turn_off)             → Turn-off transition
          [... +t_turn_off, ...)                      → Dead time (FET off)
        """
        t_on_start = dead_time
        t_on_end = dead_time + t_turn_on
        t_flat_end = t_on_end + flat_on
        t_off_end = t_flat_end + t_turn_off

        # ── Dead time 1 (before turn-on) ──
        if t < t_on_start:
            return (0.0, v_bus, 0.0, 0.0)

        # ── Turn-on transition ──
        elif t < t_on_end:
            t_local = t - t_on_start

            # Region 1: Pre-threshold
            if t_local < t_r1:
                vgs = v_drv * (1 - math.exp(-t_local / tau_on)) if tau_on > 0 else 0
                ig = (v_drv - vgs) / rg_on if rg_on > 0 else 0
                return (vgs, v_bus, 0.0, ig)

            # Region 2: Active (Vth → Vplateau, Id ramps up)
            elif t_local < t_r1 + t_r2:
                t_abs = t_local  # from start of RC charging
                vgs = v_drv * (1 - math.exp(-t_abs / tau_on)) if tau_on > 0 else vgs_pl
                vgs = min(vgs, vgs_pl)
                frac = (t_local - t_r1) / t_r2 if t_r2 > 0 else 1.0
                frac = max(0, min(1, frac))
                i_d = i_load * frac
                ig = (v_drv - vgs) / rg_on if rg_on > 0 else 0
                # Vds starts dropping slightly as current flows through Rds
                vds = v_bus - (v_bus - vds_on) * frac * 0.05  # slight Vds drop
                return (vgs, vds, i_d, ig)

            # Region 3: Miller plateau (Vgs flat, Vds drops)
            elif t_local < t_r1 + t_r2 + t_r3:
                frac = (t_local - t_r1 - t_r2) / t_r3 if t_r3 > 0 else 1.0
                frac = max(0, min(1, frac))
                vgs = vgs_pl
                vds = v_bus - (v_bus - vds_on) * frac
                return (vgs, vds, i_load, ig_miller_on)

            # Region 4: Post-plateau (Vplateau → Vdrv)
            else:
                t_local_r4 = t_local - t_r1 - t_r2 - t_r3
                # RC charge from Vplateau towards Vdrv
                vgs = v_drv - (v_drv - vgs_pl) * math.exp(-t_local_r4 / tau_on) if tau_on > 0 else v_drv
                ig = (v_drv - vgs) / rg_on if rg_on > 0 else 0
                return (vgs, vds_on, i_load, ig)

        # ── Fully on (flat) ──
        elif t < t_flat_end:
            return (v_drv, vds_on, i_load, 0.0)

        # ── Turn-off transition ──
        elif t < t_off_end:
            t_local = t - t_flat_end

            # Region 4': Vdrv → Vplateau (discharge)
            if t_local < t_r4_off:
                vgs = v_drv * math.exp(-t_local / tau_off) if tau_off > 0 else vgs_pl
                vgs = max(vgs, vgs_pl)
                ig = -vgs / rg_off if rg_off > 0 else 0
                return (vgs, vds_on, i_load, ig)

            # Region 3': Miller plateau (Vgs flat, Vds rises)
            elif t_local < t_r4_off + t_r3_off:
                frac = (t_local - t_r4_off) / t_r3_off if t_r3_off > 0 else 1.0
                frac = max(0, min(1, frac))
                vgs = vgs_pl
                vds = vds_on + (v_bus - vds_on) * frac
                return (vgs, vds, i_load, -ig_miller_off)

            # Region 2': Active (Vplateau → Vth, Id falls)
            elif t_local < t_r4_off + t_r3_off + t_r2_off:
                t_from_r2 = t_local - t_r4_off - t_r3_off
                frac = t_from_r2 / t_r2_off if t_r2_off > 0 else 1.0
                frac = max(0, min(1, frac))
                vgs = vgs_pl - (vgs_pl - vgs_th) * frac
                i_d = i_load * (1 - frac)
                ig = -vgs / rg_off if rg_off > 0 else 0
                return (vgs, v_bus, i_d, ig)

            # Region 1': Sub-threshold (Vth → 0)
            else:
                t_from_r1 = t_local - t_r4_off - t_r3_off - t_r2_off
                vgs = vgs_th * math.exp(-t_from_r1 / tau_off) if tau_off > 0 else 0
                ig = -vgs / rg_off if rg_off > 0 else 0
                return (vgs, v_bus, 0.0, ig)

        # ── Dead time 2 (after turn-off) ──
        else:
            return (0.0, v_bus, 0.0, 0.0)
