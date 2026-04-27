# MC Hardware Designer v2

A professional web application for 48V PMSM motor controller hardware design.  
Upload IC datasheets → Gemini AI extracts all parameters → Full engineering calculations → PDF/Excel reports.

---

## Folder Structure

```
mc-designer-v2/
│
├── backend/                          ← Python FastAPI server (port 8472)
│   ├── main.py                       ← API routes
│   ├── claude_service.py             ← PDF → Gemini AI extraction + SHA-256 disk cache
│   ├── calc_engine.py                ← Calculation engine (re-exports from calculations/)
│   ├── calculations/                 ← Individual calculation modules
│   │   ├── mosfet.py
│   │   ├── gate_resistors.py
│   │   ├── input_capacitors.py
│   │   ├── bootstrap.py
│   │   ├── shunts.py
│   │   ├── snubber.py
│   │   ├── protection.py
│   │   ├── thermal.py
│   │   ├── dead_time.py
│   │   ├── emi_filter.py
│   │   ├── power_bypass.py
│   │   └── pcb_guidelines.py
│   ├── report_generator.py           ← PDF (ReportLab) + Excel (openpyxl) export
│   ├── unit_utils.py                 ← SI unit conversion (to_si)
│   ├── spice_export.py               ← SPICE netlist export
│   └── requirements.txt
│
└── frontend/                         ← React + Vite web app (port 5742)
    ├── index.html
    ├── package.json
    ├── vite.config.js                ← Dev server + API proxy (/api → :8472)
    ├── tailwind.config.js
    ├── postcss.config.js
    └── src/
        ├── main.jsx                  ← React root (ProjectProvider, Toaster)
        ├── App.jsx                   ← Layout (Header + Sidebar + Panel), BLOCK_CONFIGS
        ├── api.js                    ← All API calls in one place
        ├── utils.js                  ← Shared helpers (fmtNum, statusLabel, etc.)
        ├── constants.js              ← Shared constants and labels
        ├── index.css                 ← Full design system (dark/light CSS vars)
        ├── context/
        │   └── ProjectContext.jsx    ← Global state (useReducer), buildParamsDict, getSelectedValue
        └── components/
            ├── Header.jsx            ← Top bar (project name, save/load, theme, settings)
            ├── Sidebar.jsx           ← Left nav (block list + system specs summary)
            ├── BlockPanel.jsx        ← Upload zone, ParameterTable, missing params section
            ├── ParameterTable.jsx    ← Min/typ/max table with conditions and overrides
            ├── CalculationsPanel.jsx ← Run All button + calculation results display
            ├── PassivesPanel.jsx     ← Passive component calculation results + overrides
            ├── MotorForm.jsx         ← Motor manual entry form with design checks
            ├── FeedbackPanel.jsx     ← Sensing chain, OCP/OVP/OTP protection config
            ├── SettingsModal.jsx     ← API keys, system specs, theme
            ├── ReportPanel.jsx       ← PDF/Excel/JSON export
            └── UnitPicker.jsx        ← Unit dropdown for manual parameter entry
```

---

## Prerequisites

### Backend

| Item | Detail |
|------|--------|
| Python | 3.12 (recommended) |
| Framework | FastAPI 0.110.0 |
| AI | Google Gemini SDK (`google-genai >= 1.0.0`) — model: `gemini-3-flash-preview` |
| API Key | Google AI Studio key (free tier available at [aistudio.google.com](https://aistudio.google.com)) |

### Frontend

| Item | Detail |
|------|--------|
| Runtime | Node.js 18+ |
| Framework | React 18.3.1 |
| Build tool | Vite 7+ |

---

## Setup & Run

### Step 1 — Install backend dependencies

Use a Python virtual environment to avoid dependency conflicts.

```bash
cd mc-designer-v2/backend
python -m venv .venv

# Windows:
.venv\Scripts\activate

# Mac/Linux:
source .venv/bin/activate

pip install -r requirements.txt
```

### Step 2 — Start the backend server

```bash
# From mc-designer-v2/backend/ with venv active:
uvicorn main:app --reload --port 8472
```

Expected output:
```
INFO:     Uvicorn running on http://127.0.0.1:8472
INFO:     Application startup complete.
```

Leave this terminal running.

### Step 3 — Install frontend dependencies

Open a new terminal:
```bash
cd mc-designer-v2/frontend
npm install
```

### Step 4 — Start the frontend dev server

```bash
# From mc-designer-v2/frontend/:
npm run dev
```

Expected output:
```
VITE ready in ~400ms
➜  Local:   http://localhost:5742/
```

### Step 5 — Open the app

Navigate to: **http://localhost:5742**

### Step 6 — Add your Gemini API key

1. Click the Settings icon (top-right corner)
2. Paste your Google AI Studio API key
3. Get one free at: [aistudio.google.com](https://aistudio.google.com)
4. Click **Save Settings**

You can add multiple API keys (comma-separated). The app rotates to the next key automatically on quota exhaustion.

### Quickstart (cross-platform scripts)

Alternatively, use the provided startup scripts which handle venv activation, dependency installation, and server startup automatically:

| Platform | Script |
|----------|--------|
| Windows | `START.bat` |
| Mac | `START.command` |
| Linux | `START.sh` |

---

## Complete Workflow

```
1. Settings ──→ Enter Gemini API key + confirm system specs (48V, 3kW, 80A, 20kHz)

2. MCU Block ──→ Upload MCU PDF datasheet
                 Gemini extracts: PWM timers, ADC resolution/channels, dead-time, frequency

3. Driver Block → Upload Gate Driver PDF datasheet
                  Gemini extracts: source/sink current, UVLO, propagation delay, OCP

4. MOSFET Block → Upload MOSFET PDF datasheet
                  Gemini extracts: Vds, Rds(on), Qg, tr/tf, Qrr, Ciss, Rth_jc, and more

5. For each extracted block:
   ✓ Review all test conditions per parameter (min/typ/max)
   ✓ Typ is pre-selected by default (fallback: max → min)
   ✓ Click a condition row to select a different test condition
   ✓ Click the edit icon to manually override any value (shown in amber)
   ✓ Clear override with ✕

6. Motor Block ─→ Enter manually: Rph, Lph, Kt, pole pairs, rated speed, back-EMF

7. Run Calculations (button in any right panel)
   Runs all 12+ calculation modules:
   ✓ MOSFET conduction + switching + recovery losses
   ✓ Gate resistors (on/off, E24 standard values)
   ✓ Input bulk/film/MLCC capacitors with ESR budget
   ✓ Bootstrap capacitor + diode + minimum HS on-time (E12 snapped)
   ✓ Shunt resistors — single + 3-phase, ADC bits used
   ✓ RC snubbers (drain-source, voltage overshoot, E12 cap values)
   ✓ OVP + UVP voltage divider resistors
   ✓ OTP NTC thermistor circuit
   ✓ Power supply bypass (12V/5V/3.3V/VREF rails)
   ✓ EMI filter (CM choke + X/Y caps)
   ✓ Thermal analysis (Tj, margin, copper area, via count)
   ✓ Dead time (from datasheet values + MCU register count)

8. Passives Block → View all passive component results
   (Part numbers, quantities, placement notes)

9. Feedback Block → Sensing chain, ADC timing, protection thresholds

10. Reports → PDF design report + Excel BOM + JSON session save
    SPICE → Export SPICE netlist for simulation
```

---

## API Cost

Extraction uses the **Google Gemini API** (model: `gemini-3-flash-preview`).  
Cost depends on your Google AI Studio plan. The free tier is sufficient for most design sessions.

| Feature | Detail |
|---------|--------|
| Model | `gemini-3-flash-preview` with thinking mode |
| Thinking budget | 8,000 tokens per extraction pass |
| Max output | 65,536 tokens |
| Extraction passes | 2 (Pass 1: full extraction, Pass 2: re-verify calc-critical params) |
| Caching | SHA-256 disk cache — re-uploading the same PDF costs zero tokens |
| Multiple keys | Supported — auto-rotates on quota exhaustion |

Cache files are stored at `backend/cache/{block_type}/{sha256_hash}.json`.  
Cache is automatically invalidated when prompts or parameter dependency sets change.

---

## Troubleshooting

**Backend won't start:**
- Verify Python version: `python --version` (3.12 recommended)
- Ensure the virtual environment is activated before running uvicorn
- Run `pip install -r requirements.txt` inside the activated venv

**Frontend won't start:**
- Verify Node version: `node --version` (18+ required)
- Delete `node_modules/` and re-run `npm install`

**Extraction fails:**
- Verify your Gemini API key is correct (no extra spaces or newlines)
- Confirm the backend is running on port 8472
- PDFs larger than 50 MB are rejected — use a compressed version
- Extraction has an 11-minute timeout — very large PDFs may time out

**"CORS error" in browser:**
- Ensure both servers are running (ports 8472 and 5742)
- Open the app via `http://localhost:5742`, not by opening `index.html` directly

**Values look wrong after extraction:**
- Expand the parameter row to see all test conditions
- Select the correct condition (e.g., correct Vgs or temperature)
- Use the edit (pencil) icon to override a value manually

**Stale extraction results:**
- Delete the relevant cache file in `backend/cache/{block_type}/` to force re-extraction

---

## Deployment (Vercel + Render)

| Layer | Platform | Notes |
|-------|----------|-------|
| Frontend | Vercel | Set env var `VITE_API_URL` = `https://<your-render-app>.onrender.com` (no trailing slash). Redeploy after setting. |
| Backend | Render | Run: `uvicorn main:app --host 0.0.0.0 --port 8472`. CORS allows all origins. No server-side API key — key is sent from the browser. |

Without `VITE_API_URL`, production API calls go to the Vercel host and fail.

---

## Future Roadmap

- Plotly graphs: loss vs. frequency, Bode plot, thermal vs. current
- Simulated oscilloscope waveforms (gate drive, switch node)
- Multi-project management with project list
- Advanced PCB thermal modeling (multi-layer copper pour analysis)
