"""Motor Controller Hardware Design — Waveform Generator

Generates time-domain switching waveforms for MOSFET gate-drive circuit.
Uses the 4-region analytical model for turn-on and turn-off transitions.

References:
  - TI SLUA618: "Understanding MOSFET Parameters"
  - Infineon AN-1001: "MOSFET Basics"
  - Erickson & Maksimovic, "Fundamentals of Power Electronics", Ch. 4
  - Ren, Y. et al., "Analytical Loss Model of Power MOSFET", IEEE Trans. PE 2006

Physics model (turn-on):
  Region 1 (Pre-threshold):  Vgs charges 0→Vth via RC(Ciss), Id=0, Vds=Vbus
  Region 2 (Active/Trans.):  Vgs charges Vth→Vplateau, Id rises via gm×(Vgs−Vth), Vds=Vbus
  Region 3 (Miller plateau): Vgs=Vplateau, Qgd_eff charges, Vds falls Vbus→Vds_on
  Region 4 (Post-plateau):   Vgs charges Vplateau→Vdrv, Vds rings around Vds_on

Turn-off is the exact reverse: Region 4'→3'→2'→1', followed by Vds overshoot spike.

Corrections vs. naive model:
    - Qgd_eff uses Vds-swing scaling as primary model:
        Qgd_eff ≈ Qgd_spec × ((Vbus − Vds_on) / Vds_test), bounded for nonlinearity.
        If Vds_max is unavailable, a Crss-based fallback is used.
  - Vgs_plateau updated for actual operating current: Vpl = Vth + Id / gm
    (higher load current → higher plateau → more time in Region 3)
  - Vds ringing after switching events modelled as damped LC oscillation:
    f = 1/(2π√(L×C)), V_peak = I×√(L/C), decay Q≈8 (typical PCB)
  - Region 2 Vds correctly held at Vbus (complementary body-diode clamps node)
  - Region 2 Id follows Vgs via transconductance: Id = gm × (Vgs − Vth)
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

        # ── Extract MOSFET parameters (all in SI units) ───────────────
        ciss    = self._get(self.mosfet, "MOSFET", "ciss",        3000e-12)  # F
        qg      = self._get(self.mosfet, "MOSFET", "qg",          92e-9)     # C
        qgd     = self._get(self.mosfet, "MOSFET", "qgd",         30e-9)     # C
        qrr     = self._get(self.mosfet, "MOSFET", "qrr",         44e-9)     # C
        rds_on  = self._get(self.mosfet, "MOSFET", "rds_on",      1.5e-3)    # Ω
        vgs_th  = self._get(self.mosfet, "MOSFET", "vgs_th",      3.0)       # V
        vgs_pl  = self._get(self.mosfet, "MOSFET", "vgs_plateau", None)      # V
        rg_int  = self._get(self.mosfet, "MOSFET", "rg_int",      1.0)       # Ω
        crss    = self._get(self.mosfet, "MOSFET", "crss",        None)      # F
        coss    = self._get(self.mosfet, "MOSFET", "coss",        200e-12)   # F
        id_cont = self._get(self.mosfet, "MOSFET", "id_cont",     None)      # A

        # ── Extract driver parameters ─────────────────────────────────
        t_prop_on  = self._get(self.driver, "DRIVER", "prop_delay_on",  15e-9)  # s
        t_prop_off = self._get(self.driver, "DRIVER", "prop_delay_off", 15e-9)  # s
        io_source  = self._get(self.driver, "DRIVER", "io_source", 4.0)         # A
        io_sink    = self._get(self.driver, "DRIVER", "io_sink",   4.0)         # A

        # ── Gate resistors from gate_resistors module ─────────────────
        try:
            gate_calc  = self.calc_gate_resistors()
            rg_on_ext  = gate_calc.get("rg_on_recommended_ohm",  4.7)
            rg_off_ext = gate_calc.get("rg_off_recommended_ohm", 2.2)
        except Exception:
            rg_on_ext  = 4.7
            rg_off_ext = 2.2

        # ── System operating conditions ───────────────────────────────
        v_drv  = self.v_drv    # gate drive voltage (V)
        v_bus  = self.v_peak   # DC bus peak voltage (V) — highest Vds seen during switching
        i_load = self.i_max    # peak load current (A)
        fsw    = self.fsw      # switching frequency (Hz)

        rg_on  = rg_int + rg_on_ext    # total on-path gate resistance (Ω)
        rg_off = rg_int + rg_off_ext   # total off-path gate resistance (Ω)

        # ── Temperature-aware switching factors ─────────────────────
        # Uses thermal estimate when available; clamps to practical silicon range.
        tj_est = self.t_amb + 35.0
        try:
            ml = self.calc_mosfet_losses()
            self._current_module = "waveform"
            tj_est = float(ml.get("junction_temp_est_c", tj_est))
        except Exception:
            pass
        tj_sw = max(25.0, min(tj_est, 175.0))
        temp_delta = max(0.0, tj_sw - 25.0)
        qgd_temp_factor = 1.0 + self._dc("waveform.qgd_temp_coeff") * temp_delta
        qrr_temp_factor = 1.0 + self._dc("waveform.qrr_temp_coeff") * temp_delta
        drv_derate = max(0.7, 1.0 - self._dc("waveform.driver_temp_derate_per_c") * temp_delta)
        io_source_eff = max(0.2, io_source * drv_derate)
        io_sink_eff = max(0.2, io_sink * drv_derate)

        # ── Stray PCB inductance (for ringing calculation) ────────────
        l_stray_nh = float(self.ovr.get("stray_inductance_nh", 10.0))
        l_stray    = l_stray_nh * 1e-9  # H

        # ── FIX 1: Vgs_plateau corrected for actual operating current ─
        # Physically: Vgs_plateau = Vgs_th + Id / gm
        # Datasheet gives Vgs_pl at some test current (usually close to id_cont).
        # If id_cont is available, estimate gm and scale plateau to actual i_load.
        # Higher i_load → higher plateau → lower gate driving force → longer Miller time.
        if vgs_pl is None:
            vgs_pl = vgs_th + 1.0
            self.audit_log.append(
                f"[Waveform] Vgs_plateau not extracted — estimated as "
                f"Vth + 1.0 = {vgs_pl:.1f} V."
            )

        vgs_pl_datasheet = vgs_pl   # keep original for reference
        gm_est = None

        if id_cont is not None and id_cont > 0:
            denom = vgs_pl_datasheet - vgs_th
            if denom > 0.1:
                # gm from datasheet: gm = Id_test / (Vpl_test − Vth)
                # Assumes Vgs_plateau was measured near id_cont operating point.
                gm_est = id_cont / denom
                vgs_pl = vgs_th + (i_load / gm_est)
                self.audit_log.append(
                    f"[Waveform] Vgs_plateau scaled for operating current: "
                    f"gm={gm_est:.1f} S (Id_cont={id_cont:.0f} A, "
                    f"Vpl_spec={vgs_pl_datasheet:.2f} V) → "
                    f"Vpl_actual={vgs_pl:.2f} V at I_load={i_load:.0f} A."
                )
            else:
                self.audit_log.append(
                    f"[Waveform] Cannot compute gm — Vpl−Vth={denom:.2f} V too small. "
                    f"Using datasheet Vgs_plateau={vgs_pl:.2f} V."
                )
        else:
            self.audit_log.append(
                f"[Waveform] id_cont not extracted — Vgs_plateau kept at "
                f"{vgs_pl:.2f} V (not scaled for operating current)."
            )

        # Clamp plateau to physically valid range
        vgs_pl = max(vgs_th + 0.2, min(vgs_pl, v_drv - 0.5))

        # ── Vds_on (fully-on drain voltage) ───────────────────────────
        rds_derated = rds_on * self._dc("thermal.rds_derating")
        vds_on = i_load * rds_derated
        vds_on = max(vds_on, 0.01)  # physical floor

        # ── FIX 2: Effective Qgd from nonlinear Cgd(Vds) integration ─
        # Uses calibrated integral when Crss is available and falls back to
        # a bounded power-law scaling when only sparse charge data exists.
        def _qgd_nonlinear(v_swing: float, qgd_spec: float, v_test: float, crss_hi):
            if v_test <= 1e-9:
                return qgd_spec, "datasheet"
            if crss_hi is None or crss_hi <= 1e-14:
                gamma = 0.78 if v_swing >= v_test else 0.90
                q_eff = qgd_spec * ((v_swing / v_test) ** gamma)
                return max(qgd_spec * 0.45, min(q_eff, qgd_spec * 2.5)), "power_law"

            vk = max(4.0, 0.15 * max(v_bus, v_test))
            c_hi = max(crss_hi, (qgd_spec / v_test) * 0.02)
            ln_test = math.log(1.0 + v_test / vk)
            denom = max(vk * ln_test, 1e-15)
            c_lo = c_hi + (qgd_spec - c_hi * v_test) / denom
            c_lo = max(c_hi * 1.05, min(c_lo, c_hi * 40.0))

            q_eff = c_hi * v_swing + (c_lo - c_hi) * vk * math.log(1.0 + v_swing / vk)
            q_eff = max(qgd_spec * 0.35, min(q_eff, qgd_spec * 3.0))
            return q_eff, "nonlinear_cgd_integral"

        v_ds_swing  = max(v_bus - vds_on, 1.0)
        vds_max_val = self._get(self.mosfet, "MOSFET", "vds_max", None)

        if vds_max_val is not None and vds_max_val > 0:
            # Typical datasheet test: Vds = 50% of Vds_max
            vds_test  = vds_max_val * 0.5
            qgd_eff_base, qgd_method = _qgd_nonlinear(v_ds_swing, qgd, vds_test, crss)
            self.audit_log.append(
                f"[Waveform] Qgd_eff ({qgd_method}): "
                f"Qgd_spec={qgd*1e9:.1f} nC, Vds_swing={v_ds_swing:.1f} V, "
                f"Vds_test={vds_test:.0f} V → Qgd_eff_base={qgd_eff_base*1e9:.2f} nC."
            )
        elif crss is not None and crss > 1e-14 and v_ds_swing > 5:
            vds_test = 40.0
            qgd_eff_base, qgd_method = _qgd_nonlinear(v_ds_swing, qgd, vds_test, crss)
            self.audit_log.append(
                f"[Waveform] Vds_max missing — Qgd_eff ({qgd_method}) from "
                f"Crss={crss*1e12:.0f} pF, Vds_swing={v_ds_swing:.1f} V "
                f"(ref Vds_test={vds_test:.0f} V): {qgd_eff_base*1e9:.2f} nC."
            )
        else:
            # Fallback: use datasheet Qgd as-is
            qgd_eff_base = qgd
            qgd_method = "datasheet"
            self.audit_log.append(
                f"[Waveform] Vds_max and Crss not extracted — using datasheet "
                f"Qgd = {qgd*1e9:.1f} nC directly. Extract Vds_max for accurate "
                f"Miller time scaling."
            )

        qgd_eff_temp = qgd_eff_base * qgd_temp_factor
        qrr_eff = qrr * qrr_temp_factor
        qrr_coupling = self._dc("waveform.qrr_miller_coupling")
        comm_scale = min(1.5, max(0.3, i_load / max(id_cont or i_load, 1.0)))
        qgd_rr = qrr_eff * qrr_coupling * comm_scale

        # Turn-on includes additional commutation burden from reverse recovery;
        # turn-off excludes it because this term is tied to opposite diode recovery.
        qgd_on_eff = max(qgd * 0.35, min(qgd_eff_temp + qgd_rr, qgd * 4.0))
        qgd_off_eff = max(qgd * 0.35, min(qgd_eff_temp, qgd * 3.5))

        self.audit_log.append(
            f"[Waveform] Temp-adjusted charges at Tj_model={tj_sw:.1f}C: "
            f"Qgd_on_eff={qgd_on_eff*1e9:.2f} nC, Qgd_off_eff={qgd_off_eff*1e9:.2f} nC, "
            f"Qrr_eff={qrr_eff*1e9:.1f} nC, driver derate={drv_derate:.3f}."
        )

        # ── Transconductance (for Region 2 Id shape) ─────────────────
        gfs = i_load / (vgs_pl - vgs_th) if (vgs_pl - vgs_th) > 0.1 else i_load / 0.5

        # ── FIX 3: Ring parameters (Lstray–Coss LC resonance) ─────────
        # After turn-on Miller: small ring around Vds_on (body-diode recovery)
        # After turn-off Id snap: large spike + ring above Vbus (Lstray × dI/dt)
        vds_overshoot_danger = False
        vds_overshoot_warning = None

        if l_stray > 0 and coss > 0:
            f_ring     = 1.0 / (2 * math.pi * math.sqrt(l_stray * coss))
            Q_ring     = self._dc("snub.ring_q_factor")
            tau_ring   = Q_ring / (math.pi * f_ring)
            omega_ring = 2 * math.pi * f_ring
            # V_overshoot = I × sqrt(L/C) — peak spike above Vbus at turn-off
            v_overshoot_raw = i_load * math.sqrt(l_stray / max(coss, 1e-15))

            # Avalanche danger check — must happen on the raw (unclamped) value
            if vds_max_val is not None and vds_max_val > 0:
                danger_threshold = vds_max_val * 0.85
                if v_overshoot_raw >= danger_threshold:
                    vds_overshoot_danger = True
                    vds_overshoot_warning = (
                        f"⚠ Vds overshoot {v_bus + v_overshoot_raw:.0f} V "
                        f"({v_overshoot_raw:.0f} V above bus) reaches "
                        f"{v_overshoot_raw / vds_max_val * 100:.0f}% of Vds_max "
                        f"({vds_max_val:.0f} V) — avalanche risk. "
                        f"Reduce L_stray, add snubber, or choose higher Vds_max MOSFET."
                    )
                    self.audit_log.append(f"[Waveform] DANGER: {vds_overshoot_warning}")

            # Cap display at Vds_max × 0.9 (MOSFET breakdown) if extracted, else 3× Vbus
            _vds_cap = (vds_max_val * 0.9) if (vds_max_val is not None and vds_max_val > 0) else (v_bus * 3.0)
            v_overshoot_off = min(v_overshoot_raw, _vds_cap)
            # Turn-on ring is smaller — mainly from complementary body-diode recovery
            v_ring_on  = v_overshoot_off * 0.15
            self.audit_log.append(
                f"[Waveform] Switching ring: f = {f_ring/1e6:.0f} MHz, "
                f"V_ov(off) = {v_overshoot_off:.1f} V, τ = {tau_ring*1e9:.0f} ns "
                f"(Q = {Q_ring}, L_stray = {l_stray_nh:.0f} nH, "
                f"Coss = {coss*1e12:.0f} pF)."
            )
        else:
            f_ring = 0.0;  tau_ring = 1e-9;  omega_ring = 0.0
            v_overshoot_off = 0.0;  v_ring_on = 0.0

        # ── RC time constants ─────────────────────────────────────────
        tau_on  = rg_on  * ciss   # turn-on RC time constant
        tau_off = rg_off * ciss   # turn-off RC time constant

        # ── Turn-on region durations ──────────────────────────────────
        # Region 1: Vgs charges from 0 to Vth (gate capacitance only, Id=0)
        if v_drv > vgs_th and tau_on > 0:
            t_r1 = -tau_on * math.log(1.0 - vgs_th / v_drv)
        else:
            t_r1 = 10e-9

        # Region 2: Vgs continues charging Vth → Vplateau (Id ramps via gm)
        if v_drv > vgs_pl and tau_on > 0:
            t_total_r1r2 = -tau_on * math.log(1.0 - vgs_pl / v_drv)
            t_r2 = max(0.0, t_total_r1r2 - t_r1)
        else:
            t_r2 = 5e-9

        # Region 3: Miller plateau with common-source inductance feedback.
        l_cs_nh = self._dc("waveform.common_source_inductance_nh")
        l_cs = max(0.0, l_cs_nh) * 1e-9
        di_dt_on_raw = i_load / max(t_r2, 5e-9)
        di_dt_limited = v_ds_swing / max(l_stray, 1e-9)
        di_dt_on = min(di_dt_on_raw, di_dt_limited)
        v_lcs_on_raw = l_cs * di_dt_on
        v_lcs_on = min(v_lcs_on_raw, max(0.2, 0.65 * max(v_drv - vgs_pl, 0.3)))

        ig_miller_on_ideal = (v_drv - vgs_pl) / rg_on if rg_on > 0 else io_source_eff
        ig_miller_on_floor = max(0.02, min(io_source_eff * 0.2, max(ig_miller_on_ideal * 0.2, 0.02)))
        ig_miller_on = (v_drv - vgs_pl - v_lcs_on) / rg_on if rg_on > 0 else io_source_eff
        ig_miller_on = min(max(ig_miller_on, ig_miller_on_floor), io_source_eff)
        t_r3 = qgd_on_eff / ig_miller_on

        # Region 4: Post-plateau Vgs charges Vplateau → Vdrv (~4τ)
        t_r4 = min(-tau_on * math.log(0.02) if tau_on > 0 else 20e-9, 200e-9)

        t_turn_on = t_r1 + t_r2 + t_r3 + t_r4

        # ── Turn-off region durations ─────────────────────────────────
        # Region 4': Vgs discharges Vdrv → Vplateau
        t_r4_off = min(
            -tau_off * math.log(vgs_pl / v_drv) if (v_drv > 0 and tau_off > 0 and vgs_pl > 0) else 20e-9,
            200e-9
        )

        # Region 2': Vgs discharges Vplateau → Vth, Id falls to 0
        t_r2_off = min(
            -tau_off * math.log(vgs_th / vgs_pl) if (vgs_th < vgs_pl and tau_off > 0) else 5e-9,
            50e-9
        )

        di_dt_off_raw = i_load / max(t_r2_off, 5e-9)
        di_dt_off = min(di_dt_off_raw, di_dt_limited)
        v_lcs_off_raw = l_cs * di_dt_off
        v_lcs_off = min(v_lcs_off_raw, max(0.15, 0.65 * max(vgs_pl, 0.2)))
        ig_miller_off_ideal = vgs_pl / rg_off if rg_off > 0 else io_sink_eff
        ig_miller_off_floor = max(0.02, min(io_sink_eff * 0.2, max(ig_miller_off_ideal * 0.2, 0.02)))
        ig_miller_off = (vgs_pl - v_lcs_off) / rg_off if rg_off > 0 else io_sink_eff
        ig_miller_off = min(max(ig_miller_off, ig_miller_off_floor), io_sink_eff)
        t_r3_off = qgd_off_eff / ig_miller_off

        # Region 1': Sub-threshold discharge Vth → 0
        t_r1_off = min(
            -tau_off * math.log(0.02 / max(vgs_th, 0.1)) if (vgs_th > 0.02 and tau_off > 0) else 20e-9,
            200e-9
        )

        t_turn_off = t_r4_off + t_r3_off + t_r2_off + t_r1_off

        # ── Dead time ─────────────────────────────────────────────────
        dt_prop    = float(t_prop_on) if t_prop_on else 15e-9
        dt_abs     = self._dc("dt.abs_margin") * 1e-9
        dt_safety  = self._dc("dt.safety_mult")
        dead_time  = max(50e-9, (t_turn_off + dt_prop) * dt_safety + dt_abs)
        dead_time  = min(dead_time, 2e-6)

        # ── Build display window ──────────────────────────────────────
        period       = 1.0 / fsw
        on_time_half = period * 0.5
        flat_on  = max(0.0, on_time_half - t_turn_on  - dead_time)
        flat_off = max(0.0, period - on_time_half - t_turn_off - dead_time)

        # Show enough time for the ring to visibly decay (~5 × tau)
        ring_tail   = min(5 * tau_ring, 300e-9) if f_ring > 0 else 200e-9
        view_on_flat  = min(flat_on,  max(t_turn_on  * 1.5, ring_tail))
        view_off_flat = min(flat_off, max(t_turn_off * 1.5, ring_tail))
        total_view  = dead_time + t_turn_on + view_on_flat + t_turn_off + dead_time + ring_tail

        # ── Sample waveform ───────────────────────────────────────────
        n_points  = 800
        max_pts   = 5000
        dt_step   = total_view / n_points if total_view > 0 else 1e-9

        times   = []
        vgs_arr = []
        vds_arr = []
        id_arr  = []
        ig_arr  = []
        pd_arr  = []

        t = 0.0
        while t <= total_view and len(times) < max_pts:
            vgs, vds, i_d, i_g = self._sample_waveform(
                t, v_drv, v_bus, i_load, vgs_th, vgs_pl, vds_on,
                gfs, rg_on, rg_off, tau_on, tau_off,
                ig_miller_on, ig_miller_off,
                t_r1, t_r2, t_r3, t_r4,
                t_r4_off, t_r3_off, t_r2_off, t_r1_off,
                dead_time, t_turn_on, view_on_flat, t_turn_off,
                tau_ring, omega_ring, v_overshoot_off, v_ring_on,
            )
            times.append(round(t * 1e9, 2))
            vgs_arr.append(round(vgs, 3))
            vds_arr.append(round(max(0.0, vds), 2))   # Vds ≥ 0
            id_arr.append(round(max(0.0, i_d), 2))    # Id ≥ 0
            ig_arr.append(round(i_g, 3))
            pd_arr.append(round(max(0.0, vds) * max(0.0, i_d), 1))
            t += dt_step

        sampled_v_overshoot = max(0.0, max(vds_arr) - v_bus) if vds_arr else 0.0

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
                "v_lcs_on_v":       round(v_lcs_on, 3),
            },
            "turn_off": {
                "t_r4_off_ns":      round(t_r4_off * 1e9, 1),
                "t_miller_off_ns":  round(t_r3_off * 1e9, 1),
                "t_r2_off_ns":      round(t_r2_off * 1e9, 1),
                "t_r1_off_ns":      round(t_r1_off * 1e9, 1),
                "total_off_ns":     round(t_turn_off * 1e9, 1),
                "ig_miller_off_a":  round(ig_miller_off, 2),
                "v_lcs_off_v":      round(v_lcs_off, 3),
            },
            "dead_time_ns":         round(dead_time * 1e9, 1),
            "vgs_plateau_v":        round(vgs_pl, 2),
            "vgs_threshold_v":      round(vgs_th, 2),
            "ring_freq_mhz":        round(f_ring / 1e6, 0) if f_ring > 0 else None,
            "v_overshoot_v":        round(sampled_v_overshoot, 1) if f_ring > 0 else None,
            "vds_overshoot_danger": vds_overshoot_danger,
            "vds_overshoot_warning": vds_overshoot_warning,
        }

        # ── Parameters used (shown in UI transparency panel) ──────────
        params_used = {
            "ciss_pf":          round(ciss * 1e12, 0),
            "qg_nc":            round(qg * 1e9, 1),
            "qgd_spec_nc":      round(qgd * 1e9, 1),
            "qgd_eff_base_nc":  round(qgd_eff_base * 1e9, 2),
            "qgd_on_eff_nc":    round(qgd_on_eff * 1e9, 2),
            "qgd_off_eff_nc":   round(qgd_off_eff * 1e9, 2),
            "qrr_eff_nc":       round(qrr_eff * 1e9, 1),
            "qrr_to_miller_nc": round(qgd_rr * 1e9, 2),
            "qgd_method":       qgd_method,
            "crss_pf":          round(crss * 1e12, 1) if crss is not None else None,
            "rds_on_mohm":      round(rds_on * 1e3, 2),
            "vgs_th_v":         round(vgs_th, 2),
            "vgs_pl_spec_v":    round(vgs_pl_datasheet, 2),
            "vgs_pl_actual_v":  round(vgs_pl, 2),
            "temp_model_tj_c":  round(tj_sw, 1),
            "qgd_temp_factor":  round(qgd_temp_factor, 3),
            "qrr_temp_factor":  round(qrr_temp_factor, 3),
            "driver_temp_derate": round(drv_derate, 3),
            "common_source_l_nh": round(l_cs_nh, 3),
            "id_cont_a":        round(id_cont, 1) if id_cont is not None else None,
            "gm_s":             round(gm_est, 1) if gm_est is not None else None,
            "rg_int_ohm":       round(rg_int, 2),
            "rg_on_ext_ohm":    round(rg_on_ext, 1),
            "rg_off_ext_ohm":   round(rg_off_ext, 1),
            "v_drv_v":          round(v_drv, 1),
            "v_bus_v":          round(v_bus, 1),
            "i_load_a":         round(i_load, 1),
            "fsw_khz":          round(fsw / 1e3, 1),
            "l_stray_nh":       round(l_stray_nh, 1),
            "coss_pf":          round(coss * 1e12, 0),
            "f_ring_mhz":       round(f_ring / 1e6, 0) if f_ring > 0 else None,
            "v_overshoot_v":    round(sampled_v_overshoot, 1) if f_ring > 0 else None,
        }

        self.audit_log.append(
            f"[Waveform] Generated: turn-on = {t_turn_on*1e9:.0f} ns "
            f"(t_R3_Miller = {t_r3*1e9:.0f} ns with Qgd_on_eff = {qgd_on_eff*1e9:.1f} nC, "
            f"Vpl = {vgs_pl:.2f} V), "
            f"turn-off = {t_turn_off*1e9:.0f} ns, dead-time = {dead_time*1e9:.0f} ns, "
            f"ring = {f_ring/1e6:.0f} MHz, V_ov(sampled) = {sampled_v_overshoot:.1f} V."
        )

        # ── Multi-cycle ringing residual ──────────────────────────────
        # Ring starts at turn-off; next turn-off arrives ~one period later.
        # Residual fraction = exp(-T_sw / tau_ring) — if > 10%, Q is too high
        # and rings from successive switching events superpose and reinforce.
        v_ring_residual_pct = None
        v_ring_residual_v   = None
        ring_undamped       = False
        if f_ring > 0 and tau_ring > 0 and v_overshoot_off > 0:
            t_period = 1.0 / fsw
            residual_factor = math.exp(-t_period / tau_ring)
            v_ring_residual_v   = round(v_overshoot_off * residual_factor, 2)
            v_ring_residual_pct = round(residual_factor * 100, 1)
            ring_undamped = residual_factor > 0.10
            if ring_undamped:
                self.audit_log.append(
                    f"[Waveform] Multi-cycle ringing: {v_ring_residual_pct:.1f}% residual "
                    f"({v_ring_residual_v:.2f}V) after one period — Q too high, rings reinforce."
                )

        return {
            "time_ns":     times,
            "vgs":         vgs_arr,
            "vds":         vds_arr,
            "id":          id_arr,
            "ig":          ig_arr,
            "pd":          pd_arr,
            "v_ring_residual_pct": v_ring_residual_pct,
            "v_ring_residual_v":   v_ring_residual_v,
            "ring_undamped":       ring_undamped,
            "annotations": annotations,
            "params_used": params_used,
            "model_note": (
                "Physics-accurate 4-region MOSFET switching model.\n"
                "• Qgd_eff uses nonlinear Cgd(Vds) integration with bounded fallback scaling. "
                "Higher Vbus generally increases Miller time.\n"
                "• Turn-on Miller includes Qrr-coupled commutation charge, while turn-off uses only MOSFET charge.\n"
                "• Vgs_plateau adjusted for actual operating current (Id/gm). "
                "Higher load current → higher Vpl → longer Miller plateau.\n"
                "• Common-source inductance feedback reduces effective gate headroom via Ls·di/dt on both edges.\n"
                "• Charge/current terms are temperature-adjusted using a bounded Tj model.\n"
                "• Post-switch Vds ringing: damped LC oscillation at "
                "f = 1/(2π√(L_stray×Coss)), V_peak = I×√(L/C), Q ≈ 8.\n"
                "• Region 2 Vds held at Vbus (complementary body-diode clamps node).\n"
                "• Region 2 Id follows Vgs via gm: Id = gm × (Vgs − Vth).\n"
                "Validate against oscilloscope — real Ciss is nonlinear (~5× "
                "over Vds range), actual region durations may differ."
            ),
            "vds_overshoot_danger":  vds_overshoot_danger,
            "vds_overshoot_warning": vds_overshoot_warning,
            "_meta": self._module_meta.get("waveform", {"hardcoded": [], "fallbacks": []}),
        }

    # ──────────────────────────────────────────────────────────────────────────
    def _sample_waveform(
        self,
        t, v_drv, v_bus, i_load, vgs_th, vgs_pl, vds_on,
        gfs, rg_on, rg_off, tau_on, tau_off,
        ig_miller_on, ig_miller_off,
        t_r1, t_r2, t_r3, t_r4,
        t_r4_off, t_r3_off, t_r2_off, t_r1_off,
        dead_time, t_turn_on, flat_on, t_turn_off,
        tau_ring, omega_ring, v_overshoot_off, v_ring_on,
    ):
        """Sample Vgs, Vds, Id, Ig at absolute time t within one switching cycle.

        Timeline (absolute times):
          [0,          dead_time)             → Dead time 1 (FET off)
          [dead_time,  t_on_end)              → Turn-on transition (R1→R2→R3→R4)
          [t_on_end,   t_flat_end)            → Fully on (Vds rings and settles)
          [t_flat_end, t_off_end)             → Turn-off transition (R4'→R3'→R2'→R1')
          [t_off_end,  ...)                   → Dead time 2 (Vds overshoot decays)
        """
        def _ring_sin(t_abs, t_start, amplitude):
            """Damped sinusoidal ring (sine start → zero crossing, natural impulse shape).
            Starts at 0, peaks near t = π/(2ω), then decays exponentially."""
            dt = t_abs - t_start
            if dt < 0 or tau_ring <= 0 or omega_ring <= 0:
                return 0.0
            return amplitude * math.exp(-dt / tau_ring) * math.sin(omega_ring * dt)

        # ── Absolute timeline boundaries ───────────────────────────────
        t_on_start   = dead_time
        t_on_end     = dead_time + t_turn_on
        t_flat_end   = t_on_end + flat_on
        t_off_end    = t_flat_end + t_turn_off

        # Ringing start times (absolute)
        # Turn-on ring: starts when Miller plateau ends (end of Region 3)
        t_ring_on    = t_on_start + t_r1 + t_r2 + t_r3
        # Turn-off ring: starts when Id snaps to 0 (end of Region 2')
        t_ring_off   = t_flat_end + t_r4_off + t_r3_off + t_r2_off

        # ── Dead time 1 (FET fully off) ───────────────────────────────
        if t < t_on_start:
            return (0.0, v_bus, 0.0, 0.0)

        # ── Turn-on transition ─────────────────────────────────────────
        elif t < t_on_end:
            t_local = t - t_on_start

            # ── Region 1: Pre-threshold ──────────────────────────────
            # Gate charges 0 → Vth via RC(Ciss). Id = 0, Vds = Vbus.
            # (Complementary body-diode holds switching node at Vbus.)
            if t_local < t_r1:
                vgs = v_drv * (1.0 - math.exp(-t_local / tau_on)) if tau_on > 0 else 0.0
                ig  = (v_drv - vgs) / rg_on if rg_on > 0 else 0.0
                return (vgs, v_bus, 0.0, ig)

            # ── Region 2: Active (Vth → Vplateau) ───────────────────
            # Vgs continues charging on RC curve.
            # Id follows transconductance: Id = gm × (Vgs − Vth)
            # Vds stays at Vbus — complementary body-diode still conducting.
            elif t_local < t_r1 + t_r2:
                vgs = v_drv * (1.0 - math.exp(-t_local / tau_on)) if tau_on > 0 else vgs_pl
                vgs = min(vgs, vgs_pl)
                i_d = gfs * max(0.0, vgs - vgs_th)
                i_d = min(i_d, i_load)   # clamp to load current
                ig  = (v_drv - vgs) / rg_on if rg_on > 0 else 0.0
                # Vds: clamped at Vbus (body-diode of complementary FET)
                return (vgs, v_bus, i_d, ig)

            # ── Region 3: Miller plateau ─────────────────────────────
            # Vgs stuck at Vplateau (gate current consumed charging Cgd).
            # Vds falls linearly from Vbus to Vds_on.
            elif t_local < t_r1 + t_r2 + t_r3:
                frac = (t_local - t_r1 - t_r2) / t_r3 if t_r3 > 0 else 1.0
                frac = max(0.0, min(1.0, frac))
                vgs  = vgs_pl
                vds  = v_bus - (v_bus - vds_on) * frac
                return (vgs, vds, i_load, ig_miller_on)

            # ── Region 4: Post-plateau ───────────────────────────────
            # Vgs charges Vplateau → Vdrv. Vds settles at Vds_on + small ring.
            # The ring is from body-diode reverse recovery of complementary FET.
            else:
                t_local_r4 = t_local - t_r1 - t_r2 - t_r3
                vgs = v_drv - (v_drv - vgs_pl) * math.exp(-t_local_r4 / tau_on) if tau_on > 0 else v_drv
                ig  = (v_drv - vgs) / rg_on if rg_on > 0 else 0.0
                vds = vds_on + _ring_sin(t, t_ring_on, v_ring_on)
                return (vgs, max(0.0, vds), i_load, ig)

        # ── Fully on (flat conduction) ─────────────────────────────────
        # Vds ring from turn-on continues to decay.
        elif t < t_flat_end:
            vds = vds_on + _ring_sin(t, t_ring_on, v_ring_on)
            return (v_drv, max(0.0, vds), i_load, 0.0)

        # ── Turn-off transition ────────────────────────────────────────
        elif t < t_off_end:
            t_local = t - t_flat_end

            # ── Region 4': Discharge Vdrv → Vplateau ─────────────────
            # Vgs falls exponentially. Id and Vds unchanged.
            if t_local < t_r4_off:
                vgs = v_drv * math.exp(-t_local / tau_off) if tau_off > 0 else vgs_pl
                vgs = max(vgs, vgs_pl)
                ig  = -vgs / rg_off if rg_off > 0 else 0.0
                return (vgs, vds_on, i_load, ig)

            # ── Region 3': Miller plateau (reverse) ──────────────────
            # Vgs held at Vplateau. Vds rises linearly from Vds_on to Vbus.
            elif t_local < t_r4_off + t_r3_off:
                frac = (t_local - t_r4_off) / t_r3_off if t_r3_off > 0 else 1.0
                frac = max(0.0, min(1.0, frac))
                vgs  = vgs_pl
                vds  = vds_on + (v_bus - vds_on) * frac
                return (vgs, vds, i_load, -ig_miller_off)

            # ── Region 2': Active (Vplateau → Vth), Id falls to 0 ────
            # Vds stays at Vbus — load inductor forces current through
            # complementary body-diode, clamping the switching node.
            elif t_local < t_r4_off + t_r3_off + t_r2_off:
                t_from_r2 = t_local - t_r4_off - t_r3_off
                frac = t_from_r2 / t_r2_off if t_r2_off > 0 else 1.0
                frac = max(0.0, min(1.0, frac))
                vgs  = vgs_pl - (vgs_pl - vgs_th) * frac
                i_d  = i_load * (1.0 - frac)
                ig   = -vgs / rg_off if rg_off > 0 else 0.0
                return (vgs, v_bus, i_d, ig)

            # ── Region 1': Sub-threshold Vth → 0, Vds spike + ring ───
            # Id = 0. Stray inductance (L × dI/dt) drives a voltage spike
            # ABOVE Vbus that decays as a damped sinusoid: the turn-off
            # "heartbeat" visible on every oscilloscope measurement.
            else:
                t_from_r1 = t_local - t_r4_off - t_r3_off - t_r2_off
                vgs = vgs_th * math.exp(-t_from_r1 / tau_off) if tau_off > 0 else 0.0
                ig  = -vgs / rg_off if rg_off > 0 else 0.0
                vds = v_bus + _ring_sin(t, t_ring_off, v_overshoot_off)
                return (vgs, max(0.0, vds), 0.0, ig)

        # ── Dead time 2 (FET off, Vds spike decaying) ─────────────────
        else:
            vds = v_bus + _ring_sin(t, t_ring_off, v_overshoot_off)
            return (0.0, max(0.0, vds), 0.0, 0.0)
