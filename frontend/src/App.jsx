import React, { Suspense, lazy } from 'react'
import { useProject } from './context/ProjectContext.jsx'
import Header from './components/Header.jsx'
import Sidebar from './components/Sidebar.jsx'

const BlockPanel = lazy(() => import('./components/BlockPanel.jsx'))
const MotorForm = lazy(() => import('./components/MotorForm.jsx'))
const PassivesPanel = lazy(() => import('./components/PassivesPanel.jsx'))
const FeedbackPanel = lazy(() => import('./components/FeedbackPanel.jsx'))
const DashboardPanel = lazy(() => import('./components/DashboardPanel.jsx'))
const ChartsPanel = lazy(() => import('./components/ChartsPanel.jsx'))
const WaveformPanel = lazy(() => import('./components/WaveformPanel.jsx'))
const ComparisonPanel = lazy(() => import('./components/ComparisonPanel.jsx'))
const DiagramPanel = lazy(() => import('./components/DiagramPanel.jsx'))
const ThermalTracePanel = lazy(() => import('./components/ThermalTracePanel.jsx'))

import SettingsModal from './components/SettingsModal.jsx'
import ReportPanel from './components/ReportPanel.jsx'
import DesignConstantsModal from './components/DesignConstantsModal.jsx'
import SmartTooltip from './components/SmartTooltip.jsx'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info.componentStack)
  }
  render() {
    if (this.state.hasError) {
      if (this.props.inline) {
        return (
          <div style={{ padding: 32, color: 'var(--txt-3)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p>Failed to load panel. Refresh to retry.</p>
            <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => window.location.reload()}>
              Refresh
            </button>
          </div>
        )
      }
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', padding: 40, background: 'var(--bg-1)', color: 'var(--txt-1)',
        }}>
          <h2 style={{ marginBottom: 12 }}>Something went wrong</h2>
          <p style={{ color: 'var(--txt-3)', marginBottom: 20, maxWidth: 500, textAlign: 'center' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button className="btn btn-primary" onClick={() => {
            this.setState({ hasError: false, error: null })
          }}>
            Try Again
          </button>
          <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => window.location.reload()}>
            Reload Page
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export const BLOCK_CONFIGS = {
  dashboard: {
    key: 'dashboard',
    label: 'Dashboard',
    fullLabel: 'Design Dashboard',
    icon: '📊',
    color: '#1e90ff',
    type: 'dashboard',
    desc: 'Overview — health score, loss breakdown, thermal analysis, key metrics',
  },
  diagram: {
    key: 'diagram',
    label: 'Diagram',
    fullLabel: 'Interactive Block Diagram',
    icon: '🔌',
    color: '#00d4e8',
    type: 'diagram',
    desc: 'Clickable topology — 3-phase inverter power stage, gate drive, control',
  },
  charts: {
    key: 'charts',
    label: 'Charts',
    fullLabel: 'Interactive Charts',
    icon: '📉',
    color: '#bb86fc',
    type: 'charts',
    desc: 'Parametric sweeps — loss vs frequency, derating, efficiency, gate timing',
  },
  waveform: {
    key: 'waveform',
    label: 'Waveform',
    fullLabel: 'Waveform Simulator',
    icon: '🔬',
    color: '#FFD700',
    type: 'waveform',
    desc: 'Switching waveform simulator — Vgs, Vds, Id, Ig oscilloscope view from datasheet',
  },
  mcu: {
    key: 'mcu',
    label: 'MCU',
    fullLabel: 'Microcontroller',
    icon: '🧠',
    color: '#1e90ff',
    type: 'upload',
    extractionType: 'mcu',
    desc: 'Motor-control MCU — PWM timers, ADC, dead-time generator, SPI/UART',
  },
  driver: {
    key: 'driver',
    label: 'Gate Driver',
    fullLabel: 'Gate Driver IC',
    icon: '⚡',
    color: '#bb86fc',
    type: 'upload',
    extractionType: 'driver',
    desc: '3-phase non-isolated bootstrap driver — source/sink current, UVLO, OCP, dead-time',
  },
  passives: {
    key: 'passives',
    label: 'Passives',
    fullLabel: 'Passive Components',
    icon: '🔧',
    color: '#ffab00',
    type: 'passives',
    desc: 'Gate R, caps, snubbers, shunts, dividers — auto-calculated with overrides',
  },
  mosfet: {
    key: 'mosfet',
    label: 'MOSFETs',
    fullLabel: 'Power MOSFETs',
    icon: '🔋',
    color: '#ff4444',
    type: 'upload',
    extractionType: 'mosfet',
    desc: 'N-ch power MOSFETs — Rds(on), Qg, switching times, thermal resistance',
  },
  motor: {
    key: 'motor',
    label: 'Motor',
    fullLabel: 'PMSM Motor',
    icon: '🌀',
    color: '#00e676',
    type: 'motor',
    desc: 'Motor parameters — manual entry: Rph, Lph, Kt, poles, rated speed',
  },
  feedback: {
    key: 'feedback',
    label: 'Feedback',
    fullLabel: 'Feedback & Sensing',
    icon: '🔄',
    color: '#00d4e8',
    type: 'feedback',
    desc: 'Sensing chain, ADC scaling, OCP/OVP/OTP — connects MOSFETs ↔ MCU',
  },
  compare: {
    key: 'compare',
    label: 'Compare',
    fullLabel: 'MOSFET Loss Analyzer',
    icon: '⚖️',
    color: '#00d4e8',
    type: 'compare',
    desc: 'Batch MOSFET datasheet analysis — queued extraction, ranking, timing and optional project selection',
  },
  pcb_thermal: {
    key: 'pcb_thermal',
    label: 'PCB Thermal & Impedance',
    fullLabel: 'PCB Trace Thermal & Power Loop Impedance',
    icon: '🔥',
    color: '#f0a04a',
    type: 'pcb_thermal',
    desc: 'IPC-2221B/2152 trace & via thermal — current capacity, ΔT, voltage drop, recommendations. Also: half-bridge power loop inductance and PCB layout guidelines.',
  },
}

export default function App() {
  const { state } = useProject()
  const cfg = BLOCK_CONFIGS[state.active_block]

  return (
    <ErrorBoundary>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header />
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <Sidebar blocks={BLOCK_CONFIGS} />
          <main style={{
            flex: 1,
            overflow: 'hidden',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}>
            <ErrorBoundary inline>
              <Suspense fallback={<div style={{ padding: 20, color: 'var(--txt-3)' }}>Loading panel...</div>}>
                {Object.keys(BLOCK_CONFIGS).map(key => {
                  const b = BLOCK_CONFIGS[key]
                  const isActive = state.active_block === key
                  
                  return (
                    <div key={key} style={{ 
                      display: isActive ? 'flex' : 'none',
                      flexDirection: 'column',
                      flex: 1,
                      overflow: 'auto',
                      padding: '16px'
                    }}>
                      {key === 'dashboard' && <DashboardPanel config={b} />}
                      {key === 'diagram' && <DiagramPanel config={b} />}
                      {key === 'charts' && <ChartsPanel config={b} />}
                      {b.type === 'upload' && <BlockPanel blockKey={key} config={b} />}
                      {key === 'motor' && <MotorForm config={b} />}
                      {key === 'passives' && <PassivesPanel config={b} />}
                      {key === 'feedback' && <FeedbackPanel config={b} />}
                      {key === 'waveform' && <WaveformPanel config={b} />}
                      {key === 'compare' && <ComparisonPanel config={b} />}
                      {key === 'pcb_thermal' && <ThermalTracePanel config={b} />}
                    </div>
                  )
                })}
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        {state.settings_open && <SettingsModal />}
        {state.report_open && <ReportPanel />}
        {state.constants_open && <DesignConstantsModal />}
        <SmartTooltip />
      </div>
    </ErrorBoundary>
  )
}
