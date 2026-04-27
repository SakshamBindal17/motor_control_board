# MC Hardware Designer v2 — Project Context for AI Agents

---

## How to use this file

**Step 1 (first message):** Attach this file and type only:

> "Read this file to have context about the project."

The AI reads the document and confirms it has context. No task yet.

**Step 2 (second message):** Give the actual task — e.g. "Add validation for PWM frequency in Settings" or "Fix the calculation panel when motor is empty." The AI already knows the project and can start working.

---

## Instructions for AI agents

- If the user's message is only to read this file: read it fully, reply briefly that you have context, wait for the task.
- When you make major changes (new features, new files, new API endpoints, changed data flow, new env vars, or fixes that affect behavior), **update this document in the same session**: add a short entry under "Changelog" at the bottom and fix any section that no longer matches the codebase.

---

## What this project is

**MC Hardware Designer v2** is a full-stack web app for **48V PMSM motor controller hardware design**.  
It helps power electronics engineers:

1. **Upload PDF datasheets** (MCU, gate driver, MOSFET) and get **parameter extraction via Google Gemini AI**, with SHA-256 disk cache so re-uploading the same PDF costs zero tokens.
2. **Run 12+ engineering calculation modules**: MOSFET losses, gate resistors, input/bulk/film/MLCC capacitors, bootstrap, current shunts, RC snubbers, OVP/UVP/OCP/OTP protection, power supply bypass, EMI filter, thermal analysis, dead time, PCB guidelines, and motor validation.
3. **View and override** extracted parameters (min/typ/max per test condition, manual entry for missing params).
4. **Export** PDF design report, Excel BOM, JSON session, and SPICE netlist.

**Deployment target:** Frontend on **Vercel**, backend on **Render**.  
Production API URL is set via `VITE_API_URL` on Vercel (see Deployment section).

---

## Tech stack

| Layer | Tech |
|-------|------|
| Backend | Python 3.12, FastAPI 0.110.0, Uvicorn, `google-genai >= 1.0.0`, ReportLab, openpyxl, httpx, aiofiles |
| Frontend | React 18.3.1, Vite 7+, Tailwind CSS, react-dropzone, react-hot-toast, recharts, lucide-react, clsx |
| AI | **Google Gemini** (`gemini-3-flash-preview`) — two-pass extraction with thinking mode (8k token budget); API key(s) sent from browser in `X-API-Keys` header; supports multiple keys with auto-rotation on quota exhaustion |
| Cache | SHA-256 disk cache at `backend/cache/{block_type}/{hash}.json`; invalidated by `PROMPT_VERSION` (`v14-gemini`) and `CALC_DEPS` set changes |

---

## Folder structure and file roles

```
mc-designer-v2/
├── backend/
│   ├── main.py               # FastAPI app: all API routes, CORS, multipart upload
│   ├── claude_service.py     # PDF → Gemini extraction; two-pass system; SHA-256 disk cache;
│   │                         # exponential backoff on 503; key rotation on 429
│   ├── calc_engine.py        # Shim re-exporting CalculationEngine from calculations/;
│   │                         # defines CALC_DEPS (param sets that feed formulas directly)
│   ├── calculations/         # Individual calculation modules (one file per domain)
│   │   ├── mosfet.py         # Conduction, switching, recovery losses
│   │   ├── gate_resistors.py # Rg_on/off (E24), rise/fall time, dV/dt
│   │   ├── input_capacitors.py # Bulk cap count, ESR budget, ripple
│   │   ├── bootstrap.py      # C_boot (E12 snapped), min HS on-time
│   │   ├── shunts.py         # Single + 3-phase shunts, ADC bits used
│   │   ├── snubber.py        # RC snubber (E12 cap), voltage overshoot
│   │   ├── protection.py     # OVP/UVP dividers, OTP NTC, TVS
│   │   ├── power_bypass.py   # Bypass caps per rail (12V/5V/3.3V/VREF)
│   │   ├── emi_filter.py     # CM choke, X/Y caps
│   │   ├── thermal.py        # Tj estimate, margin, trace width, thermal vias
│   │   ├── dead_time.py      # dt_min, MCU register count
│   │   └── pcb_guidelines.py # Layer stack, trace widths, clearances
│   ├── report_generator.py   # PDF (ReportLab) + Excel (openpyxl) export
│   ├── unit_utils.py         # to_si(value, unit) — SI conversion for all param types
│   ├── spice_export.py       # SPICE netlist export
│   └── requirements.txt
│
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js        # Dev proxy: /api → http://localhost:8472
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── src/
│       ├── main.jsx          # React root — ProjectProvider, Toaster
│       ├── App.jsx           # Layout: Header, Sidebar, main panel; BLOCK_CONFIGS; ErrorBoundary; lazy loading
│       ├── api.js            # All API calls — BASE = VITE_API_URL || ''; 11-min timeout for extraction
│       ├── utils.js          # fmtNum, statusDotClass, statusLabel, thresholdClass, etc.
│       ├── constants.js      # Shared constants and display labels
│       ├── index.css         # Design system: CSS vars (dark/light), all component styles
│       ├── context/
│       │   └── ProjectContext.jsx   # Global state: useReducer, buildParamsDict, getSelectedValue,
│       │                            # _buildDefaultSelections; blocks (mcu, driver, mosfet, motor,
│       │                            # passives, feedback); localStorage persistence; backward-compat migration
│       └── components/
│           ├── Header.jsx         # Project name, save/load JSON, report modal, theme, settings
│           ├── Sidebar.jsx        # Block nav, system specs summary
│           ├── BlockPanel.jsx     # Upload zone, ParameterTable, MissingParamsSection;
│           │                      # EXPECTED_PARAMS (essential only), CALC_CRITICAL, PARAM_LABELS
│           ├── ParameterTable.jsx # Min/typ/max, test conditions, unit editing, value override (amber)
│           ├── CalculationsPanel.jsx # Run All, SECTIONS, audit log, grid modal; pre-flight check
│           │                         # for system specs + CALC_CRITICAL params
│           ├── PassivesPanel.jsx  # Override fields, component result cards (gate R, caps,
│           │                      # bootstrap, shunts, snubber, protection, bypass, EMI, PCB)
│           ├── MotorForm.jsx      # Motor specs form (Rph, Lph, Kt, poles, Ke, etc.),
│           │                      # derived params, design checks with warn state
│           ├── FeedbackPanel.jsx  # Sensing chain, current sensing, ADC timing, protection
│           │                      # (OVP/UVP/OCP/OTP), dead time display
│           ├── SettingsModal.jsx  # Gemini API key(s), system specs (bus_voltage, power,
│           │                      # pwm_freq_hz, etc.), theme
│           ├── ReportPanel.jsx    # Export PDF/Excel via api.downloadReport (uses VITE_API_URL)
│           └── UnitPicker.jsx     # Unit dropdown for manual parameter entry
│
├── docs/                     # Reference docs, saved session examples
├── README.md                 # User-facing setup and run instructions
├── PROJECT_CONTEXT.md        # This file — for AI agents
├── START.bat                 # Windows quickstart script
├── START.sh                  # Linux quickstart script
└── START.command             # macOS quickstart script
```

---

## Data flow

### 1. Extraction

```
User uploads PDF
    → frontend: extractDatasheet(blockKey, file, apiKeys)
    → POST /api/extract/{mcu|driver|mosfet}
      Headers: X-API-Keys: key1,key2,...
      Body: multipart/form-data (file)
    → claude_service.py:
        1. SHA-256 hash of PDF bytes → check disk cache
        2. Cache miss → Pass 1: full extraction via Gemini (gemini-3-flash-preview, thinking mode)
        3. Pass 2: re-verify CALC_DEPS parameters (calc-critical params always re-verified)
        4. Write result to cache/{block_type}/{hash}.json
    → Response: { success, data: { component_name, manufacturer, parameters[] } }
       Each parameter: { id, name, conditions: [{ label, min, typ, max, unit }] }
    → ProjectContext: stored in project.blocks[block].raw_data
       Frontend builds selected_params: param_id → { condition_index, override }
```

### 2. Parameters

Frontend sends params to backend as a **flat dict**:
- `params[id]` = selected value (override → selected condition typ/max/min fallback)
- `params[id + '__unit']` = unit string

Backend `unit_utils.to_si()` converts all values to SI; `calc_engine` uses SI throughout.

### 3. Calculation

```
User clicks "Run All Calculations"
    → CalculationsPanel pre-flight: check system_specs + CALC_CRITICAL params for missing values
    → frontend: buildParamsDict(mosfet) + buildParamsDict(driver) + buildParamsDict(mcu)
               + system_specs + motor_specs + passives.overrides
    → POST /api/calculate (body: CalcRequest)
    → calc_engine.run_all() → 12+ modules
    → Result stored in project.calculations
    → CalculationsPanel + PassivesPanel display results
```

### 4. Reports and Export

```
POST /api/report     → PDF or Excel blob (format: "pdf" | "excel")
POST /api/export/spice → SPICE netlist text
```

Both use `api.js → downloadReport / downloadSpice` which respects `VITE_API_URL` in production.

---

## Key conventions

- **Block types:** `mcu`, `driver`, `mosfet` (upload + extract); `motor` (manual form); `passives` (overrides + calc results); `feedback` (display only).
- **Parameter IDs** are fixed snake_case strings from extraction (e.g. `rds_on`, `qg`, `io_source`, `pwm_deadtime_res`). `BlockPanel.jsx` has `EXPECTED_PARAMS` (essential only, controls missing-params section) and `CALC_CRITICAL`. `ProjectContext.jsx` has `PARAM_LABELS_CTX` in sync.
- **Selected value logic:** `selected_params[param_id].override` if set, else selected condition value (typ → max → min fallback).
- **System specs** live in `project.system_specs`: `bus_voltage`, `peak_voltage`, `power`, `max_phase_current`, `pwm_freq_hz`, `ambient_temp_c`, `gate_drive_voltage`. Editable in Settings modal.
- **API base:** All frontend API calls go through `api.js` using `BASE = import.meta.env.VITE_API_URL || ''`. Local dev: `''` with Vite proxying `/api` to `:8472`. Production: set `VITE_API_URL` to the Render backend URL.
- **CALC_DEPS:** Defined in `calc_engine.py`. Three sets — mosfet (27 params), driver (13 params), mcu (5 params). Used for Pass 2 targeting and automatic cache invalidation when the set changes.
- **Cache invalidation:** Automatic when `PROMPT_VERSION` or `CALC_DEPS` hash changes. Manual: delete files in `backend/cache/{block_type}/`.

---

## API endpoints

| Method + Path | Purpose |
|---------------|---------|
| `POST /api/extract/{block_type}` | `block_type` ∈ {mcu, driver, mosfet}; multipart file body; `X-API-Keys` header (comma-separated). Returns `{ success, data }` with extracted JSON. |
| `POST /api/calculate` | Body: `CalcRequest` (system_specs, mosfet_params, driver_params, mcu_params, motor_specs, passives_overrides). Returns `{ success, data }` with full calc result. |
| `POST /api/reverse-calculate` | Target-to-component reverse design. Returns component values that achieve a given performance target. |
| `POST /api/report` | Body: `{ project, calculations, format }` — format `"pdf"` or `"excel"`. Returns binary blob. |
| `POST /api/export/spice` | Body: project + calculations. Returns SPICE netlist as text. |
| `GET /api/design-constants` | Returns the design constants schema (default values and ranges for system-level constants). |
| `GET /api/health` | Returns `{ status, version }`. |

---

## Deployment

- **Backend (Render):** `uvicorn main:app --host 0.0.0.0 --port 8472`. CORS allows all origins. No server-side API key — Gemini key(s) are sent from the browser per-request.
- **Frontend (Vercel):** Set environment variable `VITE_API_URL` = `https://<your-render-app>.onrender.com` (no trailing slash). Redeploy after setting so the build gets the correct API base.

Without `VITE_API_URL`, all production API calls go to the Vercel host and fail with 404.

---

## Deferred / known state

- **Report generator:** `report_generator.py` uses key names that don't fully match `calc_engine.run_all()` output (e.g. `conduction_loss_per_mosfet_w` vs `conduction_loss_per_fet_w`; `protection` flat vs `protection_dividers` nested). When implementing report improvements, align `report_generator.py` with `calc_engine` output keys.
- **Motor params:** `Lph`, `Rph`, `Kt` not yet fully used across all calc modules. Ripple current calc uses `Lph` when available.
- **unit_utils.py:** Duplicate `"mω"` key in multiplier table — optional cleanup.
- **Cache never expires:** There is no TTL. To force re-extraction, delete the relevant `.json` file in `backend/cache/{block_type}/`.

---

## How to run locally

```bash
# Terminal 1 — backend
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Mac/Linux
pip install -r requirements.txt
uvicorn main:app --reload --port 8472

# Terminal 2 — frontend
cd frontend
npm install
npm run dev
# Open http://localhost:5742
```

In the app: open Settings → add Gemini API key(s) → confirm system specs (48V, 3kW, 80A, 20kHz).

---

## Changelog

- **Initial:** Project context doc created.
- **Fixes applied:** FeedbackPanel UVP hysteresis key fixed (`hysteresis_voltage_v`); ReportPanel switched to `api.downloadReport()` for production API base URL.
- **Documentation:** Added `docs/CALCULATIONS_REFERENCE.md` (in-depth formulas, theory, worked examples) and `docs/FALLBACKS_AND_HARDCODED_VALUES.md` (all parameter fallbacks and hardcoded constants with locations).
- **Calculation improvements:** Ripple current calc uses motor `Lph` when available; bootstrap cap snapped to E12 standard values; snubber cap snapped to E12 pF values.
- **UI improvements:** Light theme contrast fixes (txt-3: `#7a9ab8` → `#4a6a8a` for WCAG compliance); MotorForm refactored to CSS vars with CheckRow warn state.
- **AI migration:** Migrated from Anthropic Claude (`claude-haiku-4-5-20251001`) to **Google Gemini** (`gemini-3-flash-preview`). `claude_service.py` now uses `google-genai` SDK. Removed `httpx==0.27.2` pin (was required for Anthropic SDK compatibility only). API key header changed from `X-API-Key` to `X-API-Keys` (supports multiple keys with auto-rotation).
- **Two-pass extraction:** Added Pass 2 re-verification for CALC_DEPS parameters. Added CALC_DEPS sets in `calc_engine.py` for both Pass 2 targeting and cache invalidation. PROMPT_VERSION bumped to `v14-gemini`.
- **New endpoints:** Added `/api/reverse-calculate` (target-to-component design), `/api/export/spice` (SPICE netlist), `/api/design-constants` (design constant schema).
- **Startup scripts:** Added cross-platform scripts: `START.bat` (Windows), `START.sh` (Linux), `START.command` (macOS).
- **PROJECT_CONTEXT.md:** Fully updated to reflect Gemini migration, new endpoints, two-pass extraction, CALC_DEPS, and current folder structure.
