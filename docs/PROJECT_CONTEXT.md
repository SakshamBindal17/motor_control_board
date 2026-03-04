# MC Hardware Designer v2 — Complete Project Context

> **Purpose of this document:** Full context for any developer or LLM to understand, continue, and extend this project from scratch. Every architectural decision, data flow, file, bug fix, and design choice is documented here.

---

## 1. Project Overview

**What it is:** A web application for hardware engineers designing 48V / 3kW Permanent Magnet Synchronous Motor (PMSM) controllers. The engineer uploads datasheets (PDF) for the three main ICs in their design — MOSFET, Gate Driver, and MCU — and the app uses Claude AI to extract all electrical parameters, then runs a full suite of passive-component calculations (gate resistors, capacitors, snubbers, thermal, dead time, EMI filter, etc.) and generates a design report.

**Target user:** Power electronics / motor controller hardware engineer designing a 3-phase inverter for a PMSM motor drive.

**Core system specs the app is designed around (defaults, all editable):**
- Bus voltage: 48V
- Peak voltage: 60V
- Power: 3000W
- Max phase current: 80A
- PWM frequency: 20 kHz
- Ambient temperature: 30°C
- Gate drive voltage: 12V
- Motor type: PMSM, control mode: FOC (Field Oriented Control)
- Cooling: natural convection
- PCB: 6 layers

---

## 2. Tech Stack

### Backend
| Item | Detail |
|------|--------|
| Language | Python 3.12 |
| Framework | FastAPI 0.110.0 |
| Server | Uvicorn 0.27.0 with `--reload` |
| AI | Anthropic Python SDK 0.21.3 — Claude Haiku (`claude-haiku-4-5-20251001`) |
| PDF feature | `anthropic-beta: pdfs-2024-09-25` header (NOT `.beta.messages` — see bug section) |
| Reports | ReportLab 4.1.0 (PDF), openpyxl 3.1.2 (Excel) |
| HTTP client | httpx **pinned at 0.27.2** (0.28+ removed `proxies` arg, breaks Anthropic SDK) |
| Validation | Pydantic 2.6.3 |

### Frontend
| Item | Detail |
|------|--------|
| Framework | React 18.3.1 |
| Build tool | Vite 5.4.2 (port 5173) |
| State | React `useReducer` via Context API (no Redux) |
| UI icons | lucide-react 0.441.0 |
| Charts | recharts 2.12.7 |
| File upload | react-dropzone 14.2.3 |
| Notifications | react-hot-toast 2.4.1 |
| Styling | Custom CSS variables (dark/light theme) + minimal Tailwind |

### Dev Environment
- Windows (user's machine)
- Two terminals required simultaneously:
  - **Terminal 1:** `cd backend && uvicorn main:app --reload --port 8000`
  - **Terminal 2:** `cd frontend && npm run dev`
- Vite proxies all `/api/*` requests to `http://localhost:8000`

---

## 3. Project File Structure

```
mc-designer-v2/
├── backend/
│   ├── main.py                  # FastAPI app, 3 route groups
│   ├── claude_service.py        # AI extraction + disk cache
│   ├── calc_engine.py           # All 12 calculation modules
│   ├── unit_utils.py            # SI unit normalization
│   ├── report_generator.py      # PDF + Excel report generation
│   ├── requirements.txt         # Pinned Python deps
│   └── cache/                   # Auto-created at runtime
│       ├── mosfet/              # SHA-256 keyed JSON cache files
│       ├── driver/
│       └── mcu/
│
└── frontend/
    ├── vite.config.js           # Proxy /api → localhost:8000
    ├── package.json
    ├── index.html
    └── src/
        ├── main.jsx             # React root
        ├── App.jsx              # BLOCK_CONFIGS + router
        ├── api.js               # All fetch helpers
        ├── index.css            # Full CSS variables + component styles
        ├── utils.js             # Misc helpers
        ├── context/
        │   └── ProjectContext.jsx   # Global state, all reducer actions
        └── components/
            ├── Header.jsx           # Top bar, save/load/report buttons
            ├── Sidebar.jsx          # Left nav with block icons
            ├── BlockPanel.jsx       # Upload + param table + missing params
            ├── ParameterTable.jsx   # Interactive parameter display
            ├── UnitPicker.jsx       # Searchable unit dropdown (NEW)
            ├── CalculationsPanel.jsx# Right panel, runs/shows calculations
            ├── PassivesPanel.jsx    # Manual passives overrides
            ├── MotorForm.jsx        # Motor specs manual entry
            ├── FeedbackPanel.jsx    # Sensing chain config
            ├── SettingsModal.jsx    # API key + theme settings
            └── ReportPanel.jsx      # Generate PDF/Excel report
```

---

## 4. Application Architecture

### 4.1 Block System

The app is organized around 6 "blocks" defined in `App.jsx → BLOCK_CONFIGS`:

| Key | Type | Description |
|-----|------|-------------|
| `mcu` | upload | Microcontroller — upload PDF, AI extracts params |
| `driver` | upload | Gate Driver IC — upload PDF, AI extracts params |
| `mosfet` | upload | Power MOSFETs — upload PDF, AI extracts params |
| `motor` | motor | PMSM motor — manual entry form |
| `passives` | passives | Passive components — auto-calculated, overridable |
| `feedback` | feedback | Sensing chain config |

Each block config has: `key`, `label`, `fullLabel`, `icon`, `color`, `type`, `extractionType`, `desc`.

The active block is tracked in global state (`active_block`). `App.jsx` renders the appropriate panel component based on `cfg.type`.

**Critical:** `BlockPanel.jsx` always uses `blockKey` (the prop) as the extraction type in API calls — NOT `config.extractionType`. This was a bug (stale closure) where uploading a gate driver PDF would call `/api/extract/mcu` instead of `/api/extract/driver`.

### 4.2 Global State Shape (ProjectContext)

```javascript
{
  settings: {
    api_key: '',          // Anthropic API key (user enters in Settings)
    theme: 'dark',        // 'dark' | 'light'
    model: 'claude-haiku-4-5-20251001',
  },
  project: {
    name: 'Untitled MC Project',
    system_specs: { bus_voltage, peak_voltage, power, max_phase_current,
                    pwm_freq_hz, ambient_temp_c, gate_drive_voltage,
                    motor_type, control_mode, cooling, pcb_layers },
    blocks: {
      mcu:     { status, filename, raw_data, selected_params, error },
      driver:  { status, filename, raw_data, selected_params, error },
      mosfet:  { status, filename, raw_data, selected_params, error },
      motor:   { specs: { type, max_speed_rpm, pole_pairs, rph_mohm,
                           lph_uh, kt_nm_per_a, rated_torque_nm, back_emf_v_per_krpm } },
      passives:{ overrides: {}, calculated: null },
      feedback:{ calculated: null },
    },
    calculations: null,   // output from /api/calculate
    last_saved: null,
  },
  active_block: 'mcu',
  settings_open: false,
  report_open: false,
}
```

**Block statuses:** `idle` → `uploading` → `extracting` → `done` | `error`

**`raw_data` shape** (what Claude returns, stored per block):
```javascript
{
  component_name: "IRF540N",
  manufacturer: "Infineon",
  component_type: "MOSFET",    // or "GATE_DRIVER" or "MCU"
  package: "TO-220AB",
  description: "N-channel MOSFET, 100V, 33A",
  parameters: [
    {
      id: "rds_on",
      name: "On-Resistance",
      symbol: "Rds(on)",
      category: "Electrical",
      conditions: [
        {
          condition_text: "VGS=10V, ID=33A, TJ=25°C",
          note: null,               // or full footnote text if footnote ref in datasheet
          min: null,
          typ: 44,
          max: null,
          unit: "mΩ",
          selected: 44,             // added by backend after extraction
          override: null,           // added by backend after extraction
        }
      ]
    }
  ]
}
```

**`selected_params` shape:**
```javascript
{
  "rds_on": { condition_index: 0, override: null },
  "qg":     { condition_index: 1, override: null },
  "tr":     { condition_index: 0, override: 35 },   // user set 35 manually
}
```

### 4.3 All Reducer Actions

| Action | Payload | What it does |
|--------|---------|--------------|
| `SET_SETTINGS` | partial settings obj | Merge into settings |
| `SET_ACTIVE_BLOCK` | blockKey string | Switch active tab |
| `TOGGLE_SETTINGS` | — | Open/close settings modal |
| `TOGGLE_REPORT` | — | Open/close report panel |
| `SET_BLOCK_STATUS` | `{block, status, error?}` | Update block status |
| `SET_BLOCK_DATA` | `{block, filename, raw_data}` | Store AI extraction result, build default selections |
| `SET_PARAM_SELECTION` | `{block, param_id, condition_index}` | User picks which test condition to use |
| `SET_PARAM_OVERRIDE` | `{block, param_id, override}` | User manually types a value |
| `SET_PARAM_UNIT` | `{block, param_id, cond_idx, unit}` | User edits a unit string on any condition |
| `SET_MANUAL_PARAM` | `{block, param_id, value, unit}` | Injects a synthetic param for a missing one |
| `DELETE_MANUAL_PARAM` | `{block, param_id}` | Removes a manually-entered param (returns it to missing list) |
| `SET_MOTOR_SPECS` | partial motor specs | Update motor form fields |
| `SET_SYSTEM_SPECS` | partial system specs | Update system-level specs |
| `SET_PASSIVES_OVERRIDE` | `{key, value}` | Override one passive component value |
| `SET_CALCULATIONS` | calculations dict | Store results from /api/calculate |
| `SET_PROJECT_NAME` | string | Rename project |
| `LOAD_PROJECT` | full project obj | Load from JSON file |
| `RESET_BLOCK` | blockKey | Reset a block to idle/empty |

**Persistence:** Only `settings` (API key + theme) is persisted to `localStorage`. The full project state is NOT auto-saved — user must manually save (downloads JSON).

---

## 5. Data Flow: PDF Upload → Calculations

```
User drops PDF on BlockPanel
        ↓
doExtract(file) — uses blockKey (NOT config.extractionType)
        ↓
api.js → POST /api/extract/{blockKey}
         Headers: { X-API-Key: user_api_key }
         Body: FormData with file
        ↓
backend/main.py → extract_datasheet()
        ↓
claude_service.py → extract_parameters_from_pdf(pdf_bytes, block_type, api_key)
        ↓
  1. Compute SHA-256 hash of pdf_bytes
  2. Check cache/{block_type}/{hash}.json — if found, return immediately (_from_cache: true)
  3. If not cached: base64-encode PDF, call Claude API
     - Model: claude-haiku-4-5-20251001
     - max_tokens: 16000
     - extra_headers: {"anthropic-beta": "pdfs-2024-09-25"}
     - Prompt selects MOSFET_PROMPT / DRIVER_PROMPT / MCU_PROMPT
  4. Strip markdown fences from response
  5. JSON.parse response
  6. Post-process: add selected + override fields to each condition
  7. Save to cache
  8. Return data
        ↓
frontend: dispatch SET_BLOCK_DATA
  - stores raw_data in project.blocks[blockKey].raw_data
  - calls _buildDefaultSelections(raw_data) → selected_params
    (every param gets condition_index:0, override:null by default)
        ↓
BlockPanel renders ParameterTable grouped by category
        ↓
User reviews params, selects conditions, optionally overrides values / edits units
        ↓
CalculationsPanel → user clicks "Run Calculations"
        ↓
api.js → POST /api/calculate
  Body: {
    system_specs,
    mosfet_params: buildParamsDict(mosfet_block),   // flat {id: value, id__unit: unit}
    driver_params: buildParamsDict(driver_block),
    mcu_params:    buildParamsDict(mcu_block),
    motor_specs,
    passives_overrides,
  }
        ↓
backend/calc_engine.py → CalculationEngine.run_all()
  - _get(params, key) reads value + __unit key, calls to_si() for automatic SI conversion
  - Returns 12 calculation modules
        ↓
frontend: dispatch SET_CALCULATIONS, CalculationsPanel displays results
```

### 4.4 buildParamsDict (frontend → backend)

`ProjectContext.jsx → buildParamsDict(block_state)` builds the flat dict sent to `/api/calculate`:

```javascript
// For each parameter, sends TWO keys:
result["rds_on"]        = 1.5      // raw numeric value (in datasheet units)
result["rds_on__unit"]  = "mΩ"    // unit string
// If user has an override, the override value replaces the selected value
```

The backend `_get()` function reads both keys and calls `unit_utils.to_si(value, unit)` to convert to SI before any math.

---

## 6. Backend: claude_service.py

### Prompts

Three prompts — one per block type. All share the same rules:

1. Return ONLY valid JSON (no markdown fences, no preamble)
2. **Footnote resolution:** If a condition references `(1)`, `(2)`, `(*)` etc., look up the footnote and write its full text into the `"note"` field. Keep `condition_text` short (actual test conditions only).
3. Essential parameters only — ~16-17 per block type
4. 1-3 conditions per parameter (most relevant)

**MOSFET parameters extracted:** `vds_max`, `id_cont`, `rds_on`, `vgs_th`, `qg`, `qgd`, `qgs`, `qrr`, `trr`, `coss`, `td_on`, `tr`, `td_off`, `tf`, `rth_jc`, `tj_max`, `body_diode_vf`

**Gate Driver parameters extracted:** `vcc_range`, `vcc_uvlo`, `vbs_max`, `vbs_uvlo`, `io_source`, `io_sink`, `prop_delay_on`, `prop_delay_off`, `deadtime_min`, `deadtime_default`, `vil`, `vih`, `ocp_threshold`, `ocp_response`, `thermal_shutdown`, `rth_ja`, `tj_max`, `current_sense_gain`

**MCU parameters extracted:** `cpu_freq_max`, `flash_size`, `ram_size`, `adc_resolution`, `adc_channels`, `adc_sample_rate`, `pwm_timers`, `pwm_resolution`, `pwm_deadtime_res`, `pwm_deadtime_max`, `complementary_outputs`, `spi_count`, `uart_count`, `vdd_range`, `idd_run`, `temp_range`, `gpio_count`

### Disk Cache

- Location: `backend/cache/{block_type}/{sha256_hash}.json`
- Key: SHA-256 hash of the raw PDF bytes (not filename — filename can be same but contents different)
- Hit: returns data immediately with `_from_cache: True`
- Miss: calls Claude, saves result, returns data
- To force re-extraction: delete the relevant `.json` file from the cache folder
- **Important:** After changing prompts (e.g., adding `note` field), delete old cache files so fresh extraction runs

### Claude API Call

```python
client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=16000,
    extra_headers={"anthropic-beta": "pdfs-2024-09-25"},
    messages=[{
        "role": "user",
        "content": [
            { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": pdf_b64 } },
            { "type": "text", "text": prompt }
        ]
    }]
)
```

**Why `extra_headers` and not `client.beta.messages.create`?** The older SDK version (0.21.3) does not have the `.beta` namespace. Using `extra_headers` works with all SDK versions.

---

## 7. Backend: unit_utils.py

Maps any datasheet unit string to its SI multiplier so calculations are always in SI:

```python
to_si(92, "nC")   # → 9.2e-8  (Coulombs)
to_si(1.5, "mΩ")  # → 0.0015  (Ohms)
to_si(40, "MHz")  # → 4e7     (Hz)
to_si(30, "ns")   # → 3e-8    (seconds)
```

Supported unit families: Resistance (mΩ, Ω, kΩ, MΩ), Capacitance (pF, nF, µF, mF, F), Charge (pC, nC, µC, mC, C), Time (ps, ns, µs, ms, s), Current (µA, mA, A, kA), Voltage (mV, V, kV), Power (mW, W, kW), Frequency (Hz, kHz, MHz, GHz), Thermal (°C/W, K/W, °C), Memory (B, KB, MB), Digital (bits), Misc (%, rpm, V/µs).

Also exports `UNIT_TOOLTIPS` dict used for hover tooltips on the frontend.

---

## 8. Backend: calc_engine.py

`CalculationEngine` class takes: `system_specs`, `mosfet_params`, `driver_params`, `mcu_params`, `motor_specs`, `overrides`. All `_get()` calls return SI values automatically.

### The 12 Calculation Modules

| # | Method | Key outputs |
|---|--------|-------------|
| 1 | `calc_mosfet_losses()` | Conduction loss, switching loss, recovery loss, gate charge loss, total 6-FET loss, junction temp estimate, efficiency |
| 2 | `calc_gate_resistors()` | Rg_on (calculated + nearest E24), Rg_off, bootstrap Rg=10Ω, rise/fall time, dV/dt, gate resistor power rating |
| 3 | `calc_input_capacitors()` | Bulk cap count, total capacitance, ESR budget, ripple voltage, cap voltage rating recommendation |
| 4 | `calc_bootstrap_cap()` | Bootstrap capacitance (from gate charge + UVLO), voltage rating, bleed resistor |
| 5 | `calc_shunt_resistors()` | Phase shunt value (Ω), power rating, Kelvin routing note, sense amplifier gain |
| 6 | `calc_snubber()` | RC snubber: R and C values, power dissipated, placement notes |
| 7 | `calc_protection_dividers()` | OVP divider (R1, R2), OCP threshold, temperature derating, NTC thermistor |
| 8 | `calc_power_supply_bypass()` | VCC bypass (100nF + 10µF near each IC), PVCC bulk cap, decoupling strategy |
| 9 | `calc_emi_filter()` | Common-mode choke inductance, Y-cap, X-cap, differential filter |
| 10 | `calc_thermal()` | Heatsink requirement, total system loss, thermal budget per FET |
| 11 | `calc_dead_time()` | Minimum dead time (from td_off + tf), recommended dead time with margin, MCU register value hint |
| 12 | `calc_pcb_guidelines()` | Trace widths (power, gate, signal), via sizes, copper pour advice, AGND star-point note, half-bridge loop constraint |

All methods return a `dict` with numeric results + a `notes` sub-dict with human-readable engineering explanations for each key value.

**E-series rounding:** `_nearest_e(value, series=E24)` snaps resistor values to standard E24 values for BOM-friendliness.

---

## 9. Frontend: Key Component Descriptions

### App.jsx
Defines `BLOCK_CONFIGS` (the 6 block definitions) and renders the correct panel based on `state.active_block`. Uses `key={state.active_block}` on `<BlockPanel>` to force remount when switching blocks.

### BlockPanel.jsx
The main panel for `mcu`, `driver`, `mosfet` blocks. Handles:
- Drag-and-drop PDF upload (react-dropzone)
- Upload/extract status display with progress bar
- Category-grouped parameter table (collapsible sections)
- **Closed-category attention badge:** When a category section is collapsed and has multi-condition parameters, shows amber `⚠ N needs attention` badge inline in the header
- **Missing params detection:** Compares extracted param IDs against `EXPECTED_PARAMS[blockKey]`. Missing ones go to `MissingParamsSection`
- `MissingParamsSection` component: shows two sub-lists — already-set manual params (green, with × delete button) and still-missing params (red, with value + UnitPicker + Set button)

**`EXPECTED_PARAMS`** per block:
```javascript
mosfet: ['vds_max','id_cont','rds_on','vgs_th','qg','qgd','qgs','qrr',
         'trr','coss','td_on','tr','td_off','tf','rth_jc','tj_max','body_diode_vf']
driver: ['vcc_range','vcc_uvlo','vbs_max','vbs_uvlo','io_source','io_sink',
         'prop_delay_on','prop_delay_off','deadtime_min','deadtime_default',
         'vil','vih','ocp_threshold','ocp_response','thermal_shutdown','rth_ja','tj_max']
mcu:    ['cpu_freq_max','flash_size','ram_size','adc_resolution','adc_channels',
         'adc_sample_rate','pwm_timers','pwm_resolution','pwm_deadtime_res',
         'pwm_deadtime_max','complementary_outputs','spi_count','uart_count',
         'vdd_range','idd_run','temp_range','gpio_count']
```

### ParameterTable.jsx
Displays extracted parameters in a table. Key behaviours:

- **Attention banner:** If any params in the group have >1 condition, shows amber banner: "N parameters with multiple test conditions — review and select the most appropriate one"
- **Multi-condition rows:** Amber left border + amber tinted background for rows with multiple test conditions. Clicking the row toggles expansion
- **Expanded condition rows:** Each condition shown as a clickable sub-row with ✓ selector circle. Clicking selects it as active
- **Footnote notes:** If `cond.note` is present, renders below condition_text in smaller italic with cyan ℹ icon
- **`UnitCell` component:** Shows unit with tooltip on hover (dotted cyan underline). Long/messy units (>8 chars) get amber ⚠ warning. Every unit has a tiny ✎ edit button that opens an inline `UnitPicker`
- **Active value:** Shown in colored badge. If user has overridden, shows in amber with ✎ symbol. Edit3 button lets user type override. Check/X confirm/cancel. Override cleared with × button

### UnitPicker.jsx
Fully self-contained searchable unit dropdown component.

- 50+ units in 12 groups: Resistance, Capacitance, Charge, Time, Current, Voltage, Power, Frequency, Thermal, Memory, Digital, Misc
- Typing filters by unit symbol, label name, or group name
- Arrow keys navigate, Enter selects (or confirms custom text if no match)
- Escape/Tab closes
- Border color: cyan = known unit, amber = unrecognized unit, normal = empty
- Outside-click handler closes dropdown
- Used in: `MissingParamsSection` (entering new params), `UnitCell` edit mode (fixing AI-extracted units)
- Exports `UNIT_TIPS` dict (unit → tooltip string) used by `UnitCell`

### Header.jsx
Top bar with:
- Editable project name (click to edit inline)
- Status badge showing `N/3 sheets` loaded
- "Calculated" badge when calculations exist
- "⚠ No API key" clickable badge
- Save (downloads resolved JSON), Load (reads JSON), Report, Theme toggle, Settings buttons

**JSON Export (Save) — resolved output:** The save function does NOT just dump raw state. It builds a resolved copy where for each parameter it finds the active condition (from `selected_params.condition_index`), applies any override, and marks `active: true` on that condition row + writes the override value into `selected`. This means the exported JSON accurately reflects what values the user has chosen, not just raw extracted data.

### CalculationsPanel.jsx
Right-side panel (300px wide) showing:
- "Run Calculations" button (only enabled when all 3 sheets + motor specs are filled)
- Results grouped by the 12 calculation modules
- Each result shown with value, unit, and engineering notes

### PassivesPanel.jsx
For the `passives` block — shows auto-calculated values from the engine with override inputs for the engineer to adjust any value.

### MotorForm.jsx
Manual entry form for motor specs: phase resistance (mΩ), phase inductance (µH), Kt (Nm/A), torque, back-EMF constant, speed, pole pairs.

### FeedbackPanel.jsx
Configuration for the sensing chain connecting MOSFETs and MCU: ADC scaling, OCP/OVP/OTP thresholds, NTC thermistor.

### SettingsModal.jsx
Modal for: Anthropic API key entry (password field), theme toggle, model info display.

---

## 10. API Reference

### POST /api/extract/{block_type}
- `block_type`: `mcu` | `driver` | `mosfet`
- Header: `X-API-Key: <anthropic_api_key>`
- Body: `multipart/form-data` with `file` (PDF, max 50MB)
- Response: `{ success: true, data: { component_name, manufacturer, parameters: [...] } }`

### POST /api/calculate
- Body: `{ system_specs, mosfet_params, driver_params, mcu_params, motor_specs, passives_overrides }`
- `*_params` are flat dicts: `{ "rds_on": 1.5, "rds_on__unit": "mΩ", ... }`
- Response: `{ success: true, data: { mosfet_losses, gate_resistors, ... } }` (12 modules)

### POST /api/report
- Body: `{ project, calculations, format }` where `format` is `"pdf"` or `"excel"`
- Response: binary file stream (PDF or XLSX)

### GET /api/health
- Response: `{ status: "ok", version: "2.0.0" }`

---

## 11. Bug Fixes History

### Bug 1: Stale Closure — Wrong Block Type in API Call
**Symptom:** Uploading Gate Driver PDF would POST to `/api/extract/mcu` (and overwrite MCU data).  
**Root cause:** `doExtract` was a function inside the component but `useCallback` had `config` in its dependency array. When switching from MCU tab to Driver tab, the `onDrop` callback was stale and still held the old `config.extractionType = 'mcu'`.  
**Fix:** Changed `extractDatasheet(config.extractionType, ...)` to `extractDatasheet(blockKey, ...)` — `blockKey` is the prop, always fresh. Updated `useCallback` deps to `[blockKey, settings.api_key]`.

### Bug 2: httpx Version Conflict
**Symptom:** `TypeError: Client.__init__() got an unexpected keyword argument 'proxies'`  
**Root cause:** httpx 0.28+ removed the `proxies` argument; Anthropic SDK 0.21.3 passes it.  
**Fix:** `pip install httpx==0.27.2` and pin in requirements.txt.

### Bug 3: Anthropic SDK `.beta` Not Available
**Symptom:** `AttributeError: 'Anthropic' object has no attribute 'beta'`  
**Root cause:** SDK 0.21.3 doesn't have `.beta.messages`. Newer SDK does.  
**Fix:** Use `client.messages.create(extra_headers={"anthropic-beta": "pdfs-2024-09-25"}, ...)` instead — works with all SDK versions.

### Bug 4: JSON Truncation on Large PDFs
**Symptom:** `json.decoder.JSONDecodeError: Unterminated string` mid-response  
**Root cause:** `max_tokens=4096` (then 8192) was too small for large datasheet PDFs (740KB+).  
**Fix:** Increased to `max_tokens=16000`. Also added conciseness rules to prompts: limit to essential params only, 1-3 conditions max, footnotes resolved into `note` field (short `condition_text`).

### Bug 5: Override Value Not Reflected in JSON Export
**Symptom:** User changes a value to 80, saves JSON, exported file still shows 40.  
**Root cause:** `save()` in Header.jsx was exporting raw `project` state which stores override separately in `selected_params`, not inside `raw_data.parameters`.  
**Fix:** `save()` now builds a resolved copy — walks every parameter, finds the active condition index, applies override if present, marks `active: true` on the right condition, writes override into `selected`.

### Bug 6: Unit Conversion Errors in Calculations
**Symptom:** Claude returns `92 nC` for gate charge; calc engine was treating it as `92 C` (off by 10⁹).  
**Root cause:** `_get()` just returned raw floats, manual `/1000` or `*1e-9` conversions in calc functions were hardcoded for specific assumed units.  
**Fix:** `buildParamsDict` now sends `{ "qg": 92, "qg__unit": "nC" }`. `_get()` reads the `__unit` key and calls `unit_utils.to_si()`. All calc function fallbacks updated to SI values (e.g., `92e-9` not `92`).

---

## 12. UI/UX Design Decisions

### Parameter Table Visual Hierarchy
- Multi-condition rows: amber left border + very faint amber background (draws eye without being noisy)
- Attention banner at top of each category group (not just global) — more actionable
- Closed category header: amber `⚠ N needs attention` badge appears only when collapsed (disappears when open, replaced by the full banner)
- Footnote notes: italic small text with cyan ℹ icon, wrapped in multiple lines (not truncated) — important for conditions like "ID at PCB/package limits"
- Units: cyan dotted underline = known SI unit with tooltip; amber dashed underline + ⚠ = suspicious AI-extracted unit (>8 chars); plain = unknown

### UnitPicker Design
- Live filter — typing immediately narrows the list (no search button needed)
- Grouped by category so engineer can browse if unsure of exact symbol
- Shows: `symbol | label | tip` in each row
- Keyboard-navigable (arrow keys + Enter + Escape)
- If user types something not in the list, Enter uses it verbatim (covers rare/custom units)
- Border color feedback: cyan = recognized, amber = unrecognized, standard = empty

### Missing Parameters Section
- Only appears if `EXPECTED_PARAMS[blockKey]` has IDs not in extracted list
- Split into two sub-lists: green "✓ Manually set" (deletable) and red "missing" (enterable)
- × delete button returns param to missing list (dispatches `DELETE_MANUAL_PARAM`)
- After setting, param appears in "Manual Entry" category in the main table

---

## 13. Data Integrity Notes

### Why SHA-256 Cache (not filename)
Same filename, different content = different hash → re-extracts. Filename-based cache would silently use wrong data after PDF edits.

### Why `selected` and `override` are separate
`selected` = the datasheet value for that condition (typ/max/min priority: typ first). `override` = user-entered replacement. Keeping them separate means: (a) user can always see original datasheet value, (b) clearing override restores datasheet value without re-extraction, (c) JSON export can show both.

### Why SI in calc engine
All calculation formulas use SI (Ω, C, s, A, V) internally. Converting at the boundary (in `_get`) is safer than converting in each formula — one conversion point, easier to audit.

### Why `buildParamsDict` sends both value + unit
Lets the backend know the original unit context even when the user has overridden a value. If user overrides `qg` to `80` with unit `nC`, the backend converts 80 nC → 8e-8 C correctly.

---

## 14. Known Limitations / Future Work

1. **No user accounts / server persistence** — all state is client-side. Session JSON must be saved manually.
2. **Cache never expires** — cached PDFs stay forever. If Claude's extraction improves, old cache must be manually cleared.
3. **Report generator (report_generator.py)** — generates a basic PDF/Excel with the calculation results but is not deeply styled.
4. **Calculations assume 3-phase 6-switch topology** — not configurable for other topologies.
5. **Motor parameters are not used in calculations yet** — the motor form stores data but calc engine doesn't use Lph, Rph, Kt for ripple current or bandwidth calculations.
6. **No backend authentication** — anyone who knows the port can call `/api/calculate`. Fine for local use.
7. **Windows-specific:** On Windows, `uvicorn --reload` prints `KeyboardInterrupt` during subprocess restart — this is cosmetic and harmless (server still starts correctly).

---

## 15. Setup Instructions (from scratch)

### Python backend
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
pip install httpx==0.27.2       # override if httpx got upgraded
uvicorn main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173
```

### First use
1. Open http://localhost:5173
2. Click Settings (⚙ gear icon top right)
3. Enter your Anthropic API key
4. Go to MOSFETs tab → drag-drop MOSFET datasheet PDF
5. Go to Gate Driver tab → drag-drop gate driver PDF
6. Go to MCU tab → drag-drop MCU PDF
7. Go to any block → click "Run Calculations" in right panel
8. Review results, adjust overrides, save session JSON

---

## 16. File-by-File Summary for Quick Reference

| File | Lines | Purpose |
|------|-------|---------|
| `backend/main.py` | 118 | FastAPI app: 3 POST routes + health |
| `backend/claude_service.py` | ~250 | Cache + Claude PDF extraction + 3 prompts |
| `backend/unit_utils.py` | ~130 | SI conversion map + tooltip strings |
| `backend/calc_engine.py` | 750 | 12 calculation modules |
| `backend/report_generator.py` | ~400 | PDF (ReportLab) + Excel (openpyxl) reports |
| `frontend/src/App.jsx` | 109 | BLOCK_CONFIGS + panel router |
| `frontend/src/api.js` | 52 | fetch wrappers (extract, calculate, report, health) |
| `frontend/src/context/ProjectContext.jsx` | ~414 | Full global state + 16 reducer actions |
| `frontend/src/components/BlockPanel.jsx` | ~370 | Upload + param display + missing params |
| `frontend/src/components/ParameterTable.jsx` | ~350 | Interactive param table with all UI features |
| `frontend/src/components/UnitPicker.jsx` | ~180 | Searchable unit dropdown (50+ units, 12 groups) |
| `frontend/src/components/CalculationsPanel.jsx` | ~300 | Run/display calculations |
| `frontend/src/components/Header.jsx` | ~137 | Top bar, save/load/report |
| `frontend/src/components/PassivesPanel.jsx` | ~400 | Passives overrides |
| `frontend/src/components/MotorForm.jsx` | ~250 | Motor specs entry |
| `frontend/src/components/FeedbackPanel.jsx` | ~250 | Sensing chain config |
| `frontend/src/index.css` | ~500 | CSS variables, all component styles |
