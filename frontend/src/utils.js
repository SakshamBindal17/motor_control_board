/** Shared utilities */

/** Format a number nicely for display */
export function fmtNum(val, decimals = 3) {
  if (val === null || val === undefined || val === '') return '—'
  const n = parseFloat(val)
  if (isNaN(n)) return String(val)
  if (Math.abs(n) >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3)  return (n / 1e3).toFixed(2) + 'k'
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
}

/** Format with unit */
export function fmtVal(val, unit = '', decimals = 3) {
  const s = fmtNum(val, decimals)
  if (s === '—') return '—'
  return unit ? `${s} ${unit}` : s
}

/** Block status → badge class */
export function statusBadgeClass(status) {
  return {
    idle:       'badge-idle',
    uploading:  'badge-busy',
    extracting: 'badge-busy',
    done:       'badge-done',
    error:      'badge-error',
  }[status] || 'badge-idle'
}

/** Block status → dot class */
export function statusDotClass(status) {
  return {
    idle:       'dot-idle',
    uploading:  'dot-busy',
    extracting: 'dot-busy',
    done:       'dot-done',
    error:      'dot-error',
  }[status] || 'dot-idle'
}

/** Block status → label */
export function statusLabel(status) {
  return {
    idle:       'Not started',
    uploading:  'Uploading…',
    extracting: 'Extracting…',
    done:       'Complete',
    error:      'Error',
  }[status] || 'Unknown'
}

/** Save a blob to disk */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href    = url
  a.download= filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Deep-get nested value safely */
export function deepGet(obj, path, fallback = undefined) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : fallback), obj) ?? fallback
}

/** Returns CSS color class based on value threshold */
export function thresholdClass(val, warnAbove, dangerAbove) {
  if (dangerAbove !== undefined && val >= dangerAbove) return 'danger'
  if (warnAbove  !== undefined && val >= warnAbove)  return 'warn'
  return ''
}
