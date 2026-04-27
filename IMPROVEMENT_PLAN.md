# MC Hardware Designer v2 — Full Improvement Plan

> Generated: 2026-04-22 · Last updated: 2026-04-23  
> Scope: Extraction accuracy, calculation correctness, unused motor params, hardcoded fallbacks,  
> unit handling, frontend display gaps, report generator, E-series snapping, dead code,  
> API key management, error handling.

---

## How to use this document

Work through each section top-to-bottom. Each item has:
- **Severity**: 🔴 High (wrong results / crash risk) · 🟡 Medium (degraded accuracy) · 🟢 Low (polish)
- **Effort**: S (< 1 hr) · M (1–4 hrs) · L (4–12 hrs)
- **Status**: ✅ Done · ⏳ Pending · 🚫 Decided not to implement
- **File + line** reference so you can jump straight to the code

---

## ✅ Completed in 2026-04-23 Session

All items below are implemented and in the worktree. Do not re-implement.

| # | What | Files Changed |
|---|------|--------------|
| A | Multi-API-key support — Settings UI accepts N keys; backend rotates on 429 | `SettingsModal.jsx`, `ProjectContext.jsx`, `api.js`, `main.py`, `claude_service.py`, `Header.jsx`, `BlockPanel.jsx`, `ComparisonPanel.jsx`, `Sidebar.jsx` |
| B | Pass 2 independent key rotation — Pass 1 succeeds on key K; Pass 2 tries K, K+1, … independently without re-running Pass 1 | `claude_service.py` |
| C | 503 retry with exponential backoff (5→10→20→40→60 s) — server-overload errors retry same key before giving up | `claude_service.py` |
| D | Frontend cycling status message — "Gemini is reading…" → "servers busy, retrying…" at 60 s | `BlockPanel.jsx` |
| E | File processing loop timeout — 120 s max; raises `TimeoutError` instead of hanging forever | `claude_service.py` |
| F | `asyncio.TimeoutError` caught at `wait_for` — surfaces as clean error message | `claude_service.py` |
| G | `_parse_raw` always ensures `parameters` key — prevents silent empty-data returns | `claude_service.py` |
| H | Error message sanitization in all routes — no more `type(e).__name__` in HTTP responses | `main.py` |
| I | Specific error messages: 429 quota, 504 timeout, 500 file-processing | `main.py` |
| J | Fetch timeout in frontend — 11 min for extraction (matches backend), 30 s for all other routes | `api.js` |
| K | `AbortController` on every fetch — hangs are now impossible | `api.js` |
| L | `localStorage.setItem` wrapped in try/catch; parse failure logs to console | `ProjectContext.jsx` |
| M | `fmtCell` guards `Infinity` — parameter table no longer renders raw "Infinity" | `ParameterTable.jsx` |
| N | Manual param commit shows toast on invalid input — previously silent | `BlockPanel.jsx` |
| O | `sys.cooling` ReferenceError fixed in ComparisonPanel — was a crash on losses render | `ComparisonPanel.jsx` |
| P | Unknown unit logs warning in `to_si()` — previously silently used ×1.0 | `unit_utils.py` |

---

## 1. Motor Parameters — Design Philosophy & Correct Usage

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
> 2. Validate that a specific motor fits within the already-sized PCB's ratings (read-only, never feeds back into component sizing)

---

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

**1c.** Add a read-only **"Motor Compatibility"** output block (new module in `calc_engine.py`).  
This block reads the already-sized PCB results and checks whether the entered motor fits:

```python
# motor_compatibility module — READS calcs, never feeds back into them
i_pk_motor   = rated_torque / kt                          # motor's peak current demand
f_elec_hz    = max_speed_rpm * pole_pairs / 60            # electrical frequency at max RPM
back_emf_v   = back_emf_v_per_krpm * (max_speed_rpm/1000)# back-EMF at max RPM
bus_headroom = v_bus - back_emf_v                         # voltage margin remaining

checks = {
    "current_ok":    i_pk_motor <= max_phase_current,     # motor fits within PCB rating?
    "freq_ok":       f_elec_hz  <= pwm_freq_hz / 6,       # electrical freq sane vs PWM?
    "headroom_ok":   bus_headroom >= 5,                    # at least 5V bus headroom?
    "id_ok":         i_pk_motor <= id_cont,                # within MOSFET continuous rating?
}
```

Output shows ✅/❌ per check with plain-English explanation. User can swap motor specs and immediately see if the same PCB can drive the new motor.

**1d.** In `CalculationsPanel.jsx`: Render the Motor Compatibility block as a dedicated section with green/red status badges — clearly labelled **"Motor Fit Check"** so the user understands it is not a component sizing output.

---

## 2. Hardcoded Fallback Values 🔴

Every `_get(block, "BLOCK", "param", FALLBACK)` with a non-None fallback is a **silent failure**. If extraction missed a param, the design continues with a generic value that may be wrong by 5–10×.

### Full list of hardcoded fallbacks in `calc_engine.py`

> **Note — already-handled values (do NOT action these):**
> - `csa_gain` (20 V/V): Has a **"CSA Gain Override"** field in PassivesPanel. Priority: UI override → driver datasheet `current_sense_gain` → fallback. ✅ User can always set it manually.
> - `adc_ref` (3.3 V): Is a **DESIGN_CONSTANT** (`prot.adc_ref`) shown in DesignConstantsModal AND extracted as essential MCU param `adc_ref`. ✅ Already configurable.

| Param | Fallback | Source Block | Risk |
|-------|----------|--------------|------|
| `qg` | 92 nC | MOSFET datasheet | Gate resistor, boot cap wrong if MOSFET has 30 nC or 200 nC Qg |
| `qgd` | 30 nC | MOSFET datasheet | Switching loss off by 2–5× |
| `rds_on` | 1.5 mΩ | MOSFET datasheet | Conduction loss wrong |
| `tr` | 30 ns | MOSFET datasheet | Switching loss, dead time wrong |
| `tf` | 20 ns | MOSFET datasheet | Same |
| `rth_jc` | 0.5 °C/W | MOSFET datasheet | Thermal margin could be 3× off |
| `qrr` | 44 nC | MOSFET datasheet | Recovery loss silently wrong |
| `body_diode_vf` | 0.7 V | MOSFET datasheet | Dead-time energy estimate wrong |
| `coss` | 200 pF | MOSFET datasheet | Snubber cap could be 20× wrong |
| `io_source` | 1.5 A | Driver datasheet | Rg_on wrong → wrong dV/dt |
| `io_sink` | 2.5 A | Driver datasheet | Rg_off wrong |
| `vgs_th` | 3.0 V | MOSFET datasheet | Gate plateau wrong |
| `rg_int` | 0 Ω | MOSFET datasheet | Gate series resistance underestimated |
| `td_off` | 50 ns | MOSFET datasheet | Dead time register count wrong |
| `prop_delay_off` | 60 ns | Driver datasheet | Same |
| `prop_delay_on` | 60 ns | Driver datasheet | Same |
| `pwm_deadtime_res` | 8 ns | MCU datasheet | Wrong register value |
| `pwm_deadtime_max` | 1000 ns | MCU datasheet | Wrong saturation check |
| `adc_resolution` | 12 bits | MCU datasheet | Shunt ADC SNR calculation wrong |
| `tj_max` | 175 °C | MOSFET/Driver datasheet | Thermal headroom wrong |
| `i_leakage_ua` | 3 µA | Driver quiescent | Boot cap undersized |

### Action items

**2a.** Add a `_warnings[]` list to each module output. When a fallback is used, push a warning:
```python
"warnings": ["rth_jc fallback used (0.5 °C/W) — upload MOSFET datasheet for accurate thermal margin"]
```

**2b.** In `CalculationsPanel.jsx`: Render per-module warning badges (amber) next to any result section that used a fallback. This tells the user which results are unreliable.

**2c.** Audit ESSENTIAL_IDS in `claude_service.py` — add `ciss`, `rg_int`, `qoss` which are listed as expected in `BlockPanel.jsx` but missing from the backend's essential set (so Pass 2 re-extraction never targets them):
```python
# claude_service.py line ~503
ESSENTIAL_IDS = {
    "mosfet": {
        ..., "ciss", "rg_int", "qoss"   # ADD THESE
    },
    ...
}
```

---

## 3. Calculation Formula Issues 🟡

### 3a. MOSFET Losses — `calc_mosfet_losses()`

| Issue | Current | Correct |
|-------|---------|---------|
| Modulation index hardcoded | `M = 0.9` always | Pull from `design_constants["spwm_modulation_index"]` |
| Ripple current split | 50/50 between HS/LS assumed | Correct for SPWM; document as assumption |
| Sinusoidal averaging | `sin_avg = 2/π` (half-wave) | Correct for fundamental; add note about 3rd harmonic injection |
| `qoss_loss` not returned | Calculated internally | Add to output dict as `qoss_loss_per_fet_w` |
| `coss_loss` not returned | Calculated internally | Add to output dict as `coss_loss_per_fet_w` |

### 3b. Input Capacitors — `calc_input_capacitors()`

| Issue | Current | Correct |
|-------|---------|---------|
| Power factor hardcoded | `pf = 0.85` always | Add to `design_constants` with default 0.85 |
| Bulk cap ripple limit | `1.94 A` hardcoded | Add `design_constants["bulk_cap_ripple_limit_a"]` default 2.0 A |
| MLCC DC-bias derating | 60% of rating hardcoded | Add `design_constants["mlcc_dc_bias_derating"]` default 0.5 |
| Ripple frequency | Uses `fsw` only | Should also check `2 × fsw` for 3-phase ripple cancellation |

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
| Motor copper loss derating | 1.5× hardcoded | Should use `rph_mohm` extracted param at rated `I_pk` |
| Rth_JA fallback path | Only used for "natural" cooling | Use for all modes when no heatsink configured |

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
| `ciss` | MOSFET | Logged only | Gate charge timing: `t_rise = ciss × rg_total / i_gate` (independent cross-check of `tr`) |
| `qoss` | MOSFET | Logged only | Coss switching loss: `E_qoss = qoss × v_bus` per switching event |
| `vgs_max` | MOSFET | Warning check | Driver supply voltage guard: warn if `vdrv > vgs_max × 0.9` |
| `vgs_plateau` | MOSFET | Fallback to `vgs_th + 1` | Miller plateau: feed directly into gate resistor sizing instead of estimate |
| `id_pulsed` | MOSFET | Avalanche clamp | Peak inrush check: verify `I_peak_ripple < id_pulsed` |
| `crss` | MOSFET | Miller shoot-through | dV/dt calculation: `dVdt = i_gate / crss` (more accurate than from `tr` alone) |
| `cpu_freq_max` | MCU | Not used | Dead-time register resolution cross-check |
| `adc_sample_rate` | MCU | Not used | ADC timing check: verify sample time > settling time at full signal bandwidth |
| `complementary_outputs` | MCU | Not used | Verify MCU can generate complementary PWM with correct polarity |

### Action items

**4a.** Feed `qoss` into `calc_mosfet_losses()`:
```python
qoss = self._get(self.mosfet, "MOSFET", "qoss", None)
if qoss:
    e_qoss = qoss * v_bus  # J per event
    p_qoss = e_qoss * fsw * 6  # 6 switches
    results["qoss_loss_per_fet_w"] = e_qoss * fsw
```

**4b.** Use `vgs_plateau` directly in gate resistor sizing if available (currently only used as fallback estimate from `vgs_th + 1`).

**4c.** Use `crss` for `dV/dt` calculation: `dVdt = i_gate / crss` provides a better estimate than inferred from `tr`.

**4d.** Add MCU validation sub-module:
- `cpu_freq_max` → verify PWM timer resolution at target `fsw`  
- `adc_sample_rate` → verify ADC can sample within switching dead-time window
- `complementary_outputs` → confirm MCU has enough complementary pairs for 3-phase

---

## 5. Frontend Display Gaps 🟡

### 5a. Missing result keys in CalculationsPanel.jsx

These keys are produced by `calc_engine.py` but have no corresponding display row:

| Key | Produced By | Missing From UI |
|-----|-------------|-----------------|
| `qoss_loss_per_fet_w` | mosfet_losses | Not displayed |
| `coss_loss_per_fet_w` | mosfet_losses | Not displayed |
| `motor_validation` warnings | run_all() | Not rendered as warnings |
| `transparency` dict | All modules | Not shown anywhere |
| `pcb_trace_thermal` (some keys) | calc_pcb_trace_thermal | Partial |

### 5b. Hardcoded fallback warnings never reach UI

The backend logs fallback usage but never returns it in the API response. The frontend has no way to show amber "⚠ Used fallback" badges.

**Fix**: Add `"_meta": { "fallbacks_used": [...], "hardcoded_values": [...] }` to each module output dict, then render in CalculationsPanel.

### 5c. Design constants not shown

`GET /api/design-constants` exists but the UI has no panel to view/edit them without going through SettingsModal. Users can't see what hardcoded values are driving their design.

**Fix**: Add a collapsible "Design Constants" section in SettingsModal showing all constants with their units and current values.

---

## 6. Report Generator Gaps 🟢

The PDF/Excel report is missing 8 of 12 calculation modules.

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
- Thermal interface material (if heatsink used)

### Action items

**6a.** In `report_generator.py → generate_pdf_report()`: Add a section loop — iterate over all module keys in `calculations` dict and render a generic table for any module not explicitly handled.

**6b.** In `generate_excel_report()`: Add BOM rows for bootstrap cap, EMI filter, snubber from calculation results.

---

## 7. Unit Conversion Risks 🔴

### 7a. Motor specs bypass `buildParamsDict()`

**Location**: `frontend/src/context/ProjectContext.jsx → buildCalcPayload()`

Motor specs are sent directly as `motor_specs: { rph_mohm: 12, lph_uh: 50, ... }` without going through the unit conversion pipeline that mosfet/driver/mcu params use.

In `calc_engine.py`, motor params are accessed as:
```python
rph = self._get(self.motor, "MOTOR", "rph_mohm", ...)
```
But `self.motor` is the raw dict from frontend with no `__unit` keys, so `_get()` calls `to_si()` with empty string unit — which returns raw value unchanged.

**This works only because** the unit is hardcoded in the key name (`rph_mohm` = mΩ implied). If a user enters kΩ thinking the field accepts it, the value is 1000× wrong with no error.

**Fix**: Either:
1. Add unit labels to motor form fields (lock to mΩ / µH) so user can't enter wrong scale, OR
2. Pass motor specs through `buildParamsDict()` with `__unit` keys like all other params

### 7b. No SI bounds validation after conversion

After `to_si()`, there is no bounds check. If `rds_on` comes in as 0.001 Ω (1 mΩ) vs 1 Ω, the calc silently uses it. A wrong unit from extraction produces wildly wrong losses with no warning.

**Fix**: Add per-param SI sanity bounds in calc_engine:
```python
PARAM_BOUNDS_SI = {
    "rds_on":   (1e-5,  1.0),   # 10 µΩ to 1 Ω
    "qg":       (1e-9,  1e-6),  # 1 nC to 1 µC
    "rth_jc":  (0.01,  10.0),  # 10 mK/W to 10 K/W
    # ...
}
```

---

## 8. Missing E-Series Snapping 🟢

| Value | Current | Fix |
|-------|---------|-----|
| Shunt capacitor `C_shunt` | Not snapped | Snap to E12 pF |
| TVS clamp voltage | Hardcoded suggestions | Snap to nearest standard TVS voltage (5.1, 6.2, 6.8, 8.2, 9.1, 10, 12, 15, 18, 20, 22, 24, 27, 30, 33, 36, 43, 51, 58, 62, 68 V) |
| OTP NTC R_series | Not snapped | Snap to E24 |
| Bootstrap cap | Snapped to E12 ✅ | Done |
| Gate resistors | Snapped to E24 ✅ | Done |

---

## 9. Pass-2 Re-Extraction — ESSENTIAL_IDS Gaps 🟡

**Location**: `backend/claude_service.py` — `ESSENTIAL_IDS` dict

The following params are in `BlockPanel.jsx EXPECTED_PARAMS` (shown as "Missing" in UI when absent) but NOT in `ESSENTIAL_IDS` (so Pass-2 re-extraction never targets them):

```python
# Currently missing from ESSENTIAL_IDS["mosfet"]:
"ciss"      # Input capacitance — needed for gate timing cross-check
"rg_int"    # Internal gate resistance — subtracts from external Rg budget

# Currently missing from ESSENTIAL_IDS["driver"]:
"deadtime_min"     # Minimum dead time — safety check
"deadtime_default" # Default dead time

# Currently missing from ESSENTIAL_IDS["mcu"]:
"pwm_deadtime_res"  # Dead-time register resolution
"pwm_deadtime_max"  # Maximum dead time
```

**Fix**: Add all the above to `ESSENTIAL_IDS` and bump `PROMPT_VERSION` to `v13-gemini` to invalidate cache.

---

## 10. Dead Code / Unintegrated Features 🟢

| Feature | Location | Status | Fix |
|---------|----------|--------|-----|
| `reverse_calculate()` | backend/main.py | Endpoint exists, frontend calls partially wired | Complete reverse target UI for gate rise time, bootstrap cap |
| `transparency` / `_log_hc()` | calc_engine base | Built, NOT shown in UI | Add to CalculationsPanel as collapsible "How this was calculated" |
| `waveform.py` | backend/calculations/waveform.py | 612 lines, NOT called in run_all() | Integrate into run_all() or document as frontend-only |
| `spice_export.py` | backend/spice_export.py | Endpoint exists at `/api/export/spice` | Add export button in UI |
| Design constants API | `GET /api/design-constants` | Endpoint exists, frontend never calls it | Render in SettingsModal |

---

## 11. Prompt Improvements (Extraction Quality) 🟡

Based on the visual PDF verification sessions:

### 11a. MOSFET prompt
- ✅ Rule 10 (condition objects only) — fixed
- Add: Extract `crss` more reliably — it appears in "Capacitances" table as "Reverse Transfer Capacitance"
- Add: For `vgs_plateau`, look in gate charge curve graph description, not just tables

### 11b. Gate Driver prompt  
- ✅ Rule 10 (HO/LO split) — fixed
- Add: `deadtime_min` and `deadtime_default` are often in a separate "Shoot-through protection" table; look there explicitly

### 11c. MCU prompt
- ✅ `cpu_freq_max` multi-condition note — fixed
- Add: `adc_sample_rate` — look in "ADC10 Timing" section for `t_conv` (conversion time), convert to KSPS
- Add: `pwm_deadtime_res` — look for "Dead-Time Generator" register description with step size in ns

---

## 12. Calculation Module — New Outputs Needed 🟡

### 12a. Add "Motor Compatibility" module (replaces old "Motor Operating Point")

> **See Section 1 design principle — this module is read-only validation, not a sizing input.**

New output block, derives operating point from motor specs and checks against already-sized PCB:

```
i_pk_motor       = T_rated / Kt                     # motor's actual peak current demand
f_electrical_hz  = (RPM × pole_pairs) / 60          # electrical frequency at max speed
back_emf_at_max  = Ke × (max_speed_rpm / 1000)      # back-EMF at max RPM [V]
bus_headroom_v   = V_bus - back_emf_at_max          # voltage margin [V]
current_margin   = max_phase_current - i_pk_motor   # PCB headroom over motor demand [A]
```

**Output is compatibility flags only — nothing feeds back into component calculations.**
`max_phase_current` from `system_specs` remains the sole design basis for all sizing.

### 12b. Add ADC timing validation output

```
adc_settling_time_ns  = 1 / adc_sample_rate × 1e9
dead_time_ns          = (from dead_time module)
adc_fits_in_dead_time = adc_settling_time_ns < dead_time_ns
```

### 12c. Add dV/dt output

```
dvdt_on_v_per_ns   = v_bus / tr        # during turn-on
dvdt_off_v_per_ns  = v_bus / tf        # during turn-off
dvdt_limit_ok      = dvdt < 50 V/ns   # typical EMC guideline
```

---

## Recommended Fix Order

### Phase 1 — Correctness (do first, high impact)

1. **Motor params → I_peak** (#1a): Replace system_specs current with kt-derived current
2. **Fallback warnings** (#2a, 2b): Surface hardcoded values to UI so user knows when to trust results
3. **ESSENTIAL_IDS gaps** (#9): Ensure Pass-2 re-extraction targets ciss, rg_int, deadtime params
4. **Unit bounds validation** (#7b): Add SI sanity bounds to prevent silent 1000× errors
5. **qoss / crss usage** (#4a, 4c): Feed extracted params into calculations

### Phase 2 — Accuracy (second priority)

6. **Design constants** (#3a–3f): Replace hardcoded values with configurable constants
7. **Missing calc outputs** (#5a): Add qoss_loss, coss_loss, body_diode_loss to display
8. **Motor specs unit safety** (#7a): Lock motor form fields to specific units
9. **Pass-2 ESSENTIAL_IDS** (#9): Add missing essential params

### Phase 3 — Completeness (polish)

10. **Report generator** (#6): Add missing 8 sections to PDF/Excel
11. **E-series snapping** (#8): Snap TVS, shunt cap to standard values
12. **SPICE export UI** (#10): Add export button for SPICE netlist
13. **Design constants UI** (#10): Render in SettingsModal
14. **Motor operating point module** (#12a): New output block

---

## Files to Touch (by fix)

| Fix | Backend File | Frontend File |
|-----|-------------|---------------|
| #1 Motor → I_peak | calc_engine.py (mosfet module) | — |
| #2 Fallback warnings | calc_engine.py (base _get) | CalculationsPanel.jsx |
| #3 Design constants | calc_engine.py (DESIGN_CONSTANTS) | SettingsModal.jsx |
| #4 Use qoss/crss | calc_engine.py (mosfet module) | CalculationsPanel.jsx |
| #5 Display gaps | — | CalculationsPanel.jsx |
| #6 Report | report_generator.py | — |
| #7 Unit bounds | unit_utils.py or calc_engine.py base | ProjectContext.jsx (motor form) |
| #8 E-series | calc_engine.py (protection module) | — |
| #9 ESSENTIAL_IDS | claude_service.py | — |
| #10 Dead code | main.py, calc_engine.py | App.jsx, SettingsModal.jsx |
| #11 Prompts | claude_service.py | — |
| #12 New modules | calc_engine.py (new file) | CalculationsPanel.jsx |

---

## 13. Formula-Level Bugs & Wrong Defaults 🔴

Deep audit of every formula vs. textbook. Items marked ✓ are **confirmed correct**.

### 13a. Confirmed-correct formulas (no action needed)

| Formula | Module | Verdict |
|---------|--------|---------|
| Conduction loss `I_rms² × Rds_hot` | mosfet.py | ✓ Correct |
| Switching loss `Vbus × I × (tr+tf) × fsw / π` | mosfet.py | ✓ Correct (linear V/I overlap, π is sinusoidal avg) |
| RMS current `√(1/8 + M/(3π))` | mosfet.py | ✓ Correct (Mohan textbook 3-phase SPWM) |
| Ripple current `Vbus×0.25 / (Lph×fsw)` | mosfet.py | ✓ Correct (worst case D=0.5, factor 0.25) |
| Ripple RMS conversion `/2√3` | mosfet.py | ✓ Correct (triangular wave) |
| Gate rise time `Rg × Qgd / (Vdrv − Vpl)` | gate_drive.py | ✓ Correct |
| dV/dt `= Vbus / t_rise` | gate_drive.py | ✓ Correct |
| Miller current `Crss × dV/dt` | gate_drive.py | ✓ Correct |
| Bootstrap charge `Q_total / ΔV_droop` | gate_drive.py | ✓ Correct |
| Bootstrap refresh `−τ × ln(0.05) = 3τ` | gate_drive.py | ✓ Elegant and correct |
| Dead time sum `td_off + tf + t_prop + t_drv + margin` | gate_drive.py | ✓ Correct |
| Ripple RMS (3-phase Kolar) | passives.py | ✓ Correct |
| Bulk cap `I_max / (4 × fsw × ΔV)` | passives.py | ✓ Correct |
| Snubber `f_res = 1/(2π√LC)` | passives.py | ✓ Correct |
| Overshoot `V = I × √(L/C)` | passives.py | ✓ Correct |
| Snubber power `0.5 × Cs × Vpeak² × fsw` | passives.py | ✓ Correct |
| Thermal chain `Tj = Tamb + P×(Rjc+Rcs+Rsa)` | thermal.py | ✓ Correct |
| Ring frequency `1/(2π√(Lstray×Coss))` | waveform.py | ✓ Correct |
| Ring damping `τ = Q/(πf)` (backend) `ζ = R/(2√(L/C))` (frontend) | waveform.py + WaveformPanel | ✓ **Both consistent** (same physics, different parameterisation) |
| Ring amplitude `A = I × √(L/C)` | waveform.py | ✓ Correct |
| Vgs plateau `= Vth + Id/gm` | waveform.py | ✓ Correct and sophisticated |
| Body diode loss `Vf × I × sin_avg × dt × fsw × 2 / 2` | mosfet.py | ✓ Correct |
| Coss loss `0.5 × Qoss × Vbus × fsw` | mosfet.py | ✓ Correct |
| Gate power `Qg × Vdrv × fsw` | mosfet.py | ✓ Correct |

### 13b. Genuine formula issues found

**Issue 1 — Tj iteration has no convergence check** 🟡  
`mosfet.py`: Loops exactly 5 times regardless of convergence.  
If `|ΔTj| > 0.1°C` between iterations 4→5, result is not converged.  
**Fix**: Replace `for _ in range(5)` with convergence criterion:
```python
for _ in range(20):
    ...
    if abs(tj_new - tj_prev) < 0.1:
        break
    tj_prev = tj_new
```

**Issue 2 — Turn-on dead time path not separately validated** 🟡  
`gate_drive.py`: Only the turn-off path (td_off + tf + t_prop_off) is used to size dead time.  
Turn-on path (td_on + tr + t_prop_on) may be longer for asymmetric drivers.  
**Fix**: Compute both, take max:
```python
dt_turnoff = td_off + tf + t_prop_off + drv_fall + margin
dt_turnon  = td_on  + tr + t_prop_on  + drv_rise + margin
dt_min = max(dt_turnoff, dt_turnon)
```

**Issue 3 — Switching loss uses LINEAR approximation only** 🟢  
`mosfet.py`: The `/π` overlap model is linear rise/fall. Real RC-charged transitions are nonlinear.  
The Qgd-based model (already implemented) is more accurate.  
**Fix**: Log a note in output when falling back to linear model. The Qgd model should be preferred when `qgd` is extracted.

**Issue 4 — Rds(on) temperature coefficient α hardcoded to 2.1** 🟡  
`mosfet.py line 124`: `alpha_rds = 2.1` for all technologies.  
Si planar: 2.0–2.3 ✓. Trench Si: 2.2–2.5. SiC MOSFET: **0.3–0.5** (catastrophically wrong for SiC).  
**Fix**: Add `thermal.rds_alpha` to DESIGN_CONSTANTS (default 2.1), user-overridable for SiC.

**Issue 5 — Ringing Q factor hardcoded to 8** 🟡  
`waveform.py`: `Q_ring = 8.0` always.  
High-inductance PCBs (L > 10nH) or low-resistance packages can have Q = 15–20, causing severe ringing underestimation.  
**Fix**: Add `snub.ring_q_factor` to DESIGN_CONSTANTS (default 8.0).

**Issue 6 — No multi-cycle ringing superposition** 🟢  
`WaveformPanel.jsx` + `waveform.py`: Each switching event resets ring to zero.  
If ring from event N hasn't decayed before event N+1, amplitudes should superimpose.  
**Fix**: Track residual ring amplitude at end of each period; add to next period's initial ring.

**Issue 7 — Snubber response time not validated** 🟡  
Snubber `τ = Rs × Cs` must satisfy `3τ < 0.5 / fsw` (must damp before next switch).  
Code computes Rs and Cs but never checks this.  
**Fix**: Add in `calc_snubber()`:
```python
tau_snub = rs_ohm * cs_f
t_half_period = 0.5 / self.fsw
if 3 * tau_snub > t_half_period:
    results["snubber_too_slow"] = True
    results["warnings"].append("Snubber RC too slow — ring may not damp before next event")
```

**Issue 8 — Vds_max overshoot check silent** 🔴  
`waveform.py line 234`: `v_overshoot_off = min(v_overshoot_off, _vds_cap)` silently clamps.  
If ringing hits Vds_max × 0.9, MOSFET is in avalanche danger zone. No explicit warning returned.  
**Fix**: Add to waveform output:
```python
if v_overshoot_off >= vds_max * 0.85:
    results["vds_overshoot_danger"] = True
    results["warnings"].append(
        f"⚠ Ring overshoot {v_overshoot_off:.0f}V ≥ 85% of Vds_max {vds_max:.0f}V — add snubber or reduce stray inductance"
    )
```

---

## 14. Wrong DESIGN_CONSTANTS Defaults 🔴

These defaults are **factually incorrect** for a 48V/3kW PMSM application and will produce wrong results even when all datasheets are uploaded correctly.

| Constant | Current Default | Correct Default | Impact if Wrong |
|----------|----------------|-----------------|-----------------|
| `gate.bootstrap_vf` | **1.0 V** | **0.6 V** | Bootstrap cap oversized 20%; Vbs budget wrong | 
| `waveform.driver_temp_derate_per_c` | **0.001 1/°C** | **0.003 1/°C** | Gate drive current at Tj=125°C overestimated by 2× |
| `input.esr_per_cap` | **50 mΩ** | **80 mΩ** | Ripple voltage and cap count underestimated |
| `boot.safety_margin` | **2.0×** | **1.5×** | Bootstrap cap oversized 33% unnecessarily |
| `thermal.rth_sa` | **20 °C/W** | **10 °C/W** (forced air) | At 50W FET loss: ΔT error = 500°C (absurd) |

**Also questionable:**

| Constant | Default | Why questionable |
|----------|---------|-----------------|
| `input.spwm_mod_index` | 0.9 | Should derive from `Ke × max_RPM / Vbus`, not hardcoded |
| `snub.ring_q_factor` | — (missing, hardcoded 8.0) | Should be design constant, Q=8 ok for 48V but Q=15 for high-L layouts |
| `thermal.rds_alpha` | — (missing, hardcoded 2.1) | SiC users get 5–7× wrong Rds derating |
| `adc.max_duty_cycle` | 0.90 | **Never read by any module** — dead constant, remove or use it |

### Action: Add missing design constants to `base.py`

```python
DESIGN_CONSTANTS = {
    ...
    # NEW — fix hardcoded values:
    "snub.ring_q_factor":          (8.0,   "(none)", "Snubber",  "Ring Q factor",   "PCB layout Q factor for LC ringing model. Typical: 8 (48V), 12 (SiC), 15 (high-L)"),
    "thermal.rds_alpha":           (2.1,   "(none)", "Thermal",  "Rds temp exponent","Power-law α for Rds(Tj): Rds_hot = Rds25 × (Tj/298)^α. Si=2.1, SiC=0.4"),
    "gate.driver_derating_per_c":  (0.003, "1/°C",  "Gate",     "Driver IO derating","Driver source/sink current derating per °C. Typical: 0.3%/°C for most ICs"),
}
```

And fix existing defaults:
```python
"gate.bootstrap_vf":       (0.6,  "V",   "Gate", "Bootstrap diode Vf",    "..."),  # was 1.0
"boot.safety_margin":      (1.5,  "x",   "Boot", "Bootstrap safety mult", "..."),  # was 2.0
"input.esr_per_cap":       (80,   "mΩ",  "Caps", "ESR per bulk cap",      "..."),  # was 50
"waveform.driver_temp_derate_per_c": (0.003, ...),  # was 0.001
```

---

## 15. Missing Calculation Modules 🟡

Modules that are needed for a complete design but don't exist yet.

| Module | What It Does | Priority | New File |
|--------|-------------|----------|----------|
| **Gate drive IC thermal** | Split gate power → Rg_external vs driver IC; check Tj of driver | 🔴 High | gate_drive.py (extend) |
| **MOSFET SOA check** | Is switching time within datasheet SOA boundary at (Vds, Id)? | 🔴 High | mosfet.py (extend) |
| **Shoot-through current** | If dt < trr, compute peak shoot-through vs avalanche rating | 🔴 High | gate_drive.py (extend) |
| **Vds overshoot validation** | Already computed; add explicit danger flag to output | 🔴 High | waveform.py (1 line) |
| **ADC current loop bandwidth** | fsw_pwm ripple vs ADC sample rate; alias check | 🟡 Medium | passives.py (extend) |
| **EMI DM noise estimate** | `V_dm = fsw × L_stray × di/dt`; check against CISPR limit | 🟡 Medium | new: emi_dm.py |
| **Derating curves** | Sweep T_amb 0→125°C; output safe I_max at each | 🟡 Medium | new: derating.py |
| **Motor compatibility check** | Derive motor's I_peak from Kt + Torque; validate against PCB's `max_phase_current` — read-only, does NOT feed into loss calcs (see §1 design principle) | 🟡 Medium | new: motor_compat.py |

### Gate drive IC thermal (most critical missing module)

```python
# In gate_drive.py, add to output of calc_gate_resistors():
rg_ext_fraction = rg_on_std / (rg_on_std + rg_int)
p_rg_on  = (1/3) * qg * v_drv * fsw * rg_ext_fraction
p_rg_off = (1/3) * qg * v_drv * fsw * (rg_off_std / (rg_off_std + rg_int))
p_driver_gate = qg * v_drv * fsw - p_rg_on - p_rg_off   # driver IC dissipation
tj_driver = t_amb + p_driver_gate * rth_ja_driver          # driver junction temp
```

### MOSFET SOA check

```python
# Switching time from waveform module
t_switch = tr + tf  # total Vds transition time
# Linear SOA boundary: MOSFET can sustain Vds for duration t_switch
# If no SOA data: use rule-of-thumb t_SOA < 1µs at V=Vds_max
soa_pass = t_switch < soa_time_limit  # typically 1µs
```

### Shoot-through current

```python
if dt_actual_ns < trr_ns:
    i_shoot_peak = qrr * self.v_bus / (ls_loop * self.i_max)  # rough estimate
    if i_shoot_peak > id_pulsed:
        results["warnings"].append("⚠ Dead time < trr: shoot-through risk — Id,shoot > Id,pulse rating")
```

---

## 16. API Key Management & Error Handling — Remaining Gaps ⏳

### 16a. 🚫 Decided NOT to implement (user choice, 2026-04-23)

| Item | Reason skipped |
|------|---------------|
| 429 type distinction (RPM vs daily quota) — retry same key for RPM, rotate for quota | Added complexity, user chose not to implement |
| Comparison tab stop-on-quota-exhaustion — stop loop when all keys return 429 | Added complexity, user chose not to implement |
| Pass 2 disable option in comparison mode — save API calls at cost of less accuracy | Added complexity, user chose not to implement |

### 16b. ⏳ Still pending — error handling gaps found in audit

| File | Issue | Severity | Effort |
|------|-------|----------|--------|
| `report_generator.py` | No try/catch around `doc.build(story)` — any bad cell value crashes with raw ReportLab traceback | 🟡 | S |
| `report_generator.py` | `None` values in cells crash ReportLab — add `str(v) if v is not None else "—"` in `_make_table()` | 🔴 | S |
| `spice_export.py` | Out-of-bounds parameter clamping is silent — user gets wrong SPICE netlist with no warning | 🟡 | S |
| `App.jsx` | Lazy-loaded panel that fails to import shows "Loading panel…" forever — add error boundary with "Failed to load, refresh" | 🟢 | S |
| `CalculationsPanel.jsx` | `uvloDataBadgeInfo()` returns `undefined` for unknown status — `.label` access crashes | 🔴 | S |
| `ComparisonPanel.jsx` | `convertUnit()` returns raw value for unsupported target unit — silently wrong in comparison table | 🟡 | S |

### 16c. ⏳ API key UX improvements (not yet implemented)

| Item | Value | Effort |
|------|-------|--------|
| Show per-key status in Settings (cached / active / quota-exhausted) | User knows which key to replace | M |
| Pre-run API call estimate in ComparisonPanel before hitting Run | "~12 API calls needed (6 uncached × 2 passes)" | S |
| Key health check button — test each key with a tiny request, show ✅/❌ | User can validate keys before extraction | M |

---

## Updated Fix Order (incorporating formula audit)

### Phase 1 — Critical correctness (do first)

1. **Fix wrong DESIGN_CONSTANTS defaults** (#14): bootstrap_vf, ESR, boot safety, driver derating
2. **Add missing design constants** (#14): ring Q factor, Rds alpha, driver derating
3. **Vds overshoot explicit warning** (#13 Issue 8): 1-line addition in waveform.py
4. **Snubber response time check** (#13 Issue 7): Add 3τ < T/2 validation
5. ~~**Motor params → I_peak**~~ → **Motor Compatibility block** (#1c): New read-only validation module — does NOT replace `max_phase_current` in any calculation
6. **Fallback warnings to UI** (#2a, 2b): Surface fallback usage as amber warning badges
7. **Tj convergence criterion** (#13 Issue 1): Replace fixed-iteration loop

### Phase 2 — Accuracy

8. **Dead time turn-on path** (#13 Issue 2): Compute both paths, take max
9. **Rds α as design constant** (#14): For SiC MOSFET support
10. **Ring Q as design constant** (#14): For high-inductance layouts
11. **Gate drive IC thermal** (#15): Split gate power into Rg vs driver IC
12. **MOSFET SOA check** (#15): Switching time vs SOA boundary
13. **Shoot-through current** (#15): Dead-time inadequacy consequence
14. **ESSENTIAL_IDS gaps** (#9): ciss, rg_int, deadtime params in Pass-2

### Phase 3 — Completeness

15. **ADC current loop bandwidth** (#15): Alias check for ripple frequency
16. **EMI DM noise module** (#15)
17. **Derating curves** (#15)
18. **Motor operating point output block** (#12a)
19. **Report generator** (#6): 8 missing sections
20. **Multi-cycle ringing** (#13 Issue 6): Frontend accumulation

---

## Summary Stats

| Category | Issues Found | Critical | Medium | Low | Status |
|----------|-------------|----------|--------|-----|--------|
| Formula correctness | 8 | 2 | 5 | 1 | ⏳ Pending |
| Wrong DC defaults | 5 | 3 | 2 | 0 | ⏳ Pending |
| Missing DC constants | 4 | 2 | 2 | 0 | ⏳ Pending |
| Missing modules | 8 | 3 | 4 | 1 | ⏳ Pending |
| Motor params unused | 6 | 2 | 3 | 1 | ⏳ Pending |
| Hardcoded fallbacks | 21 | 12 | 7 | 2 | ⏳ Pending |
| Display/report gaps | 10 | 0 | 5 | 5 | ⏳ Pending |
| API key management | 16 | 2 | 6 | 8 | ✅ 16 done · ⏳ 6 pending · 🚫 3 skipped |
| Error handling | 6 | 2 | 3 | 1 | ⏳ Pending (§16b) |
| **Total** | **84** | **28** | **37** | **19** | |

### Completion as of 2026-04-23
- ✅ **16 items completed** (all API/error handling from 2026-04-23 session)
- 🚫 **3 items decided not to implement** (429 distinction, comparison stop, Pass 2 toggle)
- ⏳ **65 items remaining** across phases 1–3

---

*End of plan — updated total estimated effort: ~55–70 hours for remaining phases.*

