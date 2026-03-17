import React, { useState } from 'react'
import { X, FileText, Table, Download } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'
import { downloadReport } from '../api.js'

export default function ReportPanel() {
  const { state, dispatch } = useProject()
  const { project } = state
  const [loading, setLoading] = useState(null)

  function close() { dispatch({ type: 'TOGGLE_REPORT' }) }

  async function download(format) {
    if (!project.calculations) {
      toast.error('Run calculations first before generating a report')
      return
    }
    setLoading(format)
    toast.loading(`Generating ${format.toUpperCase()} report…`, { id: 'report' })
    try {
      const blob = await downloadReport(
        { name: project.name, system_specs: project.system_specs },
        project.calculations,
        format
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = format === 'pdf' ? 'mc_design_report.pdf' : 'mc_bom.xlsx'
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Download started!', { id: 'report' })
    } catch (err) {
      toast.error(`Report failed: ${err.message}`, { id: 'report' })
    } finally {
      setLoading(null)
    }
  }

  const hasCalc    = !!project.calculations
  const doneBlocks = ['mcu','driver','mosfet'].filter(k => project.blocks[k]?.status === 'done')

  // Overlay + modal box — same pattern as SettingsModal
  const overlay = {
    position: 'fixed', inset: 0, zIndex: 50,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(4px)',
  }

  const box = {
    background: 'var(--bg-2)',
    border: '1px solid var(--border-2)',
    borderRadius: 12,
    width: '100%',
    maxWidth: 480,
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
  }

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && close()}>
      <div style={box}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 20px',
          borderBottom: '1px solid var(--border-1)',
        }}>
          <span style={{ fontSize: 18 }}>📋</span>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt-1)' }}>Export Report</span>
          <button onClick={close} className="btn btn-ghost btn-icon" style={{ marginLeft: 'auto' }}>
            <X size={15}/>
          </button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Status block */}
          <div style={{
            background: 'var(--bg-3)', borderRadius: 8, padding: '10px 14px',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-2)', marginBottom: 4,
              textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Project Status
            </div>
            <StatusLine label="Datasheets extracted" ok={doneBlocks.length === 3}
              value={`${doneBlocks.length}/3 (${doneBlocks.join(', ') || 'none'})`} />
            <StatusLine label="Calculations complete" ok={hasCalc}
              value={hasCalc ? 'Yes' : 'Not yet'} />
            <StatusLine label="Motor specs entered"
              ok={!!project.blocks.motor.specs?.max_speed_rpm}
              value="Manual entry" />
          </div>

          {/* Warning if no calcs */}
          {!hasCalc && (
            <div style={{
              padding: '8px 12px', borderRadius: 7, fontSize: 11, lineHeight: 1.5,
              background: 'rgba(255,68,68,.08)', color: 'var(--red)',
              border: '1px solid rgba(255,68,68,.2)',
            }}>
              ⚠ Run calculations first (in any IC block) to include results in the report.
            </div>
          )}

          {/* Export cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ExportCard icon={<FileText size={20}/>} title="PDF Design Report"
              desc="Full engineering report with specs, loss analysis, BOM, thermal, protection thresholds"
              color="#ef4444" loading={loading === 'pdf'} onClick={() => download('pdf')} />
            <ExportCard icon={<Table size={20}/>} title="Excel BOM + Calculations"
              desc="Bill of Materials with component values, quantities, and all calculation results"
              color="#22c55e" loading={loading === 'excel'} onClick={() => download('excel')} />
          </div>
        </div>

        {/* Footer */}
        <div style={{
          borderTop: '1px solid var(--border-1)',
          padding: '12px 20px',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button onClick={close} className="btn btn-ghost" style={{ fontSize: 12 }}>
            Close
          </button>
        </div>

      </div>
    </div>
  )
}

function ExportCard({ icon, title, desc, color, loading, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px',
        background: 'var(--bg-3)', border: '1px solid var(--border-1)',
        borderRadius: 9, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.7 : 1,
        textAlign: 'left', width: '100%',
        transition: 'border-color .15s, background .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.background = `${color}08` }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-1)'; e.currentTarget.style.background = 'var(--bg-3)' }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: 10, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `${color}20`, color, border: `1px solid ${color}30`,
      }}>
        {loading ? <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span> : icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--txt-1)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
      </div>
      <Download size={13} style={{ color: 'var(--txt-3)', flexShrink: 0 }}/>
    </button>
  )
}

function StatusLine({ label, ok, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: ok ? 'var(--green)' : 'var(--amber)', fontWeight: 700 }}>{ok ? '✓' : '○'}</span>
        <span style={{ color: 'var(--txt-2)' }}>{label}</span>
      </div>
      <span style={{ color: ok ? 'var(--green)' : 'var(--txt-3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{value}</span>
    </div>
  )
}
