# MC Hardware Designer v2 — Project Context for AI Agents

---

## How to use this file (two-step flow)

**Your first message (this chat):** Attach this file and type only:

**"Read this file to have context about the project."**

The AI will read the whole document and confirm it has context. No task yet.

**Your second message:** Give the actual work — e.g. "Add validation for PWM frequency in Settings" or "Fix the calculation panel when motor is empty." The AI will already know the project and can start working.

---

## Instructions for AI agents

- **If the user’s message is only to read this file for context:** Read this entire document to understand the project. Reply briefly that you have the context and are ready for their next message with the task.
- **When you make major changes** (new features, new files, new API endpoints, changed data flow, new env vars, deployment changes, or fixes that affect behavior), **update this document** in the same session: add a short entry under "Changelog" at the bottom and fix any section that no longer matches the codebase.

---

## What this project is

**MC Hardware Designer v2** is a web app for **48V PMSM motor controller hardware design**. It helps engineers:

1. **Upload PDF datasheets** (MCU, gate driver, MOSFET) and get **parameter extraction** via **Claude (Anthropic)** — with disk cache by PDF hash so re-uploading the same file costs no tokens.
2. **Run 12+ engineering calculation modules** (MOSFET losses, gate resistors, input/bulk/film/MLCC caps, bootstrap, shunts, snubbers, OVP/UVP/OCP/OTP, power bypass, EMI filter, thermal, dead time, PCB guidelines, motor validation).
3. **View and override** extracted parameters (min/typ/max, test conditions, manual entry for missing params).
4. **Export** PDF design report and Excel BOM (report content is not yet aligned with calc output — see "Deferred / known state" below).

**Deployment:** Frontend on **Vercel**, backend on **Render**. Production API URL is set via **`VITE_API_URL`** on Vercel (see Deployment section).

---

## Tech stack

| Layer    | Tech |
|----------|------|
| Backend  | Python 3.12, FastAPI 0.110.0, uvicorn, anthropic SDK, reportlab, openpyxl, httpx 0.27.2 |
| Frontend | React 18, Vite 5+, Tailwind, react-dropzone, react-hot-toast, recharts, lucide-react |
| AI       | Claude Haiku (`claude-haiku-4-5-20251001`) for PDF extraction; API key sent from browser in `X-API-Key` header |

---

## Folder structure and file roles

```
mc-designer-v2/
├── backend/
│   ├── main.py              # FastAPI app: /api/extract/{mcu|driver|mosfet}, /api/calculate, /api/report, /api/health
│   ├── claude_service.py    # PDF → Claude extraction, prompts, SHA-256 cache (backend/cache/{block_type}/)
│   ├── calc_engine.py       # CalculationEngine: all 12+ calc modules, SI units via unit_utils
│   ├── report_generator.py  # PDF (ReportLab) and Excel (openpyxl) — keys not yet aligned with calc_engine output
│   ├── unit_utils.py        # to_si(value, unit) for resistance, capacitance, charge, time, etc.
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js       # dev proxy: /api → http://localhost:8472
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── src/
│       ├── main.jsx         # React root, ProjectProvider, Toaster
│       ├── App.jsx          # Layout: Header, Sidebar, main panel; BLOCK_CONFIGS; ErrorBoundary
│       ├── api.js            # All API calls: BASE = VITE_API_URL; extractDatasheet, runCalculations, downloadReport, healthCheck
│       ├── utils.js          # fmtNum, statusDotClass, statusLabel, thresholdClass, etc.
│       ├── index.css         # Design system (dark/light), Tailwind
│       ├── context/
│       │   └── ProjectContext.jsx   # Global state: reducer, buildParamsDict, getSelectedValue; blocks (mcu, driver, mosfet, motor, passives, feedback)
│       └── components/
│           ├── Header.jsx        # Project name, save/load JSON, report modal, theme, settings
│           ├── Sidebar.jsx       # Block nav (feedback, mcu, driver, passives, mosfet, motor), system specs summary
│           ├── BlockPanel.jsx    # Upload zone, ParameterTable, MissingParamsSection; EXPECTED_PARAMS, CALC_CRITICAL, PARAM_LABELS
│           ├── ParameterTable.jsx # Min/typ/max, conditions, unit edit, override value
│           ├── CalculationsPanel.jsx # Run All, SECTIONS (motor_validation, mosfet_losses, gate_resistors, thermal, input_capacitors, bootstrap_cap, dead_time, snubber), audit log, grid modal
│           ├── PassivesPanel.jsx  # Override fields (gate_rise_time_ns, delta_v_ripple, etc.), comp cards (gate R, caps, bootstrap, shunts, snubber, protection, bypass, EMI, PCB)
│           ├── MotorForm.jsx      # Motor specs form (Rph, Lph, Kt, poles, Ke, etc.), derived params, design checks
│           ├── FeedbackPanel.jsx # Sensing chain, current sensing, ADC timing, protection (OVP/UVP/OCP/OTP), dead time
│           ├── SettingsModal.jsx  # API key, system specs (bus_voltage, power, pwm_freq_hz, etc.), theme
│           ├── ReportPanel.jsx    # Export PDF/Excel via api.downloadReport (uses VITE_API_URL)
│           └── UnitPicker.jsx     # Unit dropdown for manual param entry
├── README.md                # User-facing setup and run instructions
└── PROJECT_CONTEXT.md       # This file — for AI agents
```

---

## Data flow (high level)

1. **Extraction**  
   User uploads PDF → frontend calls `extractDatasheet(blockKey, file, apiKey)` → `POST /api/extract/{mcu|driver|mosfet}` with `X-API-Key` → `claude_service` (cache or Claude) → JSON with `parameters[]` (each has `id`, `conditions[]` with min/typ/max/unit). Frontend stores in `project.blocks[block].raw_data` and builds `selected_params` (param_id → { condition_index, override }).

2. **Parameters**  
   Frontend sends params to backend as a **flat dict**: for each param, `params[id] = value` and `params[id + '__unit'] = unit`. Backend `unit_utils.to_si` converts to SI; `calc_engine` uses SI everywhere.

3. **Calculation**  
   User clicks "Run All Calculations" → frontend builds payload from `buildParamsDict(mosfet)`, `buildParamsDict(driver)`, `buildParamsDict(mcu)`, plus `system_specs`, `motor_specs`, `passives.overrides` → `POST /api/calculate` → `CalculationEngine.run_all()` → result stored in `project.calculations`.  
   **Pre-flight:** CalculationsPanel checks system specs and CALC_CRITICAL params for missing values before calling API.

4. **Report**  
   Report panel uses `downloadReport(project, calculations, format)` from `api.js` (so it respects `VITE_API_URL` in production). Backend returns PDF or Excel blob. **Note:** PDF/Excel content still use keys that don’t match `calc_engine` output; report is deferred until core app is stable.

---

## Key conventions

- **Block types:** `mcu`, `driver`, `mosfet` (upload + extract); `motor` (manual form); `passives` (overrides + calc results); `feedback` (display only).
- **Parameter IDs** are fixed strings from extraction (e.g. `rds_on`, `qg`, `io_source`, `pwm_deadtime_res`). See `BlockPanel.jsx` `EXPECTED_PARAMS` and `CALC_CRITICAL`; `ProjectContext.jsx` has `PARAM_LABELS_CTX` in sync.
- **Selected value:** For each param, frontend uses `selected_params[param_id].override` if set, else the selected condition’s `selected` (typ → max → min).
- **System specs** live in `project.system_specs` (bus_voltage, peak_voltage, power, max_phase_current, pwm_freq_hz, ambient_temp_c, gate_drive_voltage). Editable in Settings modal.
- **API base:** All frontend API calls go through `api.js` using `BASE = import.meta.env.VITE_API_URL || ''`. Local dev: BASE is '' and Vite proxies `/api` to 8472. Production: must set `VITE_API_URL` to the Render backend URL.

---

## API endpoints (backend)

| Method + Path | Purpose |
|---------------|---------|
| POST `/api/extract/{block_type}` | `block_type` in (mcu, driver, mosfet); body: multipart file; header: `X-API-Key`. Returns `{ success, data }` with extracted JSON. |
| POST `/api/calculate` | Body: `CalcRequest` (system_specs, mosfet_params, driver_params, mcu_params, motor_specs, passives_overrides). Returns `{ success, data }` with full calc result. |
| POST `/api/report` | Body: `{ project, calculations, format }` (format: "pdf" or "excel"). Returns PDF or Excel blob. |
| GET `/api/health` | Returns `{ status, version }`. |

---

## Deployment (Vercel + Render)

- **Backend (Render):** Run FastAPI with uvicorn. CORS allows all origins. No server-side Anthropic key; key is sent from browser.
- **Frontend (Vercel):** Set **Environment Variable**: `VITE_API_URL` = `https://<your-render-app>.onrender.com` (no trailing slash). Redeploy after setting so the build gets the correct API base. Without this, production API calls go to the Vercel host and fail.
- **Report:** When report is implemented, it already uses `api.js` → `downloadReport`, so it will use the same backend URL.

---

## Deferred / known state

- **Report generator:** `report_generator.py` uses different key names and structure than `calc_engine.run_all()` returns (e.g. `conduction_loss_per_mosfet_w` vs `conduction_loss_per_fet_w`, `protection` flat vs `protection_dividers` nested). Report is the last step; when implementing it, align report_generator with calc_engine output.
- **unit_utils.py:** Duplicate `"mω"` key in multiplier table; optional cleanup.

---

## How to run locally

1. **Backend:** `cd backend && python -m venv .venv && .venv\Scripts\activate` (or `source .venv/bin/activate`), `pip install -r requirements.txt`, `uvicorn main:app --reload --port 8472`.
2. **Frontend:** `cd frontend && npm install && npm run dev`. Open http://localhost:5742. No `VITE_API_URL` needed; Vite proxies `/api` to 8472.
3. **Settings:** In the app, add Anthropic API key (Settings) and confirm system specs.

---

## Changelog (keep this updated when making major changes)

- **Initial:** Project context doc created; Cursor rule added to update this file on major changes.
- **Fixes applied:** FeedbackPanel UVP hysteresis key fixed (`hysteresis_voltage_v`); ReportPanel switched to `api.downloadReport()` for production API base URL.
- **Documentation:** Added `docs/CALCULATIONS_REFERENCE.md` (in-depth formulas, theory, and worked examples using Aron Sir motor session) and `docs/FALLBACKS_AND_HARDCODED_VALUES.md` (all parameter fallbacks and hardcoded constants with locations and action items). Aron session lacks three params: DRIVER `current_sense_gain`, MCU `pwm_deadtime_res`, MCU `pwm_deadtime_max`; doc uses assumed values 20, 8 ns, 1000 ns for examples.
