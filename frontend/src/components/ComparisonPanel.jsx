import React, { useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'
import { extractDatasheet } from '../api.js'
import './ComparisonPanel.css'

const MAX_UPLOADS = 12


function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function toNum(v) {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function normUnit(unit) {
  return (unit || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/μ/g, 'u')
    .replace(/µ/g, 'u')
    .replace(/ω/g, 'ohm')
    .replace(/Ω/g, 'ohm')
    .replace(/°/g, '')
}

function convertUnit(value, fromUnit, targetUnit) {
  const v = toNum(value)
  if (!Number.isFinite(v)) return null
  const u = normUnit(fromUnit)

  if (targetUnit === 'v') {
    if (u === 'v') return v
    if (u === 'mv') return v / 1000
    return v
  }
  if (targetUnit === 'a') {
    if (u === 'a') return v
    if (u === 'ma') return v / 1000
    return v
  }
  if (targetUnit === 'ohm') {
    if (u === 'ohm') return v
    if (u === 'mohm') return v / 1000
    return v
  }
  if (targetUnit === 'mohm') {
    if (u === 'mohm') return v
    if (u === 'ohm') return v * 1000
    return v
  }
  if (targetUnit === 'nc') {
    if (u === 'nc') return v
    if (u === 'uc') return v * 1000
    if (u === 'c') return v * 1e9
    return v
  }
  if (targetUnit === 'pf') {
    if (u === 'pf') return v
    if (u === 'nf') return v * 1000
    if (u === 'uf') return v * 1e6
    if (u === 'f') return v * 1e12
    return v
  }
  if (targetUnit === 'ns') {
    if (u === 'ns') return v
    if (u === 'us') return v * 1000
    if (u === 'ms') return v * 1e6
    if (u === 's') return v * 1e9
    return v
  }
  if (targetUnit === 'c/w') {
    return v
  }

  return v
}

function pickCondition(param, conditionRegex) {
  const conds = param?.conditions || []
  if (!conds.length) return null
  if (!conditionRegex) return conds[0]
  const found = conds.find(c => conditionRegex.test(String(c.condition_text || '')))
  return found || conds[0]
}

function pickStatValue(cond, statOrder) {
  if (!cond) return null
  for (const key of statOrder) {
    const v = toNum(cond[key])
    if (Number.isFinite(v)) return v
  }
  return null
}

function extractValue(rawData, paramId, options = {}) {
  const {
    targetUnit,
    conditionRegex = null,
    statOrder = ['selected', 'typ', 'max', 'min'],
  } = options

  const param = (rawData?.parameters || []).find(p => p.id === paramId)
  if (!param) return null

  const cond = pickCondition(param, conditionRegex)
  const value = pickStatValue(cond, statOrder)
  if (!Number.isFinite(value)) return null
  if (!targetUnit) return value

  return convertUnit(value, cond?.unit || '', targetUnit)
}

function normalizeExtracted(rawData, fallbackName) {
  return {
    name: rawData?.component_name || fallbackName,
    manufacturer: rawData?.manufacturer || '',
    package: rawData?.package || '',
    vds_max: extractValue(rawData, 'vds_max', { targetUnit: 'v', statOrder: ['selected', 'max', 'typ', 'min'] }),
    id_max_25c: extractValue(rawData, 'id_cont', {
      targetUnit: 'a',
      conditionRegex: /(25\s*c|tc\s*=\s*25|tcase\s*=\s*25|tj\s*=\s*25)/i,
      statOrder: ['selected', 'max', 'typ', 'min'],
    }) ?? extractValue(rawData, 'id_cont', { targetUnit: 'a', statOrder: ['selected', 'max', 'typ', 'min'] }),
    rds_on_max_10v: extractValue(rawData, 'rds_on', {
      targetUnit: 'mohm',
      conditionRegex: /(vgs\s*=\s*10|10\s*v)/i,
      statOrder: ['max', 'selected', 'typ', 'min'],
    }) ?? extractValue(rawData, 'rds_on', { targetUnit: 'mohm', statOrder: ['max', 'selected', 'typ', 'min'] }),
    rds_on_typ_10v: extractValue(rawData, 'rds_on', {
      targetUnit: 'mohm',
      conditionRegex: /(vgs\s*=\s*10|10\s*v)/i,
      statOrder: ['typ', 'selected', 'max', 'min'],
    }) ?? extractValue(rawData, 'rds_on', { targetUnit: 'mohm', statOrder: ['typ', 'selected', 'max', 'min'] }),
    vgs_th_typ: extractValue(rawData, 'vgs_th', { targetUnit: 'v', statOrder: ['typ', 'selected', 'max', 'min'] }),
    qg_total: extractValue(rawData, 'qg', { targetUnit: 'nc' }),
    qgs: extractValue(rawData, 'qgs', { targetUnit: 'nc' }),
    qgd: extractValue(rawData, 'qgd', { targetUnit: 'nc' }),
    qrr: extractValue(rawData, 'qrr', { targetUnit: 'nc' }),
    trr: extractValue(rawData, 'trr', { targetUnit: 'ns' }),
    ciss: extractValue(rawData, 'ciss', { targetUnit: 'pf' }),
    coss: extractValue(rawData, 'coss', { targetUnit: 'pf' }),
    rg_internal: extractValue(rawData, 'rg_int', { targetUnit: 'ohm' }),
    rth_jc: extractValue(rawData, 'rth_jc', { targetUnit: 'c/w' }),
    td_on: extractValue(rawData, 'td_on', { targetUnit: 'ns' }),
    tr: extractValue(rawData, 'tr', { targetUnit: 'ns' }),
    td_off: extractValue(rawData, 'td_off', { targetUnit: 'ns' }),
    tf: extractValue(rawData, 'tf', { targetUnit: 'ns' }),
  }
}

function calcTiming(p, sys) {
  const N = sys.npar || 1
  const Qg = (p.qg_total || 120) * 1e-9 * N
  const Qgd = (p.qgd || 35) * 1e-9
  const Ciss = (p.ciss || 8000) * 1e-12
  const Rgi = p.rg_internal || 2.0
  const Vth = p.vgs_th_typ || 3.0
  const Vpl = Vth + 1.5
  const Rg_on = sys.rg_on + Rgi
  const Rg_off = sys.rg_off + Rgi

  const td_on = Ciss * Rg_on * Math.log(sys.vgs / Math.max(sys.vgs - Vth, 0.1))
  const td_off = Ciss * Rg_off * Math.log(sys.vgs / Math.max(sys.vgs - Vpl, 0.1))

  const Ig_on_pl = Math.max((sys.vgs - Vpl) / Rg_on, 0.05)
  const Ig_off_pl = Math.max(Vpl / Rg_off, 0.05)

  const t_rise = Qgd / Ig_on_pl
  const t_fall = Qgd / Ig_off_pl
  const t_on_tot = td_on + t_rise
  const t_off_tot = td_off + t_fall

  const Ig_on_pk = (sys.vgs / (Rg_on / N)) * 1000
  const Ig_off_pk = (sys.vgs / (Rg_off / N)) * 1000

  const dt_min = Math.max(t_fall * 1.3, t_rise * 1.3, 100e-9)
  const dt_rec = dt_min * 1.25
  const dt_pct = dt_rec * sys.fsw * 100

  const dVb = 0.5
  const Cb_min_nF = (Qg / dVb) * 1e9
  const Vboot = sys.vgs - sys.vf
  const Cb_act = sys.cb * 1e-6
  const dVb_act = Qg / Cb_act
  const Rboot = sys.rboot || 10
  const t_rech = 5 * Rboot * Cb_act
  const D_max = Math.max(0, Math.min((1 - t_rech * sys.fsw) * 100, 99))
  const cbOk = (sys.cb * 1000) >= Cb_min_nF

  return {
    Rg_on: Rg_on.toFixed(2),
    Rg_off: Rg_off.toFixed(2),
    Vpl: Vpl.toFixed(1),
    Ig_on_pk: Ig_on_pk.toFixed(0),
    Ig_off_pk: Ig_off_pk.toFixed(0),
    td_on: (td_on * 1e9).toFixed(1),
    td_off: (td_off * 1e9).toFixed(1),
    t_rise: (t_rise * 1e9).toFixed(1),
    t_fall: (t_fall * 1e9).toFixed(1),
    t_on_tot: (t_on_tot * 1e9).toFixed(1),
    t_off_tot: (t_off_tot * 1e9).toFixed(1),
    dt_min: (dt_min * 1e9).toFixed(0),
    dt_rec: (dt_rec * 1e9).toFixed(0),
    dt_pct: dt_pct.toFixed(2),
    Cb_min: Cb_min_nF.toFixed(1),
    cbOk,
    Vboot: Vboot.toFixed(1),
    dVb_act: dVb_act.toFixed(3),
    t_rech: (t_rech * 1e6).toFixed(2),
    D_max: D_max.toFixed(1),
  }
}

function calcLosses(p, sys, tc) {
  const N = sys.npar || 1
  const Ipk = sys.irms * Math.sqrt(2)
  const Isw = Ipk / Math.sqrt(3)
  const Isw_dev = Isw / N
  const Ipk_dev = Ipk / N
  const Tder = tc === 85 ? 1.55 : 1.0
  const Rds_single = ((p.rds_on_max_10v || (p.rds_on_typ_10v || 1.5) * 1.2) / 1000) * Tder
  const Rds = Rds_single / N
  const Pcond = Isw_dev * Isw_dev * Rds_single * N
  const Rgi = p.rg_internal || 2.0
  const Vpl = (p.vgs_th_typ || 3.0) + 1.5
  const Ig_on = Math.max((sys.vgs - Vpl) / (sys.rg_on + Rgi), 0.05)
  const Ig_off = Math.max(Vpl / (sys.rg_off + Rgi), 0.05)
  const Qgd = (p.qgd || 40) * 1e-9
  const Psw_on = 0.5 * sys.vbus * Ipk_dev * (Qgd / Ig_on) * sys.fsw * (tc === 85 ? 1.05 : 1.0) * N
  const Psw_off = 0.5 * sys.vbus * Ipk_dev * (Qgd / Ig_off) * sys.fsw * (tc === 85 ? 1.05 : 1.0) * N
  const Pqrr = sys.vbus * (p.qrr || 200) * 1e-9 * sys.fsw * (tc === 85 ? 1.1 : 1.0) * N
  const Pcoss = 0.5 * (p.coss || 3000) * 1e-12 * sys.vbus * sys.vbus * sys.fsw * N
  const Pgate = (p.qg_total || 150) * 1e-9 * sys.vgs * sys.fsw * N
  const Ptot = Pcond + Psw_on + Psw_off + Pqrr + Pcoss + Pgate
  const P3ph = Ptot * 6
  const Pout = sys.vbus * sys.irms

  return {
    cond: Pcond.toFixed(2),
    sw_on: Psw_on.toFixed(3),
    sw_off: Psw_off.toFixed(3),
    qrr: Pqrr.toFixed(3),
    coss: Pcoss.toFixed(3),
    gate: Pgate.toFixed(3),
    total: Ptot.toFixed(2),
    total3ph: P3ph.toFixed(1),
    eff: (Pout > 0 ? (Pout / (Pout + P3ph)) * 100 : 0).toFixed(2),
    dtj: ((Ptot / N) * (p.rth_jc || 0.4)).toFixed(1),
    rds: (Rds * 1000).toFixed(3),
  }
}

function getRanks(values, lowerBetter) {
  const nums = values.map(v => toNum(v))
  const valid = nums.filter(v => Number.isFinite(v))
  if (valid.length < 2) return values.map(() => '')
  const best = lowerBetter ? Math.min(...valid) : Math.max(...valid)
  const worst = lowerBetter ? Math.max(...valid) : Math.min(...valid)
  return nums.map(n => {
    if (!Number.isFinite(n)) return ''
    if (n === best) return 'best'
    if (n === worst) return 'worst'
    return ''
  })
}

function rankStyle(rank) {
  if (rank === 'best') return { background: 'rgba(0,230,118,0.12)', color: 'var(--green)', fontWeight: 700 }
  if (rank === 'worst') return { background: 'rgba(255,68,68,0.12)', color: 'var(--red)' }
  return null
}

function num(v, d = 2) {
  const n = toNum(v)
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}

export default function ComparisonPanel() {
  const { state, dispatch } = useProject()
  const { project, settings } = state

  const fileInputRef = useRef(null)
  const [phase, setPhase] = useState('upload')
  const [files, setFiles] = useState([])
  const [currentTemp, setCurrentTemp] = useState(25)

  const defaultNpar = Number.isFinite(parseInt(project.system_specs.mosfets_parallel_per_switch, 10))
    ? Math.max(1, parseInt(project.system_specs.mosfets_parallel_per_switch, 10))
    : Math.max(1, Math.round((project.system_specs.num_fets || 6) / 6))

  const [cfg, setCfg] = useState({
    vbus: Number(project.system_specs.peak_voltage) || 60,
    irms: Number(project.system_specs.max_phase_current) || 120,
    fsw: Number(project.system_specs.pwm_freq_hz) || 20000,
    vgs: Number(project.system_specs.gate_drive_voltage) || 12,
    rg_on: Number(project.system_specs.rg_on_override) || 4.7,
    rg_off: Number(project.system_specs.rg_off_override) || 4.7,
    idr_src: 4,
    idr_snk: 4,
    cb: 0.1,
    vf: 0.5,
    npar: defaultNpar,
    rboot: 10,
  })

  const doneItems = useMemo(
    () => files.filter(f => f.status === 'done' && f.rawData && f.norm),
    [files],
  )

  const losses = useMemo(
    () => doneItems.map(item => calcLosses(item.norm, cfg, currentTemp)),
    [doneItems, cfg, currentTemp],
  )

  const timings = useMemo(
    () => doneItems.map(item => calcTiming(item.norm, cfg)),
    [doneItems, cfg],
  )

  const derived = useMemo(() => {
    const Ipk = cfg.irms * Math.sqrt(2)
    const Isw = Ipk / Math.sqrt(3)
    const IswDev = Isw / Math.max(cfg.npar, 1)
    const IpkDev = Ipk / Math.max(cfg.npar, 1)
    return { Ipk, Isw, IswDev, IpkDev }
  }, [cfg])

  function updateCfg(key, value) {
    const parsed = toNum(value)
    setCfg(prev => ({ ...prev, [key]: Number.isFinite(parsed) ? parsed : prev[key] }))
  }

  function onFileInput(filesList) {
    addFiles(Array.from(filesList || []))
  }

  function addFiles(newFiles) {
    const pdfs = newFiles.filter(f => /\.pdf$/i.test(f.name))
    if (!pdfs.length) {
      toast.error('Please upload PDF datasheets only')
      return
    }

    setFiles(prev => {
      const slots = Math.max(0, MAX_UPLOADS - prev.length)
      const sliced = pdfs.slice(0, slots)
      if (pdfs.length > sliced.length) {
        toast.error(`Maximum ${MAX_UPLOADS} files allowed`) 
      }
      const next = sliced.map(file => ({
        id: makeId(),
        file,
        name: file.name,
        status: 'queued',
        error: null,
        rawData: null,
        norm: null,
      }))
      return [...prev, ...next]
    })
  }

  function removeFile(id) {
    setFiles(prev => prev.filter(f => f.id !== id))
  }

  function resetAll() {
    setFiles([])
    setPhase('upload')
    setCurrentTemp(25)
  }

  function goToConfig() {
    if (files.length < 2) {
      toast.error('Upload at least 2 MOSFET datasheets')
      return
    }
    setPhase('config')
  }

  async function runAnalysis() {
    if (!settings.api_key) {
      toast.error('Add Anthropic API key in Settings first')
      dispatch({ type: 'TOGGLE_SETTINGS' })
      return
    }
    if (files.length < 2) {
      toast.error('Upload at least 2 MOSFET datasheets')
      return
    }

    setPhase('loading')

    setFiles(prev => prev.map(f => ({
      ...f,
      status: f.rawData ? 'done' : 'queued',
      error: null,
    })))

    let successCount = files.filter(f => f.rawData).length
    let failureCount = 0

    for (let i = 0; i < files.length; i++) {
      const item = files[i]
      if (item.rawData) continue

      setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: 'extracting', error: null } : f))
      try {
        const data = await extractDatasheet('mosfet', item.file, settings.api_key)
        const norm = normalizeExtracted(data, item.name)
        setFiles(prev => prev.map(f => f.id === item.id ? {
          ...f,
          status: 'done',
          rawData: data,
          norm,
          error: null,
        } : f))
        successCount += 1
      } catch (e) {
        setFiles(prev => prev.map(f => f.id === item.id ? {
          ...f,
          status: 'error',
          error: e?.message || 'Extraction failed',
        } : f))
        failureCount += 1
      }
    }

    const finalDone = successCount

    if (finalDone <= 0) {
      toast.error('No datasheet extraction succeeded')
      setPhase('config')
      return
    }

    if (failureCount > 0) {
      toast('Some files failed extraction. Showing results for successful devices.', {
        icon: '⚠️',
        duration: 4000,
      })
    } else {
      toast.success('Analysis completed')
    }

    setPhase('results')
  }

  function applyMosfetToProject(item) {
    if (!item?.rawData) return
    dispatch({
      type: 'SET_BLOCK_DATA',
      payload: {
        block: 'mosfet',
        filename: item.name,
        raw_data: item.rawData,
      },
    })
    dispatch({ type: 'SET_ACTIVE_BLOCK', payload: 'mosfet' })
    toast.success(`${item.norm?.name || item.name} selected in MOSFET tab`) 
  }

  const sysInfo = `${cfg.vbus}V · ${cfg.irms}A(phase total) · ${(cfg.fsw / 1000).toFixed(0)}kHz · ${cfg.npar}× parallel/switch`

  const ranked = useMemo(() => {
    const combined = doneItems.map((item, i) => ({ item, l: losses[i], t: timings[i] }))
    return combined.sort((a, b) => {
      const sa = toNum(a.l?.eff) * 10 - (toNum(a.item.norm?.qrr) || 300) * 0.05 - toNum(a.l?.total)
      const sb = toNum(b.l?.eff) * 10 - (toNum(b.item.norm?.qrr) || 300) * 0.05 - toNum(b.l?.total)
      return sb - sa
    })
  }, [doneItems, losses, timings])

  return (
    <div className="mla-root" style={{ maxWidth: 1280, margin: '0 auto', padding: '8px 8px 24px 8px' }}>
      <div className="card mla-header-card" style={{ padding: '14px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="mla-header-icon" style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(37,99,235,0.16)', border: '1px solid rgba(37,99,235,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>⚡</div>
        <div style={{ flex: 1 }}>
          <div className="mla-header-logo">Power Electronics Tool</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--txt-1)' }}>MOSFET Loss Analyzer</div>
          <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>Upload up to {MAX_UPLOADS} datasheets once, extract sequentially, compare losses/timing, and optionally pick one for project calculations.</div>
        </div>
        {phase === 'results' && (
          <button className="btn btn-ghost" onClick={resetAll}>New Analysis</button>
        )}
      </div>

      <div className="card mla-steps-wrap" style={{ padding: 6, marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          {[
            { key: 'upload', title: 'Upload PDFs', idx: 1 },
            { key: 'config', title: 'Set Conditions', idx: 2 },
            { key: 'results', title: 'Results', idx: 3 },
          ].map(step => {
            const done = (step.key === 'upload' && (phase === 'config' || phase === 'loading' || phase === 'results'))
              || (step.key === 'config' && (phase === 'loading' || phase === 'results'))
            const active = (step.key === 'upload' && phase === 'upload')
              || (step.key === 'config' && phase === 'config')
              || (step.key === 'results' && (phase === 'loading' || phase === 'results'))
            const stepClass = `mla-step ${active ? 'active' : ''} ${done ? 'done' : ''}`.trim()
            return (
              <div key={step.key} className={stepClass} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                borderRadius: 8,
                padding: '8px 10px',
                border: `1px solid ${active ? 'rgba(79,195,247,0.5)' : 'var(--border-1)'}`,
                background: active ? 'rgba(79,195,247,0.08)' : 'var(--bg-2)',
              }}>
                <div className="mla-step-num" style={{
                  width: 22, height: 22, borderRadius: 6,
                  background: done ? 'var(--green)' : active ? 'var(--accent)' : 'var(--bg-4)',
                  color: done || active ? '#fff' : 'var(--txt-3)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
                }}>
                  {done ? '✓' : step.idx}
                </div>
                <span className="mla-step-label" style={{ fontSize: 11, color: active ? 'var(--txt-1)' : 'var(--txt-3)', fontWeight: active ? 700 : 600 }}>{step.title}</span>
              </div>
            )
          })}
        </div>
      </div>

      {phase === 'upload' && (
        <div className="card" style={{ padding: 14 }}>
          <div className="mla-card-title" style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt-2)', marginBottom: 10 }}>Step 1 — Upload MOSFET Datasheets (2 to {MAX_UPLOADS})</div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => onFileInput(e.target.files)}
          />

          <div
            className="mla-dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              addFiles(Array.from(e.dataTransfer.files || []))
            }}
            style={{
              border: '2px dashed var(--border-2)',
              borderRadius: 10,
              padding: '34px 16px',
              textAlign: 'center',
              cursor: 'pointer',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            <div style={{ fontSize: 38, marginBottom: 10 }}>📄</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt-1)' }}>Drop MOSFET PDFs here or click to browse</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 4 }}>All files are queued. Extraction runs one-by-one safely.</div>
          </div>

          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map((f, idx) => (
              <div key={f.id} className="mla-file-item" style={{
                display: 'flex', alignItems: 'center', gap: 8,
                borderRadius: 7, border: '1px solid var(--border-1)',
                background: 'var(--bg-3)', padding: '6px 10px',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt-3)', width: 24 }}>{idx + 1}</span>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--txt-2)', fontFamily: 'var(--font-mono)' }}>{f.name}</span>
                <span style={{ fontSize: 10, color: f.status === 'error' ? 'var(--red)' : f.status === 'done' ? 'var(--green)' : 'var(--txt-3)' }}>
                  {f.status === 'done' ? 'ready' : f.status}
                </span>
                <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => removeFile(f.id)}>Remove</button>
              </div>
            ))}
            {!files.length && (
              <div style={{ fontSize: 11, color: 'var(--txt-3)', padding: '8px 2px' }}>No files added yet.</div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button className="btn btn-primary" disabled={files.length < 2} onClick={goToConfig}>Continue → Set Conditions</button>
            <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>+ Add More</button>
            <span style={{ fontSize: 11, color: files.length < 2 ? 'var(--amber)' : 'var(--txt-3)' }}>
              {files.length < 2 ? 'Upload at least 2 files to compare' : `${files.length}/${MAX_UPLOADS} files selected`}
            </span>
          </div>
        </div>
      )}

      {phase === 'config' && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt-2)', marginBottom: 10 }}>Step 2 — Operating Conditions (formula inputs)</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 }}>
            <FormInput label="DC Bus Voltage [V]" value={cfg.vbus} onChange={(v) => updateCfg('vbus', v)} />
            <FormInput label="Phase Current RMS [A] (total)" value={cfg.irms} onChange={(v) => updateCfg('irms', v)} />
            <FormInput label="Switching Freq [Hz]" value={cfg.fsw} onChange={(v) => updateCfg('fsw', v)} />
            <FormInput label="Parallel MOSFETs / switch" value={cfg.npar} onChange={(v) => updateCfg('npar', Math.max(1, Math.min(12, parseInt(v || '1', 10) || 1)))} />
            <FormInput label="Bootstrap Resistor Rboot [Ω]" value={cfg.rboot} onChange={(v) => updateCfg('rboot', v)} />
            <FormInput label="Gate Drive Voltage Vgs [V]" value={cfg.vgs} onChange={(v) => updateCfg('vgs', v)} />
            <FormInput label="Turn-ON Gate Rg_on [Ω] (per MOSFET)" value={cfg.rg_on} onChange={(v) => updateCfg('rg_on', v)} />
            <FormInput label="Turn-OFF Gate Rg_off [Ω] (per MOSFET)" value={cfg.rg_off} onChange={(v) => updateCfg('rg_off', v)} />
            <FormInput label="Driver Source Current [A]" value={cfg.idr_src} onChange={(v) => updateCfg('idr_src', v)} />
            <FormInput label="Driver Sink Current [A]" value={cfg.idr_snk} onChange={(v) => updateCfg('idr_snk', v)} />
            <FormInput label="Bootstrap Cap Cb [μF]" value={cfg.cb} onChange={(v) => updateCfg('cb', v)} />
            <FormInput label="Bootstrap Diode Vf [V]" value={cfg.vf} onChange={(v) => updateCfg('vf', v)} />
          </div>

          <div className="note-box blue" style={{ marginTop: 10, fontFamily: 'var(--font-mono)' }}>
            I_peak(total)={num(derived.Ipk, 1)}A · I_sw_rms(total)={num(derived.Isw, 1)}A · I_sw_rms/device={num(derived.IswDev, 1)}A · I_peak/device={num(derived.IpkDev, 1)}A · T_sw={num(1e6 / Math.max(cfg.fsw, 1), 2)}µs
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn btn-ghost" onClick={() => setPhase('upload')}>← Back</button>
            <button className="btn btn-primary" onClick={runAnalysis}>Run AI Analysis</button>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="card" style={{ padding: '28px 18px' }}>
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 34, marginBottom: 6 }}>⏳</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt-1)' }}>Extracting Datasheets Sequentially</div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>Files are processed one-by-one to keep extraction stable.</div>
          </div>

          <div style={{ maxWidth: 620, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map((f) => (
              <div key={f.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                border: '1px solid var(--border-1)',
                borderRadius: 7,
                padding: '7px 10px',
                background: f.status === 'extracting' ? 'rgba(30,144,255,0.09)' : 'var(--bg-3)',
              }}>
                <span style={{ width: 18, textAlign: 'center', fontSize: 11, color: f.status === 'done' ? 'var(--green)' : f.status === 'error' ? 'var(--red)' : 'var(--txt-3)' }}>
                  {f.status === 'done' ? '✓' : f.status === 'extracting' ? '►' : f.status === 'error' ? '✗' : '○'}
                </span>
                <span style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--txt-2)' }}>{f.name}</span>
                <span style={{ fontSize: 10, color: f.status === 'done' ? 'var(--green)' : f.status === 'error' ? 'var(--red)' : 'var(--txt-3)' }}>
                  {f.status === 'extracting' ? 'extracting…' : f.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {phase === 'results' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="mla-result-info" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt-2)', background: 'var(--bg-3)', border: '1px solid var(--border-1)', borderRadius: 6, padding: '5px 8px' }}>{sysInfo}</span>
            <div className="mla-temp-toggle" style={{ marginLeft: 'auto', display: 'flex', border: '1px solid var(--border-2)', borderRadius: 6, overflow: 'hidden' }}>
              <button
                className={`btn mla-temp-btn ${currentTemp === 25 ? 'active' : ''}`}
                style={{ border: 'none', borderRadius: 0, background: currentTemp === 25 ? 'var(--accent)' : 'var(--bg-3)', color: currentTemp === 25 ? '#fff' : 'var(--txt-3)', padding: '6px 12px' }}
                onClick={() => setCurrentTemp(25)}
              >
                25°C
              </button>
              <button
                className={`btn mla-temp-btn ${currentTemp === 85 ? 'active' : ''}`}
                style={{ border: 'none', borderRadius: 0, background: currentTemp === 85 ? 'var(--accent)' : 'var(--bg-3)', color: currentTemp === 85 ? '#fff' : 'var(--txt-3)', padding: '6px 12px' }}
                onClick={() => setCurrentTemp(85)}
              >
                85°C
              </button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 10, overflow: 'hidden' }}>
            <div className="sec-head">
              <span>📋 Extracted Datasheet Parameters</span>
              <span className="mla-tag">AI Extracted From PDF</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="ptable">
                <thead>
                  <tr>
                    <th style={{ minWidth: 200 }}>Parameter</th>
                    {doneItems.map(item => (
                      <th key={item.id} style={{ minWidth: 130 }}>
                        {item.norm.name}
                        <div style={{ fontSize: 10, color: 'var(--txt-3)', fontWeight: 500 }}>{item.norm.manufacturer || '—'}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'VDS max [V]', key: 'vds_max', lowerBetter: false },
                    { label: 'ID max @25°C [A]', key: 'id_max_25c', lowerBetter: false },
                    { label: 'RDS(on) max @10V [mΩ]', key: 'rds_on_max_10v', lowerBetter: true },
                    { label: 'Vgs(th) typ [V]', key: 'vgs_th_typ', lowerBetter: true },
                    { label: 'Qg total [nC]', key: 'qg_total', lowerBetter: true },
                    { label: 'Qgs [nC]', key: 'qgs', lowerBetter: true },
                    { label: 'Qgd Miller [nC]', key: 'qgd', lowerBetter: true },
                    { label: 'Qrr [nC]', key: 'qrr', lowerBetter: true },
                    { label: 'trr [ns]', key: 'trr', lowerBetter: true },
                    { label: 'Ciss [pF]', key: 'ciss', lowerBetter: true },
                    { label: 'Coss [pF]', key: 'coss', lowerBetter: true },
                    { label: 'Rg internal [Ω]', key: 'rg_internal', lowerBetter: true },
                    { label: 'td(on) [ns]', key: 'td_on', lowerBetter: true },
                    { label: 'tr [ns]', key: 'tr', lowerBetter: true },
                    { label: 'td(off) [ns]', key: 'td_off', lowerBetter: true },
                    { label: 'tf [ns]', key: 'tf', lowerBetter: true },
                    { label: 'RthJC max [°C/W]', key: 'rth_jc', lowerBetter: true },
                    { label: 'Package', key: 'package', lowerBetter: null },
                  ].map(row => {
                    const values = doneItems.map(item => item.norm[row.key])
                    const ranks = row.lowerBetter == null ? values.map(() => '') : getRanks(values, row.lowerBetter)
                    return (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        {values.map((v, i) => (
                          <td key={`${row.key}_${doneItems[i].id}`} style={rankStyle(ranks[i]) || undefined}>
                            {row.key === 'package' ? (v || '—') : num(v, row.key === 'vgs_th_typ' ? 2 : 2)}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginTop: 10, overflow: 'hidden' }}>
            <div className="sec-head">🔥 Loss Breakdown @ {currentTemp}°C — Per Switch Position</div>
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="ptable">
                <thead>
                  <tr>
                    <th style={{ minWidth: 220 }}>Loss Component</th>
                    <th style={{ minWidth: 210 }}>Formula</th>
                    {doneItems.map(item => <th key={`loss_h_${item.id}`} style={{ minWidth: 120 }}>{item.norm.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: `1. Conduction [W]${cfg.npar > 1 ? ` (${cfg.npar} dev)` : ''}`, formula: 'Isw²×RDS_par×Tderate', key: 'cond', lowerBetter: true },
                    { label: '2. Turn-ON switching [W]', formula: '½×Vbus×Ipk_dev×(Qgd/Ig_on)×fsw×N', key: 'sw_on', lowerBetter: true },
                    { label: '3. Turn-OFF switching [W]', formula: '½×Vbus×Ipk_dev×(Qgd/Ig_off)×fsw×N', key: 'sw_off', lowerBetter: true },
                    { label: '4. Body Diode Qrr [W]', formula: 'Vbus×Qrr×fsw×N', key: 'qrr', lowerBetter: true },
                    { label: '5. Coss [W]', formula: '½×Coss×Vbus²×fsw×N', key: 'coss', lowerBetter: true },
                    { label: '6. Gate Drive [W]', formula: 'Qg×Vgs×fsw×N', key: 'gate', lowerBetter: true },
                  ].map(row => {
                    const vals = losses.map(l => l[row.key])
                    const ranks = getRanks(vals, row.lowerBetter)
                    return (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td style={{ color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>{row.formula}</td>
                        {vals.map((v, i) => <td key={`${row.key}_${doneItems[i].id}`} style={rankStyle(ranks[i]) || undefined}>{v}</td>)}
                      </tr>
                    )
                  })}

                  {[
                    { label: `TOTAL / switch-pos [W]${cfg.npar > 1 ? ` (${cfg.npar}× MOSFET)` : ''}`, formula: 'Σ rows 1–6', key: 'total', lowerBetter: true, cls: 'rgba(30,144,255,0.10)' },
                    { label: '3-phase total [W] (×6 positions)', formula: '×6 switch positions', key: 'total3ph', lowerBetter: true },
                    { label: 'Efficiency [%]', formula: 'Pout/(Pout+Ploss)', key: 'eff', lowerBetter: false, cls: 'rgba(0,230,118,0.10)' },
                    { label: 'ΔTj per MOSFET [°C]', formula: '(Ptot÷N)×RthJC', key: 'dtj', lowerBetter: true },
                    { label: `RDS parallel [mΩ] ×${currentTemp === 85 ? '1.55' : '1.0'}`, formula: 'RDS_single÷N × Tderate', key: 'rds', lowerBetter: true },
                  ].map(row => {
                    const vals = losses.map(l => l[row.key])
                    const ranks = getRanks(vals, row.lowerBetter)
                    return (
                      <tr key={row.key} style={{ background: row.cls || undefined }}>
                        <td>{row.label}</td>
                        <td style={{ color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>{row.formula}</td>
                        {vals.map((v, i) => <td key={`${row.key}_${doneItems[i].id}`} style={rankStyle(ranks[i]) || undefined}>{v}</td>)}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div className="sec-head">⏱️ Gate Drive, Timing, Dead Time, Bootstrap</div>
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {doneItems.map((item, idx) => {
                const t = timings[idx]
                const p = item.norm
                const dtRec = toNum(t.dt_rec)
                const dtClass = dtRec > 500 ? 'rgba(255,68,68,0.12)' : dtRec > 200 ? 'rgba(255,171,0,0.12)' : 'rgba(0,230,118,0.10)'
                const cbClass = t.cbOk ? 'rgba(0,230,118,0.10)' : 'rgba(255,68,68,0.12)'
                const rippleClass = toNum(t.dVb_act) > 0.5 ? 'rgba(255,171,0,0.12)' : 'rgba(0,230,118,0.10)'
                const dutyClass = toNum(t.D_max) < 80 ? 'rgba(255,171,0,0.12)' : 'rgba(30,144,255,0.10)'

                return (
                  <div key={`tim_${item.id}`} style={{ border: '1px solid var(--border-1)', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '8px 10px', background: 'var(--bg-3)', borderBottom: '1px solid var(--border-1)' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt-1)' }}>{p.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--txt-3)' }}>{p.manufacturer || '—'} · {p.package || '—'} · Rg_total_on={t.Rg_on}Ω/dev · Rg_total_off={t.Rg_off}Ω/dev · Vplateau={t.Vpl}V</div>
                    </div>

                    <div style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 }}>
                      <MetricCard title="Turn-ON Delay td(on)" value={t.td_on} unit="ns" formula="Ciss×Rg_on×ln(Vgs/(Vgs−Vth))" />
                      <MetricCard title="Rise Time t_rise (Vds fall)" value={t.t_rise} unit="ns" formula="Qgd ÷ ((Vgs−Vpl)/Rg_on)" hue="blue" />
                      <MetricCard title="Total Turn-ON" value={t.t_on_tot} unit="ns" formula="td(on)+t_rise" />
                      <MetricCard title="Turn-OFF Delay td(off)" value={t.td_off} unit="ns" formula="Ciss×Rg_off×ln(Vgs/(Vgs−Vpl))" />
                      <MetricCard title="Fall Time t_fall (Vds rise)" value={t.t_fall} unit="ns" formula="Qgd ÷ (Vpl/Rg_off)" hue="blue" />
                      <MetricCard title="Total Turn-OFF" value={t.t_off_tot} unit="ns" formula="td(off)+t_fall" />
                      <MetricCard title="Peak Gate I — Source" value={t.Ig_on_pk} unit="mA" formula="Vgs ÷ Rg_on_total" />
                      <MetricCard title="Peak Gate I — Sink" value={t.Ig_off_pk} unit="mA" formula="Vgs ÷ Rg_off_total" />

                      <MetricCard title="Dead Time Minimum DT_min" value={t.dt_min} unit="ns" formula="max(t_rise,t_fall)×1.3, floor 100ns" bg={dtClass} />
                      <MetricCard title="Recommended Dead Time" value={t.dt_rec} unit="ns" formula="DT_min × 1.25" bg={dtClass} />
                      <MetricCard title="Dead Time % of T_sw" value={t.dt_pct} unit="%" formula="DT_rec ÷ T_sw × 100" />
                      <MetricCard title="Body Diode Conduction / cycle" value={(toNum(t.dt_rec) * 2).toFixed(0)} unit="ns" formula="2 × DT_rec" />

                      <MetricCard title="Cb Min (N×Qg÷0.5V)" value={t.Cb_min} unit="nF" formula={`${cfg.npar}×Qg ÷ ΔVb`} bg={cbClass} />
                      <MetricCard title={`Your Cb = ${cfg.cb} µF`} value={t.cbOk ? 'OK' : 'LOW'} formula={`${(cfg.cb * 1000).toFixed(0)}nF vs ${t.Cb_min}nF`} bg={cbClass} />
                      <MetricCard title="Bootstrap Voltage" value={t.Vboot} unit="V" formula={`Vgs − Vf(${cfg.vf}V)`} />
                      <MetricCard title="Cb Voltage Ripple" value={t.dVb_act} unit="V" formula={`${cfg.npar}×Qg ÷ Cb_actual`} bg={rippleClass} />
                      <MetricCard title="Bootstrap Recharge Time" value={t.t_rech} unit="µs" formula="5 × Rboot(10Ω) × Cb" />
                      <MetricCard title="Max HS Duty Cycle" value={t.D_max} unit="%" formula="1 − t_recharge × fsw" bg={dutyClass} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div className="sec-head">🏆 Ranking & Recommendations</div>
            <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 10 }}>
              {ranked.map((entry, rank) => {
                const { item, l, t } = entry
                const p = item.norm
                const medals = ['🏆', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '11', '12']
                const borderColors = ['#16a34a', '#2563eb', '#d97706']
                const borderColor = borderColors[rank] || '#607d8b'
                const qrrVal = toNum(p.qrr) || 0
                const qrrBad = qrrVal > 400
                const qrrGood = qrrVal > 0 && qrrVal < 150

                return (
                  <div key={`rank_${item.id}`} className="mla-rank-card" style={{ border: '1px solid var(--border-1)', borderLeft: `4px solid ${borderColor}`, borderRadius: 10, padding: 12, background: 'var(--bg-2)' }}>
                    <div style={{ fontSize: 24, marginBottom: 4 }}>{medals[rank] || `${rank + 1}`}</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--txt-1)' }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--txt-3)', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>{p.manufacturer || '—'} · {p.package || '—'}</div>

                    <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                      <div>⚡ Efficiency: <strong style={{ color: 'var(--green)' }}>{l.eff}%</strong></div>
                      <div>🔥 Total loss/position: <strong>{l.total} W</strong></div>
                      <div>↩ Qrr loss: <strong style={{ color: qrrBad ? 'var(--red)' : qrrGood ? 'var(--green)' : 'var(--txt-1)' }}>{l.qrr} W</strong></div>
                      <div>📉 RDS parallel: <strong>{l.rds} mΩ</strong></div>
                      <div>🌡 ΔTj/MOSFET: <strong>{l.dtj}°C</strong></div>
                      <div>⏱ t_rise / t_fall: <strong>{t.t_rise} / {t.t_fall} ns</strong></div>
                      <div>⏸ Dead time rec: <strong>{t.dt_rec} ns</strong></div>
                      <div>🔋 Cb min: <strong>{t.Cb_min} nF</strong></div>
                      <div>🏭 3-phase total: <strong>{l.total3ph} W</strong></div>
                    </div>

                    {qrrBad && (
                      <div className="note-box red" style={{ marginTop: 8 }}>Qrr is high for hard-switched 6-step behavior; consider diode strategy.</div>
                    )}
                    {qrrGood && (
                      <div className="note-box green" style={{ marginTop: 8 }}>Low Qrr profile is favorable for hard-switched transitions.</div>
                    )}

                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => applyMosfetToProject(item)}>
                        Use in MOSFET Tab
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function renderLabel(labelText) {
  if (!labelText) return null
  return labelText.split(/(\[.*?\])/g).map((p, i) =>
    p.startsWith('[') && p.endsWith(']') ? <span key={i} style={{ textTransform: 'none' }}>{p}</span> : p
  )
}

function FormInput({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>
        {renderLabel(label)}
      </span>
      <input className="inp inp-mono" type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function SelectInput({ label, value, onChange, options }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>
        {renderLabel(label)}
      </span>
      <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    </label>
  )
}

function MetricCard({ title, value, unit, formula, hue, bg }) {
  const accent = hue === 'blue' ? 'var(--accent)' : 'var(--txt-1)'
  return (
    <div className="mla-metric-card" style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: '9px 10px', background: bg || 'var(--bg-3)' }}>
      <div style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 20, color: accent, fontFamily: 'var(--font-mono)', fontWeight: 800, lineHeight: 1.1 }}>
        {value}
        {unit && <span style={{ fontSize: 11, marginLeft: 4, color: 'var(--txt-3)', fontWeight: 600 }}>{unit}</span>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--txt-4)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>{formula}</div>
    </div>
  )
}
