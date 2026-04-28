/** Centralized API helpers */

const BASE = import.meta.env.VITE_API_URL || ''  // URL from env in prod, proxied in dev

// Long timeout for PDF extraction (Gemini can take several minutes)
const EXTRACT_TIMEOUT_MS = 660_000  // 11 min (backend times out at 10 min)
const DEFAULT_TIMEOUT_MS = 30_000

async function _req(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + url, { ...opts, signal: controller.signal })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = await res.json()
        msg = j.detail || j.message || msg
      } catch { /* response body not JSON — keep HTTP status message */ }
      throw new Error(msg)
    }
    return res
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out — check your connection or try again')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Extract parameters from a PDF datasheet — apiKeys can be a string or string[] */
export async function extractDatasheet(blockType, file, apiKeys) {
  const keys = Array.isArray(apiKeys) ? apiKeys : [apiKeys]
  const form = new FormData()
  form.append('file', file)
  const res = await _req(
    `/api/extract/${blockType}`,
    { method: 'POST', headers: { 'X-API-Keys': keys.filter(Boolean).join(',') }, body: form },
    EXTRACT_TIMEOUT_MS,
  )
  return (await res.json()).data
}

/** Run all calculations */
export async function runCalculations(payload) {
  const res = await _req('/api/calculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await res.json()).data
}

/** Run reverse calculations (target → component values) */
export async function runReverseCalculation(payload) {
  const res = await _req('/api/reverse-calculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await res.json()).data
}

/** Download PDF report — returns a Blob */
export async function downloadReport(project, calculations, format) {
  const res = await _req('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, calculations, format }),
  })
  return res.blob()
}

/** Download SPICE netlist — returns a Blob */
export async function downloadSpice(systemSpecs, calculations, mosfetParams) {
  const res = await _req('/api/export/spice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_specs: systemSpecs, calculations, mosfet_params: mosfetParams }),
  })
  return res.blob()
}

/** Fetch design constants from backend schema */
export async function fetchDesignConstants() {
  const res = await _req('/api/design-constants')
  return (await res.json()).data
}

/** Health check */
export async function healthCheck() {
  const res = await _req('/api/health')
  return res.json()
}

/** Test API key health — returns array of {key_suffix, status} */
export async function checkKeyHealth(keys) {
  const res = await _req('/api/key-health', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  })
  const data = await res.json()
  return data.results
}
