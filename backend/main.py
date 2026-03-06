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

app = FastAPI(title="MC Hardware Designer API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow all origins for easy cloud deployment (Vercel/Netlify)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Extraction ───────────────────────────────────────────────────────────────

@app.post("/api/extract/{block_type}")
async def extract_datasheet(
    block_type: str,
    file: UploadFile = File(...),
    x_api_key: str = Header(..., alias="X-API-Key"),
):
    if block_type not in ("mcu", "driver", "mosfet"):
        raise HTTPException(400, f"Unknown block type: {block_type}")
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")

    pdf_bytes = await file.read()
    if len(pdf_bytes) == 0:
        raise HTTPException(400, "Uploaded file is empty")
    if len(pdf_bytes) > 50 * 1024 * 1024:
        raise HTTPException(400, "PDF too large (max 50 MB)")

    logger.info(f"Extracting {block_type} from {file.filename} ({len(pdf_bytes)//1024} KB)")

    try:
        result = await extract_parameters_from_pdf(pdf_bytes, block_type, x_api_key)
        logger.info(f"Extracted {len(result.get('parameters', []))} parameters from {result.get('component_name', '?')}")
        return {"success": True, "data": result}
    except Exception as e:
        logger.error(f"Extraction error:\n{traceback.format_exc()}")
        # Return the real error message so user can debug
        raise HTTPException(500, f"{type(e).__name__}: {str(e)}")


# ─── Calculations ─────────────────────────────────────────────────────────────

class CalcRequest(BaseModel):
    system_specs: dict
    mosfet_params: dict
    driver_params: dict
    mcu_params: dict
    motor_specs: dict
    passives_overrides: Optional[dict] = {}

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
        )
        results = engine.run_all()
        return {"success": True, "data": results}
    except Exception as e:
        logger.error(f"Calc error:\n{traceback.format_exc()}")
        raise HTTPException(500, f"{type(e).__name__}: {str(e)}")


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
    except Exception as e:
        logger.error(f"Report error:\n{traceback.format_exc()}")
        raise HTTPException(500, f"{type(e).__name__}: {str(e)}")


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.0"}
