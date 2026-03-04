import React, { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, RefreshCw, CheckCircle, AlertCircle, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'
import { extractDatasheet } from '../api.js'
import ParameterTable from './ParameterTable.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'
import UnitPicker from './UnitPicker.jsx'

// Expected parameter IDs per block type — used to detect missing params
const EXPECTED_PARAMS = {
  mosfet: ['vds_max','id_cont','rds_on','vgs_th','qg','qgd','qgs','qrr','trr','coss','td_on','tr','td_off','tf','rth_jc','tj_max','body_diode_vf'],
  driver: ['vcc_range','vcc_uvlo','vbs_max','vbs_uvlo','io_source','io_sink','prop_delay_on','prop_delay_off','deadtime_min','deadtime_default','vil','vih','ocp_threshold','ocp_response','thermal_shutdown','rth_ja','tj_max'],
  mcu:    ['cpu_freq_max','flash_size','ram_size','adc_resolution','adc_channels','adc_sample_rate','pwm_timers','pwm_resolution','pwm_deadtime_res','pwm_deadtime_max','complementary_outputs','spi_count','uart_count','vdd_range','idd_run','temp_range','gpio_count'],
}

const PARAM_LABELS = {
  vds_max:'Max Drain-Source Voltage', id_cont:'Continuous Drain Current', rds_on:'On-Resistance', vgs_th:'Gate Threshold Voltage',
  qg:'Total Gate Charge', qgd:'Gate-Drain Charge', qgs:'Gate-Source Charge', qrr:'Reverse Recovery Charge',
  trr:'Reverse Recovery Time', coss:'Output Capacitance', td_on:'Turn-On Delay', tr:'Rise Time',
  td_off:'Turn-Off Delay', tf:'Fall Time', rth_jc:'Thermal Resistance (J-C)', tj_max:'Max Junction Temp', body_diode_vf:'Body Diode Vf',
  vcc_range:'VCC Supply Range', vcc_uvlo:'VCC UVLO', vbs_max:'Max Bootstrap Voltage', vbs_uvlo:'Bootstrap UVLO',
  io_source:'Peak Source Current', io_sink:'Peak Sink Current', prop_delay_on:'Prop Delay Turn-On', prop_delay_off:'Prop Delay Turn-Off',
  deadtime_min:'Min Dead Time', deadtime_default:'Default Dead Time', vil:'Input Low Voltage', vih:'Input High Voltage',
  ocp_threshold:'OCP Threshold', ocp_response:'OCP Response Time', thermal_shutdown:'Thermal Shutdown Temp', rth_ja:'Thermal Resistance (J-A)',
  cpu_freq_max:'Max CPU Frequency', flash_size:'Flash Size', ram_size:'RAM Size', adc_resolution:'ADC Resolution',
  adc_channels:'ADC Channels', adc_sample_rate:'ADC Sample Rate', pwm_timers:'PWM Timers', pwm_resolution:'PWM Resolution',
  pwm_deadtime_res:'Dead-Time Resolution', pwm_deadtime_max:'Max Dead Time', complementary_outputs:'Complementary Outputs',
  spi_count:'SPI Count', uart_count:'UART Count', vdd_range:'VDD Range', idd_run:'Run Current',
  temp_range:'Temperature Range', gpio_count:'GPIO Count',
}

export default function BlockPanel({ blockKey, config }) {
  const { state, dispatch } = useProject()
  const blockState = state.project.blocks[blockKey]
  const { settings } = state
  const [collapsed, setCollapsed] = useState({})

  async function doExtract(file) {
    if (!settings.api_key) {
      toast.error('Add your Anthropic API key in Settings first')
      dispatch({ type: 'TOGGLE_SETTINGS' })
      return
    }
    dispatch({ type: 'SET_BLOCK_STATUS', payload: { block: blockKey, status: 'uploading' } })
    toast.loading(`Uploading ${file.name}…`, { id: 'ex' })
    try {
      dispatch({ type: 'SET_BLOCK_STATUS', payload: { block: blockKey, status: 'extracting' } })
      toast.loading('Claude is reading the datasheet…', { id: 'ex' })
      // FIX: use blockKey directly (not config.extractionType) to avoid stale closure
      const data = await extractDatasheet(blockKey, file, settings.api_key)
      dispatch({ type: 'SET_BLOCK_DATA', payload: { block: blockKey, filename: file.name, raw_data: data } })
      const cacheNote = data._from_cache ? ' (from cache)' : ''
      toast.success(`Extracted ${data.parameters?.length || 0} parameters — ${data.component_name}${cacheNote}`, { id: 'ex', duration: 5000 })
    } catch (err) {
      dispatch({ type: 'SET_BLOCK_STATUS', payload: { block: blockKey, status: 'error', error: err.message } })
      toast.error(err.message, { id: 'ex' })
    }
  }

  const onDrop = useCallback(files => { if (files[0]) doExtract(files[0]) }, [blockKey, settings.api_key])
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'application/pdf': ['.pdf'] }, multiple: false,
  })

  const { status, filename, raw_data, error } = blockState

  // Group extracted params by category
  const groups = {}
  for (const p of (raw_data?.parameters || [])) {
    const cat = p.category || 'Other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(p)
  }

  // Detect missing expected params
  const extractedIds = new Set((raw_data?.parameters || []).map(p => p.id))
  const expectedIds  = EXPECTED_PARAMS[blockKey] || []
  const missingIds   = expectedIds.filter(id => !extractedIds.has(id))

  // Count multi-condition params per category (for closed-header badge)
  function attentionCountForGroup(params) {
    return params.filter(p => (p.conditions?.length || 0) > 1).length
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0 }}>
      {/* ─── Left: Upload + params ─────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

        {/* Block info card */}
        <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${config.color}18`,
            border: `1px solid ${config.color}35`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>{config.icon}</div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>{config.fullLabel}</span>
              <StatusChip status={status} color={config.color} />
              {raw_data?.component_name && (
                <span style={{
                  fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
                  color: config.color, background: `${config.color}15`,
                  padding: '1px 8px', borderRadius: 4,
                }}>
                  {raw_data.component_name}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>{config.desc}</div>
            {raw_data?.manufacturer && (
              <div style={{ fontSize: 11, color: 'var(--txt-2)', marginTop: 1 }}>
                {raw_data.manufacturer}
                {raw_data.package && ` · ${raw_data.package}`}
                {(raw_data.core || raw_data.topology) && ` · ${raw_data.core || raw_data.topology}`}
              </div>
            )}
          </div>

          {status === 'done' && (
            <button
              onClick={() => dispatch({ type: 'RESET_BLOCK', payload: blockKey })}
              className="btn btn-ghost"
              style={{ fontSize: 12, flexShrink: 0 }}
            >
              <RefreshCw size={13} /> Re-upload
            </button>
          )}
        </div>

        {/* Upload zone or loading */}
        {(status === 'idle' || status === 'error') && (
          <div
            {...getRootProps()}
            className={`drop-zone ${isDragActive ? 'drag-active' : ''}`}
            style={{ padding: '40px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}
          >
            <input {...getInputProps()} />
            <div style={{
              width: 60, height: 60, borderRadius: 16,
              background: `${config.color}15`,
              border: `1px solid ${config.color}30`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Upload size={26} style={{ color: config.color }} />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--txt-1)', marginBottom: 4 }}>
                {isDragActive ? 'Drop PDF here' : `Upload ${config.fullLabel} Datasheet`}
              </div>
              <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                PDF only · Claude Haiku extracts all parameters with test conditions
              </div>
            </div>
            {error && (
              <div className="note-box red" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertCircle size={13} /> {error}
              </div>
            )}
          </div>
        )}

        {(status === 'uploading' || status === 'extracting') && (
          <div className="card" style={{ padding: '40px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 60, height: 60, borderRadius: 16,
              background: `${config.color}15`,
              border: `1px solid ${config.color}30`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: 'pulse-dot 1.4s infinite',
            }}>
              <span style={{ fontSize: 26 }}>📄</span>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--txt-1)', marginBottom: 4 }}>
                {status === 'uploading' ? 'Uploading…' : 'Claude is reading the datasheet…'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                {filename} · Large datasheets may take 15–30s
              </div>
            </div>
            <div className="progress-bar" style={{ width: 200 }}>
              <div className="progress-bar-fill indeterminate" />
            </div>
          </div>
        )}

        {/* Parameter groups */}
        {status === 'done' && raw_data && (
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="sec-head">
              <CheckCircle size={13} style={{ color: 'var(--green)' }} />
              Extracted Parameters
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: config.color, marginLeft: 4 }}>
                {raw_data.parameters?.length || 0}
              </span>
              <span className="badge-count">{Object.keys(groups).length} categories</span>
            </div>

            <div style={{ flex: 1, overflow: 'auto' }}>
              {Object.entries(groups).map(([cat, params]) => {
                const isOpen    = collapsed[cat] !== false
                const attention = attentionCountForGroup(params)
                return (
                  <div key={cat}>
                    <button
                      className={`collapsible-trigger ${isOpen ? 'open' : ''}`}
                      onClick={() => setCollapsed(p => ({ ...p, [cat]: !isOpen }))}
                    >
                      {isOpen ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
                      <span>{cat}</span>
                      <span style={{
                        fontSize: 10, fontFamily: 'var(--font-mono)',
                        padding: '1px 6px', background: 'var(--bg-4)', borderRadius: 4,
                      }}>{params.length}</span>
                      {/* Attention badge — visible when collapsed AND has multi-condition params */}
                      {!isOpen && attention > 0 && (
                        <span style={{
                          display: 'flex', alignItems: 'center', gap: 3,
                          fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)',
                          padding: '1px 6px', borderRadius: 4,
                          background: 'rgba(255,171,0,.15)',
                          color: 'var(--amber)',
                          border: '1px solid rgba(255,171,0,.3)',
                        }}>
                          <AlertTriangle size={8}/> {attention} need{attention === 1 ? 's' : ''} attention
                        </span>
                      )}
                      <span className="chevron"><ChevronDown size={11}/></span>
                    </button>
                    {isOpen && (
                      <div className="table-wrap">
                        <ParameterTable params={params} blockKey={blockKey} color={config.color} />
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Missing parameters section */}
              {missingIds.length > 0 && (
                <MissingParamsSection
                  missingIds={missingIds}
                  blockKey={blockKey}
                  color={config.color}
                  collapsed={collapsed}
                  setCollapsed={setCollapsed}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* ─── Right: Calculations panel ───────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <CalculationsPanel />
      </div>
    </div>
  )
}

function StatusChip({ status, color }) {
  const map = {
    idle:       { cls: 'badge-idle',  label: 'Ready' },
    uploading:  { cls: 'badge-busy',  label: 'Uploading…' },
    extracting: { cls: 'badge-busy',  label: 'Extracting…' },
    done:       { cls: 'badge-done',  label: '✓ Done' },
    error:      { cls: 'badge-error', label: '✗ Error' },
  }
  const s = map[status] || map.idle
  return <span className={`badge ${s.cls}`}>{s.label}</span>
}

function MissingParamsSection({ missingIds, blockKey, color, collapsed, setCollapsed }) {
  const { state, dispatch } = useProject()
  const [vals,  setVals]  = useState({})
  const [units, setUnits] = useState({})
  const isOpen = collapsed['__missing__'] !== false

  // Which IDs have already been manually set (live in raw_data as 'Manual Entry')
  const manualParams = (state.project.blocks[blockKey]?.raw_data?.parameters || [])
    .filter(p => p.category === 'Manual Entry')
  const manualIds = new Set(manualParams.map(p => p.id))

  // Still-missing = missingIds that haven't been set yet
  const stillMissing = missingIds.filter(id => !manualIds.has(id))

  function commit(id) {
    const v = parseFloat(vals[id])
    if (isNaN(v)) return
    dispatch({ type: 'SET_MANUAL_PARAM', payload: { block: blockKey, param_id: id, value: v, unit: units[id] || '' } })
    setVals(p => { const n = {...p}; delete n[id]; return n })
  }

  function deleteManual(id) {
    dispatch({ type: 'DELETE_MANUAL_PARAM', payload: { block: blockKey, param_id: id } })
  }

  const totalCount = stillMissing.length + manualParams.length
  if (totalCount === 0) return null

  return (
    <div>
      <button
        className={`collapsible-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setCollapsed(p => ({ ...p, '__missing__': !isOpen }))}
        style={{ borderTop: '1px solid rgba(255,68,68,.2)' }}
      >
        {isOpen ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
        <span style={{ color: 'var(--red)' }}>Missing / Not Extracted</span>
        {/* counts */}
        {stillMissing.length > 0 && (
          <span style={{ fontSize:10, fontFamily:'var(--font-mono)', padding:'1px 6px', background:'rgba(255,68,68,.12)', color:'var(--red)', borderRadius:4 }}>
            {stillMissing.length} missing
          </span>
        )}
        {manualParams.length > 0 && (
          <span style={{ fontSize:10, fontFamily:'var(--font-mono)', padding:'1px 6px', background:'rgba(0,230,118,.1)', color:'var(--green)', borderRadius:4 }}>
            {manualParams.length} set
          </span>
        )}
        {!isOpen && stillMissing.length > 0 && (
          <span style={{ display:'flex', alignItems:'center', gap:3, fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:4, background:'rgba(255,68,68,.12)', color:'var(--red)', border:'1px solid rgba(255,68,68,.25)' }}>
            <AlertTriangle size={8}/> enter manually
          </span>
        )}
        <span className="chevron"><ChevronDown size={11}/></span>
      </button>

      {isOpen && (
        <div style={{ padding:'8px 12px 12px', display:'flex', flexDirection:'column', gap:6 }}>

          {/* ── Already-set manual params ─────────────────────────── */}
          {manualParams.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:4 }}>
              <div style={{ fontSize:10, color:'var(--green)', fontWeight:600, marginBottom:2 }}>✓ Manually set</div>
              {manualParams.map(p => {
                const cond = p.conditions?.[0] || {}
                return (
                  <div key={p.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 8px', borderRadius:5, background:'rgba(0,230,118,.04)', border:'1px solid rgba(0,230,118,.15)' }}>
                    <span style={{ flex:1, fontSize:11, color:'var(--txt-2)' }}>
                      {PARAM_LABELS[p.id] || p.id}
                      <span style={{ fontSize:9, color:'var(--txt-4)', fontFamily:'var(--font-mono)', marginLeft:5 }}>{p.id}</span>
                    </span>
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:11, fontWeight:700, color:'var(--green)' }}>
                      {cond.typ ?? cond.max ?? cond.min}
                    </span>
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--cyan)' }}>{cond.unit || '—'}</span>
                    <button
                      title="Delete — moves back to missing list"
                      onClick={() => deleteManual(p.id)}
                      style={{ background:'none', border:'none', cursor:'pointer', color:'var(--red)', opacity:.7, padding:'1px 4px', fontSize:13, lineHeight:1 }}
                    >×</button>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Still-missing entries ─────────────────────────────── */}
          {stillMissing.length > 0 && (
            <>
              <div style={{ fontSize:11, color:'var(--txt-3)', marginBottom:2 }}>
                Not found in datasheet — enter manually to include in calculations:
              </div>
              {stillMissing.map(id => (
                <div key={id} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:5, background:'rgba(255,68,68,.05)', border:'1px solid rgba(255,68,68,.12)' }}>
                  <AlertTriangle size={11} color="var(--red)" style={{ flexShrink:0 }}/>
                  <span style={{ flex:1, fontSize:11, color:'var(--txt-2)', minWidth:130 }}>
                    {PARAM_LABELS[id] || id}
                    <span style={{ fontSize:9, color:'var(--txt-4)', fontFamily:'var(--font-mono)', marginLeft:5 }}>{id}</span>
                  </span>
                  <input
                    type="number" step="any" placeholder="value"
                    className="inp inp-mono inp-sm"
                    style={{ width:75 }}
                    value={vals[id] || ''}
                    onChange={e => setVals(p => ({ ...p, [id]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') commit(id) }}
                  />
                  <UnitPicker
                    value={units[id] || ''}
                    onChange={v => setUnits(p => ({ ...p, [id]: v }))}
                    style={{ width:80 }}
                  />
                  <button
                    onClick={() => commit(id)}
                    disabled={!vals[id]}
                    style={{
                      padding:'2px 9px', borderRadius:4, fontSize:11, fontWeight:600, flexShrink:0,
                      background: vals[id] ? `${color}20` : 'var(--bg-3)',
                      color: vals[id] ? color : 'var(--txt-4)',
                      border:`1px solid ${vals[id] ? color+'40' : 'transparent'}`,
                      cursor: vals[id] ? 'pointer' : 'default',
                    }}
                  >Set</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
