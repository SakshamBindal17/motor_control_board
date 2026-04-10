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

# ─── In-flight dedup ─────────────────────────────────────────────────────────
# Prevents duplicate API calls when the same PDF is uploaded concurrently
_inflight_lock = asyncio.Lock()
_inflight: dict[str, asyncio.Event] = {}  # key → Event (set when done)

# ─── Cache setup ─────────────────────────────────────────────────────────────

CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")

# Bump this string whenever prompts change — forces cache re-extraction automatically
PROMPT_VERSION = "v10"

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
    # Include PROMPT_VERSION in hash so any prompt change invalidates old cache entries
    versioned = pdf_bytes + PROMPT_VERSION.encode()
    return hashlib.sha256(versioned).hexdigest()


# ─── Prompts ─────────────────────────────────────────────────────────────────
# Each prompt lists ESSENTIAL params (must extract, go to missing-params if absent)
# and GOOD-TO-HAVE params (extract only if present, never invent).
# Vendor alias lists handle the fact that different manufacturers name the same
# parameter differently (e.g. Rds(on) vs RDS(ON) vs Rdson).

MOSFET_PROMPT = """You are a power electronics engineer. Extract MOSFET parameters from this datasheet for a 48V motor controller design.

CRITICAL RULES:
1. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text
2. Each parameter MUST use the exact "id" string listed below — not a variant
3. FOOTNOTES: If a value row references a footnote like (1)(2)(*) etc., look up the full footnote text and place it in the "note" field. Keep "condition_text" to the actual test conditions only (e.g. VGS=10V, ID=80A, TC=25°C).
4. Include ALL test conditions found in the datasheet for each parameter — never cap or truncate
5. Different vendors use different names for the same parameter — use the alias list to identify each one
6. ESSENTIAL parameters: extract every one that appears in the datasheet
7. GOOD-TO-HAVE parameters: extract only if present — omit entirely if not found, do NOT invent values
8. ESCAPE ALL QUOTES: If you include a quote inside a string value (like a note), you MUST escape it (e.g. \"See \\"Notes\\"\"). Never use unescaped double quotes.
9. NO TRAILING COMMAS: Ensure the JSON is strictly valid, with no trailing commas before } or ].

JSON FORMAT:
{
  "component_name": "exact part number",
  "manufacturer": "manufacturer name",
  "component_type": "MOSFET",
  "package": "e.g. TO-263-7 / D2PAK",
  "description": "one-line description",
  "parameters": [
    {
      "id": "exact id from the list below",
      "name": "Human-readable parameter name",
      "symbol": "e.g. Rds(on)",
      "category": "Absolute Maximum | Electrical | Thermal | Switching | Gate Charge | Capacitance | Body Diode",
      "conditions": [
        {
          "condition_text": "short test conditions, e.g. VGS=10V, ID=80A, TC=25°C",
          "note": "Full footnote text if this row references one, else null",
          "min": null,
          "typ": 1.5,
          "max": null,
          "unit": "mΩ"
        }
      ]
    }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ESSENTIAL PARAMETERS  (extract all — required for board design calculations)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

id="vds_max"
  Name: Maximum Drain-Source Voltage
  Aliases: VDSS · V(BR)DSS · BVdss · VDS(max) · VDSmax · Drain-Source Voltage (max) · Drain-Source Breakdown Voltage

id="id_cont"
  Name: Continuous Drain Current
  Aliases: ID · I_D · ID(cont) · Idcont · IDS · Continuous Drain Current
  Note: Extract all conditions (e.g. TC=25°C and TC=100°C or PCB-limited)

id="rds_on"
  Name: On-State Drain-Source Resistance
  Aliases: RDS(ON) · Rdson · RDS,on · RDS(on) · Ron · On-Resistance · Drain-Source On-State Resistance · Static Drain-Source On-Resistance
  Note: Extract all conditions (different VGS values, e.g. 10V and 6V)

id="vgs_th"
  Name: Gate Threshold Voltage
  Aliases: VGS(th) · VGS(TH) · VGS,th · VT · Vth · Gate Threshold Voltage · Gate-Source Threshold · Turn-On Gate Threshold

id="qg"
  Name: Total Gate Charge
  Aliases: Qg · QG · Qgate · Total Gate Charge · Gate Charge (total) · Charge gate

id="qgd"
  Name: Gate-to-Drain (Miller) Charge
  Aliases: Qgd · QGD · Gate-Drain Charge · Miller Charge · Qmiller

id="qgs"
  Name: Gate-to-Source Charge
  Aliases: Qgs · QGS · Gate-Source Charge · Qg1

id="qrr"
  Name: Reverse Recovery Charge
  Aliases: Qrr · QRR · Body Diode Reverse Recovery Charge · Qrec · Q_rr · Diode Qrr

id="trr"
  Name: Reverse Recovery Time
  Aliases: trr · t_rr · t_rr(off) · Reverse Recovery Time · Body Diode Recovery Time · tRR

id="coss"
  Name: Output Capacitance
  Aliases: Coss · C_oss · Cout · CDS · Output Capacitance

id="td_on"
  Name: Turn-On Delay Time
  Aliases: td(on) · t_d(on) · Turn-On Delay Time · tdon · tdON · td,on

id="tr"
  Name: Rise Time
  Aliases: tr · t_r · Rise Time · Current Rise Time · trise

id="td_off"
  Name: Turn-Off Delay Time
  Aliases: td(off) · t_d(off) · Turn-Off Delay Time · tdoff · tdOFF · td,off

id="tf"
  Name: Fall Time
  Aliases: tf · t_f · Fall Time · Current Fall Time · tfall

id="rth_jc"
  Name: Junction-to-Case Thermal Resistance
  Aliases: Rth(j-c) · RθJC · RthJC · θJC · RTH,JC · RTHJC · Thermal Resistance (Junction to Case)

id="rth_ja"
  Name: Junction-to-Ambient Thermal Resistance
  Aliases: RθJA · Rth(j-a) · RthJA · θJA · RTH,JA · RTHJA · Thermal Resistance (Junction to Ambient)

id="tj_max"
  Name: Maximum Junction Temperature
  Aliases: TJ(max) · TjMAX · Tjmax · Maximum Junction Temperature · Maximum Operating Junction Temperature

id="body_diode_vf"
  Name: Body Diode Forward Voltage
  Aliases: Vsd · VSD · VF(body) · VF(diode) · Vf · IS · Body Diode Forward Voltage · Diode Forward Voltage Drop

id="vgs_max"
  Name: Maximum Gate-Source Voltage
  Aliases: VGSS · VGS(max) · VGSmax · Gate-Source Voltage Rating · Maximum Gate Voltage

id="ciss"
  Name: Input Capacitance
  Aliases: Ciss · C_iss · Cin · Input Capacitance · CGS+CGD

id="rg_int"
  Name: Internal Gate Resistance
  Aliases: Rg · RG · Rint · Rg(int) · Internal Gate Resistance · Gate Series Resistance (internal)

id="qoss"
  Name: Output Charge (energy stored in Coss)
  Aliases: Qoss · Q_oss · Qo · Output Charge

id="avalanche_energy"
  Name: Single-Pulse Avalanche Energy (in mJ)
  Aliases: Eas · EAS · EAR · Ear · Avalanche Energy · Single-Pulse Avalanche Energy · Drain-Source Avalanche Energy

id="avalanche_current"
  Name: Avalanche Current (Single-Pulse)
  Aliases: Ias · IAS · Iar · IAR · Avalanche Current · Single-Pulse Avalanche Current · Repetitive Avalanche Current

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GOOD-TO-HAVE PARAMETERS  (extract only if present — omit entirely if not found)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

id="id_pulsed"
  Name: Pulsed Drain Current (peak)
  Aliases: IDM · I_DM · IDpulse · IDM(peak) · Peak Drain Current · Pulsed Drain Current

id="crss"
  Name: Reverse Transfer Capacitance
  Aliases: Crss · C_rss · Creverse · Reverse Transfer Capacitance · Miller Capacitance · CGD

id="vgs_plateau"
  Name: Gate Plateau Voltage (Miller Plateau)
  Aliases: VGS(pl) · Vplateau · Vpl · Gate Plateau · Miller Plateau Voltage · Vgs(plateau)"""


DRIVER_PROMPT = """You are a power electronics engineer. Extract gate driver IC parameters from this datasheet for a 48V motor controller design.

CRITICAL RULES:
1. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text
2. Each parameter MUST use the exact "id" string listed below — not a variant
3. FOOTNOTES: If a value row references a footnote like (1)(2)(*) etc., look up the full footnote text and place it in the "note" field. Keep "condition_text" to actual test conditions only.
4. Include ALL test conditions found in the datasheet — never cap or truncate
5. Different vendors use different names for the same parameter — use the alias list to identify each one
6. ESSENTIAL parameters: extract every one that appears in the datasheet
7. GOOD-TO-HAVE parameters: extract only if present — omit entirely if not found, do NOT invent values
8. ESCAPE ALL QUOTES: If you include a quote inside a string value (like a note), you MUST escape it (e.g. \"See \\"Notes\\"\"). Never use unescaped double quotes.
9. NO TRAILING COMMAS: Ensure the JSON is strictly valid, with no trailing commas before } or ].

JSON FORMAT:
{
  "component_name": "exact part number",
  "manufacturer": "manufacturer name",
  "component_type": "GATE_DRIVER",
  "package": "package type",
  "description": "one-line description",
  "topology": "e.g. Half-bridge / 3-phase / single-channel",
  "parameters": [
    {
      "id": "exact id from the list below",
      "name": "Human-readable parameter name",
      "symbol": "e.g. IO+",
      "category": "Supply | Input Logic | Output Drive | Timing | Protection | Thermal",
      "conditions": [
        {
          "condition_text": "condition or 'No condition'",
          "note": null,
          "min": null, "typ": null, "max": null, "unit": "unit"
        }
      ]
    }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ESSENTIAL PARAMETERS  (extract all — required for dead-time and gate-drive calculations)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

id="vcc_range"
  Name: VCC Supply Voltage Operating Range
  Aliases: VCC · VS · VSUPPLY · VCC(op) · Supply Voltage · Operating Supply Voltage · VCC min/max · VCC_max · VCC_min
  Note: Extract min and max as separate conditions, or as a single range condition

id="vcc_uvlo"
  Name: VCC Under-Voltage Lockout Threshold
  Aliases: UVLO · VCC_UVLO · VCC(UVLO) · Under-Voltage Lock-Out · UVLO threshold · VCC_UV · VCC_UVLO_RISE · VCC_UVLO_FALL · UVLO rising · UVLO falling
  Note: Extract rising edge (turn-on) and falling edge (turn-off) as separate conditions when available

id="vbs_max"
  Name: Maximum Bootstrap Supply Voltage
  Aliases: VBS · VBOOT · VB · V(BOOT) · VB-VS · Bootstrap Voltage Max · Max Bootstrap Supply Voltage · VBS(max) · VBST

id="vbs_uvlo"
  Name: Bootstrap Supply Under-Voltage Lockout
  Aliases: VBS_UVLO · VBOOT_UVLO · Bootstrap UVLO · VB_UVLO · VBS Under-Voltage Lockout · VBST_UVLO
  Note: Extract rising and falling thresholds as separate conditions when available

id="io_source"
  Name: Peak Output Source Current (Turn-On drive)
  Aliases: IO+ · IOH · I_source · IOUT(source) · Peak Source Current · IO(source) · IOUT+ · IO_SOURCE · Source Peak Current · Turn-on drive current · IOUT_source · Isource · IO,source

id="io_sink"
  Name: Peak Output Sink Current (Turn-Off drive)
  Aliases: IO- · IOL · I_sink · IOUT(sink) · Peak Sink Current · IO(sink) · IOUT- · IO_SINK · Sink Peak Current · Turn-off drive current · IOUT_sink · Isink · IO,sink

id="prop_delay_on"
  Name: Propagation Delay — Turn-On (Input Low → Output High)
  Aliases: tpd_on · tPLH · td(on) · ton_pd · tPD_ON · tdr · td_rise · Propagation Delay (Turn-On) · Input-to-Output Delay (LH) · tPH · tPROP_ON · tON · delay turn-on

id="prop_delay_off"
  Name: Propagation Delay — Turn-Off (Input High → Output Low)
  Aliases: tpd_off · tPHL · td(off) · toff_pd · tPD_OFF · tdf · td_fall · Propagation Delay (Turn-Off) · Input-to-Output Delay (HL) · tPL · tPROP_OFF · tOFF · delay turn-off

id="deadtime_min"
  Name: Minimum Dead Time
  Aliases: DT_min · tDT_min · Dead Time (min) · Minimum Dead Band · Min Deadband · Minimum Dead Time · tDEAD_min · DTmin · Dead-Time (minimum)
  Note: Only include if dead time is a programmable or built-in feature of this driver IC — skip if not applicable

id="deadtime_default"
  Name: Default / Typical Dead Time
  Aliases: DT_typ · tDT_typ · Dead Time (typ) · Default Dead Time · Fixed Dead Time · Typical Deadband · DT(default) · DTdefault · built-in dead time
  Note: Only include if dead time is a programmable or built-in feature of this driver IC — skip if not applicable

id="vil"
  Name: Input Logic Low Voltage Threshold
  Aliases: VIL · VIN(L) · Input Low Threshold · Logic Low Input Voltage · V_IL · VIN_LOW · VIN(low) · VL · Input Low

id="vih"
  Name: Input Logic High Voltage Threshold
  Aliases: VIH · VIN(H) · Input High Threshold · Logic High Input Voltage · V_IH · VIN_HIGH · VIN(high) · VH · Input High

id="rth_ja"
  Name: Junction-to-Ambient Thermal Resistance
  Aliases: RθJA · Rth(j-a) · RthJA · θJA · RTH,JA · RTHJA · Thermal Resistance (Junction to Ambient)

id="tj_max"
  Name: Maximum Junction Temperature
  Aliases: TJ(max) · TjMAX · Tjmax · Maximum Junction Temperature · Maximum Operating Junction Temperature

id="current_sense_gain"
  Name: Current Sense Amplifier Gain
  Aliases: CSA Gain · GAIN · KGAIN · Current Sense Amplifier Gain · Transconductance Gain · Sense Amplifier Gain · CSA_GAIN
  Note: Only include if a current sense amplifier is integrated into this IC — skip if not applicable

id="rise_time_out"
  Name: Output Rise Time (driver output)
  Aliases: tr(out) · tr · Output Rise Time · Driver Output Rise Time · Gate Rise Time (driver output)

id="fall_time_out"
  Name: Output Fall Time (driver output)
  Aliases: tf(out) · tf · Output Fall Time · Driver Output Fall Time · Gate Fall Time (driver output)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GOOD-TO-HAVE PARAMETERS  (extract only if present — omit entirely if not found)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

id="ocp_threshold"
  Name: Over-Current Protection Threshold
  Aliases: OCP · IOCP · ITRIP · VCS(OCP) · Current Limit Threshold · Overcurrent Trip Level · OCP threshold · OCP trip current
  Note: Only include if OCP is an integrated feature of this driver IC

id="ocp_response"
  Name: OCP Blanking / Response Time
  Aliases: tBLANK · tOCP · OCP Blanking Time · Overcurrent Response Time · Fault Blanking Time · tFAULT · OCP blank
  Note: Only include if OCP is an integrated feature of this driver IC

id="thermal_shutdown"
  Name: Thermal Shutdown Temperature
  Aliases: TSD · T_SD · Thermal Shutdown Threshold · Over-Temperature Protection · TJ_SHUTDOWN · TSHDN · Thermal Shutdown temp

id="idd_quiescent"
  Name: Quiescent Supply Current (driver standby/operating current)
  Aliases: IDD · IQ · ICC · Quiescent current · Operating current · Supply current · Standby current · IDD(Q) · IQ(DD)
  Note: Extract at typical VDD operating conditions. This is used for bootstrap capacitor leakage budget calculations."""


MCU_PROMPT = """You are an embedded engineer. Extract motor-control MCU parameters from this datasheet for a motor controller design.

CRITICAL RULES:
1. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text
2. Each parameter MUST use the exact "id" string listed below — not a variant
3. FOOTNOTES: If a value row references a footnote like (1)(2)(*) etc., look up the full footnote text and place it in the "note" field. Keep "condition_text" to actual test conditions only.
4. Include ALL test conditions found in the datasheet — never cap or truncate
5. Different vendors use different names for the same parameter — use the alias list to identify each one
6. ESSENTIAL parameters: extract every one that appears in the datasheet
7. GOOD-TO-HAVE parameters: extract only if present — omit entirely if not found, do NOT invent values
8. ESCAPE ALL QUOTES: If you include a quote inside a string value (like a note), you MUST escape it (e.g. \"See \\"Notes\\"\"). Never use unescaped double quotes.
9. NO TRAILING COMMAS: Ensure the JSON is strictly valid, with no trailing commas before } or ].

JSON FORMAT:
{
  "component_name": "exact part number",
  "manufacturer": "manufacturer name",
  "component_type": "MCU",
  "package": "package type",
  "description": "one-line description",
  "core": "e.g. ARM Cortex-M4",
  "parameters": [
    {
      "id": "exact id from the list below",
      "name": "Human-readable parameter name",
      "symbol": "Symbol if applicable",
      "category": "Clock | ADC | PWM Timer | GPIO | Communication | Power | Memory | Temperature",
      "conditions": [
        {
          "condition_text": "condition or 'No condition'",
          "note": null,
          "min": null, "typ": null, "max": null, "unit": "unit"
        }
      ]
    }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ESSENTIAL PARAMETERS  (extract all — required for dead-time and ADC calculations)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

id="cpu_freq_max"
  Name: Maximum CPU / Core Frequency
  Aliases: FMAX · fCPU · fSYS_max · SYSCLK_max · Maximum Operating Frequency · CPU Clock Max · Core Frequency Max · fCLK_max · Max CPU Speed · Maximum system clock · CPU freq

id="adc_resolution"
  Name: ADC Resolution
  Aliases: ADC bits · ADC Resolution · ADC word length · ADC bit width · ADC precision · Resolution (ADC) · Number of ADC bits
  Note: Express in bits (e.g. 12)

id="adc_channels"
  Name: Number of ADC Input Channels
  Aliases: ADC channels · ADC inputs · Number of ADC inputs · ADC multiplexer channels · Number of analog inputs · ADC channel count · Analog input channels

id="adc_sample_rate"
  Name: ADC Maximum Sampling / Conversion Rate
  Aliases: ADC sampling rate · Conversion time · MSPS · ksps · ADC throughput · Conversion Rate · ADC Speed · Sampling frequency · ADC conversion rate · ADC speed · Max sampling rate

id="pwm_timers"
  Name: Number of Advanced-Control PWM Timers (motor control capable)
  Aliases: Advanced-control timers · Motor control timers · Advanced timers · TIM1 · TIM8 · Advanced PWM timer count · Number of advanced timers · Advanced-control timer count

id="pwm_resolution"
  Name: PWM Timer Counter Resolution
  Aliases: Timer resolution · Counter resolution · PWM bit depth · Timer width · ARR register width · Auto-reload register width · Timer counter bits · PWM counter width
  Note: Express in bits (e.g. 16)

id="pwm_deadtime_res"
  Name: Dead-Time Generator Resolution (step size per LSB)
  Aliases: DTG resolution · Dead-time resolution · Dead-time step · DTR step · Dead-time generator step · DT resolution · DTG step size · Dead-time LSB · Dead-time generator LSB · DTG prescaler step

id="pwm_deadtime_max"
  Name: Maximum Programmable Dead Time
  Aliases: DTG max · Maximum dead-time · DT_max · Maximum deadband · Max programmable dead time · DTG maximum value · Maximum dead-time value

id="complementary_outputs"
  Name: Number of Complementary PWM Output Pairs
  Aliases: Complementary pairs · CHxN outputs · Complementary channels · High-side/Low-side pairs · 3-phase PWM channels · Complementary PWM outputs · Number of CHxN pairs · Complementary channel count
  Note: Count only TRUE complementary output pairs (e.g. TIM1_CH1/CH1N on STM32, or FTM CH0/CH1 in complementary mode). Do NOT count independent timer channels as complementary pairs. Simple TPM/GPT timers with independent channels are NOT complementary — report 0 unless explicitly documented.

id="vdd_range"
  Name: VDD / Supply Voltage Operating Range
  Aliases: VDD · VCORE · Supply voltage range · Operating voltage range · VCC range · Power supply voltage · VDD operating range · VDD min/max · Operating VDD

id="adc_ref"
  Name: ADC Reference Voltage
  Aliases: VREF · VREF+ · ADC reference · ADC VREF · Reference voltage (ADC) · VDDA · Analog reference voltage · ADC reference voltage · VREFH · VREF_ADC · ADC supply voltage
  Note: If the ADC reference is tied to VDD (e.g. VREF=VDD), extract the VDD value here. Express in Volts.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GOOD-TO-HAVE PARAMETERS  (extract only if present — omit entirely if not found)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

id="flash_size"
  Name: Flash (Program) Memory Size
  Aliases: Flash · Program memory · ROM size · Code flash · Flash memory · Flash capacity · Program flash

id="ram_size"
  Name: RAM / SRAM Size
  Aliases: SRAM · RAM · Data memory · Working memory · SRAM capacity · RAM size · Data SRAM

id="spi_count"
  Name: Number of SPI Interfaces
  Aliases: SPI · SPIM · SSP · SPI master · Number of SPI · SPI interface count · SPI peripherals

id="uart_count"
  Name: Number of UART / USART Interfaces
  Aliases: UART · USART · Serial · Number of UART · UART/USART count · Number of serial interfaces · USART count

id="idd_run"
  Name: Run Mode Supply Current
  Aliases: IDD(run) · ICC(run) · Active current · Operating current · Run mode current · IDD at max frequency · IDD_run

id="temp_range"
  Name: Operating Temperature Range
  Aliases: Ambient temperature range · TA · Temperature rating · Operating temperature · Tj range · Temperature range · Operating TA

id="gpio_count"
  Name: Total GPIO Count
  Aliases: I/O pins · GPIO · I/O count · Digital I/Os · General purpose I/O · Total I/O pins · GPIO count

id="encoder_interface"
  Name: Quadrature Encoder / Hall Sensor Interface
  Aliases: QEP · Encoder timer · Hall sensor input · Position encoder · Quadrature encoder interface · Encoder pulse count · Encoder inputs · Hall interface

id="can_count"
  Name: Number of CAN Bus Interfaces
  Aliases: CAN · CANbus · FDCAN · CAN FD · Number of CAN · CAN interface count · bxCAN · CAN peripherals

id="dma_channels"
  Name: Number of DMA Channels / Streams
  Aliases: DMA · Direct memory access channels · DMA channels · DMA streams · DMA request count · DMA channel count"""


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

    # Dedup: if same PDF+block is already in-flight, wait for it
    dedup_key = f"{block_type}:{pdf_hash}"
    event = None
    async with _inflight_lock:
        if dedup_key in _inflight:
            event = _inflight[dedup_key]

    if event:
        await event.wait()
        cached = _load_cache(block_type, pdf_hash)
        if cached:
            return cached

    # Register this request as in-flight
    done_event = asyncio.Event()
    async with _inflight_lock:
        _inflight[dedup_key] = done_event

    try:
        prompt  = prompts[block_type]
        pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")

        def _call_claude():
            client = anthropic.Anthropic(api_key=api_key, timeout=120.0)
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

        response = await asyncio.wait_for(asyncio.to_thread(_call_claude), timeout=150)
        raw = response.content[0].text.strip()

        # Strip markdown fences if present
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE).strip()
        raw = re.sub(r"```\s*$",          "", raw, flags=re.MULTILINE).strip()

        # Parse JSON
        # Clean trailing commas from arrays and objects before parsing
        raw = re.sub(r',\s*([\]}])', r'\1', raw)
        
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as root_e:
            match = re.search(r'\{.*\}', raw, re.DOTALL)
            if match:
                try:
                    data = json.loads(match.group())
                except json.JSONDecodeError as inner_e:
                    raise ValueError(f"Claude returned malformed JSON: {inner_e}")
            else:
                raise ValueError(
                    f"Claude returned non-JSON.\nFirst 400 chars:\n{raw[:400]}\nParse Error: {root_e}"
                )

        # Post-process: set selected value and override slot
        for param in data.get("parameters", []):
            for cond in param.get("conditions", []):
                cond["selected"] = _pick(cond)
                cond["override"] = None

        # Save to cache
        _save_cache(block_type, pdf_hash, data)

        return data
    finally:
        # Signal waiters and clean up
        done_event.set()
        async with _inflight_lock:
            _inflight.pop(dedup_key, None)


def _pick(cond: dict):
    if cond.get("typ") is not None: return cond["typ"]
    if cond.get("max") is not None: return cond["max"]
    if cond.get("min") is not None: return cond["min"]
    return None
