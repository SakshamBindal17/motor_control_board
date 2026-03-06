import React from 'react'
import { useProject } from './context/ProjectContext.jsx'
import Header from './components/Header.jsx'
import Sidebar from './components/Sidebar.jsx'
import BlockPanel from './components/BlockPanel.jsx'
import MotorForm from './components/MotorForm.jsx'
import PassivesPanel from './components/PassivesPanel.jsx'
import FeedbackPanel from './components/FeedbackPanel.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import ReportPanel from './components/ReportPanel.jsx'

export const BLOCK_CONFIGS = {
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
}

export default function App() {
  const { state } = useProject()
  const cfg = BLOCK_CONFIGS[state.active_block]

  function renderPanel() {
    if (!cfg) return null
    switch (cfg.type) {
      case 'upload': return <BlockPanel key={state.active_block} blockKey={state.active_block} config={cfg} />
      case 'motor': return <MotorForm config={cfg} />
      case 'passives': return <PassivesPanel config={cfg} />
      case 'feedback': return <FeedbackPanel config={cfg} />
      default: return null
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar blocks={BLOCK_CONFIGS} />
        <main style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}>
          {renderPanel()}
        </main>
      </div>
      {state.settings_open && <SettingsModal />}
      {state.report_open && <ReportPanel />}
    </div>
  )
}
