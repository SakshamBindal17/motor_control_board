import React, { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, RefreshCw, CheckCircle, AlertCircle, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'
import { extractDatasheet } from '../api.js'
import ParameterTable from './ParameterTable.jsx'
import CalculationsPanel from './CalculationsPanel.jsx'
import UnitPicker from './UnitPicker.jsx'

// ── ESSENTIAL PARAMS ────────────────────────────────────────────────────────
// These are required for calculations and board design.
// If Claude fails to extract any of these they appear in the Missing Params
// section so the user can enter them manually.
const EXPECTED_PARAMS = {
  // 17 essential MOSFET params — cover all switching, thermal, and gate-charge calcs
  mosfet: [
    'vds_max',        // absolute max voltage rating
    'id_cont',        // continuous current rating
    'rds_on',         // conduction loss
    'vgs_th',         // gate drive headroom (Vdrv - Vth)
    'qg',             // gate charge loss + bootstrap sizing
    'qgd',            // Miller charge (gate resistor calc)
    'qgs',            // gate-source charge
    'qrr',            // reverse recovery loss
    'trr',            // reverse recovery time
    'coss',           // output capacitance (snubber design)
    'td_on',          // switching timing
    'tr',             // rise time (switching loss)
    'td_off',         // turn-off delay (dead-time minimum)
    'tf',             // fall time (switching loss)
    'rth_jc',         // thermal: junction temperature estimate
    'tj_max',         // thermal: margin check
    'body_diode_vf',  // body diode forward drop
    'ciss',           // input capacitance (for gate resistor Qg fallback)
  ],
  // 15 essential Gate Driver params — supply, drive current, timing, logic thresholds
  driver: [
    'vcc_range',       // supply voltage range
    'vcc_uvlo',        // under-voltage lockout (supply)
    'vbs_max',         // max bootstrap voltage
    'vbs_uvlo',        // bootstrap UVLO
    'io_source',       // peak source current → Rg_on calculation
    'io_sink',         // peak sink current → Rg_off calculation
    'prop_delay_on',   // turn-on propagation delay → dead-time calc
    'prop_delay_off',  // turn-off propagation delay → dead-time calc
    'deadtime_min',    // built-in minimum dead time (if present)
    'deadtime_default',// default/fixed dead time (if present)
    'vil',             // logic low threshold
    'vih',             // logic high threshold
    'rth_ja',          // thermal resistance
    'tj_max',          // max junction temperature
    'current_sense_gain', // used for shunt resistor sizing
  ],
  // 10 essential MCU params — the ones that feed into dead-time and ADC calculations
  mcu: [
    'cpu_freq_max',        // max CPU clock
    'adc_resolution',      // ADC bits → shunt SNR (bits_used calc)
    'adc_channels',        // number of ADC inputs
    'adc_sample_rate',     // ADC conversion speed
    'pwm_timers',          // advanced-control timer count
    'pwm_resolution',      // PWM counter width (bits)
    'pwm_deadtime_res',    // dead-time LSB → dt_register = dt_ns / resolution
    'pwm_deadtime_max',    // dead-time feasibility check
    'complementary_outputs', // complementary PWM pairs for 3-phase
    'vdd_range',           // VDD operating range
  ],
}

// Set version of the essential lists (used for O(1) lookup in the UI)
const ESSENTIAL_PARAMS = {
  mosfet: new Set(EXPECTED_PARAMS.mosfet),
  driver: new Set(EXPECTED_PARAMS.driver),
  mcu: new Set(EXPECTED_PARAMS.mcu),
}

// Params that are directly read by calc_engine.py — engine formula references them by name.
// ★ badge = "the app reads this value in a formula right now"
const CALC_CRITICAL = {
  mosfet: new Set([
    "rds_on",         // conduction loss, gate resistor
    "qg",             // gate resistor, bootstrap, gate charge loss
    "qgd",            // gate resistor (Qgd/Io ratio)
    "tr",             // switching loss (0.5 × Vbus × Imax × tr × fsw)
    "tf",             // switching loss
    "td_off",         // dead time minimum
    "coss",           // snubber design
    "qrr",            // reverse recovery loss
    "body_diode_vf",  // snubber / diode drop
    "rth_jc",         // thermal → Tj estimate
    "tj_max",         // thermal margin check
    "vgs_th",         // gate resistor (Vdrv - Vth drive headroom)
    "ciss",           // gate resistor (alternative Qg path)
  ]),
  driver: new Set([
    "io_source",      // Rg_on calculation
    "io_sink",        // Rg_off calculation
    "prop_delay_on",  // dead time: dt_min = td_off + tf + prop_delay_off + margin
    "prop_delay_off", // dead time
    "vbs_uvlo",       // bootstrap voltage check vs UVLO
    "current_sense_gain", // shunt resistor sizing (V_ADC = Ishunt × Rshunt × gain)
  ]),
  mcu: new Set([
    "pwm_deadtime_res",  // dead time register calculation (dt_reg = dt_ns / resolution)
    "pwm_deadtime_max",  // dead time feasibility check
    "adc_resolution",    // shunt ADC SNR / bits-used calculation
  ]),
}

const PARAM_LABELS = {
  // ── MOSFET essential ────────────────────────────────────────────────────
  vds_max: 'Max Drain-Source Voltage', id_cont: 'Continuous Drain Current',
  rds_on: 'On-Resistance', vgs_th: 'Gate Threshold Voltage',
  qg: 'Total Gate Charge', qgd: 'Gate-Drain (Miller) Charge',
  qgs: 'Gate-Source Charge', qrr: 'Reverse Recovery Charge',
  trr: 'Reverse Recovery Time', coss: 'Output Capacitance',
  td_on: 'Turn-On Delay Time', tr: 'Rise Time',
  td_off: 'Turn-Off Delay Time', tf: 'Fall Time',
  rth_jc: 'Thermal Resistance (J-C)', tj_max: 'Max Junction Temperature',
  body_diode_vf: 'Body Diode Forward Voltage',
  // ── MOSFET good-to-have ─────────────────────────────────────────────────
  vgs_max: 'Max Gate-Source Voltage', id_pulsed: 'Pulsed Drain Current',
  ciss: 'Input Capacitance', crss: 'Reverse Transfer Capacitance',
  avalanche_energy: 'Avalanche Energy', rg_int: 'Internal Gate Resistance',
  vgs_plateau: 'Gate Plateau Voltage', qoss: 'Output Charge (Qoss)',
  // ── Gate Driver essential ────────────────────────────────────────────────
  vcc_range: 'VCC Supply Voltage Range', vcc_uvlo: 'VCC UVLO',
  vbs_max: 'Max Bootstrap Voltage', vbs_uvlo: 'Bootstrap UVLO',
  io_source: 'Peak Source Current', io_sink: 'Peak Sink Current',
  prop_delay_on: 'Prop Delay (Turn-On)', prop_delay_off: 'Prop Delay (Turn-Off)',
  deadtime_min: 'Minimum Dead Time', deadtime_default: 'Default Dead Time',
  vil: 'Input Logic Low (VIL)', vih: 'Input Logic High (VIH)',
  rth_ja: 'Thermal Resistance (J-A)',
  // ── Gate Driver good-to-have ─────────────────────────────────────────────
  ocp_threshold: 'OCP Threshold', ocp_response: 'OCP Blanking Time',
  thermal_shutdown: 'Thermal Shutdown Temp',
  current_sense_gain: 'Current Sense Amplifier Gain',
  rise_time_out: 'Driver Output Rise Time',
  fall_time_out: 'Driver Output Fall Time',
  // ── MCU essential ────────────────────────────────────────────────────────
  cpu_freq_max: 'Max CPU Frequency',
  adc_resolution: 'ADC Resolution', adc_channels: 'ADC Channels',
  adc_sample_rate: 'ADC Sample Rate', pwm_timers: 'Advanced PWM Timers',
  pwm_resolution: 'PWM Timer Resolution',
  pwm_deadtime_res: 'Dead-Time Generator Resolution',
  pwm_deadtime_max: 'Max Programmable Dead Time',
  complementary_outputs: 'Complementary Output Pairs',
  vdd_range: 'VDD Voltage Range',
  // ── MCU good-to-have ────────────────────────────────────────────────────
  flash_size: 'Flash Memory Size', ram_size: 'RAM / SRAM Size',
  spi_count: 'SPI Interfaces', uart_count: 'UART / USART Interfaces',
  idd_run: 'Run Mode Current', temp_range: 'Operating Temperature Range',
  gpio_count: 'Total GPIO Count', encoder_interface: 'Encoder / Hall Interface',
  can_count: 'CAN Bus Interfaces', dma_channels: 'DMA Channels',
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
  const expectedIds = EXPECTED_PARAMS[blockKey] || []
  const missingIds = expectedIds.filter(id => !extractedIds.has(id))

  // Count multi-condition params per category (for closed-header badge)
  function attentionCountForGroup(params) {
    return params.filter(p => (p.conditions?.length || 0) > 1).length
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0 }}>
      {/* ─── Left: Upload + params ─────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, overflowY: 'auto', paddingRight: 4 }}>

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

        {/* Parameter groups — two top-level sections: Essential & Good to Have */}
        {status === 'done' && raw_data && (
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="sec-head">
              <CheckCircle size={13} style={{ color: 'var(--green)' }} />
              Extracted Parameters
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: config.color, marginLeft: 4 }}>
                {raw_data.parameters?.length || 0}
              </span>
            </div>

            <div style={{ flex: 1, overflow: 'auto' }}>
              {(() => {
                const essentialSet = ESSENTIAL_PARAMS[blockKey] || new Set()
                const calcCritSet = CALC_CRITICAL[blockKey] || new Set()

                // Partition ALL extracted params into essential vs good-to-have
                const allParams = raw_data.parameters || []
                const essParams = allParams.filter(p => essentialSet.has(p.id))
                const gthParams = allParams.filter(p => !essentialSet.has(p.id))

                // Group each partition by category
                function byCategory(params) {
                  return params.reduce((acc, p) => {
                    const cat = p.category || 'Other'
                    if (!acc[cat]) acc[cat] = []
                    acc[cat].push(p)
                    return acc
                  }, {})
                }
                const essCats = byCategory(essParams)
                const gthCats = byCategory(gthParams)

                const essOpen = collapsed['__top_ess__'] !== false  // default open
                const gthOpen = collapsed['__top_gth__'] !== false  // default open

                // Total attention count for a set of params
                const essAttention = essParams.filter(p => (p.conditions?.length || 0) > 1).length

                // Sub-category row component
                function SubCatSection({ cat, params, isCrit = false }) {
                  const catKey = `__cat__${isCrit ? 'ess' : 'gth'}__${cat}`
                  const catOpen = collapsed[catKey] !== false
                  const catAttn = params.filter(p => (p.conditions?.length || 0) > 1).length
                  return (
                    <div key={cat} style={{ borderBottom: '1px solid var(--border-1)' }}>
                      <button
                        className={`collapsible-trigger ${catOpen ? 'open' : ''}`}
                        onClick={() => setCollapsed(p => ({ ...p, [catKey]: !catOpen }))}
                        style={{ paddingLeft: 22, background: 'var(--bg-3)', fontSize: 11 }}
                      >
                        {catOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                        <span style={{ color: 'var(--txt-2)' }}>{cat}</span>
                        <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', padding: '1px 5px', background: 'var(--bg-4)', borderRadius: 3 }}>
                          {params.length}
                        </span>
                        {!catOpen && catAttn > 0 && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(255,171,0,.15)', color: 'var(--amber)', border: '1px solid rgba(255,171,0,.3)' }}>
                            <AlertTriangle size={8} />{catAttn}
                          </span>
                        )}
                        <span className="chevron"><ChevronDown size={10} /></span>
                      </button>
                      {catOpen && (
                        <div className="table-wrap">
                          <ParameterTable params={params} blockKey={blockKey} color={config.color}
                            calcCritical={isCrit ? calcCritSet : null} />
                        </div>
                      )}
                    </div>
                  )
                }

                return (
                  <>
                    {/* ══ TOP SECTION: ESSENTIAL ═══════════════════════════ */}
                    <div>
                      <button
                        className={`collapsible-trigger ${essOpen ? 'open' : ''}`}
                        onClick={() => setCollapsed(p => ({ ...p, '__top_ess__': !essOpen }))}
                        style={{ background: 'rgba(0,230,118,.06)', borderBottom: '1px solid rgba(0,230,118,.15)' }}
                      >
                        {essOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span style={{ fontWeight: 700, color: 'var(--green)' }}>✦ Essential</span>
                        <span style={{ fontSize: 9, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>
                          {essParams.length} params — required for board design
                        </span>
                        {essAttention > 0 && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'rgba(255,171,0,.15)', color: 'var(--amber)', border: '1px solid rgba(255,171,0,.3)' }}>
                            <AlertTriangle size={8} /> {essAttention} need attention
                          </span>
                        )}
                        <span
                          title="★ calc-critical = this value is read directly by a formula in the calculation engine. Enter these first for accurate results."
                          style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--cyan)', fontFamily: 'var(--font-mono)', fontWeight: 600, cursor: 'help' }}>
                          ★ {essParams.filter(p => calcCritSet.has(p.id)).length} used in formulas
                        </span>
                        <span className="chevron"><ChevronDown size={11} /></span>
                      </button>

                      {essOpen && (
                        <div>
                          {Object.entries(essCats).map(([cat, params]) =>
                            <SubCatSection key={cat} cat={cat} params={params} isCrit={true} />
                          )}
                          {essParams.length === 0 && (
                            <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--txt-3)' }}>
                              No essential parameters extracted — check the datasheet.
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* ══ TOP SECTION: GOOD TO HAVE ════════════════════════ */}
                    {gthParams.length > 0 && (
                      <div>
                        <button
                          className={`collapsible-trigger ${gthOpen ? 'open' : ''}`}
                          onClick={() => setCollapsed(p => ({ ...p, '__top_gth__': !gthOpen }))}
                          style={{ background: 'rgba(30,144,255,.04)', borderBottom: '1px solid rgba(30,144,255,.12)' }}
                        >
                          {gthOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          <span style={{ fontWeight: 700, color: 'var(--cyan)' }}>◈ Good to Have</span>
                          <span style={{ fontSize: 9, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>
                            {gthParams.length} extra params — reference only
                          </span>
                          <span className="chevron"><ChevronDown size={11} /></span>
                        </button>

                        {gthOpen && (
                          <div style={{ opacity: 0.85 }}>
                            {Object.entries(gthCats).map(([cat, params]) =>
                              <SubCatSection key={cat} cat={cat} params={params} isCrit={false} />
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ══ MISSING / NOT EXTRACTED ══════════════════════════ */}
                    {missingIds.length > 0 && (
                      <MissingParamsSection
                        missingIds={missingIds}
                        blockKey={blockKey}
                        color={config.color}
                        collapsed={collapsed}
                        setCollapsed={setCollapsed}
                      />
                    )}
                  </>
                )
              })()}
            </div>
          </div>
        )}
      </div>

      {/* ─── Right: Calculations panel ───────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <CalculationsPanel />
      </div>
    </div>
  )
}

function StatusChip({ status, color }) {
  const map = {
    idle: { cls: 'badge-idle', label: 'Ready' },
    uploading: { cls: 'badge-busy', label: 'Uploading…' },
    extracting: { cls: 'badge-busy', label: 'Extracting…' },
    done: { cls: 'badge-done', label: '✓ Done' },
    error: { cls: 'badge-error', label: '✗ Error' },
  }
  const s = map[status] || map.idle
  return <span className={`badge ${s.cls}`}>{s.label}</span>
}

function MissingParamsSection({ missingIds, blockKey, color, collapsed, setCollapsed }) {
  const { state, dispatch } = useProject()
  const [vals, setVals] = useState({})
  const [units, setUnits] = useState({})
  const isOpen = collapsed['__missing__'] !== false
  const gthOpen = collapsed['__missing_gth__'] !== false  // good-to-have sub-section

  const manualParams = (state.project.blocks[blockKey]?.raw_data?.parameters || [])
    .filter(p => p.category === 'Manual Entry')
  const manualIds = new Set(manualParams.map(p => p.id))

  const stillMissing = missingIds.filter(id => !manualIds.has(id))

  // Split still-missing into calc-critical vs good-to-have
  const critSet = CALC_CRITICAL[blockKey] || new Set()
  const missingCrit = stillMissing.filter(id => critSet.has(id))
  const missingGth = stillMissing.filter(id => !critSet.has(id))

  // Same split for manually-set params (to show which category they came from)
  const manualCrit = manualParams.filter(p => critSet.has(p.id))
  const manualGth = manualParams.filter(p => !critSet.has(p.id))

  function commit(id) {
    const v = parseFloat(vals[id])
    if (isNaN(v)) return
    dispatch({ type: 'SET_MANUAL_PARAM', payload: { block: blockKey, param_id: id, value: v, unit: units[id] || '' } })
    setVals(p => { const n = { ...p }; delete n[id]; return n })
  }

  function deleteManual(id) {
    dispatch({ type: 'DELETE_MANUAL_PARAM', payload: { block: blockKey, param_id: id } })
  }

  const totalCount = stillMissing.length + manualParams.length
  if (totalCount === 0) return null

  // Reusable row for a missing param entry input
  function MissingRow({ id, isCrit }) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 5,
        background: isCrit ? 'rgba(255,68,68,.05)' : 'rgba(30,144,255,.04)',
        border: `1px solid ${isCrit ? 'rgba(255,68,68,.15)' : 'rgba(30,144,255,.12)'}`,
      }}>
        {isCrit
          ? <AlertTriangle size={11} color="var(--red)" style={{ flexShrink: 0 }} />
          : <span style={{ width: 11, textAlign: 'center', fontSize: 11, color: 'var(--cyan)', flexShrink: 0 }}>◈</span>
        }
        <span style={{ flex: 1, fontSize: 11, color: 'var(--txt-2)', minWidth: 130 }}>
          {PARAM_LABELS[id] || id}
          <span style={{ fontSize: 9, color: 'var(--txt-4)', fontFamily: 'var(--font-mono)', marginLeft: 5 }}>{id}</span>
        </span>
        <input
          type="number" step="any" placeholder="value"
          className="inp inp-mono inp-sm"
          style={{ width: 75 }}
          value={vals[id] || ''}
          onChange={e => setVals(p => ({ ...p, [id]: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter') commit(id) }}
        />
        <UnitPicker
          value={units[id] || ''}
          onChange={v => setUnits(p => ({ ...p, [id]: v }))}
          style={{ width: 80 }}
        />
        <button
          onClick={() => commit(id)}
          disabled={!vals[id]}
          style={{
            padding: '2px 9px', borderRadius: 4, fontSize: 11, fontWeight: 600, flexShrink: 0,
            background: vals[id] ? `${color}20` : 'var(--bg-3)',
            color: vals[id] ? color : 'var(--txt-4)',
            border: `1px solid ${vals[id] ? color + '40' : 'transparent'}`,
            cursor: vals[id] ? 'pointer' : 'default',
          }}
        >Set</button>
      </div>
    )
  }

  // Reusable row for a manually-set param
  function ManualRow({ p }) {
    const cond = p.conditions?.[0] || {}
    const isCrit = critSet.has(p.id)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 5, background: 'rgba(0,230,118,.04)', border: '1px solid rgba(0,230,118,.15)' }}>
        <span style={{ width: 11, textAlign: 'center', fontSize: 10, color: 'var(--green)' }}>✓</span>
        <span style={{ flex: 1, fontSize: 11, color: 'var(--txt-2)' }}>
          {PARAM_LABELS[p.id] || p.id}
          <span style={{ fontSize: 9, color: 'var(--txt-4)', fontFamily: 'var(--font-mono)', marginLeft: 5 }}>{p.id}</span>
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--green)' }}>
          {cond.typ ?? cond.max ?? cond.min}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--cyan)', minWidth: 28 }}>{cond.unit || '—'}</span>
        <button title="Remove — moves back to missing" onClick={() => deleteManual(p.id)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', opacity: .6, padding: '1px 5px', fontSize: 14, lineHeight: 1 }}>×</button>
      </div>
    )
  }

  return (
    <div>
      {/* ── Section header ───────────────────────────────────────── */}
      <button
        className={`collapsible-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setCollapsed(p => ({ ...p, '__missing__': !isOpen }))}
        style={{ borderTop: '1px solid rgba(255,68,68,.2)' }}
      >
        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span style={{ color: 'var(--red)' }}>Missing / Not Extracted</span>
        {missingCrit.length > 0 && (
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', padding: '1px 6px', background: 'rgba(255,68,68,.12)', color: 'var(--red)', borderRadius: 4 }}>
            {missingCrit.length} calc-critical
          </span>
        )}
        {missingGth.length > 0 && (
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', padding: '1px 6px', background: 'rgba(30,144,255,.1)', color: 'var(--cyan)', borderRadius: 4 }}>
            {missingGth.length} optional
          </span>
        )}
        {manualParams.length > 0 && (
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', padding: '1px 6px', background: 'rgba(0,230,118,.1)', color: 'var(--green)', borderRadius: 4 }}>
            {manualParams.length} set
          </span>
        )}
        <span className="chevron"><ChevronDown size={11} /></span>
      </button>

      {isOpen && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>

          {/* ══ CALC-CRITICAL MISSING ════════════════════════════════ */}
          {(missingCrit.length > 0 || manualCrit.length > 0) && (
            <div>
              {/* Sub-header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 14px 4px',
                background: 'rgba(255,68,68,.04)',
                borderBottom: '1px solid rgba(255,68,68,.12)',
              }}>
                <AlertTriangle size={10} color="var(--red)" />
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--red)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                  ★ Calc-Critical
                </span>
                <span style={{ fontSize: 9, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>
                  — enter these to get accurate results
                </span>
                {missingCrit.length === 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--green)', fontWeight: 600 }}>all set ✓</span>
                )}
              </div>
              <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                {manualCrit.map(p => <ManualRow key={p.id} p={p} />)}
                {missingCrit.map(id => <MissingRow key={id} id={id} isCrit={true} />)}
              </div>
            </div>
          )}

          {/* ══ GOOD-TO-HAVE MISSING ═════════════════════════════════ */}
          {(missingGth.length > 0 || manualGth.length > 0) && (
            <div>
              {/* Sub-header — collapsible */}
              <button
                onClick={() => setCollapsed(p => ({ ...p, '__missing_gth__': !gthOpen }))}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 14px', cursor: 'pointer',
                  background: 'rgba(30,144,255,.03)',
                  border: 'none', borderBottom: '1px solid var(--border-1)',
                }}
              >
                {gthOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--cyan)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                  ◈ Good to Have
                </span>
                <span style={{ fontSize: 9, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>
                  — optional, no direct calculation impact
                </span>
                {manualGth.length > 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                    {manualGth.length} set
                  </span>
                )}
              </button>
              {gthOpen && (
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5, opacity: .9 }}>
                  {manualGth.map(p => <ManualRow key={p.id} p={p} />)}
                  {missingGth.map(id => <MissingRow key={id} id={id} isCrit={false} />)}
                </div>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  )
}
