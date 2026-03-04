# ⚡ MC Hardware Designer v2

A professional web app for 48V PMSM Motor Controller hardware design.  
Upload datasheets → Claude extracts all parameters → Full engineering calculations → PDF/Excel reports.

---

## 📁 Exact Folder Structure (keep exactly as-is)

```
mc-designer-v2/
│
├── backend/                        ← Python FastAPI server
│   ├── main.py                     ← API routes
│   ├── claude_service.py           ← PDF → Claude AI extraction
│   ├── calc_engine.py              ← All engineering calculations
│   ├── report_generator.py         ← PDF + Excel report output
│   └── requirements.txt            ← Python dependencies
│
└── frontend/                       ← React + Vite web app
    ├── index.html                  ← Entry point (loads Google Fonts)
    ├── package.json                ← Node dependencies
    ├── vite.config.js              ← Dev server + API proxy
    ├── tailwind.config.js
    ├── postcss.config.js
    └── src/
        ├── main.jsx                ← React root
        ├── App.jsx                 ← Layout (Header + Sidebar + Panel)
        ├── api.js                  ← All API calls in one place
        ├── utils.js                ← Shared helpers
        ├── index.css               ← Full design system (dark/light)
        ├── context/
        │   └── ProjectContext.jsx  ← Global state (React context)
        └── components/
            ├── Header.jsx          ← Top bar (name, save/load, theme)
            ├── Sidebar.jsx         ← Left nav (block list + system specs)
            ├── BlockPanel.jsx      ← MCU / Driver / MOSFET upload + params
            ├── ParameterTable.jsx  ← Full min/typ/max table with overrides
            ├── CalculationsPanel.jsx ← Right panel: results + run button
            ├── PassivesPanel.jsx   ← ALL passive component calculations
            ├── MotorForm.jsx       ← Motor manual entry form
            ├── FeedbackPanel.jsx   ← Sensing chain + protection
            ├── SettingsModal.jsx   ← API key + system specs settings
            └── ReportPanel.jsx     ← PDF/Excel/JSON export
```

---

## ⚙️ Prerequisites

| Tool | Version | Item | Detail |
|------|--------|
| Language | Python 3.12 |
| Framework | FastAPI 0.110.0 |
| AI | Anthropic Python SDK — Claude Haiku (`claude-haiku-4-5-20251001`) |
| HTTP client | httpx **pinned at 0.27.2** |

### Frontend
| Item | Detail |
|------|--------|
| Framework | React 18.3.1 |
| Build tool | Vite 5.4.2 |

---

## 🚀 Setup & Run (Step by Step)

### Step 1 — Install backend dependencies

It is highly recommended to use a Python virtual environment to avoid dependency conflicts, specifically with `httpx` and `anthropic`.

```bash
cd mc-designer-v2/backend
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Mac/Linux:
source .venv/bin/activate

pip install -r requirements.txt
pip install httpx==0.27.2  # Critical for Anthropic SDK compatibility
```

If you get permission errors on Linux/Mac:
```bash
pip3 install -r requirements.txt --user
```

### Step 2 — Start the backend server

```bash
# Still inside mc-designer-v2/backend/
uvicorn main:app --reload --port 8000
```

You should see:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Application startup complete.
```

Leave this terminal running.

### Step 3 — Install frontend dependencies

Open a NEW terminal:
```bash
cd mc-designer-v2/frontend
npm install
```

This installs React, Vite, Tailwind, lucide-react, recharts, react-dropzone, react-hot-toast.

### Step 4 — Start the frontend dev server

```bash
# Still inside mc-designer-v2/frontend/
npm run dev
```

You should see:
```
VITE v5.x  ready in 400ms
➜  Local:   http://localhost:5173/
```

### Step 5 — Open the app

Go to: **http://localhost:5173**

### Step 6 — Add your API key

1. Click the ⚙️ Settings icon (top-right)
2. Paste your Anthropic API key (`sk-ant-...`)
3. Get one free at: https://console.anthropic.com
4. Click Save Settings

---

## 📋 Complete Workflow

```
1. Settings ──→ Enter API key + confirm system specs (48V, 3kW, 80A, 20kHz)

2. MCU Block ──→ Upload MCU PDF datasheet
                 Claude extracts: PWM timers, ADC, dead-time, SPI, frequency

3. Driver Block → Upload Gate Driver PDF datasheet  
                  Claude extracts: source/sink current, UVLO, propagation delay, OCP

4. MOSFET Block → Upload MOSFET PDF datasheet
                  Claude extracts: Vds, Rds(on), Qg, tr/tf, Qrr, Ciss, Rth_jc...

5. For each extracted block:
   ✓ See ALL test conditions per parameter (min/typ/max)
   ✓ Typ is pre-selected by default (fallback: max → min)
   ✓ Click a condition row to select a different test condition
   ✓ Click ✏ to manually override any value
   ✓ Override shows in amber — clear with ✕

6. Motor Block ─→ Type in: Rph, Lph, Kt, pole pairs, rated speed, back-EMF

7. Run Calculations (click button in any right panel)
   Computes ALL 12 calculation modules:
   ✓ MOSFET conduction + switching + recovery losses
   ✓ Gate resistors (E24 standard values)
   ✓ Input bulk/film/MLCC capacitors
   ✓ Bootstrap capacitor + diode + minimum on-time
   ✓ Shunt resistors (single + 3-phase, ADC bits used)
   ✓ RC Snubbers (drain-source, voltage overshoot)
   ✓ OVP + UVP voltage divider resistors (R1/R2)
   ✓ OTP NTC thermistor circuit
   ✓ Power supply bypassing (12V/5V/3.3V/VREF)
   ✓ EMI filter (CM choke + X/Y caps)
   ✓ Thermal analysis (Tj, margin, copper area)
   ✓ Dead time (from actual datasheet values + MCU register count)

8. Passives Block → View ALL passive component results
   (All calculations shown with part numbers, quantities, placement notes)

9. Feedback Block → Sensing chain, ADC timing, protection thresholds

10. Reports → PDF design report + Excel BOM + JSON session save
```

---

## 💰 API Cost

| Action | Tokens | Cost (approx) |
|---|---|---|
| 1 datasheet (40 pages) | ~16k tokens | ~$0.10 |
| 3 datasheets total | ~48k tokens | ~$0.30 |
| Full design session | | **< $0.35** |

Model: `claude-haiku-4-5-20251001` — fastest and cheapest, handles IC datasheets well.
Note: The application uses a robust extraction prompt and allows up to `16000` max output tokens to prevent truncation on large, complex PDFs. It also features a disk-based SHA-256 caching system so re-uploading the exact same PDF costs zero tokens.

---

## ❓ Troubleshooting

**Backend won't start:**
- Check Python version: `python --version` (needs 3.12 recommended)
- If you see `TypeError: Client.__init__() got an unexpected keyword argument 'proxies'`, you are using an incompatible version of `httpx`. Run `pip install httpx==0.27.2`.

**Frontend won't start:**
- Check Node version: `node --version` (needs 18+)
- Delete `node_modules` and run `npm install` again

**Extraction fails:**
- Check your API key is correct (starts with `sk-ant-`)
- Check backend is running on port 8000
- Large PDFs (>50MB) are rejected — use compressed PDFs

**"CORS error" in browser:**
- Make sure both servers are running (port 8000 and 5173)
- Don't open `index.html` directly — use `http://localhost:5173`

**Values look wrong after extraction:**
- Click the parameter row to expand all test conditions
- Select the correct condition (e.g., right VGS / Temperature)
- Use ✏ to override if Claude extracted a wrong value

---

## 🔮 Future Phases (ready to add)

- 📈 Plotly graphs: loss vs frequency, Bode plot, thermal vs current
- 🔬 Simulated oscilloscope waveforms (gate drive, switch node)
- 🗂 Multi-project management with project list
- 📡 SPICE netlist export
