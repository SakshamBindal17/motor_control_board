# MC Hardware Designer v2 — Full Improvement Plan

> Generated: 2026-04-22 · Last updated: 2026-04-28 (Phase 2 + Phase 3 complete)
> Scope: Extraction accuracy, calculation correctness, unused motor params, hardcoded fallbacks,
> unit handling, frontend display gaps, report generator, E-series snapping, dead code,
> API key management, error handling, SPICE export, Design Constants UI, waveform accuracy,
> motor compatibility feature.

---

## How to use this document

Work through each section top-to-bottom. Each item has:
- **Severity**: 🔴 High (wrong results / crash risk) · 🟡 Medium (degraded accuracy) · 🟢 Low (polish)
- **Effort**: S (< 1 hr) · M (1–4 hrs) · L (4–12 hrs)
- **Status**: ✅ Done · ⏳ Pending · 🚫 Decided not to implement
- **File + line** reference so you can jump straight to the code

**Dependency notation**: items marked `→ requires →` must be done in that order.

---

## ✅ Completed in 2026-04-23 Session

All items below are implemented and merged to main. Do not re-implement.

| # | What | Files Changed |
|---|------|--------------|
| A | Multi-API-key support — Settings UI accepts N keys; backend rotates on 429 | `SettingsModal.jsx`, `ProjectContext.jsx`, `api.js`, `main.py`, `claude_service.py`, `Header.jsx`, `BlockPanel.jsx`, `ComparisonPanel.jsx`, `Sidebar.jsx` |
| B | Pass 2 independent key rotation — Pass 1 succeeds on key K; Pass 2 tries K, K+1, … independently without re-running Pass 1 | `claude_service.py` |
| C | 503 retry with exponential backoff (5→10→20→40→60 s) | `claude_service.py` |
| D | Frontend cycling status message — "Gemini is reading…" → "servers busy, retrying…" at 60 s | `BlockPanel.jsx` |
| E | File processing loop timeout — 120 s max; raises `TimeoutError` instead of hanging forever | `claude_service.py` |
| F | `asyncio.TimeoutError` caught at `wait_for` — surfaces as clean error message | `claude_service.py` |
| G | `_parse_raw` always ensures `parameters` key — prevents silent empty-data returns | `claude_service.py` |
| H | Error message sanitization in all routes — no more `type(e).__name__` in HTTP responses | `main.py` |
| I | Specific error messages: 429 quota, 504 timeout, 500 file-processing | `main.py` |
| J | Fetch timeout in frontend — 11 min for extraction, 30 s for all other routes | `api.js` |
| K | `AbortController` on every fetch — hangs are now impossible | `api.js` |
| L | `localStorage.setItem` wrapped in try/catch; parse failure logs to console | `ProjectContext.jsx` |
| M | `fmtCell` guards `Infinity` — parameter table no longer renders raw "Infinity" | `ParameterTable.jsx` |
| N | Manual param commit shows toast on invalid input — previously silent | `BlockPanel.jsx` |
| O | `sys.cooling` ReferenceError fixed in ComparisonPanel | `ComparisonPanel.jsx` |
| P | Unknown unit logs warning in `to_si()` — previously silently used ×1.0 | `unit_utils.py` |

---

## ✅ Already Resolved — §9 ESSENTIAL_IDS Gaps

> This section was written before v14-gemini. All listed params are now ESSENTIAL in the prompts.
> **No action required at the prompt level.**

The following params were claimed missing from extraction prompts — all are now confirmed ESSENTIAL in `claude_service.py` v14-gemini:

| Param | Block | Status |
|-------|-------|--------|
| `ciss` | MOSFET | ✅ Essential in v14-gemini |
| `rg_int` | MOSFET | ✅ Essential in v14-gemini |
| `deadtime_min` | Driver | ✅ Essential in v14-gemini |
| `deadtime_default` | Driver | ✅ Essential in v14-gemini |
| `pwm_deadtime_res` | MCU | ✅ Essential in v14-gemini |
| `pwm_deadtime_max` | MCU | ✅ Essential in v14-gemini |

**Remaining action**: Verify `CALC_DEPS` in `calc_engine.py` includes all six params above so Pass 2 targets them. If any are missing from `CALC_DEPS`, add them — cache invalidates automatically via deps hash, no prompt version bump needed.

---

## 1. Motor Parameters — Design Philosophy & Motor Compatibility Feature

### ⚠️ Critical Design Principle — Read Before Touching Motor Params

> **This PCB is a general-purpose motor controller, not a motor-specific design.**
>
> `system_specs.max_phase_current` is the **PCB's design envelope** — the worst-case current
> the board must safely handle regardless of which motor is attached. Every component
> calculation (MOSFET sizing, shunt resistor, capacitor ripple, thermal margin) uses this
> as the design ceiling, and **must continue to do so**.
>
> Motor parameters must **NEVER replace `max_phase_current` as a calculation input**.
> If they did, the PCB would be sized for one specific motor. Swapping to a different motor
> (higher torque, lower Kt, more pole pairs) would silently produce an undersized board
> with no warning to the user.
>
> **Motor params have two and only two correct roles:**
> 1. Improve accuracy of calculations that depend on actual circuit properties (e.g. `Lph` for ripple current — the inductor physically exists in the circuit regardless of motor identity)
> 2. Validate that a specific motor fits within the already-sized PCB's ratings — read-only, never feeds back into component sizing

### What each motor param should actually do

| Parameter | Currently Used | Correct Role | Drives Component Sizing? |
|-----------|---------------|--------------|--------------------------|
| `rph_mohm` | Copper loss estimate | Copper loss (already correct) | ❌ No — informational only |
| `lph_uh` | Ripple current calc | Ripple (already correct — real circuit property) | ❌ No — improves accuracy only |
| `kt_nm_per_a` | Validation only | Motor compatibility check: `I_pk = T_rated / Kt` vs `max_phase_current` | ❌ No — validation only |
| `rated_torque_nm` | Validation only | Motor compatibility check (with `Kt`) | ❌ No — validation only |
| `max_speed_rpm` | Validation only | Check `f_elec = RPM × poles / 60` vs MCU PWM capability | ❌ No — validation only |
| `pole_pairs` | Validation only | `f_elec` for compatibility check | ❌ No — validation only |
| `back_emf_v_per_krpm` | Validation only | Bus voltage headroom check at max RPM | ❌ No — validation only |
| `type` (PMSM/BLDC) | Never read | Informational label only | ❌ No |

### Action items

**1a. ~~CANCELLED — was wrong~~** ~~Replace `max_phase_current` with Kt-derived `I_pk` in loss calcs.~~
This would make the PCB motor-specific. **Do not implement.**

**1b.** `lph_uh` ripple usage — already implemented. No action needed.

**1c–1f. Motor Compatibility Feature** ✅ Partially done (Phase 1 item 8: single-motor checks, verdict banner, stall/modulation/regen checks). Multi-motor comparison (COMPAT-1 to COMPAT-5) deferred — see §COMPAT.

---

## §COMPAT — Motor Compatibility Feature (New Dedicated Feature)

> **Vision**: The PCB is sized once. Multiple motors can be validated against it.
> This makes the board truly universal — swap motors without re-designing the board.
> All checks are read-only. Nothing feeds back into component sizing calculations.

### What to build

A new **"Motor Compatibility"** sidebar tab (like the Comparison tab), showing a side-by-side table of multiple motors checked against the same PCB:

| Check | Motor A (current) | Motor B | Motor C |
|-------|-------------------|---------|---------|
| Peak current demand | 42 A | 67 A | 95 A |
| Electrical frequency | 433 Hz | 267 Hz | 700 Hz |
| Back-EMF at max RPM | 38 V | 44 V | 55 V |
| Bus voltage headroom | 10 V ✅ | 4 V ⚠ | -7 V ❌ |
| Fits this PCB? | ✅ Yes | ⚠ Marginal | ❌ No |

### Calculation logic (backend)

```python
# motor_compat.py — READS calcs, never feeds back into them
i_pk_motor    = rated_torque / kt                         # motor's actual peak current demand
f_elec_hz     = max_speed_rpm * pole_pairs / 60           # electrical frequency at max RPM
back_emf_v    = back_emf_v_per_krpm * (max_speed_rpm / 1000)  # back-EMF at max RPM
bus_headroom  = v_bus - back_emf_v                        # voltage margin remaining

checks = {
    "current_ok":    i_pk_motor  <= max_phase_current,    # motor fits within PCB rating?
    "freq_ok":       f_elec_hz   <= pwm_freq_hz / 6,      # electrical freq sane vs PWM?
    "headroom_ok":   bus_headroom >= 5,                    # at least 5V bus headroom?
    "id_ok":         i_pk_motor  <= id_cont,               # within MOSFET continuous rating?
    "current_margin": max_phase_current - i_pk_motor,      # PCB headroom over motor demand [A]
}
```

### Action items

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| COMPAT-1 | New sidebar tab: "Motor Compatibility" — add to BLOCK_CONFIGS in App.jsx | 🟡 | M | ⏳ Deferred (Phase 4) |
| COMPAT-2 | New backend file: `backend/calculations/motor_compat.py` — returns compatibility flags + margins per motor | 🟡 | M | ⏳ Deferred (Phase 4) |
| COMPAT-3 | Frontend: multi-motor entry (add Motor B, Motor C) — same form fields as MotorForm, saved separately in state | 🟡 | L | ⏳ Deferred (Phase 4) |
| COMPAT-4 | Frontend: compatibility table with ✅/⚠/❌ per check per motor, plain-English explanation per row | 🟡 | M | ⏳ Deferred (Phase 4) |
| COMPAT-5 | Frontend: clear panel label — "These checks do not affect component calculations. PCB is sized for `max_phase_current`." | 🟢 | S | ✅ Done (Phase 1 item 8 disclaimer banner) |

**Dependency**: COMPAT-2 (backend module) → must complete before → COMPAT-4 (frontend display)

---

## 2. Hardcoded Fallback Values 🔴

Every `_get(block, "BLOCK", "param", FALLBACK)` with a non-None fallback is a **silent failure**. If extraction missed a param, the design continues with a generic value that may be wrong by 5–10×.

### Already-handled values (do NOT action these)

- `csa_gain` (20 V/V): Has "CSA Gain Override" field in PassivesPanel. Priority: UI override → driver `current_sense_gain` → fallback. ✅
- `adc_ref` (3.3 V): Is a DESIGN_CONSTANT (`prot.adc_ref`) AND extracted as essential MCU param. ✅

### Full list of hardcoded fallbacks in `calc_engine.py`

| Param | Fallback | Source Block | Risk |
|-------|----------|--------------|------|
| `qg` | 92 nC | MOSFET | Gate resistor, boot cap wrong if MOSFET has 30 nC or 200 nC Qg |
| `qgd` | 30 nC | MOSFET | Switching loss off by 2–5× |
| `rds_on` | 1.5 mΩ | MOSFET | Conduction loss wrong |
| `tr` | 30 ns | MOSFET | Switching loss, dead time wrong |
| `tf` | 20 ns | MOSFET | Same |
| `rth_jc` | 0.5 °C/W | MOSFET | Thermal margin could be 3× off |
| `qrr` | 44 nC | MOSFET | Recovery loss silently wrong |
| `body_diode_vf` | 0.7 V | MOSFET | Dead-time energy estimate wrong |
| `coss` | 200 pF | MOSFET | Snubber cap could be 20× wrong |
| `io_source` | 1.5 A | Driver | Rg_on wrong → wrong dV/dt |
| `io_sink` | 2.5 A | Driver | Rg_off wrong |
| `vgs_th` | 3.0 V | MOSFET | Gate plateau wrong |
| `rg_int` | 0 Ω | MOSFET | Gate series resistance underestimated |
| `td_off` | 50 ns | MOSFET | Dead time register count wrong |
| `prop_delay_off` | 60 ns | Driver | Same |
| `prop_delay_on` | 60 ns | Driver | Same |
| `pwm_deadtime_res` | 8 ns | MCU | Wrong register value |
| `pwm_deadtime_max` | 1000 ns | MCU | Wrong saturation check |
| `adc_resolution` | 12 bits | MCU | Shunt ADC SNR calculation wrong |
| `tj_max` | 175 °C | MOSFET/Driver | Thermal headroom wrong |
| `i_leakage_ua` | 3 µA | Driver quiescent | Boot cap undersized |

### Action items

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| 2a | Add `_warnings[]` list to each module output. When fallback used, push: `"rth_jc fallback used (0.5 °C/W) — upload MOSFET datasheet"` | 🔴 | M | ✅ Done (Phase 1) |
| 2b | CalculationsPanel.jsx: Render amber warning badges next to any result section that used a fallback | 🔴 | M | ✅ Done (Phase 1) |

**Dependency**: 2a (backend adds `_meta.fallbacks_used`) → must complete before → 2b (frontend renders badges)

---

## 3. Calculation Formula Issues 🟡

### 3a. MOSFET Losses — `calc_mosfet_losses()`

| Issue | Current | Correct |
|-------|---------|---------|
| Modulation index hardcoded | `M = 0.9` always | Pull from `design_constants["spwm_modulation_index"]` |
| `qoss_loss` not returned | Calculated internally | Add to output dict as `qoss_loss_per_fet_w` |
| `coss_loss` not returned | Calculated internally | Add to output dict as `coss_loss_per_fet_w` |

### 3b. Input Capacitors — `calc_input_capacitors()`

| Issue | Current | Correct |
|-------|---------|---------|
| Power factor hardcoded | `pf = 0.85` always | Add to `design_constants` with default 0.85 |
| Bulk cap ripple limit | `1.94 A` hardcoded | Add `design_constants["bulk_cap_ripple_limit_a"]` default 2.0 A |
| MLCC DC-bias derating | 60% of rating hardcoded | Add `design_constants["mlcc_dc_bias_derating"]` default 0.5 |

### 3c. Bootstrap Cap — `calc_bootstrap_cap()`

| Issue | Current | Correct |
|-------|---------|---------|
| Leakage fallback | 3 µA hardcoded | Add to design constants |
| Recovery time factor | `3τ` = 95% | Document as assumption; add `design_constants["bootstrap_rc_factor"]` |

### 3d. Protection Dividers — `calc_protection_dividers()`

| Issue | Current | Correct |
|-------|---------|---------|
| TVS power rating | 600 W hardcoded | Add to design constants |
| RC filter cutoff | 2 kHz hardcoded | Add `design_constants["protection_filter_fc_hz"]` |

### 3e. Thermal — `calc_thermal()`

| Issue | Current | Correct |
|-------|---------|---------|
| Motor copper loss derating | 1.5× hardcoded | 🚫 **DO NOT REMOVE** — copper TCR ≈ 0.393%/°C → at 150°C winding: 1.49× ≈ 1.5×. This IS the correct worst-case model. Action: make it a design constant (default 1.5×, SiC/GaN users can reduce it). Do NOT replace with room-temp Rph — that is non-conservative. |

### 3f. Gate Resistors — `calc_gate_resistors()`

| Issue | Current | Correct |
|-------|---------|---------|
| Rg_off fallback | `rg_on × 0.5` when io_sink missing | Should warn and use symmetrical sizing instead |
| HS vs LS distinction | Lost when user overrides Rg manually | Preserve separate HS/LS resistors in output |

---

## 4. Extracted Parameters Not Used in Calculations 🟡

These params are successfully extracted from datasheets but the engine ignores them:

| Param | Extracted From | Currently | Should Be Used For |
|-------|---------------|-----------|-------------------|
| `qoss` | MOSFET | Logged only | Coss switching loss: `E_qoss = qoss × v_bus` per switching event |
| `vgs_max` | MOSFET | Warning check | Driver supply voltage guard: warn if `vdrv > vgs_max × 0.9` |
| `vgs_plateau` | MOSFET | Fallback to `vgs_th + 1` | Miller plateau: feed directly into gate resistor sizing instead of estimate |
| `id_pulsed` | MOSFET | Avalanche clamp | Peak inrush check: verify `I_peak_ripple < id_pulsed` |
| `crss` | MOSFET | Miller shoot-through | dV/dt calculation: `dVdt = i_gate / crss` (more accurate than from `tr` alone) |
| `ciss` | MOSFET | Logged only | Gate charge timing: `t_rise = ciss × rg_total / i_gate` (cross-check of `tr`) |
| `cpu_freq_max` | MCU | Not used | Dead-time register resolution cross-check |
| `adc_sample_rate` | MCU | Not used | ADC timing check: verify sample time > settling time at full signal bandwidth |
| `complementary_outputs` | MCU | Not used | Verify MCU can generate complementary PWM with correct polarity |

### Action items

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| 4a | Feed `qoss` into `calc_mosfet_losses()` as `qoss_loss_per_fet_w = qoss × v_bus × fsw` | 🟡 | S | ⏳ Not yet done |
| 4b | Use `vgs_plateau` directly in gate resistor sizing when available | 🟡 | S | ✅ Done (Phase 2 — Miller-charge sizing uses vgs_plateau) |
| 4c | Use `crss` for `dV/dt`: `dVdt = i_gate / crss` — more accurate than from `tr` alone | 🟡 | S | ✅ Done (Phase 2 item 17 — `dv_dt_crss_v_per_us` in gate_resistors) |
| 4d | Add MCU validation sub-module: `cpu_freq_max` → PWM timer resolution check; `adc_sample_rate` → ADC timing check; `complementary_outputs` → 3-phase capability confirm | 🟡 | M | ⏳ Not yet done |

---

## 5. Frontend Display Gaps 🟡

| Key | Produced By | Missing From UI |
|-----|-------------|-----------------|
| `qoss_loss_per_fet_w` | mosfet_losses | Not displayed |
| `coss_loss_per_fet_w` | mosfet_losses | Not displayed |
| `motor_validation` warnings | run_all() | Not rendered as warnings |
| `transparency` dict | All modules | Not shown anywhere |

### Action items

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| 5a | CalculationsPanel.jsx: Add display rows for `qoss_loss`, `coss_loss`, `body_diode_loss` | 🟡 | S | ⏳ Not yet done (depends on 4a) |
| 5b | Add `"_meta": { "fallbacks_used": [...] }` to each module output; render amber badges in CalculationsPanel | 🔴 | M | ✅ Done (Phase 1 — `_meta.fallbacks` + amber ⚠ N FB badge) |
| 5c | DesignConstantsModal: Already exists as standalone modal. See §DC_UI for improvement items. | ✅ Done | — | ✅ |

---

## 6. Report Generator Gaps 🟢

The PDF/Excel report is missing sections for 8 of 12 calculation modules.

### Missing from PDF report

| Module | Status |
|--------|--------|
| bootstrap_cap | ❌ Missing |
| shunt_resistors | ❌ Missing |
| power_supply_bypass | ❌ Missing |
| emi_filter | ❌ Missing |
| motor_validation | ❌ Missing |
| waveform | ❌ Missing |
| pcb_trace_thermal | ❌ Missing |
| pcb_guidelines | ❌ Missing |

### Missing from Excel BOM

- Bootstrap capacitor (value, voltage, count)
- EMI filter components (CM choke, X/Y caps)
- Snubber (Rs, Cs)

### Action items

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| 6a | `report_generator.py → generate_pdf_report()`: Add section loop — iterate over all module keys in `calculations` dict, render generic table for any unhandled module | 🟢 | M | ✅ Done (Phase 3 item 20) |
| 6b | `generate_excel_report()`: Add BOM rows for bootstrap cap, EMI filter, snubber from calculation results | 🟢 | M | ✅ Done (Phase 3 item 20) |

---

## 7. Unit Conversion Risks 🔴

### 7a. Motor specs bypass `buildParamsDict()`

**Location**: `frontend/src/context/ProjectContext.jsx → buildCalcPayload()`

Motor specs are sent as `motor_specs: { rph_mohm: 12, lph_uh: 50, ... }` without going through the unit conversion pipeline. The unit is implied in the key name (`rph_mohm` = mΩ) — if a user tries to enter a different scale, there is no protection.

**Fix**: Lock motor form fields to specific units with clear labels (mΩ, µH) so user cannot enter wrong scale. Show unit next to each field input.

### 7b. No SI bounds validation after conversion

After `to_si()`, there is no bounds check. A wrong unit from extraction produces wildly wrong results with no warning.

**Fix**: Add per-param SI sanity bounds in calc_engine:
```python
PARAM_BOUNDS_SI = {
    "rds_on":  (1e-5, 1.0),    # 10 µΩ to 1 Ω
    "qg":      (1e-9, 1e-6),   # 1 nC to 1 µC
    "rth_jc":  (0.01, 10.0),   # 10 mK/W to 10 K/W
}
```

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| 7a | MotorForm.jsx: Lock fields to specific units, show unit label per field | 🟡 | S | ✅ Done (Phase 3 item 24) |
| 7b | calc_engine base: Add SI sanity bounds — log warning when extracted value is outside physical range | 🔴 | M | ✅ Done (Phase 3 item 25 — `_PARAM_BOUNDS` already implemented in base.py) |

---

## 8. Missing E-Series Snapping 🟢

| Value | Current | Fix |
|-------|---------|-----|
| Shunt capacitor `C_shunt` | Not snapped | Snap to E12 pF |
| TVS clamp voltage | Hardcoded suggestions | Snap to nearest standard TVS voltage (5.1, 6.2, 6.8, 8.2, 9.1, 10, 12, 15, 18, 20, 22, 24, 27, 30, 33, 36, 43, 51, 58, 62, 68 V) |
| OTP NTC R_series | Not snapped | Snap to E24 |
| Bootstrap cap | Snapped to E12 ✅ | Done |
| Gate resistors | Snapped to E24 ✅ | Done |
| Snubber cap | Snapped to E12 ✅ | Done |

---

## 10. Dead Code / Unintegrated Features 🟢

> **Note**: `waveform.py` is NOT dead code — it is used by `WaveformPanel.jsx` for the
> frontend oscilloscope simulator. It is frontend-only by design (PROJECT_ROADMAP §1.16).
> Do not integrate into `run_all()`.

| Feature | Location | Status | Fix |
|---------|----------|--------|-----|
| `reverse_calculate()` | backend/main.py | Endpoint exists, frontend partially wired | Complete reverse target UI for gate rise time, bootstrap cap |
| `transparency` / `_log_hc()` | calc_engine base | Built, NOT shown in UI | Add to CalculationsPanel as collapsible "How this was calculated" |
| SPICE export UI | ReportPanel.jsx | ✅ Done — export button exists | See §SPICE for improvement items |
| Design constants UI | DesignConstantsModal.jsx | ✅ Done — modal exists and wired | See §DC_UI for improvement items |

---

## 11. Prompt Improvements (Extraction Quality) 🟡

> **Current PROMPT_VERSION: `v14-gemini`**
> Do NOT bump PROMPT_VERSION unless prompt text actually changes.
> CALC_DEPS changes auto-invalidate cache via deps hash — no bump needed for those.
> Next version if prompt changes: `v15-gemini`.

### 11a. MOSFET prompt
- ✅ Rule 10 (condition objects only) — fixed in v14
- ✅ `ciss`, `rg_int`, `rth_ja`, `avalanche_energy`, `avalanche_current` — promoted to essential in v14
- Add: Extract `crss` more reliably — appears in "Capacitances" table as "Reverse Transfer Capacitance"
- Add: For `vgs_plateau`, look in gate charge curve graph description, not just tables

### 11b. Gate Driver prompt
- ✅ Rule 10 (HO/LO split) — fixed in v14
- ✅ `deadtime_min`, `deadtime_default`, `idd_quiescent` — added in v14
- Add: `deadtime_min` and `deadtime_default` are often in "Shoot-through protection" table — look there explicitly

### 11c. MCU prompt
- ✅ `cpu_freq_max` multi-condition note — fixed in v14
- ✅ `pwm_deadtime_res`, `pwm_deadtime_max`, `adc_ref` — added in v14
- Add: `adc_sample_rate` — look in "ADC Timing" section for `t_conv`, convert to KSPS
- Add: `pwm_deadtime_res` — look for "Dead-Time Generator" register description with step size in ns

---

## 12. Calculation Module — New Outputs Needed 🟡

### 12a. Add ADC timing validation output

```
adc_settling_time_ns  = 1 / adc_sample_rate × 1e9
dead_time_ns          = (from dead_time module)
adc_fits_in_dead_time = adc_settling_time_ns < dead_time_ns
```

### 12b. Add dV/dt output

```
dvdt_on_v_per_ns   = v_bus / tr        # during turn-on
dvdt_off_v_per_ns  = v_bus / tf        # during turn-off
dvdt_limit_ok      = dvdt < 50 V/ns   # typical EMC guideline
```

### 12c. Motor Compatibility output block
See §COMPAT — this is now a dedicated feature with its own section.

---

## 13. Formula-Level Bugs & Wrong Defaults 🔴

### 13a. Confirmed-correct formulas (no action needed)

| Formula | Module | Verdict |
|---------|--------|---------|
| Conduction loss `I_rms² × Rds_hot` | mosfet.py | ✓ Correct |
| Switching loss `Vbus × I × (tr+tf) × fsw / π` | mosfet.py | ✓ Correct |
| RMS current `√(1/8 + M/(3π))` | mosfet.py | ✓ Correct (Mohan textbook) |
| Ripple current `Vbus×0.25 / (Lph×fsw)` | mosfet.py | ✓ Correct |
| Ripple RMS conversion `/2√3` | mosfet.py | ✓ Correct (triangular wave) |
| Gate rise time `Rg × Qgd / (Vdrv − Vpl)` | gate_drive.py | ✓ Correct |
| dV/dt `= Vbus / t_rise` | gate_drive.py | ✓ Correct |
| Miller current `Crss × dV/dt` | gate_drive.py | ✓ Correct |
| Bootstrap charge `Q_total / ΔV_droop` | gate_drive.py | ✓ Correct |
| Bootstrap refresh `−τ × ln(0.05) = 3τ` | gate_drive.py | ✓ Correct |
| Dead time sum `td_off + tf + t_prop + t_drv + margin` | gate_drive.py | ✓ Correct |
| Ripple RMS (3-phase Kolar) | passives.py | ✓ Correct |
| Bulk cap `I_max / (4 × fsw × ΔV)` | passives.py | ✓ Correct |
| Snubber `f_res = 1/(2π√LC)` | passives.py | ✓ Correct |
| Overshoot `V = I × √(L/C)` | passives.py | ✓ Correct |
| Snubber power `0.5 × Cs × Vpeak² × fsw` | passives.py | ✓ Correct |
| Thermal chain `Tj = Tamb + P×(Rjc+Rcs+Rsa)` | thermal.py | ✓ Correct |
| Ring frequency `1/(2π√(Lstray×Coss))` | waveform.py | ✓ Correct |
| Ring damping — both `τ=Q/(πf)` (backend) and `ζ=R/(2√(L/C))` (frontend) | waveform.py + WaveformPanel | ✓ Both consistent |
| Ring amplitude `A = I × √(L/C)` | waveform.py | ✓ Correct |
| Vgs plateau `= Vth + Id/gm` | waveform.py | ✓ Correct |
| Body diode loss `Vf × I × sin_avg × dt × fsw × 2 / 2` | mosfet.py | ✓ Correct |
| Coss loss `0.5 × Qoss × Vbus × fsw` | mosfet.py | ✓ Correct |
| Gate power `Qg × Vdrv × fsw` | mosfet.py | ✓ Correct |

### 13b. Genuine formula issues found

| # | Issue | Severity | Effort | Status |
|---|-------|----------|--------|--------|
| 13-1 | **Tj iteration — no convergence check.** `mosfet.py` loops exactly 5 times regardless. Fix: replace `for _ in range(5)` with convergence criterion `abs(tj_new - tj_prev) < 0.1°C`, max 20 iterations. | 🟡 | S | ✅ Done (Phase 1 item 4) |
| 13-2 | **Dead time — turn-on path not validated.** Only turn-off path used to size dt. Turn-on path `(td_on + tr + t_prop_on)` may be longer for asymmetric drivers. Fix: compute both, take `max(dt_turnoff, dt_turnon)`. | 🟡 | S | ✅ Done (Phase 1 item 5) |
| 13-3 | **Switching loss — linear approximation only.** The Qgd-based model (already implemented) is more accurate than the linear `/π` model. Fix: log a note in output when falling back to linear model; prefer Qgd model when `qgd` is extracted. | 🟢 | S | ✅ Done (Phase 2 — Qgd model preferred, fallback note logged) |
| 13-4 | **Rds(on) temperature coefficient α hardcoded to 2.1.** SiC MOSFETs: α ≈ 0.3–0.5 — catastrophically wrong. Fix: move to DESIGN_CONSTANTS as `thermal.rds_alpha` (default 2.1, user-overridable for SiC). | 🟡 | S | ✅ Done (Phase 1 item 1 + Phase 2 item 11) |
| 13-5 | **Ringing Q factor hardcoded to 8.0** in `waveform.py`. High-inductance PCBs can have Q=15–20. Fix: use `self._dc("snub.ring_q_factor", 8.0)` as design constant. | 🟡 | S | ✅ Done (Phase 1 item 1 + Phase 2 item 12) |
| 13-6 | **No multi-cycle ringing superposition.** Each switching event resets ring amplitude to zero. Fix: track residual at end of each period, add to next period's initial ring. | 🟢 | M | ✅ Done (Phase 3 item 31 — `v_ring_residual_pct` + warning if >10%) |
| 13-7 | **Snubber response time not validated.** `τ = Rs × Cs` must satisfy `3τ < 0.5 / fsw`. Code computes Rs and Cs but never checks this. Fix: add validation in `calc_snubber()` with warning if snubber is too slow. | 🟡 | S | ✅ Done (Phase 1 item 3) |
| 13-8 | **Vds overshoot check silent.** `waveform.py`: `v_overshoot_off = min(v_overshoot_off, _vds_cap)` silently clamps. If ringing hits Vds_max × 0.85, MOSFET is in avalanche danger zone — no warning returned. Fix: add `vds_overshoot_danger = True` and warning string to waveform output when threshold exceeded. | 🔴 | S | ✅ Done (Phase 1 item 2) |

---

## 14. Wrong DESIGN_CONSTANTS Defaults 🔴

> **⚠ Audit correction (2026-04-27):** Several changes originally listed below were reviewed against the worst-case design philosophy and found to be **INCORRECT**. Corrections noted inline.

These defaults are **factually incorrect** for a 48V/3kW PMSM application.

| Constant | Original Default | Action | Verdict | Impact |
|----------|-----------------|--------|---------|--------|
| `gate.bootstrap_vf` | 1.0 V | 🚫 **KEEP 1.0 V** | 1.0V is the worst-case value for integrated bootstrap diodes (IR2110/UCC27211 have ~0.7–1.0V internal diodes). 0.6V is only for external Schottky. Changing to 0.6V makes design LESS conservative. Description updated to clarify. | |
| `waveform.driver_temp_derate_per_c` | 0.001 1/°C | ✅ **FIX → 0.003** | 0.1%/°C is too low. Datasheets show ~0.3%/°C. Fixed in Phase 1. | Gate drive current at Tj=125°C overestimated by 2× |
| `input.esr_per_cap` | 50 mΩ | ✅ **FIX → 80 mΩ** | 80mΩ is more conservative (worst-case for electrolytic ESR). Fixed in Phase 1. | Ripple voltage and cap count underestimated |
| `boot.safety_margin` | 2.0× | 🚫 **KEEP 2.0×** | 2.0× is MORE conservative. Reducing to 1.5× makes design LESS safe for worst-case analysis. Reverted in Phase 1. | |
| `thermal.rth_sa` | 20 °C/W | ✅ **FIX → 10 °C/W** | Default changed — the cooling tier system in thermal.py handles the `natural` case correctly. 10°C/W is the base constant default. Fixed in Phase 1. | |

### Missing constants — add to `base.py`

```python
DESIGN_CONSTANTS = {
    ...
    # ADD — currently hardcoded in modules:
    "snub.ring_q_factor":         (8.0,   "(none)", "Snubber",    "Ring Q factor",        "PCB layout Q factor for LC ringing model. Typical: 8 (48V), 12 (SiC), 15 (high-L)"),
    "thermal.rds_alpha":          (2.1,   "(none)", "Thermal",    "Rds temp exponent",    "Power-law α for Rds(Tj): Rds_hot = Rds25 × (Tj/298)^α. Si=2.1, SiC=0.4"),
    "gate.driver_derating_per_c": (0.003, "1/°C",  "Gate Drive", "Driver IO derating",   "Driver source/sink current derating per °C. Typical: 0.3%/°C for most ICs"),
}
```

### Fix existing defaults in `base.py` (✅ done in Phase 1)

```python
"input.esr_per_cap":                    (80,   "mΩ",  ...),   # was 50  ✅
"waveform.driver_temp_derate_per_c":    (0.003, "1/°C", ...),  # was 0.001  ✅
# gate.bootstrap_vf kept at 1.0V — worst-case for integrated diodes  🚫 do not change
# boot.safety_margin kept at 2.0× — more conservative for worst-case  🚫 do not change
```

### ~~Delete from `base.py`~~  🚫 CANCELLED

- ~~**`adc.max_duty_cycle`**~~ — **NOT dead code**. `validation.py:172` calls `self._dc("adc.max_duty_cycle")` in `calc_adc_timing()`. Deleting it causes a `KeyError` crash. **Keep it.** (Was incorrectly marked as dead code in this plan.)

### Also questionable

| Constant | Default | Why |
|----------|---------|-----|
| `input.spwm_mod_index` | 0.9 | Should derive from `Ke × max_RPM / Vbus`, not hardcoded |
| `thermal.rds_alpha` | missing | SiC users get 5–7× wrong Rds derating — add as new constant |

---

## 15. Missing Calculation Modules 🟡

| Module | What It Does | Priority | New File |
|--------|-------------|----------|----------|
| **Gate drive IC thermal** | Split gate power → Rg_external vs driver IC; check Tj of driver | 🔴 High | gate_drive.py (extend) |
| **MOSFET SOA check** | Is switching time within SOA boundary at (Vds, Id)? | 🔴 High | mosfet.py (extend) |
| **Shoot-through current** | If dt < trr, compute peak shoot-through vs avalanche rating | 🔴 High | gate_drive.py (extend) |
| **Vds overshoot validation** | Add explicit danger flag to output | 🔴 High | waveform.py (see 13-8) |
| **ADC current loop bandwidth** | fsw_pwm ripple vs ADC sample rate; alias check | 🟡 Medium | passives.py (extend) |
| **EMI DM noise estimate** | `V_dm = fsw × L_stray × di/dt`; check vs CISPR | 🟡 Medium | new: emi_dm.py |
| **Derating curves** | Sweep T_amb 0→125°C; output safe I_max at each point | 🟡 Medium | new: derating.py |
| **Motor compatibility** | See §COMPAT — now a dedicated feature | 🟡 Medium | new: motor_compat.py |

### Gate drive IC thermal (most critical missing module)

```python
# extend gate_drive.py output:
rg_ext_fraction  = rg_on_std / (rg_on_std + rg_int)
p_rg_on          = (1/3) * qg * v_drv * fsw * rg_ext_fraction
p_rg_off         = (1/3) * qg * v_drv * fsw * (rg_off_std / (rg_off_std + rg_int))
p_driver_gate    = qg * v_drv * fsw - p_rg_on - p_rg_off   # driver IC dissipation
tj_driver        = t_amb + p_driver_gate * rth_ja_driver     # driver junction temp
```

### MOSFET SOA check

```python
t_switch = tr + tf                             # total Vds transition time
soa_pass = t_switch < soa_time_limit           # typically 1µs at Vds_max
```

### Shoot-through current

```python
if dt_actual_ns < trr_ns:
    results["warnings"].append(
        "⚠ Dead time < trr: shoot-through risk — verify Id,shoot < Id,pulse rating"
    )
```

---

## 16. API Key Management & Error Handling

### 16a. 🚫 Decided NOT to implement

| Item | Reason |
|------|--------|
| 429 type distinction (RPM vs daily quota) | Added complexity, decided against |
| Comparison tab stop-on-quota-exhaustion | Added complexity, decided against |
| Pass 2 disable option in comparison mode | Added complexity, decided against |

### 16b. ⏳ Pending — moved to Phase 0

See Phase 0 below. These are crash-risk items — they are now the first things to fix.

### 16c. ⏳ API key UX improvements

| Item | Value | Effort | Status |
|------|-------|--------|--------|
| Show per-key status in Settings (cached / active / quota-exhausted) | User knows which key to replace | M | ⏳ |
| Pre-run API call estimate in ComparisonPanel before hitting Run | "~12 API calls needed" | S | ⏳ |
| Key health check button — test each key with a tiny request, show ✅/❌ | User can validate keys before extraction | M | ⏳ |

---

## §SPICE — SPICE Export Improvements

> SPICE export endpoint and UI button are ✅ Done. These are improvements to the existing feature.

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| SPICE-1 | ReportPanel.jsx: Show amber warning when motor form is empty — netlist silently uses fallback 50mΩ/100µH. | 🟡 | S | ✅ Done (Phase 2 item 19) |
| SPICE-2 | ReportPanel.jsx: Include project name in filename — `{project.name}_halfbridge.cir`. | 🟢 | S | ✅ Done (Phase 2 item 19) |
| SPICE-3 | ReportPanel.jsx: LTspice compatibility note in card description. | 🟢 | S | ✅ Done (Phase 2 item 19) |
| SPICE-4 | ReportPanel.jsx: Motor form status row in Project Status block. | 🟡 | S | ✅ Done (Phase 2 item 19) |

---

## §DC_UI — Design Constants UI Improvements

> DesignConstantsModal.jsx is ✅ Done. These are improvements to the existing modal.

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| DC_UI-1 | DesignConstantsModal.jsx: Add `UI_META` entries for all new constants from §14 — `snub.ring_q_factor`, `thermal.rds_alpha`, `gate.driver_derating_per_c`. | 🟡 | S | ✅ Done (Phase 1 item 9) |
| DC_UI-2 | DesignConstantsModal.jsx: Add min/max bounds validation on number inputs. | 🟡 | S | ✅ Done (Phase 1 item 10) |
| DC_UI-3 | ~~base.py + DesignConstantsModal UI_META: Delete `adc.max_duty_cycle`~~ — 🚫 **CANCELLED**: it IS used in `calc_adc_timing()` at `validation.py:172`. Keep it. Add UI_META entry for it instead. | 🟢 | S | ✅ |
| DC_UI-4 | DesignConstantsModal.jsx: Add "affects:" annotation per constant row — tells user which module uses the constant (e.g. "affects: Snubber, Waveform"). | 🟢 | M | ✅ Done (Phase 3 item 26) |

---

## §WAVE — Waveform-Specific Issues

> waveform.py is NOT dead code — it powers WaveformPanel.jsx (oscilloscope simulator).
> Do not add to run_all(). These are accuracy and clarity improvements.

| # | Item | Severity | Effort | Status |
|---|------|----------|--------|--------|
| WAVE-1 | waveform.py + snubber module use **different stray inductance sources**. Waveform reads `system_specs.power_loop_inductance_nh`; snubber reads `snub.stray_l_default` design constant. They should use the same value. Fix: snubber reads `power_loop_inductance_nh` when non-zero, falls back to design constant. | 🟡 | M | ✅ Done (Phase 2 item 18 — both use same override key) |
| WAVE-2 | waveform.py line 76: `v_bus = self.v_peak` uses peak (60V transient) not nominal bus (48V). Intentional for worst-case Vds modelling, but confusing. Fix: add note in WaveformPanel UI explaining why. | 🟢 | S | ✅ Done (Phase 3 item 27) |
| WAVE-3 | Q_ring = 8.0 hardcoded in waveform.py. See §13 Issue 13-5 — replace with design constant `snub.ring_q_factor`. | 🟡 | S | ✅ Done (Phase 1 item 1 + Phase 2 item 12) |
| WAVE-4 | Vds overshoot danger check missing. See §13 Issue 13-8 — add explicit danger flag when overshoot ≥ 85% of Vds_max. | 🔴 | S | ✅ Done (Phase 1 item 2) |

---

## Fix Order

### Phase 0 — Crash Bugs ✅ COMPLETE (merged to main 2026-04-27)

| # | Item | File | Severity | Status |
|---|------|------|----------|--------|
| 0a | `None` values in `_make_table()` crash ReportLab — stringify all cells, None → "—" | `report_generator.py` | 🔴 | ✅ |
| 0b | `uvloDataBadgeInfo()` returns `undefined` for unknown status | `CalculationsPanel.jsx` | 🔴 | ✅ |
| 0c | `convertUnit()` returns raw value for unsupported target unit | `ComparisonPanel.jsx` | 🟡 | ✅ |
| 0d | Lazy-loaded panel failure shows "Loading panel…" forever | `App.jsx` | 🟢 | ✅ |

---

### Phase 1 — Critical Correctness ✅ COMPLETE (merged to main 2026-04-27)

> **Audit correction applied**: Items 1 and DC_UI-3 were revised after external review — `bootstrap_vf` and `boot.safety_margin` reverted to original (more conservative) values; `adc.max_duty_cycle` restored (NOT dead code). See §14 notes.

| # | Item | Ref | Effort | Status |
|---|------|-----|--------|--------|
| 1 | Fix DESIGN_CONSTANTS in `base.py`: fix 2 wrong defaults + add 3 missing constants + restore `adc.max_duty_cycle` + revert 2 wrong "fixes". Wire `thermal.rds_alpha` → `mosfet.py`, `snub.ring_q_factor` → `waveform.py`, `input.spwm_mod_index` → `mosfet.py` | §14 | M | ✅ |
| 2 | Vds overshoot explicit warning in `waveform.py` | §13-8 + §WAVE-4 | S | ✅ |
| 3 | Snubber response time — `3τ < T/2` check + `τ < t_rise` spike absorption check | §13-7 | S | ✅ |
| 4 | Tj convergence: range(5)→range(20) + 0.1°C break + for-else thermal runaway warning | §13-1 | S | ✅ |
| 5 | Dead time — compute both turn-on and turn-off paths, take max | §13-2 | S | ✅ |
| 6 | Fallback transparency — backend `_meta.fallbacks` with `message` field on every fallback | §2a | M | ✅ |
| 7 | Fallback transparency — frontend amber `⚠ N FB` badge with tooltip in CalculationsPanel | §2b | M | ✅ |
| 8 | Motor Compatibility feature — single-motor checks + verdict UI | §COMPAT | L | ✅ Done (Phase 1 item 8 — stall/modulation/regen checks, verdict banner). Multi-motor COMPAT-1 to COMPAT-4 deferred. |
| 9 | Update `UI_META` for new constants + add ADC Timing category + `adc.max_duty_cycle` | §DC_UI-1 | S | ✅ |
| 10 | DC_UI input bounds — `min`/`max` HTML attrs + `onBlur` clamp on all inputs | §DC_UI-2 | S | ✅ |

**Dependency notes**:
- Item 6 → must complete before → Item 7
- §COMPAT-2 (backend) → must complete before → §COMPAT-4 (frontend display)

---

### Phase 2 — Accuracy ✅ COMPLETE (merged to main 2026-04-28)

| # | Item | Ref | Effort | Status |
|---|------|-----|--------|--------|
| 11 | Rds α as design constant — replace hardcoded 2.1 in `mosfet.py` | §13-4 | S | ✅ |
| 12 | Ring Q as design constant — replace hardcoded 8.0 in `waveform.py` | §13-5 + §WAVE-3 | S | ✅ |
| 13 | Gate drive IC thermal — split gate power, compute driver Tj | §15 | M | ✅ |
| 14 | 🚫 ~~MOSFET SOA check — switching time vs SOA boundary~~ — **Decided not to implement.** Datasheet SOA curves are plotted for linear-mode operation (µs–ms pulse widths). Hard-switched PWM transitions (50–200ns) are below the shortest datasheet data point; extrapolating to sub-µs yields physically meaningless numbers. For hard-switching inverters, safety is correctly verified by Vds_max margin + Id_pulsed + Tj checks — which the engine already does. | §15 | — | 🚫 |
| 15 | Shoot-through current — dead-time < trr warning | §15 | S | ✅ |
| 16 | CALC_DEPS audit — `deadtime_min` + `deadtime_default` added to driver set | §9 (remaining) | S | ✅ |
| 17 | Feed `crss` into dV/dt (`dv_dt_crss_v_per_us`); `qoss` display deferred (§4a) | §4a, §4c | S | ✅ crss done · ⏳ qoss pending |
| 18 | Stray inductance consistency — snubber + waveform same override key | §WAVE-1 | M | ✅ |
| 19 | SPICE export improvements (SPICE-1 through SPICE-4) | §SPICE | S | ✅ |

---

### Phase 3 — Completeness ✅ COMPLETE (merged to main 2026-04-28)

| # | Item | Ref | Effort | Status |
|---|------|-----|--------|--------|
| 20 | Report generator — generic PDF section loop + Excel BOM rows (snubber, EMI) | §6 | L | ✅ |
| 21 | E-series snapping — TVS to E24, shunt cap to E12, OTP NTC pullup to E24 | §8 | M | ✅ |
| 22 | ADC dead-time window check (`adc_fits_in_dead_time`) | §12a | M | ✅ |
| 23 | dV/dt output block (`dvdt_on_v_per_ns`, Crss-based, EMC check) | §12b | S | ✅ |
| 24 | Motor form inline unit badges (mΩ / µH / etc.) | §7a | S | ✅ |
| 25 | SI bounds validation — `_PARAM_BOUNDS` already in base.py | §7b | M | ✅ Already existed |
| 26 | DC_UI "affects:" annotation per constant in DesignConstantsModal | §DC_UI-4 | M | ✅ |
| 27 | Waveform v_peak vs v_bus UI note in WaveformPanel | §WAVE-2 | S | ✅ |
| 28 | ADC current-loop bandwidth + Nyquist check module (`calc_adc_bandwidth`) | §15 | M | ✅ |
| 29 | EMI DM noise module — CISPR 25 Class 3 estimate (`calc_emi_dm`) | §15 | L | ✅ |
| 30 | Thermal derating curve sweep 0–125°C (`calc_derating`) | §15 | M | ✅ |
| 31 | Multi-cycle ringing residual — `exp(-T/τ)`, warns if >10% (`v_ring_residual_pct`) | §13-6 | M | ✅ |
| 32 | API key health check endpoint + Test Keys button + per-key status badges | §16c | M | ✅ |
| 33 | Worst-case V_peak calculator — supply transient + overshoot + regen (`calc_vpeak_check`) | §MISSING-1 | M | ✅ |
| 34 | Worst-case stall current — DC locked-rotor `v_bus/Rph` + MOSFET fault path `v_bus/(2×Rds_hot)` | §MISSING-2 | S | ✅ |
| 35 | Multi-operating-point thermal sweep — Tj at stall/25%/50%/rated/max speed (`calc_thermal_multipoint`) | §MISSING-3 | L | ✅ |

---

## Files to Touch (by fix)

| Fix | Backend File | Frontend File |
|-----|-------------|---------------|
| Phase 0 crash bugs | `report_generator.py` | `CalculationsPanel.jsx`, `ComparisonPanel.jsx`, `App.jsx` |
| §14 DESIGN_CONSTANTS | `calculations/base.py` | — |
| §DC_UI improvements | — | `DesignConstantsModal.jsx` |
| §13-8 Vds warning | `calculations/waveform.py` | — |
| §13-7 Snubber check | `calculations/snubber.py` | — |
| §13-1 Tj convergence | `calculations/mosfet.py` | — |
| §13-2 Dead time paths | `calculations/gate_drive.py` | — |
| §2 Fallback warnings | `calc_engine.py` (base `_get`) | `CalculationsPanel.jsx` |
| §3 Design constants | `calculations/base.py` | `DesignConstantsModal.jsx` |
| §4 Use qoss/crss | `calculations/mosfet.py` | `CalculationsPanel.jsx` |
| §6 Report | `report_generator.py` | — |
| §7 Unit bounds | `unit_utils.py` | `MotorForm.jsx` |
| §8 E-series | `calculations/protection.py` | — |
| §11 Prompt improvements | `claude_service.py` | — |
| §15 New modules | `calculations/gate_drive.py`, `calculations/mosfet.py` | `CalculationsPanel.jsx` |
| §COMPAT Motor compat | `calculations/motor_compat.py` (new), `main.py` | `App.jsx`, new `MotorCompatPanel.jsx` |
| §SPICE improvements | — | `ReportPanel.jsx` |
| §WAVE improvements | `calculations/waveform.py` | `WaveformPanel.jsx` |

---

## Summary Stats

| Category | Issues | Critical | Medium | Low | Status |
|----------|--------|----------|--------|-----|--------|
| Crash bugs (Phase 0) | 4 | 2 | 1 | 1 | ✅ All done |
| Formula correctness | 8 | 2 | 5 | 1 | ✅ All done (Phases 1–3) |
| Wrong DC defaults | 5 | 3 | 2 | 0 | ✅ 2 fixed · 🚫 2 reverted (audit) · ✅ 1 fixed |
| Missing DC constants | 3 | 2 | 1 | 0 | ✅ All done (Phase 1) |
| Missing modules | 7 | 3 | 3 | 1 | ✅ All done (Phases 2–3) |
| Motor compat feature | 5 | 0 | 4 | 1 | ✅ Single-motor done · ⏳ Multi-motor (COMPAT-1–4) deferred Phase 4 |
| Hardcoded fallbacks | 21 | 12 | 7 | 2 | ✅ Transparency system done (Phase 1) |
| Display / report gaps | 10 | 0 | 5 | 5 | ✅ All done (Phases 2–3) |
| API key management | 19 | 2 | 6 | 8 | ✅ All done · 🚫 3 skipped |
| SPICE export | 4 | 0 | 2 | 2 | ✅ All done (Phase 2 item 19) |
| Design constants UI | 4 | 0 | 2 | 2 | ✅ All done (Phases 1 + 3) |
| Waveform specific | 4 | 1 | 2 | 1 | ✅ All done (Phases 1–3) |
| Worst-case analysis (new) | 3 | 0 | 3 | 0 | ✅ All done (Phase 3, items 33–35) |
| ESSENTIAL_IDS (§9) | 6 | — | — | — | ✅ Resolved at prompt level (v14-gemini) |
| qoss loss calculation | 1 | — | — | — | ⏳ Not yet done (§4a) |
| MCU validation sub-module | 1 | — | — | — | ⏳ Not yet done (§4d) |

### Completion as of 2026-04-28
- ✅ **Phase 0 complete** — 4 crash bugs merged to main
- ✅ **Phase 1 complete** — all items merged to main
- ✅ **Phase 2 complete** — all items merged to main
- ✅ **Phase 3 complete** — all items merged to main
- 🚫 **5 items decided not to implement** (429 distinction, comparison stop, Pass 2 toggle, delete adc.max_duty_cycle, MOSFET SOA check)
- ⏳ **Remaining** — §4a (qoss loss), §4d (MCU validation), COMPAT-1 to COMPAT-4 (multi-motor comparison)

---

*End of plan — Phases 0–3 complete. Remaining: §4a (qoss loss, S), §4d (MCU validation, M), COMPAT-1–4 (multi-motor comparison, Phase 4, L).*
*PROMPT_VERSION current: `v14-gemini` · Next if prompt changes: `v15-gemini`*
