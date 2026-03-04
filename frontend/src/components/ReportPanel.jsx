import React, { useState } from 'react'
import { X, FileText, Table, Download } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProject } from '../context/ProjectContext.jsx'

export default function ReportPanel() {
  const { state, dispatch } = useProject()
  const { project } = state
  const [loading, setLoading] = useState(null)

  function close() { dispatch({ type: 'TOGGLE_REPORT' }) }

  async function download(format) {
    if (!project.calculations) {
      toast.error('Please run calculations first before generating a report')
      return
    }
    setLoading(format)
    toast.loading(`Generating ${format.toUpperCase()} report…`, { id: 'report' })
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: {
            name: project.name,
            system_specs: project.system_specs,
          },
          calculations: project.calculations,
          format,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail)
      const blob = await res.blob()
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

  function saveSessionJson() {
    const data = JSON.stringify(project, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name.replace(/\s+/g, '_')}_full_session.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Session JSON saved!')
  }

  const hasCalc = !!project.calculations
  const doneBlocks = ['mcu', 'driver', 'mosfet'].filter(k => project.blocks[k]?.status === 'done')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => e.target === e.currentTarget && close()}
    >
      <div className="card w-full max-w-lg" style={{ background: 'var(--bg-card)' }}>
        <div className="flex items-center gap-2 p-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <span className="text-xl">📋</span>
          <h2 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Export Report</h2>
          <button onClick={close} className="ml-auto p-1.5 rounded-lg btn-secondary"><X size={16} /></button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {/* Status */}
          <div className="rounded-lg p-3 text-xs" style={{ background: 'var(--bg-secondary)' }}>
            <div className="font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>Project Status</div>
            <StatusLine label="Datasheets extracted" ok={doneBlocks.length === 3}
              value={`${doneBlocks.length}/3 (${doneBlocks.join(', ') || 'none'})`} />
            <StatusLine label="Calculations complete" ok={hasCalc} value={hasCalc ? 'Yes' : 'Not yet'} />
            <StatusLine label="Motor specs" ok={!!project.blocks.motor.specs?.max_speed_rpm} value="Manual entry" />
          </div>

          {!hasCalc && (
            <div className="rounded-lg p-3 text-xs flex gap-2"
              style={{ background: 'rgba(248,81,73,0.1)', color: 'var(--danger)', border: '1px solid rgba(248,81,73,0.2)' }}>
              ⚠ Run calculations first (in MOSFET or Passives block) to include results in the report.
            </div>
          )}

          {/* Export options */}
          <div className="flex flex-col gap-3">
            <ExportCard
              icon={<FileText size={22} />}
              title="PDF Design Report"
              desc="Full engineering report with specs, loss analysis, BOM, thermal, and protection thresholds"
              color="#ef4444"
              loading={loading === 'pdf'}
              onClick={() => download('pdf')}
            />
            <ExportCard
              icon={<Table size={22} />}
              title="Excel BOM + Calculations"
              desc="Bill of Materials with component values, quantities, and all calculation results in spreadsheet"
              color="#22c55e"
              loading={loading === 'excel'}
              onClick={() => download('excel')}
            />
            <ExportCard
              icon={<Download size={22} />}
              title="Session JSON"
              desc="Save full project session including all extracted parameters and selections. Can be loaded later."
              color="#3b82f6"
              loading={false}
              onClick={saveSessionJson}
            />
          </div>
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
      className="card flex items-center gap-4 p-4 text-left w-full transition-all"
      style={{ cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.7 : 1 }}
    >
      <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: `${color}20`, color, border: `1px solid ${color}30` }}>
        {loading ? <span className="animate-spin">⏳</span> : icon}
      </div>
      <div>
        <div className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{title}</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{desc}</div>
      </div>
      <Download size={14} className="ml-auto flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
    </button>
  )
}

function StatusLine({ label, ok, value }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex items-center gap-1.5">
        <span style={{ color: ok ? 'var(--success)' : 'var(--warning)' }}>{ok ? '✓' : '○'}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <span style={{ color: ok ? 'var(--success)' : 'var(--text-muted)' }}>{value}</span>
    </div>
  )
}
