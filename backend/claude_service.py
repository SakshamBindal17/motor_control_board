"""
Gemini PDF extraction service
- Visual PDF extraction via gemini-3-flash-preview with thinking mode (Files API — handles up to 500-page datasheets)
- SHA-256 hash-based disk cache (backend/cache/{block_type}/)
- Sync client in asyncio.to_thread to avoid event loop blocking
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import tempfile
import time

from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from json_repair import repair_json
from calc_engine import CALC_DEPS

# ─── In-flight dedup ─────────────────────────────────────────────────────────
# Prevents duplicate API calls when the same PDF is uploaded concurrently
_inflight_lock = asyncio.Lock()
_inflight: dict[str, asyncio.Event] = {}  # key → Event (set when done)

# ─── Cache setup ─────────────────────────────────────────────────────────────

CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")

# Bump this string whenever prompts change — forces cache re-extraction automatically
PROMPT_VERSION = "v14-gemini"

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

def _pdf_hash(pdf_bytes: bytes, block_type: str) -> str:
    # Include PROMPT_VERSION so prompt changes invalidate cache.
    # Include a stable hash of CALC_DEPS[block_type] so adding a new calc formula
    # that depends on a new param automatically invalidates cache for that block.
    deps_stable = json.dumps(sorted(CALC_DEPS.get(block_type, [])), sort_keys=True).encode()
    deps_hash = hashlib.sha256(deps_stable).hexdigest()[:12]
    versioned = pdf_bytes + PROMPT_VERSION.encode() + deps_hash.encode()
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
10. CONDITION OBJECTS ONLY: A condition object may only have these keys: condition_text, note, min, typ, max, unit. Never add "id", "name", or any other key inside a condition object. Infineon-specific rows like Qg_sync, Qg_th, or any sub-variant parameter that does NOT match an id in the list below must be OMITTED entirely.
11. TABLE COLUMN FIDELITY: Map each numeric value to the EXACT column it appears in the datasheet table (Min / Typ / Max). If the "Typ" column cell is blank or a dash for a row, set "typ" to null — do NOT substitute a Min-column value into "typ". If only a single value exists in a row with no column header context, place it in "max" for absolute maximum ratings, or "typ" for typical operating specs where the column is explicitly labelled typical.
12. ZERO INFERENCE: Every numeric value you output MUST appear literally in the datasheet (in a table cell, specification line, or explicitly stated value). Do NOT calculate, estimate, or infer missing values. Do NOT use one parameter as a substitute for another (e.g. do not use tj_max as a thermal_shutdown threshold, do not use VCC_max as an OVP threshold). If a protection parameter (thermal_shutdown, OCP, OVP, etc.) has no dedicated threshold row in the datasheet, omit that parameter entirely — do not create an entry using a related operating limit.
13. EXHAUSTIVE CONDITIONS: When a parameter appears in multiple rows of a table (different test conditions, supply voltages, temperatures, load values, or operating modes), you MUST capture EVERY row as a separate condition entry. Scan the complete relevant table section before moving to the next parameter — do not stop after finding the first matching row.
14. ABSENCE HANDLING: If a parameter is absent from the datasheet, omit it entirely — do NOT create an entry with null values, zero as a placeholder, or any inferred substitute. Only output 0 when the datasheet explicitly specifies zero as the measured or rated value. If you find yourself writing a note containing phrases like "not explicitly documented", "no threshold specified", "not tested in production", or "assumed to be" — that is a signal to omit the entire parameter, not include it with that note.
15. QUALIFIER COUNT ACCURACY: For any parameter that counts peripherals or features with a capability qualifier (e.g. "motor-control capable timers", "timers with dead-time generation", "complementary output pairs", "channels with fault shutdown"), only count items that EXPLICITLY satisfy all stated criteria in the datasheet. Do not count items that partially match or are assumed to match based on general knowledge about the vendor or product family. When in doubt, report 0 and let the user override.
16. DATA FIDELITY: Write condition_text in compact notation — Symbol=ValueUnit pairs separated by commas (e.g. VGS=10V, ID=75A, TC=25°C). No spaces around =. Use the datasheet's own symbols, not spelled-out names. Preserve exact numeric precision as printed in the datasheet — do not round, truncate, or reformat numeric values.
17. PART / GRADE VARIANTS: When a parameter differs by part number suffix, temperature grade, speed grade, voltage grade, or package variant, extract each variant as a separate condition entry with the distinguishing factor stated in condition_text (e.g. "C suffix, TA=-40 to 85°C", "V suffix, TA=-40 to 105°C", "M suffix, TA=-40 to 125°C"). Do not merge multiple grade variants into a single combined min/max span.

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
10. HIGH-SIDE / LOW-SIDE SPLIT: For any parameter specified separately for high-side (HO/HI) and low-side (LO/LI) outputs — including io_source, io_sink, prop_delay_on, prop_delay_off, vil, vih, rise_time_out, fall_time_out — extract EACH as a SEPARATE condition entry. Do NOT merge them into one condition. Put the output channel in condition_text (e.g. "Low-side output, VLO=0V" and "High-side output, VHO=0V").
11. TABLE COLUMN FIDELITY: Map each numeric value to the EXACT column it appears in the datasheet table (Min / Typ / Max). If the "Typ" column cell is blank or a dash for a row, set "typ" to null — do NOT substitute a Min-column value into "typ". If only a single value exists in a row with no column header context, place it in "max" for absolute maximum ratings, or "typ" for typical operating specs where the column is explicitly labelled typical.
12. ZERO INFERENCE: Every numeric value you output MUST appear literally in the datasheet (in a table cell, specification line, or explicitly stated value). Do NOT calculate, estimate, or infer missing values. Do NOT use one parameter as a substitute for another (e.g. do not use tj_max as a thermal_shutdown threshold, do not use VCC_max as an OVP threshold). If a protection parameter (thermal_shutdown, OCP, OVP, etc.) has no dedicated threshold row in the datasheet, omit that parameter entirely — do not create an entry using a related operating limit.
13. EXHAUSTIVE CONDITIONS: When a parameter appears in multiple rows of a table (different test conditions, supply voltages, temperatures, load values, or operating modes), you MUST capture EVERY row as a separate condition entry. Scan the complete relevant table section before moving to the next parameter — do not stop after finding the first matching row.
14. ABSENCE HANDLING: If a parameter is absent from the datasheet, omit it entirely — do NOT create an entry with null values, zero as a placeholder, or any inferred substitute. Only output 0 when the datasheet explicitly specifies zero as the measured or rated value. If you find yourself writing a note containing phrases like "not explicitly documented", "no threshold specified", "not tested in production", or "assumed to be" — that is a signal to omit the entire parameter, not include it with that note.
15. QUALIFIER COUNT ACCURACY: For any parameter that counts peripherals or features with a capability qualifier (e.g. "motor-control capable timers", "timers with dead-time generation", "complementary output pairs", "channels with fault shutdown"), only count items that EXPLICITLY satisfy all stated criteria in the datasheet. Do not count items that partially match or are assumed to match based on general knowledge about the vendor or product family. When in doubt, report 0 and let the user override.
16. DATA FIDELITY: Write condition_text in compact notation — Symbol=ValueUnit pairs separated by commas (e.g. VCC=12V, CLOAD=1000pF, TA=25°C). No spaces around =. Use the datasheet's own symbols, not spelled-out names. Preserve exact numeric precision as printed in the datasheet — do not round, truncate, or reformat numeric values.
17. PART / GRADE VARIANTS: When a parameter differs by part number suffix, temperature grade, speed grade, voltage grade, or package variant, extract each variant as a separate condition entry with the distinguishing factor stated in condition_text (e.g. "C suffix, TA=-40 to 85°C", "V suffix, TA=-40 to 105°C", "M suffix, TA=-40 to 125°C"). Do not merge multiple grade variants into a single combined min/max span.

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
10. TABLE COLUMN FIDELITY: Map each numeric value to the EXACT column it appears in the datasheet table (Min / Typ / Max). If the "Typ" column cell is blank or a dash for a row, set "typ" to null — do NOT substitute a Min-column value into "typ". If only a single value exists in a row with no column header context, place it in "max" for absolute maximum ratings, or "typ" for typical operating specs where the column is explicitly labelled typical.
11. ZERO INFERENCE: Every numeric value you output MUST appear literally in the datasheet (in a table cell, specification line, or explicitly stated value). Do NOT calculate, estimate, or infer missing values. Do NOT use one parameter as a substitute for another. If a parameter has no dedicated row in the datasheet, omit it entirely — do not create an entry using a related operating limit or general knowledge.
12. EXHAUSTIVE CONDITIONS: When a parameter appears in multiple rows of a table (different test conditions, supply voltages, temperatures, load values, or operating modes), you MUST capture EVERY row as a separate condition entry. Scan the complete relevant table section before moving to the next parameter — do not stop after finding the first matching row.
13. ABSENCE HANDLING: If a parameter is absent from the datasheet, omit it entirely — do NOT create an entry with null values, zero as a placeholder, or any inferred substitute. Only output 0 when the datasheet explicitly specifies zero as the measured or rated value. If you find yourself writing a note containing phrases like "not explicitly documented", "no threshold specified", "not tested in production", or "assumed to be" — that is a signal to omit the entire parameter, not include it with that note.
14. QUALIFIER COUNT ACCURACY: For any parameter that counts peripherals or features with a capability qualifier (e.g. "motor-control capable timers", "timers with dead-time generation", "complementary output pairs"), only count items that EXPLICITLY satisfy all stated criteria in the datasheet. Do not count items that partially match or are assumed to match based on general knowledge about the vendor or product family. When in doubt, report 0 and let the user override.
15. DATA FIDELITY: Write condition_text in compact notation — Symbol=ValueUnit pairs separated by commas (e.g. fCPU=40MHz, VDD=5V, TA=25°C). No spaces around =. Use the datasheet's own symbols, not spelled-out names. Preserve exact numeric precision as printed in the datasheet — do not round, truncate, or reformat numeric values.
16. PART / GRADE VARIANTS: When a parameter differs by part number suffix, temperature grade, speed grade, voltage grade, or package variant, extract each variant as a separate condition entry with the distinguishing factor stated in condition_text (e.g. "C suffix, TA=-40 to 85°C", "V suffix, TA=-40 to 105°C", "M suffix, TA=-40 to 125°C"). Do not merge multiple grade variants into a single combined min/max span.

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
  Note: Extract all voltage-dependent conditions from the Recommended Operating Conditions table as separate condition entries (e.g. VCC=1.8V→6MHz, VCC=2.7V→12MHz, VCC=3.3V→16MHz)

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
  Note: Count ONLY timers that the datasheet EXPLICITLY documents as having ALL THREE of: (1) a hardware dead-time generation register, (2) complementary output pairs (e.g. CHxN on STM32, FTM complementary mode on Kinetis, MCPWM on ESP32), AND (3) a fault/break shutdown input. Standard TPM modules, basic GPT timers, TIM2–TIM5 class general-purpose timers, and any timer described only as "PWM" or "capture/compare" do NOT qualify — report 0 for those. If none qualify, report 0.

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


# ─── All param IDs per block — used to detect what Pass 1 missed for Pass 2 ──
# Includes every id defined in the prompts (essential + good-to-have).
# The UI decides how to classify each param; the backend just tries to get them all.
ALL_PARAM_IDS = {
    "mosfet": {
        # essential
        "vds_max","id_cont","rds_on","vgs_th","qg","qgd","qgs",
        "qrr","trr","coss","td_on","tr","td_off","tf",
        "rth_jc","rth_ja","tj_max","body_diode_vf",
        "vgs_max","ciss","rg_int","qoss","avalanche_energy","avalanche_current",
        # good-to-have
        "id_pulsed","crss","vgs_plateau",
    },
    "driver": {
        # essential
        "vcc_range","vcc_uvlo","vbs_max","vbs_uvlo","io_source","io_sink",
        "prop_delay_on","prop_delay_off","deadtime_min","deadtime_default",
        "vil","vih","rth_ja","tj_max",
        "current_sense_gain","rise_time_out","fall_time_out",
        # good-to-have
        "ocp_threshold","ocp_response","thermal_shutdown","idd_quiescent",
    },
    "mcu": {
        # essential
        "cpu_freq_max","adc_resolution","adc_channels","adc_sample_rate",
        "pwm_timers","pwm_resolution","pwm_deadtime_res","pwm_deadtime_max",
        "complementary_outputs","vdd_range","adc_ref",
        # good-to-have
        "flash_size","ram_size","spi_count","uart_count","idd_run",
        "temp_range","gpio_count","encoder_interface","can_count","dma_channels",
    },
}

# ─── Unit alias normalisation ─────────────────────────────────────────────────
# Gemini occasionally uses non-standard unit strings; normalise before caching.
_UNIT_ALIASES: dict[str, str] = {
    "mohm": "mΩ", "mOhm": "mΩ", "milliohm": "mΩ", "milli-ohm": "mΩ",
    "kohm": "kΩ", "kilohm": "kΩ", "kiloohm": "kΩ",
    "nc": "nC", "nanocoulomb": "nC", "nanocoulombs": "nC",
    "pc": "pC", "picocoulomb": "pC",
    "pf": "pF", "picofarad": "pF", "picofarads": "pF",
    "nf": "nF", "nanofarad": "nF",
    "ns": "ns", "nanosecond": "ns", "nanoseconds": "ns",
    "us": "µs", "µs": "µs", "microsecond": "µs", "microseconds": "µs",
    "degc": "°C", "deg c": "°C", "celsius": "°C",
    "degf": "°F",
    "mv": "mV", "millivolt": "mV",
    "ma": "mA", "milliamp": "mA", "milliampere": "mA",
}

# ─── Per-param alias lookup for targeted re-extraction prompts ────────────────
# Compact alias lines — enough for Gemini to locate the param in a re-pass.
_PARAM_ALIASES: dict[str, str] = {
    # MOSFET
    "vds_max":          "VDSS · V(BR)DSS · BVdss · VDS(max) · Drain-Source Breakdown Voltage",
    "id_cont":          "ID · I_D · ID(cont) · IDS · Continuous Drain Current",
    "rds_on":           "RDS(ON) · Rdson · RDS,on · Ron · On-Resistance · Static Drain-Source On-Resistance",
    "vgs_th":           "VGS(th) · VGS(TH) · VT · Vth · Gate Threshold Voltage",
    "qg":               "Qg · QG · Qgate · Total Gate Charge",
    "qgd":              "Qgd · QGD · Gate-Drain Charge · Miller Charge",
    "qgs":              "Qgs · QGS · Gate-Source Charge",
    "qrr":              "Qrr · QRR · Body Diode Reverse Recovery Charge",
    "trr":              "trr · t_rr · Reverse Recovery Time · Body Diode Recovery Time",
    "coss":             "Coss · C_oss · Output Capacitance",
    "td_on":            "td(on) · t_d(on) · Turn-On Delay Time",
    "tr":               "tr · t_r · Rise Time",
    "td_off":           "td(off) · t_d(off) · Turn-Off Delay Time",
    "tf":               "tf · t_f · Fall Time",
    "rth_jc":           "Rth(j-c) · RθJC · RthJC · θJC · Thermal Resistance Junction-to-Case",
    "rth_ja":           "RθJA · Rth(j-a) · RthJA · θJA · Thermal Resistance Junction-to-Ambient",
    "tj_max":           "TJ(max) · TjMAX · Tjmax · Maximum Junction Temperature",
    "body_diode_vf":    "Vsd · VSD · VF(body) · Vf · Body Diode Forward Voltage",
    "vgs_max":          "VGSS · VGS(max) · Gate-Source Voltage Rating",
    "ciss":             "Ciss · C_iss · Input Capacitance · CGS+CGD",
    "crss":             "Crss · C_rss · Reverse Transfer Capacitance · Miller Capacitance",
    "rg_int":           "Rg · RG · Rint · Internal Gate Resistance",
    "qoss":             "Qoss · Q_oss · Output Charge",
    "avalanche_energy": "Eas · EAS · Single-Pulse Avalanche Energy",
    "avalanche_current":"Ias · IAS · Single-Pulse Avalanche Current",
    "id_pulsed":        "IDM · I_DM · IDpulse · Peak Drain Current",
    "vgs_plateau":      "VGS(pl) · Vplateau · Gate Plateau · Miller Plateau Voltage",
    # Gate driver
    "vcc_range":        "VCC · VS · VSUPPLY · Supply Voltage · Operating Supply Voltage",
    "vcc_uvlo":         "UVLO · VCC_UVLO · Under-Voltage Lock-Out threshold",
    "vbs_max":          "VBS · VBOOT · VB · Bootstrap Voltage Max",
    "vbs_uvlo":         "VBS_UVLO · VBOOT_UVLO · Bootstrap UVLO",
    "io_source":        "IO+ · IOH · I_source · Peak Source Current · Turn-on drive current",
    "io_sink":          "IO- · IOL · I_sink · Peak Sink Current · Turn-off drive current",
    "prop_delay_on":    "tpd_on · tPLH · td(on) · Propagation Delay Turn-On",
    "prop_delay_off":   "tpd_off · tPHL · td(off) · Propagation Delay Turn-Off",
    "deadtime_min":     "DT_min · tDT_min · Minimum Dead Time",
    "deadtime_default": "DT_typ · tDT_typ · Default Dead Time · Fixed Dead Time",
    "vil":              "VIL · VIN(L) · Input Low Threshold",
    "vih":              "VIH · VIN(H) · Input High Threshold",
    "current_sense_gain":"CSA Gain · GAIN · Current Sense Amplifier Gain",
    "rise_time_out":    "tr(out) · Output Rise Time · Driver Output Rise Time",
    "fall_time_out":    "tf(out) · Output Fall Time · Driver Output Fall Time",
    "ocp_threshold":    "OCP · IOCP · ITRIP · Overcurrent Trip Level",
    "ocp_response":     "tBLANK · tOCP · OCP Blanking Time",
    "thermal_shutdown": "TSD · T_SD · Thermal Shutdown Temperature",
    "idd_quiescent":    "IDD · IQ · ICC · Quiescent current · Operating current",
    # MCU
    "cpu_freq_max":     "FMAX · fCPU · SYSCLK_max · Maximum Operating Frequency",
    "adc_resolution":   "ADC bits · ADC Resolution · ADC bit width",
    "adc_channels":     "ADC channels · Number of ADC inputs · Analog input channels",
    "adc_sample_rate":  "ADC sampling rate · Conversion time · MSPS · ksps · ADC throughput",
    "pwm_timers":       "Advanced-control timers · Motor control timers · TIM1 · TIM8",
    "pwm_resolution":   "Timer resolution · Counter resolution · PWM bit depth · Timer width",
    "pwm_deadtime_res": "DTG resolution · Dead-time resolution · Dead-time step",
    "pwm_deadtime_max": "DTG max · Maximum dead-time · Max programmable dead time",
    "complementary_outputs": "Complementary pairs · CHxN outputs · High-side/Low-side pairs",
    "vdd_range":        "VDD · Supply voltage range · Operating voltage range · VCC range",
    "adc_ref":          "VREF · VREF+ · ADC reference · VDDA · Analog reference voltage",
    "flash_size":       "Flash · Program memory · ROM size · Flash capacity",
    "ram_size":         "SRAM · RAM · Data memory · SRAM capacity",
    "spi_count":        "SPI · SPIM · SSP · Number of SPI",
    "uart_count":       "UART · USART · Serial · Number of UART",
    "idd_run":          "IDD(run) · ICC(run) · Active current · Operating current",
    "temp_range":       "Ambient temperature range · TA · Temperature rating",
    "gpio_count":       "I/O pins · GPIO · Digital I/Os",
    "encoder_interface":"QEP · Encoder timer · Hall sensor input · Quadrature encoder interface",
    "can_count":        "CAN · CANbus · FDCAN · Number of CAN",
    "dma_channels":     "DMA · Direct memory access channels · DMA streams",
}

_log = logging.getLogger(__name__)


def _normalise_units(data: dict) -> None:
    for param in data.get("parameters", []):
        for cond in param.get("conditions", []):
            u = cond.get("unit") or ""
            cond["unit"] = _UNIT_ALIASES.get(u.strip(), _UNIT_ALIASES.get(u.strip().lower(), u))


def _parse_raw(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE).strip()
    raw = re.sub(r"```\s*$",          "", raw, flags=re.MULTILINE).strip()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        repaired = repair_json(raw, return_objects=True)
        if not isinstance(repaired, dict):
            raise ValueError(f"Non-parseable output.\nFirst 400 chars:\n{raw[:400]}")
        result = repaired
    # Guard: ensure minimum structure so downstream code doesn't silently get empty data
    if not isinstance(result, dict):
        raise ValueError("Extraction returned non-dict JSON")
    if "parameters" not in result:
        result["parameters"] = []
    if not isinstance(result["parameters"], list):
        result["parameters"] = []
    return result


# ─── Confidence check ────────────────────────────────────────────────────────
# Params where 0 is a legitimate extracted value (not a hallucination/placeholder)
_ZERO_OK_PARAMS = {"pwm_timers", "complementary_outputs", "pwm_deadtime_res", "pwm_deadtime_max"}

# Phrases in a note field that signal the model fabricated rather than found the value
_SUSPICIOUS_NOTE_PHRASES = (
    "not explicitly documented",
    "no threshold specified",
    "not tested in production",
    "not tested",
    "assumed to be",
    "assumed",
    "not explicitly",
    "no explicit",
)


def _confidence_check(block_type: str, params: list) -> set[str]:
    """Return set of calc-critical param IDs whose extracted data looks unreliable.

    Criteria (any one triggers low confidence for that param):
      1. Only a single non-null value across min/typ/max — likely a column-mapping error.
      2. Note field contains language the model uses when fabricating rather than reading.
      3. A numeric calc-critical param was extracted as exactly 0 when 0 is not valid.
    """
    calc_critical = CALC_DEPS.get(block_type, set())
    param_map = {p["id"]: p for p in params if p.get("id") in calc_critical}
    low_conf: set[str] = set()

    for pid, param in param_map.items():
        for cond in param.get("conditions", []):
            # Criterion 1: exactly one of min/typ/max populated
            populated = sum(1 for k in ("min", "typ", "max") if cond.get(k) is not None)
            if populated == 1:
                low_conf.add(pid)
                break

            # Criterion 2: suspicious note language
            note = (cond.get("note") or "").lower()
            if any(phrase in note for phrase in _SUSPICIOUS_NOTE_PHRASES):
                low_conf.add(pid)
                break

            # Criterion 3: zero value for a param where zero is not valid
            if pid not in _ZERO_OK_PARAMS:
                val = cond.get("typ") if cond.get("typ") is not None else cond.get("max")
                if val is None:
                    val = cond.get("min")
                if val == 0:
                    low_conf.add(pid)
                    break

    return low_conf


def _build_targeted_prompt(block_type: str, target_ids: set[str]) -> str:
    lines = [
        "You are a power electronics engineer performing a VERIFICATION PASS on a datasheet.",
        "Re-extract the parameters listed below INDEPENDENTLY.",
        "Do NOT carry over or assume values from any prior extraction — read the datasheet fresh.",
        "Some parameters may have been extracted before (re-verification); others may be new.",
        "In all cases: locate the actual value in the datasheet and report exactly what is there.",
        "",
        "Return ONLY valid JSON in this exact format (no markdown, no preamble):",
        '{"parameters": [{"id": "exact_id", "name": "name", "symbol": "sym", "category": "cat",',
        '  "conditions": [{"condition_text": "...", "note": null,',
        '    "min": null, "typ": null, "max": null, "unit": "unit"}]}]}',
        "",
        "CRITICAL RULES:",
        "- Use the exact id strings listed below.",
        "- Capture ALL conditions (all table rows) for each parameter.",
        "- TABLE COLUMN FIDELITY: Map each value to its exact Min/Typ/Max column.",
        "  If the Typ cell is blank or a dash, set typ to null — never put a Min-column value into typ.",
        "- ZERO INFERENCE: Every value must appear literally in the datasheet.",
        "  Do not fabricate, estimate, or use one param as a proxy for another.",
        "- ABSENCE HANDLING: If a parameter is genuinely absent, omit it entirely.",
        "  Do NOT emit it with null values or a note saying 'not documented'.",
        "",
        "PARAMETERS TO FIND OR RE-VERIFY:",
    ]
    for pid in sorted(target_ids):
        aliases = _PARAM_ALIASES.get(pid, pid)
        lines.append(f'  id="{pid}"  Aliases: {aliases}')
    return "\n".join(lines)


# ─── Main extraction function ─────────────────────────────────────────────────

async def extract_parameters_from_pdf(pdf_bytes: bytes, block_type: str, api_keys: list[str]) -> dict:
    prompts = {"mosfet": MOSFET_PROMPT, "driver": DRIVER_PROMPT, "mcu": MCU_PROMPT}
    if block_type not in prompts:
        raise ValueError(f"Unknown block type: {block_type}")

    # Normalise: strip blanks, deduplicate, keep order
    api_keys = list(dict.fromkeys(k.strip() for k in api_keys if k.strip()))
    if not api_keys:
        raise ValueError("No valid API key provided")

    # Check cache first
    pdf_hash = _pdf_hash(pdf_bytes, block_type)
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
        prompt = prompts[block_type]

        def _call_gemini():
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                    tmp.write(pdf_bytes)
                    tmp_path = tmp.name

                # ── Helpers ───────────────────────────────────────────────

                def _upload(api_key):
                    client = genai.Client(api_key=api_key)
                    with open(tmp_path, "rb") as f:
                        uf = client.files.upload(
                            file=f,
                            config=genai_types.UploadFileConfig(
                                mime_type="application/pdf",
                                display_name="datasheet.pdf",
                            ),
                        )
                    max_wait = 120  # seconds
                    waited = 0
                    while uf.state.name == "PROCESSING":
                        if waited >= max_wait:
                            raise TimeoutError("Gemini file processing timed out after 2 minutes — try re-uploading")
                        time.sleep(2)
                        waited += 2
                        uf = client.files.get(name=uf.name)
                    if uf.state.name == "FAILED":
                        raise ValueError("Gemini file processing failed — try re-uploading")
                    return client, uf

                def _delete(client, uf):
                    try:
                        client.files.delete(name=uf.name)
                    except Exception:
                        pass

                def _generate(client, uf, prompt_text, label):
                    backoff = [5, 10, 20, 40, 60]
                    for attempt in range(len(backoff) + 1):
                        try:
                            resp = client.models.generate_content(
                                model="gemini-3-flash-preview",
                                contents=[uf, prompt_text],
                                config=genai_types.GenerateContentConfig(
                                    temperature=1,
                                    max_output_tokens=65536,
                                    response_mime_type="application/json",
                                    thinking_config=genai_types.ThinkingConfig(
                                        thinking_budget=8000,
                                    ),
                                ),
                            )
                            return resp.text
                        except genai_errors.ServerError as e:
                            if attempt < len(backoff):
                                wait = backoff[attempt]
                                _log.warning(
                                    "[%s] %s: 503 (attempt %d) — retrying in %ds",
                                    block_type, label, attempt + 1, wait,
                                )
                                time.sleep(wait)
                            else:
                                raise
                        except genai_errors.ClientError:
                            raise  # 429 — let caller handle rotation

                # ── Pass 1: try each key until one works ──────────────────

                data = None
                pass1_key_idx = None
                last_error = None

                for key_idx, api_key in enumerate(api_keys):
                    label = f"key {key_idx + 1}/{len(api_keys)} Pass 1"
                    client, uf = None, None
                    try:
                        client, uf = _upload(api_key)
                        raw1 = _generate(client, uf, prompt, label)
                        data = _parse_raw(raw1)
                        pass1_key_idx = key_idx
                        _log.info("[%s] Pass 1 done with key %d/%d", block_type, key_idx + 1, len(api_keys))
                        break
                    except genai_errors.ClientError as e:
                        last_error = e
                        _log.warning(
                            "[%s] Key %d/%d Pass 1 → 429%s",
                            block_type, key_idx + 1, len(api_keys),
                            " — rotating" if key_idx < len(api_keys) - 1 else " — no more keys",
                        )
                    finally:
                        if uf and client:
                            _delete(client, uf)

                if data is None:
                    raise last_error or RuntimeError("All API keys exhausted on Pass 1")

                # ── Pass 2: verification + recovery ──────────────────────
                # Triggers when:
                #   (a) any param from ALL_PARAM_IDS is missing, OR
                #   (b) any calc-critical param shows low-confidence signals
                # Targets: ALL missing params + entire CALC_DEPS set (always re-verified).
                # Merge rule: Pass 2 answer overwrites Pass 1 for calc-critical params
                #             (independent blind read); for newly found missing params, appends.

                extracted_ids = {p["id"] for p in data.get("parameters", [])}
                missing = ALL_PARAM_IDS.get(block_type, set()) - extracted_ids
                low_conf_ids = _confidence_check(block_type, data.get("parameters", []))
                calc_deps = CALC_DEPS.get(block_type, set())

                should_run_pass2 = bool(missing) or bool(low_conf_ids)

                if should_run_pass2:
                    pass2_targets = missing | calc_deps

                    if missing and low_conf_ids:
                        _log.warning(
                            "[%s] Pass 2: %d missing %s + low confidence on %s — rechecking",
                            block_type, len(missing), sorted(missing), sorted(low_conf_ids),
                        )
                    elif missing:
                        _log.warning(
                            "[%s] Pass 2: %d missing %s + re-verifying %d calc-critical param(s)",
                            block_type, len(missing), sorted(missing), len(calc_deps),
                        )
                    else:
                        _log.warning(
                            "[%s] Pass 2: low confidence on %s — re-verifying calc-critical params",
                            block_type, sorted(low_conf_ids),
                        )

                    targeted_prompt = _build_targeted_prompt(block_type, pass2_targets)
                    pass2_done = False

                    for key_idx in range(pass1_key_idx, len(api_keys)):
                        label = f"key {key_idx + 1}/{len(api_keys)} Pass 2"
                        client2, uf2 = None, None
                        try:
                            client2, uf2 = _upload(api_keys[key_idx])
                            raw2 = _generate(client2, uf2, targeted_prompt, label)
                            data2 = _parse_raw(raw2)

                            pass2_param_map = {p["id"]: p for p in data2.get("parameters", [])}
                            overwritten, recovered = [], []

                            for pid, param in pass2_param_map.items():
                                if pid in calc_deps:
                                    # Overwrite Pass 1 answer with independent Pass 2 read
                                    data["parameters"] = [
                                        p for p in data["parameters"] if p["id"] != pid
                                    ]
                                    data["parameters"].append(param)
                                    overwritten.append(pid)
                                elif pid not in extracted_ids:
                                    # Newly recovered missing param — just append
                                    data["parameters"].append(param)
                                    recovered.append(pid)

                            if overwritten:
                                _log.info(
                                    "[%s] Pass 2 overwrote calc-critical: %s (key %d/%d)",
                                    block_type, sorted(overwritten), key_idx + 1, len(api_keys),
                                )
                            if recovered:
                                _log.info(
                                    "[%s] Pass 2 recovered missing: %s (key %d/%d)",
                                    block_type, sorted(recovered), key_idx + 1, len(api_keys),
                                )

                            pass2_done = True
                            break
                        except genai_errors.ClientError:
                            _log.warning(
                                "[%s] Key %d/%d Pass 2 → 429%s",
                                block_type, key_idx + 1, len(api_keys),
                                " — rotating" if key_idx < len(api_keys) - 1 else " — no more keys",
                            )
                        except Exception as e2:
                            _log.error("[%s] Pass 2 failed (non-quota): %s", block_type, e2)
                            break  # don't rotate on non-quota errors
                        finally:
                            if uf2 and client2:
                                _delete(client2, uf2)

                    if not pass2_done:
                        _log.warning("[%s] Pass 2 exhausted all keys — returning Pass 1 data only", block_type)

                # Always report any params still absent after all passes
                still_missing = ALL_PARAM_IDS.get(block_type, set()) - {
                    p["id"] for p in data.get("parameters", [])
                }
                if still_missing:
                    _log.warning("[%s] Final missing params: %s", block_type, sorted(still_missing))
                    data["_warnings"] = [f"Missing essential param: {pid}" for pid in still_missing]

                return data

            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except Exception:
                        pass

        try:
            data = await asyncio.wait_for(asyncio.to_thread(_call_gemini), timeout=600)
        except asyncio.TimeoutError:
            raise TimeoutError("Extraction timed out after 10 minutes — try a smaller PDF or re-upload")

        # ── Post-process ──────────────────────────────────────────────────
        _normalise_units(data)
        for param in data.get("parameters", []):
            for cond in param.get("conditions", []):
                cond["selected"] = _pick(cond, param.get("id", ""))
                cond["override"] = None

        # Save to cache
        _save_cache(block_type, pdf_hash, data)

        return data
    finally:
        # Signal waiters and clean up
        done_event.set()
        async with _inflight_lock:
            _inflight.pop(dedup_key, None)


# For thermal resistance params, use max (worst case) not typ — safety-critical for junction temp calc
_THERMAL_RESISTANCE_IDS = {"rth_jc", "rth_ja"}

def _pick(cond: dict, param_id: str = ""):
    if param_id in _THERMAL_RESISTANCE_IDS:
        if cond.get("max") is not None: return cond["max"]
        if cond.get("typ") is not None: return cond["typ"]
        return cond.get("min")
    if cond.get("typ") is not None: return cond["typ"]
    if cond.get("max") is not None: return cond["max"]
    return cond.get("min")
