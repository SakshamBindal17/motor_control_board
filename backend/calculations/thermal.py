"""Motor Controller Hardware Design — Thermal Calculations"""
import math


class ThermalMixin:
    """Mixin providing calculations for: thermal, pcb_guidelines, emi_filter."""

    # Cooling method → Rth_SA mapping (°C/W)
    # Each tier: (typical_rth_sa, description)
    COOLING_TIERS = {
        "natural":       (40.0, "PCB copper only, still air — worst case"),
        "enhanced_pcb":  (20.0, "PCB with copper pours + thermal vias, still air"),
        "forced_air":    (10.0, "Forced air cooling (fan over PCB/heatsink)"),
        "heatsink":      (5.0,  "Bolted heatsink with thermal interface material"),
        "custom":        (None, "User-specified Rth_SA via design constants"),
    }

    # ═══════════════════════════════════════════════════════════════════
    def calc_thermal(self) -> dict:
        if "thermal" in self._cached_results:
            return self._cached_results["thermal"]
        self._current_module = "thermal"
        ml      = self.calc_mosfet_losses()
        self._current_module = "thermal"  # restore after subroutine
        p_fet   = ml["total_loss_per_fet_w"]
        rth_jc  = self._get(self.mosfet, "MOSFET", "rth_jc", 0.5)
        tj_max  = self._get(self.mosfet, "MOSFET", "tj_max", 175)

        rth_cs  = self._dc("thermal.rth_cs")

        # ── Cooling method → Rth_SA ──────────────────────────────────
        cooling_method = str(self.sys.get("cooling", "natural")).strip().lower()
        tier = self.COOLING_TIERS.get(cooling_method)

        if tier is None:
            # Unknown cooling method string — treat as natural (worst case)
            cooling_method = "natural"
            tier = self.COOLING_TIERS["natural"]

        tier_rth, tier_desc = tier

        if cooling_method == "custom" or tier_rth is None:
            # "custom" mode: use user's design constant directly
            rth_sa = self._dc("thermal.rth_sa")
            cooling_label = f"Custom (user-set {rth_sa} °C/W)"
            self._log_hc("thermal", "PCB-to-ambient Rth", f"{rth_sa} °C/W",
                          "User-specified custom value", "thermal.rth_sa")
        else:
            # Use tier value — ignore design constant default
            rth_sa = tier_rth
            cooling_label = f"{cooling_method.replace('_', ' ').title()} — {tier_desc}"
            self.audit_log.append(
                f"[Thermal] Cooling method: '{cooling_method}' → Rth_SA = {rth_sa} °C/W "
                f"({tier_desc}). Change in Settings to adjust."
            )
            self._log_hc("thermal", "PCB-to-ambient Rth", f"{rth_sa} °C/W",
                          f"From cooling method '{cooling_method}': {tier_desc}")

        self._log_hc("thermal", "Case-to-PCB Rth", f"{rth_cs} °C/W", "Thermal pad + solder interface", "thermal.rth_cs")

        # Thermal chain: Tj = T_amb + P × (Rth_jc + Rth_cs + Rth_sa)
        t_junc  = self.t_amb + p_fet * (rth_jc + rth_cs + rth_sa)
        t_case  = t_junc - p_fet * rth_jc   # actual MOSFET case temperature

        margin  = tj_max - t_junc
        safe_margin_thresh = self._dc("thermal.safe_margin")
        safe    = margin > safe_margin_thresh
        self._log_hc("thermal", "Safe margin threshold", f"> {safe_margin_thresh} °C", "Minimum acceptable thermal margin", "thermal.safe_margin")

        # Motor copper loss for system power budget
        rph_mohm = (self.motor or {}).get("rph_mohm", "")
        try:
            rph = float(rph_mohm) * 1e-3 if rph_mohm not in ("", None) else 0.0
        except (TypeError, ValueError):
            rph = 0.0
        if rph > 0:
            i_rms_motor = self.i_max / math.sqrt(2)
            p_copper_3ph = 3 * (i_rms_motor ** 2) * rph
        else:
            p_copper_3ph = 0.0

        p_system_total = p_fet * self.num_fets + p_copper_3ph

        # ── Cross-module coupling: PCB Trace Thermal ──────────────────
        # If the user has configured trace thermal params, use those results
        # for more accurate trace width and system loss accounting.
        p_trace_loss = 0.0
        trace_thermal_data = None
        try:
            if hasattr(self, 'pcb_trace_params') and self.pcb_trace_params:
                trace_thermal_data = self.calc_pcb_trace_thermal()
                if trace_thermal_data and trace_thermal_data.get("has_data"):
                    p_trace_loss = trace_thermal_data.get("trace_power_loss_w", 0)
                    p_system_total += p_trace_loss
        except Exception:
            pass  # Don't fail main thermal calc if PCB trace thermal fails

        # ── Driver IC thermal analysis (using extracted rth_ja and thermal_shutdown) ──
        rth_ja_drv = self._get(self.driver, "DRIVER", "rth_ja", None)
        tj_max_drv = self._get(self.driver, "DRIVER", "tj_max", None)
        thermal_shutdown_drv = self._get(self.driver, "DRIVER", "thermal_shutdown", None)
        driver_thermal = {}
        if rth_ja_drv is not None:
            # Driver power dissipation estimate: gate charge losses for the MOSFETs it drives
            # For a half-bridge driver: 2 MOSFETs per driver, 3 drivers total
            # P_driver ≈ Qg × Vdrv × fsw × 2 (for both HS and LS) + quiescent
            qg_drv = self._get(self.mosfet, "MOSFET", "qg", 92e-9)
            p_driver_gate = qg_drv * self.v_drv * self.fsw * 2  # 2 MOSFETs per driver
            p_driver_quiescent = 0.05  # ~50mW typical quiescent
            p_driver_total = p_driver_gate + p_driver_quiescent
            tj_driver = self.t_amb + p_driver_total * rth_ja_drv

            driver_thermal["p_driver_per_ic_w"] = round(p_driver_total, 3)
            driver_thermal["rth_ja_driver_c_per_w"] = round(rth_ja_drv, 1)
            driver_thermal["tj_driver_est_c"] = round(tj_driver, 1)

            if tj_max_drv is not None:
                driver_thermal["tj_max_driver_c"] = round(tj_max_drv, 0)
                driver_thermal["driver_margin_c"] = round(tj_max_drv - tj_driver, 1)
                driver_thermal["driver_thermal_ok"] = tj_driver < tj_max_drv * 0.85
                if tj_driver >= tj_max_drv:
                    self.audit_log.append(f"[Thermal] DANGER: Driver Tj estimate ({tj_driver:.0f}°C) exceeds Tj_max ({tj_max_drv:.0f}°C).")
                elif tj_driver >= tj_max_drv * 0.85:
                    self.audit_log.append(f"[Thermal] WARNING: Driver Tj estimate ({tj_driver:.0f}°C) within 15% of Tj_max ({tj_max_drv:.0f}°C).")

            if thermal_shutdown_drv is not None:
                driver_thermal["thermal_shutdown_c"] = round(thermal_shutdown_drv, 0)
                driver_thermal["shutdown_margin_c"] = round(thermal_shutdown_drv - tj_driver, 1)

            self.audit_log.append(f"[Thermal] Driver IC: P={p_driver_total:.3f}W, Rth_ja={rth_ja_drv:.1f}°C/W, Tj_est={tj_driver:.0f}°C.")

        # IPC-2152 trace width approximation for external layer, normalized to 3oz Cu with 30°C rise.
        # Original formula for 1oz: A_mils² = (I / (0.048 × ΔT^0.44))^(1/0.725)
        # For 3oz Cu: divide cross-sectional area by 3×1.4mil (thickness). Results are conservative;
        # for currents >30A, use solid copper pours instead of traces.
        self._log_hc("thermal", "IPC-2152 derating", "3oz Cu, 30°C rise", "External layer trace width calculation")
        i_trace = self.i_max
        area_mil2 = ((i_trace / (0.048 * (30**0.44))) ** (1/0.725))
        width_mm  = (area_mil2 / (3 * 1.4)) * 0.0254  # 3oz = 3×1.4mil thick, width_mil = area/thickness, ×0.0254 → mm
        trace_w_basic = max(3.0, round(width_mm, 1))
        trace_w = trace_w_basic

        # Override with PCB Trace Thermal tab's user-specified width if available and wider
        if trace_thermal_data and trace_thermal_data.get("has_data"):
            tt_width = trace_thermal_data.get("min_trace_width_mm")
            if tt_width and tt_width > 0 and tt_width > trace_w:
                trace_w = round(tt_width, 1)
                self.audit_log.append(
                    f"[Thermal] Trace width updated from PCB Trace Thermal tab: "
                    f"{tt_width:.1f}mm (user-specified, wider than IPC-2152 minimum {trace_w_basic}mm)."
                )

        # Copper pour area for MOSFET pad: rule of thumb — 1 in² (645.16 mm²) of 1oz Cu
        # dissipates ~1W with 30°C rise in still-air convection. Results are conservative.
        cu_area_mm2 = p_fet * 645 / 30
        vias_per_fet = int(self._dc("thermal.vias_per_fet"))
        via_drill = 0.3
        cu_oz = 3

        # Override via parameters and copper weight from PCB Trace Thermal if available
        if trace_thermal_data and trace_thermal_data.get("has_data"):
            tt_oz = trace_thermal_data.get("copper_oz", trace_thermal_data.get("recommended_copper_oz"))
            if tt_oz:
                cu_oz = tt_oz

            vias_enabled = trace_thermal_data.get("vias_on", trace_thermal_data.get("input_vias_on", True))
            if vias_enabled:
                tt_vias = trace_thermal_data.get("n_vias", trace_thermal_data.get("input_n_vias"))
                tt_drill = trace_thermal_data.get("via_drill_mm", trace_thermal_data.get("input_via_drill_mm"))
                if tt_vias: vias_per_fet = int(tt_vias)
                if tt_drill: via_drill = float(tt_drill)

            self.audit_log.append(
                f"[Thermal] PCB layout updated from Trace Thermal tab: {cu_oz}oz Cu, {vias_per_fet}x {via_drill}mm vias."
            )
        else:
            self._log_hc("thermal", "Thermal vias", f"{vias_per_fet}x 0.3mm per FET", "Heat transfer to bottom copper", "thermal.vias_per_fet")

        result = {
            "p_per_fet_w":              round(p_fet,          3),
            "p_total_all_fets_w":       round(p_fet * self.num_fets, 3),
            "p_total_6_fets_w":         round(p_fet * self.num_fets, 3),  # backward compat
            "num_fets":                 self.num_fets,
            "rth_jc_c_per_w":           rth_jc,
            "rth_cs_c_per_w":           rth_cs,
            "rth_sa_pcb_c_per_w":       rth_sa,
            "cooling_method":           cooling_method,
            "cooling_label":            cooling_label,
            "t_case_est_c":             round(t_case,         1),
            "t_junction_est_c":         round(t_junc,         1),
            "tj_max_rated_c":           tj_max,
            "thermal_margin_c":         round(margin,         1),
            "thermal_safe":             safe,
            "power_trace_width_mm":     trace_w,
            "trace_width_note":         f"IPC-2152 approx: 3oz Cu, 30°C rise, external layer. For >{i_trace:.0f}A use solid copper pours.",
            "copper_area_per_fet_mm2":  round(cu_area_mm2,    0),
            "thermal_vias_per_fet":     vias_per_fet,
            "via_drill_mm":             via_drill,
            "copper_oz":                cu_oz,
            "motor_copper_loss_w":      round(p_copper_3ph, 1),
            "trace_conduction_loss_w":  round(p_trace_loss, 3),
            "system_total_loss_w":      round(p_system_total, 1),
            "notes": {
                "package":   "D2PAK (TO-263-7) — use thermal slug pad with solder mask opening",
                "vias":      f"{vias_per_fet}× {via_drill}mm drilled, 0.2mm annular ring thermal vias per MOSFET",
                "copper_oz": f"{cu_oz}oz L1/L6, thermal slug pads open to both sides",
                "cooling":   cooling_label,
                "warning":   f"⚠ CRITICAL: Tj > 150°C — upgrade cooling (current: {cooling_method})" if not safe
                              else f"✓ Thermal design safe ({cooling_method.replace('_', ' ')} cooling)",
            },
            "_meta": self._module_meta.get("thermal", {"hardcoded": [], "fallbacks": []}),
        }
        if driver_thermal:
            result["driver_thermal"] = driver_thermal

        self._cached_results["thermal"] = result
        return result

    # ═══════════════════════════════════════════════════════════════════
    # 11. Dead Time
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_pcb_guidelines(self) -> dict:
        self._current_module = "pcb_guidelines"
        th = self.calc_thermal()
        self._current_module = "pcb_guidelines"  # restore after subroutine
        trace_w = th["power_trace_width_mm"]
        cu_oz = th.get("copper_oz", 3)
        via_drill = th.get("via_drill_mm", 0.3)

        self._log_hc("pcb_guidelines", "Layer stack", "6-layer", "Standard motor controller PCB configuration")
        self._log_hc("pcb_guidelines", "Gate trace width", "0.3 mm", "Minimum for controlled impedance")
        self._log_hc("pcb_guidelines", "Signal trace width", "0.15 mm", "Standard signal routing")
        self._log_hc("pcb_guidelines", "Power clearance", "1.0 mm", "High voltage spacing")
        self._log_hc("pcb_guidelines", "Half-bridge loop target", "< 5 nH", "Low inductance switching loop")

        return {
            "layer_stack": [
                {"layer":"L1 (Top)",    "copper_oz":cu_oz, "purpose":"Power traces, MOSFET pads, gate traces"},
                {"layer":"L2",          "copper_oz":1, "purpose":"Solid GND plane"},
                {"layer":"L3",          "copper_oz":1, "purpose":"Signal: gate drive, SPI, UART"},
                {"layer":"L4",          "copper_oz":1, "purpose":"Power planes: 12V, 5V, 3.3V"},
                {"layer":"L5",          "copper_oz":1, "purpose":"Signal: analog, sensing, encoder"},
                {"layer":"L6 (Bottom)", "copper_oz":cu_oz, "purpose":"Power returns, thermal spreading"},
            ],
            "power_trace_w_mm":        trace_w,
            "gate_trace_w_mm":         0.3,
            "signal_trace_w_mm":       0.15,
            "power_clearance_mm":      1.0,
            "signal_clearance_mm":     0.15,
            "via_drill_thermal_mm":    via_drill,
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
            "_meta": self._module_meta.get("pcb_guidelines", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 13. Motor Parameter Validation & Sanity Checks
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def calc_emi_filter(self) -> dict:
        self._current_module = "emi_filter"
        i_dc    = 0 if self.v_bus == 0 else self.power / self.v_bus
        fsw  = self.fsw

        # Common mode choke: attenuation target -40dB at fsw
        # Typical values for 20-40kHz: 100–470µH CM inductance
        lcm_uh    = self._dc("emi.cm_choke_uh")
        r_dc_choke= 5   # mΩ typical
        self._log_hc("emi_filter", "CM choke", f"{lcm_uh} µH", "Baseline common-mode inductance", "emi.cm_choke_uh")
        self._log_hc("emi_filter", "CM choke DCR", "5 mΩ", "Typical DC resistance")
        p_choke   = (i_dc**2) * r_dc_choke * 1e-3

        # X capacitor (bus differential): 0.1µF at motor cable entry
        cx_nf     = 100
        self._log_hc("emi_filter", "X cap", "100 nF / 100V", "Differential mode filtering")

        # Y capacitor (CM to chassis): 4.7nF max (leakage limits)
        cy_nf     = 4.7
        self._log_hc("emi_filter", "Y cap", "4.7 nF max", "Common-mode to chassis (safety limit)")
        
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
            "_meta": self._module_meta.get("emi_filter", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 10. Thermal Analysis
    # ═══════════════════════════════════════════════════════════════════

