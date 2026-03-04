/** Centralized API helpers */

const BASE = ''  // proxied via vite to localhost:8000

async function _req(url, opts = {}) {
  const res = await fetch(BASE + url, opts)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j.detail || j.message || msg } catch {}
    throw new Error(msg)
  }
  return res
}

/** Extract parameters from a PDF datasheet */
export async function extractDatasheet(blockType, file, apiKey) {
  const form = new FormData()
  form.append('file', file)
  const res = await _req(`/api/extract/${blockType}`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: form,
  })
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

/** Download PDF report — returns a Blob */
export async function downloadReport(project, calculations, format) {
  const res = await _req('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, calculations, format }),
  })
  return res.blob()
}

/** Health check */
export async function healthCheck() {
  const res = await _req('/api/health')
  return res.json()
}
