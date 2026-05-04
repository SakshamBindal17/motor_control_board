from fastapi import FastAPI, UploadFile, File, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
import json, io, traceback, logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from claude_service import extract_parameters_from_pdf
from calc_engine import CalculationEngine
from report_generator import generate_pdf_report, generate_excel_report
from spice_export import generate_spice_netlist

app = FastAPI(title="MC Hardware Designer API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Extraction ───────────────────────────────────────────────────────────────

@app.post("/api/extract/{block_type}")
async def extract_datasheet(
    block_type: str,
    file: UploadFile = File(...),
    x_api_keys: Optional[str] = Header(None, alias="X-API-Keys"),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    # Accept X-API-Keys (comma-separated list) or fallback to legacy X-API-Key
    if x_api_keys:
        api_keys = [k.strip() for k in x_api_keys.split(",") if k.strip()]
    elif x_api_key:
        api_keys = [x_api_key.strip()]
    else:
        raise HTTPException(400, "No API key provided — add X-API-Keys header")

    if block_type not in ("mcu", "driver", "mosfet"):
        raise HTTPException(400, f"Unknown block type: {block_type}")
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")

    pdf_bytes = await file.read()
    if len(pdf_bytes) == 0:
        raise HTTPException(400, "Uploaded file is empty")
    if len(pdf_bytes) > 50 * 1024 * 1024:
        raise HTTPException(400, "PDF too large (max 50 MB)")

    logger.info(f"Extracting {block_type} from {file.filename} ({len(pdf_bytes)//1024} KB) with {len(api_keys)} key(s)")

    try:
        result = await extract_parameters_from_pdf(pdf_bytes, block_type, api_keys)
        logger.info(f"Extracted {len(result.get('parameters', []))} parameters from {result.get('component_name', '?')}")
        return {"success": True, "data": result}
    except Exception as e:
        error_msg = str(e)
        # Sanitize: never leak API keys or auth tokens in responses
        if any(s in error_msg for s in ("API_KEY_INVALID", "PERMISSION_DENIED", "PermissionDenied", "401", "403")) or "api_key" in error_msg.lower():
            logger.error(f"Extraction auth error (details suppressed for security)")
            raise HTTPException(500, "Authentication error — check your Gemini API key in Settings")
        logger.error(f"Extraction error: {type(e).__name__}: {error_msg}")
        if "All API keys exhausted" in error_msg or "quota" in error_msg.lower():
            raise HTTPException(429, "All Gemini API keys have reached their quota. Add more keys in Settings or try again tomorrow.")
        if "timeout" in error_msg.lower() or "TimeoutError" in type(e).__name__:
            raise HTTPException(504, "Extraction timed out — the PDF may be too complex. Try a smaller file.")
        if "file processing failed" in error_msg.lower():
            raise HTTPException(500, "Gemini could not process the PDF. Try re-uploading or use a different file.")
        raise HTTPException(500, f"Extraction failed: {error_msg}")


# ─── Calculations ─────────────────────────────────────────────────────────────

class CalcRequest(BaseModel):
    system_specs: dict
    mosfet_params: dict
    driver_params: dict
    mcu_params: dict
    motor_specs: dict
    passives_overrides: Optional[dict] = None
    design_constants: Optional[dict] = None
    pcb_trace_thermal_params: Optional[dict] = None

@app.post("/api/calculate")
async def calculate(req: CalcRequest):
    try:
        engine = CalculationEngine(
            system_specs=req.system_specs,
            mosfet_params=req.mosfet_params,
            driver_params=req.driver_params,
            mcu_params=req.mcu_params,
            motor_specs=req.motor_specs,
            overrides=req.passives_overrides or {},
            design_constants=req.design_constants or {},
            pcb_trace_thermal_params=req.pcb_trace_thermal_params or {},
        )
        results = engine.run_all()
        return {"success": True, "data": results}
    except ValueError as e:
        raise HTTPException(422, f"Validation error: {str(e)}")
    except (KeyError, TypeError) as e:
        logger.error(f"Input schema error ({type(e).__name__}): {str(e)}")
        raise HTTPException(400, f"Input error: {type(e).__name__} - {str(e)}")
    except Exception as e:
        logger.error(f"Calc error: {type(e).__name__}: {str(e)}")
        raise HTTPException(500, f"Calculation failed: {str(e)}")


# ─── Reverse Calculations ─────────────────────────────────────────────────

class ReverseCalcRequest(BaseModel):
    system_specs: dict
    mosfet_params: dict
    driver_params: dict
    mcu_params: dict
    motor_specs: dict
    passives_overrides: Optional[dict] = None
    design_constants: Optional[dict] = None
    targets: dict  # { "gate_rise_time_ns": 25.0, ... }

@app.post("/api/reverse-calculate")
async def reverse_calculate(req: ReverseCalcRequest):
    try:
        engine = CalculationEngine(
            system_specs=req.system_specs,
            mosfet_params=req.mosfet_params,
            driver_params=req.driver_params,
            mcu_params=req.mcu_params,
            motor_specs=req.motor_specs,
            overrides=req.passives_overrides or {},
            design_constants=req.design_constants or {},
        )
        results = engine.reverse_calculate(req.targets)
        return {"success": True, "data": results}
    except ValueError as e:
        raise HTTPException(422, f"Validation error: {str(e)}")
    except Exception as e:
        logger.error(f"Reverse calc error: {type(e).__name__}: {str(e)}")
        raise HTTPException(500, f"Reverse calculation failed: {str(e)}")


# ─── Reports ──────────────────────────────────────────────────────────────────

class ReportRequest(BaseModel):
    project: dict
    calculations: dict
    format: str

@app.post("/api/report")
async def create_report(req: ReportRequest):
    try:
        if req.format == "pdf":
            buf = generate_pdf_report(req.project, req.calculations)
            return StreamingResponse(
                io.BytesIO(buf),
                media_type="application/pdf",
                headers={"Content-Disposition": "attachment; filename=mc_design_report.pdf"},
            )
        elif req.format == "excel":
            buf = generate_excel_report(req.project, req.calculations)
            return StreamingResponse(
                io.BytesIO(buf),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": "attachment; filename=mc_bom.xlsx"},
            )
        else:
            raise HTTPException(400, "Format must be 'pdf' or 'excel'")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Report error:\n{traceback.format_exc()}")
        raise HTTPException(500, f"Report generation failed: {str(e)}")


# ─── SPICE Export ────────────────────────────────────────────────────────────

class SpiceRequest(BaseModel):
    system_specs: dict
    calculations: dict
    mosfet_params: dict
    motor_specs: dict = None

@app.post("/api/export/spice")
async def export_spice(req: SpiceRequest):
    try:
        netlist = generate_spice_netlist(req.system_specs, req.calculations, req.mosfet_params, req.motor_specs)
        buf = io.BytesIO(netlist.encode('utf-8'))
        return StreamingResponse(
            buf,
            media_type="text/plain",
            headers={"Content-Disposition": "attachment; filename=mc_halfbridge.cir"},
        )
    except Exception as e:
        logger.error(f"SPICE export error:\n{traceback.format_exc()}")
        raise HTTPException(500, f"SPICE export failed: {str(e)}")


@app.get("/api/design-constants")
def get_design_constants():
    from calc_engine import DESIGN_CONSTANTS
    result = {}
    for key, (default, unit, cat, label, desc) in DESIGN_CONSTANTS.items():
        result[key] = {"default": default, "unit": unit, "category": cat, "label": label, "description": desc}
    return {"success": True, "data": result}


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.0"}


class KeyHealthRequest(BaseModel):
    keys: list[str]

@app.post("/api/key-health")
async def check_key_health(req: KeyHealthRequest):
    """Test each Gemini API key with a minimal request and return status per key."""
    from google import genai
    from google.genai import errors as genai_errors

    results = []
    for key in req.keys:
        key = key.strip()
        if not key:
            results.append({"key_suffix": "", "status": "empty"})
            continue
        suffix = f"…{key[-6:]}" if len(key) > 6 else key
        try:
            client = genai.Client(api_key=key)
            # Minimal token-count call — no file upload, minimal quota usage
            client.models.count_tokens(
                model="gemini-2.5-flash-preview-04-17",
                contents="ping"
            )
            results.append({"key_suffix": suffix, "status": "ok"})
        except genai_errors.ClientError as e:
            code = getattr(e, "status_code", None) or getattr(e, "code", None)
            if code == 429:
                results.append({"key_suffix": suffix, "status": "quota_exhausted"})
            elif code in (400, 401, 403):
                results.append({"key_suffix": suffix, "status": "invalid"})
            else:
                results.append({"key_suffix": suffix, "status": "error", "detail": str(e)[:80]})
        except Exception as e:
            results.append({"key_suffix": suffix, "status": "error", "detail": str(e)[:80]})
    return {"success": True, "results": results}
