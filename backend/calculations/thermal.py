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

        mosfet_rth_ja = self._get(self.mosfet, "MOSFET", "rth_ja", None)
        if cooling_method == "natural" and mosfet_rth_ja is not None:
            tier_rth = max(1.0, mosfet_rth_ja - rth_jc - rth_cs)
            tier_desc = f"Datasheet Rth_JA ({mosfet_rth_ja}°C/W) (PCB baseline)"

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
            # Rigorous Driver power dissipation:
            # P_total_charge = Qg × Vdrv × fsw per FET
            # Half-bridge driver handles 'fets_per_driver' (2 for 6-FET design, 4 for 12-FET, etc)
            fets_per_driver = self.num_fets / 3.0
            qg_drv = self._get(self.mosfet, "MOSFET", "qg", 92e-9)
            p_gate_total_per_fet = qg_drv * self.v_drv * self.fsw
            
            # Power dissipates proportionally across Driver Rds(on) and External Rg.
            # Pull precise external resistor dissipation from gate_resistors phase!
            gate_res = self._cached_results.get("gate_resistors", {})
            hs_rg_power = gate_res.get("hs_rg_power_w", 0)
            ls_rg_power = gate_res.get("ls_rg_power_w", 0)
            avg_rg_power_per_fet = (hs_rg_power + ls_rg_power) / 2.0
            
            if avg_rg_power_per_fet > 0:
                p_internal_per_fet = max(0.001, p_gate_total_per_fet - avg_rg_power_per_fet)
            else:
                # Fallback if gate drive module failed: assume 50/50 split
                p_internal_per_fet = p_gate_total_per_fet * 0.5
                
            p_driver_gate = p_internal_per_fet * fets_per_driver
            
            # Quiescent driver internal power
            idd_q = self._get(self.driver, "DRIVER", "idd_quiescent", None)
            if idd_q and idd_q > 0:
                p_driver_quiescent = idd_q * self.v_drv
            else:
                p_driver_quiescent = 0.05  # 50mW typical fallback
                
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

        # IPC trace width approximation for external layer, normalized to 3oz Cu with 30°C rise.
        # Get selected IPC model from the PCB Trace Thermal params if available:
        trace_params = getattr(self, 'pcb_trace_params', {}) or {}
        common_cfg = trace_params.get("common", {})
        model_token = str(common_cfg.get("model", "2221")).replace("_", "").replace("-", "")
        
        is_2152 = "2152" in model_token
        model_name = "IPC-2152" if is_2152 else "IPC-2221B"
        
        self._log_hc("thermal", f"{model_name} approx", "3oz Cu, 30°C rise", "External layer trace width baseline")
        i_trace = self.i_max
        
        # Original formula for 1oz: A_mils² = (I / (0.048 × ΔT^0.44))^(1/0.725)
        # For IPC-2152, planar heat spreading usually provides ~0.45x Cf thermal reduction multiplier on dT
        effective_dt = 30.0 / 0.45 if is_2152 else 30.0
        
        area_mil2 = ((i_trace / (0.048 * (effective_dt**0.44))) ** (1/0.725))
        width_mm  = (area_mil2 / (3 * 1.4)) * 0.0254  # 3oz = 3×1.4mil thick
        trace_w_basic = max(3.0, round(width_mm, 1))
        trace_w = trace_w_basic

        # Override with PCB Trace Thermal tab's user-specified width if available and wider
        if trace_thermal_data and trace_thermal_data.get("has_data"):
            tt_width = trace_thermal_data.get("min_trace_width_mm")
            if tt_width and tt_width > 0 and tt_width > trace_w:
                trace_w = round(tt_width, 1)
                self.audit_log.append(
                    f"[Thermal] Trace width updated from PCB Trace Thermal tab: "
                    f"{tt_width:.1f}mm (user-specified, wider than {model_name} minimum {trace_w_basic}mm)."
                )

        # Copper pour area for MOSFET pad: rule of thumb — 1 in² (645.16 mm²) of 1oz Cu
        # dissipates ~1W with 30°C rise in still-air convection. 
        # Only relevant if the PCB itself is the primary heatsink.
        if cooling_method in ("natural", "enhanced_pcb"):
            cu_area_mm2 = p_fet * 645.16 / 30.0
        else:
            cu_area_mm2 = 0.0  # Heatsink or Forced Air dominates thermal dissipation
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
            "trace_width_note":         f"{model_name} approx: 3oz Cu, 30°C rise, external layer. For >{i_trace:.0f}A use solid copper pours.",
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
            result.update(driver_thermal)

        self._cached_results["thermal"] = result
        return result

    # ═══════════════════════════════════════════════════════════════════
    def calc_derating(self) -> dict:
        """Sweep T_amb 0→125°C and output max safe I per temperature point.

        Uses conduction-dominated loss model (dominant at low speed / stall).
        Switching loss is frequency-dependent and constant vs T_amb, so it
        reduces the available I_max headroom — included as a fixed offset.
        """
        self._current_module = "derating"
        rth_jc  = self._get(self.mosfet, "MOSFET", "rth_jc", 0.5)
        tj_max  = self._get(self.mosfet, "MOSFET", "tj_max", 175.0)
        rds_25  = self._get(self.mosfet, "MOSFET", "rds_on", 1.5e-3)

        rth_cs  = self._dc("thermal.rth_cs")
        rth_sa  = self._effective_rth_sa()
        alpha   = self._dc("thermal.rds_alpha")
        n_par   = max(1.0, float(self.num_fets) / 6.0)
        rth_tot = rth_jc + rth_cs + rth_sa

        # Fixed switching + recovery loss per FET (at design I_max) — constant vs T_amb
        try:
            ml = self.calc_mosfet_losses()
            self._current_module = "derating"
            p_sw_fixed = ml.get("switching_loss_per_fet_w", 0) + ml.get("recovery_loss_per_fet_w", 0)
        except Exception:
            p_sw_fixed = 0.0

        t_amb_points = [0, 25, 40, 50, 60, 75, 85, 100, 110, 125]
        curve = []
        for t_amb in t_amb_points:
            p_headroom = (tj_max - t_amb) / rth_tot if rth_tot > 0 else 0
            p_cond_max = max(0.0, p_headroom - p_sw_fixed)
            # Rds_hot at worst Tj → iterate once for self-consistency
            # Tj_guess = t_amb + p_headroom × rth_tot = tj_max (by definition)
            rds_hot = rds_25 * ((tj_max / 298.15) ** alpha)
            # P_cond = I² × Rds_hot / n_par (parallel MOSFET scaling)
            i_safe = math.sqrt(p_cond_max * n_par / rds_hot) if (rds_hot > 0 and p_cond_max > 0) else 0.0
            curve.append({
                "t_amb_c":    t_amb,
                "i_max_a":    round(min(i_safe, self.i_max * 2), 1),
                "p_cond_w":   round(p_cond_max, 2),
                "margin_a":   round(max(0, min(i_safe, self.i_max * 2) - self.i_max), 1),
                "derated":    i_safe < self.i_max,
            })

        design_point_idx = next((i for i, p in enumerate(curve) if p["t_amb_c"] >= self.t_amb), len(curve)-1)
        warnings = []
        if curve[design_point_idx]["derated"]:
            warnings.append(
                f"WARNING: At design T_amb={self.t_amb}°C, max safe current is "
                f"{curve[design_point_idx]['i_max_a']:.0f}A — below configured I_max "
                f"({self.i_max:.0f}A). Reduce current or improve cooling."
            )

        return {
            "curve":            curve,
            "design_t_amb_c":   self.t_amb,
            "design_i_max_a":   self.i_max,
            "rth_total":        round(rth_tot, 3),
            "rds_alpha":        alpha,
            "warnings":         warnings,
            "_meta":            self._module_meta.get("derating", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 11. Dead Time
    # ═══════════════════════════════════════════════════════════════════

    # ═══════════════════════════════════════════════════════════════════
    def _get_bus_bar_r_mohm(self):
        """Get total bus bar resistance from pcb_trace_thermal results (if available)."""
        try:
            tr = self.calc_pcb_trace_thermal()
            if isinstance(tr, dict) and tr.get("has_data"):
                return round(tr.get("resistance_total_mohm", 0), 4)
        except Exception:
            pass
        return None

    def calc_pcb_guidelines(self) -> dict:
        self._current_module = "pcb_guidelines"
        th = self.calc_thermal()
        self._current_module = "pcb_guidelines"  # restore after subroutine
        trace_w = th["power_trace_width_mm"]
        cu_oz = th.get("copper_oz", 3)
        via_drill = th.get("via_drill_mm", 0.3)

        # Configurable PCB guidelines
        try: gate_trace_w_mm = float(self.ovr.get("gate_trace_w_mm", 0.3))
        except (TypeError, ValueError): gate_trace_w_mm = 0.3
        
        try: power_clearance_mm = float(self.ovr.get("power_clearance_mm", 1.0))
        except (TypeError, ValueError): power_clearance_mm = 1.0

        self._log_hc("pcb_guidelines", "Layer stack", "6-layer", "Standard motor controller PCB configuration")
        if gate_trace_w_mm == 0.3:
            self._log_hc("pcb_guidelines", "Gate trace width", "0.3 mm", "Minimum for controlled impedance")
        self._log_hc("pcb_guidelines", "Signal trace width", "0.15 mm", "Standard signal routing")
        if power_clearance_mm == 1.0:
            self._log_hc("pcb_guidelines", "Power clearance", "1.0 mm", "High voltage spacing")

        # ── Bridge loop inductance (calculated, not hardcoded) ──────────────────
        # Uses PCB trace geometry from trace thermal params (linked to Passives tab)
        # Formula: L ≈ (µ₀/π) × l × [ln(4l/(w+t)) + 0.5]  [nH, mm]
        # where µ₀/π = 0.4 nH/mm, t = trace thickness derived from copper weight.
        # This models the partial inductance of the power loop trace.
        # Reference: Bahl & Trivedi microstrip inductance, TI app note SLVA670.
        loop_inductance_nh = None
        loop_status = "unknown"
        L_LOOP_TARGET = 5.0  # nH — standard half-bridge design target
        per_section_L = []   # list of { name, l_mm, w_mm, cu_oz, L_nH }

        if hasattr(self, 'pcb_trace_params') and self.pcb_trace_params:
            ptp = self.pcb_trace_params

            if "sections" in ptp and ptp["sections"]:
                # Multi-section: compute inductance per section, then sum
                for sec in ptp["sections"]:
                    sl = float(sec.get("trace_length_mm", 0) or 0)
                    sw = float(sec.get("trace_width_mm", 0) or 0)
                    scu = float(sec.get("copper_oz", cu_oz) or cu_oz)
                    sname = sec.get("name", "Section")
                    if sl > 0 and sw > 0:
                        sh = scu * 0.035
                        sln = max(4.0 * sl / (sw + sh), 1.01)
                        sL = 0.4 * sl * (math.log(sln) + 0.5)
                        per_section_L.append({
                            "name": sname, "l_mm": sl, "w_mm": sw,
                            "cu_oz": scu, "L_nH": round(sL, 2),
                        })
            else:
                # Legacy flat format — single section
                trace_l_mm = float(ptp.get("trace_length_mm", 0) or 0)
                trace_w_mm = float(ptp.get("trace_width_mm",  0) or 0)
                cu_oz_val  = float(ptp.get("copper_oz", cu_oz) or cu_oz)
                if trace_l_mm > 0 and trace_w_mm > 0:
                    h_mm = cu_oz_val * 0.035
                    ln_arg = max(4.0 * trace_l_mm / (trace_w_mm + h_mm), 1.01)
                    l_nH = 0.4 * trace_l_mm * (math.log(ln_arg) + 0.5)
                    per_section_L.append({
                        "name": "Trace", "l_mm": trace_l_mm, "w_mm": trace_w_mm,
                        "cu_oz": cu_oz_val, "L_nH": round(l_nH, 2),
                    })

            if per_section_L:
                loop_inductance_nh = round(sum(s["L_nH"] for s in per_section_L), 1)

            try: ext_bus_nh = float(self.ovr.get("ext_busbar_nh", 0))
            except (TypeError, ValueError): ext_bus_nh = 0

            if loop_inductance_nh is not None:
                loop_inductance_nh += ext_bus_nh
            elif ext_bus_nh > 0:
                loop_inductance_nh = ext_bus_nh
                
            if loop_inductance_nh is not None:
                if loop_inductance_nh <= L_LOOP_TARGET:
                    loop_status = "OK"
                elif loop_inductance_nh <= 10.0:
                    loop_status = "WARNING"
                else:
                    loop_status = "CRITICAL"
                sec_desc = " + ".join(f"{s['name']}({s['l_mm']:.0f}mm×{s['w_mm']:.1f}mm)" for s in per_section_L)
                if ext_bus_nh > 0:
                    sec_desc += f" + Ext({ext_bus_nh:.1f}nH)"
                self.audit_log.append(
                    f"[PCB] Half-bridge loop inductance: {loop_inductance_nh:.1f}nH "
                    f"({sec_desc}). "
                    f"Target <{L_LOOP_TARGET}nH — status: {loop_status}."
                )
        if loop_inductance_nh is None:
            self._log_hc("pcb_guidelines", "Half-bridge loop target", f"< {L_LOOP_TARGET} nH", "Low inductance switching loop — enter trace dims in Passives tab to calculate")

        return {
            "layer_stack": [
                {"layer":"L1 (Top)",    "copper_oz":cu_oz, "purpose":"Power traces, MOSFET pads, gate traces"},
                {"layer":"L2",          "copper_oz":1, "purpose":"Solid GND plane"},
                {"layer":"L3",          "copper_oz":1, "purpose":"Signal: gate drive, SPI, UART"},
                {"layer":"L4",          "copper_oz":1, "purpose":"Power planes: 12V, 5V, 3.3V"},
                {"layer":"L5",          "copper_oz":1, "purpose":"Signal: analog, sensing, encoder"},
                {"layer":"L6 (Bottom)", "copper_oz":cu_oz, "purpose":"Power returns, thermal spreading"},
            ],
            "power_trace_w_mm":              trace_w,
            "gate_trace_w_mm":               gate_trace_w_mm,
            "signal_trace_w_mm":             0.15,
            "power_clearance_mm":            power_clearance_mm,
            "signal_clearance_mm":           0.15,
            "via_drill_thermal_mm":          via_drill,
            "via_drill_power_mm":            0.4,
            "via_drill_signal_mm":           0.2,
            "half_bridge_loop_target_nh":    L_LOOP_TARGET,
            "half_bridge_loop_calculated_nh": loop_inductance_nh,
            "half_bridge_loop_status":       loop_status,
            "per_section_inductance":        per_section_L,
            "bus_bar_resistance_mohm":       self._get_bus_bar_r_mohm(),
            "shunt_kelvin_trace":            "Route sense traces INSIDE power trace pair (Kelvin connection)",
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

        # EMI component overrides
        def _flt(key, default):
            try: return float(self.ovr.get(key, default))
            except (TypeError, ValueError): return float(default)

        lcm_uh           = self._dc("emi.cm_choke_uh")
        emi_choke_dcr_mohm = _flt("emi_choke_dcr_mohm", 5.0)
        emi_x_cap_nf     = _flt("emi_x_cap_nf",  100.0)
        emi_x_cap_v      = _flt("emi_x_cap_v",   100.0)
        emi_y_cap_nf     = _flt("emi_y_cap_nf",    4.7)
        emi_y_cap_v      = _flt("emi_y_cap_v",   100.0)

        r_dc_choke = emi_choke_dcr_mohm  # mΩ
        if emi_choke_dcr_mohm == 5.0:
            self._log_hc("emi_filter", "CM choke DCR", "5 mΩ", "Typical DC resistance")
        if emi_x_cap_nf == 100.0:
            self._log_hc("emi_filter", "X cap", "100 nF / 100V", "Differential mode filtering")
        if emi_y_cap_nf == 4.7:
            self._log_hc("emi_filter", "Y cap", "4.7 nF max", "Common-mode to chassis (safety limit)")

        p_choke = (i_dc**2) * r_dc_choke * 1e-3

        self.audit_log.append(
            f"[EMI] CM choke {lcm_uh}µH / DCR={emi_choke_dcr_mohm}mΩ, "
            f"X-cap {emi_x_cap_nf:.0f}nF/{emi_x_cap_v:.0f}V, "
            f"Y-cap {emi_y_cap_nf:.1f}nF/{emi_y_cap_v:.0f}V."
        )

        return {
            "cm_choke_uh":          lcm_uh,
            "cm_choke_current_a":   round(i_dc * 1.2, 1),
            "cm_choke_r_dc_mohm":   emi_choke_dcr_mohm,
            "cm_choke_power_w":     round(p_choke, 2),
            "cm_choke_part":        "Wurth 744235 or TDK ACM series, rated for DC current",
            "x_cap_nf":             emi_x_cap_nf,
            "x_cap_v_rating":       emi_x_cap_v,
            "y_cap_nf":             emi_y_cap_nf,
            "y_cap_v_rating":       emi_y_cap_v,
            "notes": {
                "cm_choke_place": "At power input connector, before bulk caps",
                "motor_output":   "Additional RC filter on motor phase outputs reduces bearing currents",
                "pcb_ground":     "Star ground topology — separate PGND and AGND, single join point",
            },
            "_meta": self._module_meta.get("emi_filter", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    def calc_emi_dm(self) -> dict:
        """Estimate differential-mode conducted EMI at the first CISPR 25 harmonic.

        Model: switching node injects DM current proportional to C_bus × V_bus × fsw.
        CISPR 25 Class 3 limits: 79 dBµV (0.15–0.53 MHz), 56 dBµV (0.53–1.7 MHz).
        """
        self._current_module = "emi_dm"
        warnings = []

        v_bus = self.v_bus
        fsw   = self.fsw

        # Bus MLCC capacitance — from overrides or fallback
        try:
            c_mlcc_nf = float(self.ovr.get("emi_x_cap_nf", 100.0))
        except (TypeError, ValueError):
            c_mlcc_nf = 100.0
        c_mlcc_f = c_mlcc_nf * 1e-9

        # CM choke leakage inductance ≈ 1% of CM inductance (typical for motor controllers)
        lcm_uh = self._dc("emi.cm_choke_uh")
        l_dm_uh = lcm_uh * 0.01   # leakage ≈ 1% of CM inductance
        l_dm_h  = l_dm_uh * 1e-6

        # DM injection current at fundamental switching frequency
        # I_dm = V_bus × C_mlcc × 2π × fsw (capacitive coupling of switching edge)
        i_dm = v_bus * c_mlcc_f * 2 * math.pi * fsw
        self._log_hc("emi_dm", "LISN impedance", "50 Ω", "CISPR 25 / CISPR 16 standard LISN")

        # DM noise voltage across 50 Ω LISN (single-ended)
        z_lisn = 50.0
        v_dm_fund_v = i_dm * z_lisn
        v_dm_fund_uv = v_dm_fund_v * 1e6
        dm_noise_dbmuv = 20 * math.log10(max(v_dm_fund_uv, 1e-6))

        # First harmonic that falls inside CISPR 25 band (> 150 kHz)
        cispr_start_hz = 150e3
        harmonic_n = max(1, math.ceil(cispr_start_hz / fsw))
        f_harmonic = harmonic_n * fsw
        # Harmonic amplitude falls as 1/n (square-wave Fourier series approximation)
        v_dm_harmonic_uv = (v_dm_fund_uv / harmonic_n) if harmonic_n > 0 else v_dm_fund_uv
        dm_harmonic_dbmuv = 20 * math.log10(max(v_dm_harmonic_uv, 1e-6))

        # CISPR 25 Class 3 limit at this harmonic frequency
        if f_harmonic < 530e3:
            cispr_limit_dbmuv = 79.0   # 150–530 kHz band
            cispr_band = "Band 3 (0.15–0.53 MHz)"
        else:
            cispr_limit_dbmuv = 56.0   # 530 kHz – 1.7 MHz band
            cispr_band = "Band 4 (0.53–1.7 MHz)"

        required_attenuation_db = max(0.0, dm_harmonic_dbmuv - cispr_limit_dbmuv)

        # Existing DM filter attenuation at f_harmonic: LC with L_dm and C_x
        if l_dm_h > 0 and c_mlcc_f > 0:
            f_corner = 1.0 / (2 * math.pi * math.sqrt(l_dm_h * c_mlcc_f))
            if f_harmonic > f_corner:
                # -40 dB/decade above corner
                attenuation_actual_db = 40 * math.log10(f_harmonic / f_corner)
            else:
                attenuation_actual_db = 0.0
        else:
            f_corner = None
            attenuation_actual_db = 0.0

        emi_filter_adequate = attenuation_actual_db >= required_attenuation_db

        additional_attenuation_needed_db = max(0.0, required_attenuation_db - attenuation_actual_db)

        if not emi_filter_adequate and required_attenuation_db > 0:
            warnings.append(
                f"⚠ DM EMI: Estimated harmonic at {f_harmonic/1e3:.0f}kHz = {dm_harmonic_dbmuv:.0f}dBµV "
                f"exceeds CISPR 25 Class 3 {cispr_band} limit ({cispr_limit_dbmuv:.0f}dBµV) "
                f"by {required_attenuation_db:.0f}dB. Current DM filter provides only "
                f"{attenuation_actual_db:.0f}dB. Add {additional_attenuation_needed_db:.0f}dB DM filter attenuation."
            )
            self.audit_log.append(
                f"[EMI DM] Need {additional_attenuation_needed_db:.0f}dB more attenuation at {f_harmonic/1e3:.0f}kHz."
            )
        else:
            self.audit_log.append(
                f"[EMI DM] DM filter OK: {attenuation_actual_db:.0f}dB ≥ {required_attenuation_db:.0f}dB required."
            )

        return {
            "dm_noise_fund_dbmuv":          round(dm_noise_dbmuv, 1),
            "dm_noise_harmonic_dbmuv":      round(dm_harmonic_dbmuv, 1),
            "harmonic_n":                   harmonic_n,
            "harmonic_freq_khz":            round(f_harmonic / 1e3, 1),
            "cispr_limit_dbmuv":            cispr_limit_dbmuv,
            "cispr_band":                   cispr_band,
            "required_attenuation_db":      round(required_attenuation_db, 1),
            "filter_attenuation_db":        round(attenuation_actual_db, 1),
            "additional_attenuation_db":    round(additional_attenuation_needed_db, 1),
            "emi_filter_adequate":          emi_filter_adequate,
            "dm_filter_corner_khz":         round(f_corner / 1e3, 1) if f_corner else None,
            "l_dm_uh":                      round(l_dm_uh, 2),
            "c_x_nf":                       c_mlcc_nf,
            "warnings":                     warnings,
            "_meta":                        self._module_meta.get("emi_dm", {"hardcoded": [], "fallbacks": []}),
        }

    # ═══════════════════════════════════════════════════════════════════
    # 10. Thermal Analysis
    # ═══════════════════════════════════════════════════════════════════

