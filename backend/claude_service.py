"""
Claude PDF extraction service — v3
- Essential parameters only (shorter prompts, fewer tokens)
- SHA-256 hash-based disk cache (backend/cache/{block_type}/)
- Sync client in asyncio.to_thread to avoid event loop blocking
"""
import anthropic
import asyncio
import base64
import hashlib
import json
import os
import re

# ─── Cache setup ─────────────────────────────────────────────────────────────

CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")

def _cache_path(block_type: str, pdf_hash: str) -> str:
    folder = os.path.join(CACHE_DIR, block_type)
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f"{pdf_hash}.json")

def _load_cache(block_type: str, pdf_hash: str):
    path = _cache_path(block_type, pdf_hash)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            data["_from_cache"] = True
            return data
    return None

def _save_cache(block_type: str, pdf_hash: str, data: dict):
    path = _cache_path(block_type, pdf_hash)
    clean = {k: v for k, v in data.items() if k != "_from_cache"}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean, f, indent=2)

def _pdf_hash(pdf_bytes: bytes) -> str:
    return hashlib.sha256(pdf_bytes).hexdigest()


# ─── Prompts (essential parameters only) ─────────────────────────────────────

MOSFET_PROMPT = """You are a power electronics engineer. Extract key MOSFET parameters from this datasheet.

IMPORTANT RULES FOR CONDITION TEXT AND FOOTNOTES:
- If a condition references a footnote like (1), (2), (*) etc., look up that footnote at the bottom of the table and include its full text in the "note" field
- Keep condition_text short (the actual test conditions like "VGS=10V, ID=80A, TC=25°C")
- Put footnote/reference text in the separate "note" field
- Write note as a complete sentence explaining what the footnote says

Return ONLY valid JSON, no markdown, no preamble:

{
  "component_name": "exact part number",
  "manufacturer": "name",
  "component_type": "MOSFET",
  "package": "e.g. TO-263-7",
  "description": "one line",
  "parameters": [
    {
      "id": "snake_case_id",
      "name": "Parameter Name",
      "symbol": "e.g. Rds(on)",
      "category": "Absolute Maximum | Electrical | Thermal | Switching | Gate Charge | Capacitance",
      "conditions": [
        {
          "condition_text": "e.g. VGS=10V, ID=80A, TC=25°C",
          "note": "Full footnote text if there was a reference number, else null",
          "min": null, "typ": 1.5, "max": null, "unit": "mΩ"
        }
      ]
    }
  ]
}

Extract ONLY these essential parameters (1-3 conditions each, most relevant):
- vds_max: Max Drain-Source Voltage
- id_cont: Continuous Drain Current (at TC=25°C and package/PCB condition)
- rds_on: On-Resistance (at VGS=10V and VGS=6V if available)
- vgs_th: Gate Threshold Voltage
- qg: Total Gate Charge
- qgd: Gate-Drain Charge
- qgs: Gate-Source Charge
- qrr: Reverse Recovery Charge
- trr: Reverse Recovery Time
- coss: Output Capacitance
- td_on: Turn-On Delay Time
- tr: Rise Time
- td_off: Turn-Off Delay Time
- tf: Fall Time
- rth_jc: Junction-to-Case Thermal Resistance
- tj_max: Max Junction Temperature
- body_diode_vf: Body Diode Forward Voltage"""


DRIVER_PROMPT = """You are a power electronics engineer. Extract key gate driver parameters from this datasheet.

IMPORTANT: If a condition references a footnote like (1), (2), (*), look it up and put the full text in the "note" field. Keep condition_text short (actual test conditions only).

Return ONLY valid JSON, no markdown, no preamble:

{
  "component_name": "exact part number",
  "manufacturer": "name",
  "component_type": "GATE_DRIVER",
  "package": "package type",
  "description": "one line",
  "topology": "e.g. Half-bridge, 3-phase",
  "parameters": [
    {
      "id": "snake_case_id",
      "name": "Parameter Name",
      "symbol": "Symbol",
      "category": "Supply | Input Logic | Output Drive | Timing | Protection | Thermal",
      "conditions": [
        {"condition_text": "condition or 'No condition'", "note": null, "min": null, "typ": null, "max": null, "unit": "unit"}
      ]
    }
  ]
}

Extract ONLY these essential parameters (1-2 conditions each):
- vcc_range: VCC Supply Voltage range
- vcc_uvlo: VCC UVLO threshold (rising and falling)
- vbs_max: Max Bootstrap Voltage (VBS)
- vbs_uvlo: Bootstrap UVLO threshold
- io_source: Peak Source Current
- io_sink: Peak Sink Current
- prop_delay_on: Propagation Delay Turn-On
- prop_delay_off: Propagation Delay Turn-Off
- deadtime_min: Minimum Dead Time
- deadtime_default: Default/typical Dead Time
- vil: Input Low Voltage
- vih: Input High Voltage
- ocp_threshold: OCP threshold (if present)
- ocp_response: OCP response time (if present)
- thermal_shutdown: Thermal Shutdown Temperature
- rth_ja: Junction-to-Ambient Thermal Resistance
- tj_max: Max Junction Temperature
- current_sense_gain: CSA gain options (if integrated)"""


MCU_PROMPT = """You are an embedded engineer. Extract motor-control MCU parameters from this datasheet.

IMPORTANT: If a condition references a footnote like (1), (2), (*), look it up and put the full text in the "note" field. Keep condition_text short (actual test conditions only).

Return ONLY valid JSON, no markdown, no preamble:

{
  "component_name": "exact part number",
  "manufacturer": "name",
  "component_type": "MCU",
  "package": "package type",
  "description": "one line",
  "core": "e.g. ARM Cortex-M4",
  "parameters": [
    {
      "id": "snake_case_id",
      "name": "Parameter Name",
      "symbol": "Symbol",
      "category": "Clock | ADC | PWM Timer | GPIO | Communication | Power | Memory | Temperature",
      "conditions": [
        {"condition_text": "condition or 'No condition'", "note": null, "min": null, "typ": null, "max": null, "unit": "unit"}
      ]
    }
  ]
}

Extract ONLY these essential parameters (1-2 conditions each):
- cpu_freq_max: Max CPU Frequency
- flash_size: Flash Memory Size
- ram_size: RAM Size
- adc_resolution: ADC Resolution
- adc_channels: Number of ADC Channels
- adc_sample_rate: ADC Sample Rate / Conversion Time
- pwm_timers: Number of Advanced PWM Timers
- pwm_resolution: PWM Timer Resolution (bits)
- pwm_deadtime_res: Dead-Time Generator Resolution
- pwm_deadtime_max: Maximum Dead Time
- complementary_outputs: Number of Complementary Output Pairs
- spi_count: Number of SPI interfaces
- uart_count: Number of UART interfaces
- vdd_range: VDD Operating Voltage Range
- idd_run: Run Mode Current at typical frequency
- temp_range: Operating Temperature Range
- gpio_count: Total GPIO count"""


# ─── Main extraction function ─────────────────────────────────────────────────

async def extract_parameters_from_pdf(pdf_bytes: bytes, block_type: str, api_key: str) -> dict:
    prompts = {"mosfet": MOSFET_PROMPT, "driver": DRIVER_PROMPT, "mcu": MCU_PROMPT}
    if block_type not in prompts:
        raise ValueError(f"Unknown block type: {block_type}")

    # Check cache first
    pdf_hash = _pdf_hash(pdf_bytes)
    cached = _load_cache(block_type, pdf_hash)
    if cached:
        return cached

    prompt  = prompts[block_type]
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")

    def _call_claude():
        client = anthropic.Anthropic(api_key=api_key)
        return client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=16000,
            extra_headers={"anthropic-beta": "pdfs-2024-09-25"},
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": pdf_b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }],
        )

    response = await asyncio.to_thread(_call_claude)
    raw = response.content[0].text.strip()

    # Strip markdown fences if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE).strip()
    raw = re.sub(r"```\s*$",          "", raw, flags=re.MULTILINE).strip()

    # Parse JSON
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r'\{.*\}', raw, re.DOTALL)
        if match:
            data = json.loads(match.group())
        else:
            raise ValueError(
                f"Claude returned non-JSON.\nFirst 400 chars:\n{raw[:400]}"
            )

    # Post-process: set selected value and override slot
    for param in data.get("parameters", []):
        for cond in param.get("conditions", []):
            cond["selected"] = _pick(cond)
            cond["override"] = None

    # Save to cache
    _save_cache(block_type, pdf_hash, data)

    return data


def _pick(cond: dict):
    if cond.get("typ") is not None: return cond["typ"]
    if cond.get("max") is not None: return cond["max"]
    if cond.get("min") is not None: return cond["min"]
    return None
