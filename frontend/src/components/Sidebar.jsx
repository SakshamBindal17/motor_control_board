import React from 'react'
import { useProject } from '../context/ProjectContext.jsx'
import { statusDotClass, statusLabel } from '../utils.js'

const BLOCK_ORDER = ['feedback', 'mcu', 'driver', 'passives', 'mosfet', 'motor']

function getBlockStatus(blocks, key) {
  if (key === 'motor') {
    const specs = blocks.motor?.specs
    return (specs?.max_speed_rpm && (specs?.rph_mohm || specs?.lph_uh)) ? 'done' : 'idle'
  }
  if (key === 'passives') return null   // no status for passives
  if (key === 'feedback') return null
  return blocks[key]?.status || 'idle'
}

export default function Sidebar({ blocks }) {
  const { state, dispatch } = useProject()
  const { active_block, project } = state
  const b = project.blocks

  function select(key) { dispatch({ type: 'SET_ACTIVE_BLOCK', payload: key }) }

  // Summary counts
  const done = ['mcu','driver','mosfet'].filter(k => b[k]?.status === 'done').length
  const hasCalc = !!project.calculations

  return (
    <aside style={{
      width: 220,
      flexShrink: 0,
      background: 'var(--bg-0)',
      borderRight: '1px solid var(--border-1)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Logo section */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid var(--border-1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{
            width: 30, height: 30,
            borderRadius: 8,
            background: 'linear-gradient(135deg, var(--accent), var(--cyan))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, flexShrink: 0,
            boxShadow: 'var(--glow-blue)',
          }}>⚡</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt-1)', lineHeight: 1.2 }}>MC Designer</div>
            <div style={{ fontSize: 10, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>v2.0</div>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>Datasheets</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: done === 3 ? 'var(--green)' : 'var(--amber)' }}>
              {done}/3
            </span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${(done/3)*100}%` }} />
          </div>
        </div>

        {hasCalc && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, color: 'var(--green)', fontFamily: 'var(--font-mono)',
          }}>
            <span>●</span> Calculations ready
          </div>
        )}
      </div>

      {/* Block navigation */}
      <nav style={{ flex: 1, padding: '10px 0', overflowY: 'auto', minHeight: 0 }}>
        {/* Dashboard & Charts */}
        <div style={{ padding: '0 8px 6px', marginBottom: 4 }}>
          <NavItem
            cfg={blocks.dashboard}
            isActive={active_block === 'dashboard'}
            status={hasCalc ? 'done' : null}
            onClick={() => select('dashboard')}
          />
          <NavItem
            cfg={blocks.diagram}
            isActive={active_block === 'diagram'}
            status={done >= 1 ? 'done' : null}
            onClick={() => select('diagram')}
          />
          <NavItem
            cfg={blocks.charts}
            isActive={active_block === 'charts'}
            status={b.mosfet?.status === 'done' ? 'done' : null}
            onClick={() => select('charts')}
          />
          <NavItem
            cfg={blocks.waveform}
            isActive={active_block === 'waveform'}
            status={b.mosfet?.status === 'done' ? 'done' : null}
            onClick={() => select('waveform')}
          />
          <NavItem
            cfg={blocks.compare}
            isActive={active_block === 'compare'}
            status={null}
            onClick={() => select('compare')}
          />
          <NavItem
            cfg={blocks.pcb_thermal}
            isActive={active_block === 'pcb_thermal'}
            status={project.pcb_trace_thermal?.results ? 'done' : null}
            onClick={() => select('pcb_thermal')}
          />
        </div>

        {/* Feedback (special — horizontal) */}
        <div style={{ padding: '0 8px 6px', marginBottom: 4 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
            textTransform: 'uppercase', color: 'var(--txt-3)',
            padding: '0 8px', marginBottom: 4,
          }}>
            Sensing
          </div>
          <NavItem
            cfg={blocks.feedback}
            isActive={active_block === 'feedback'}
            status={null}
            onClick={() => select('feedback')}
            isHorizontal
          />
        </div>

        <div style={{
          padding: '6px 16px 4px',
          fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--txt-3)',
          borderTop: '1px solid var(--border-1)',
          marginBottom: 4,
        }}>
          Components
        </div>

        {['mcu','driver','passives','mosfet','motor'].map(key => (
          <NavItem
            key={key}
            cfg={blocks[key]}
            isActive={active_block === key}
            status={getBlockStatus(b, key)}
            onClick={() => select(key)}
          />
        ))}
      </nav>
    </aside>
  )
}

function NavItem({ cfg, isActive, status, onClick, isHorizontal }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: isHorizontal ? '7px 16px' : '8px 16px',
        background: isActive ? `${cfg.color}12` : 'transparent',
        borderTop: 'none',
        borderRight: 'none',
        borderBottom: 'none',
        borderLeft: isActive ? `3px solid ${cfg.color}` : '3px solid transparent',
        borderRadius: 0,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all .15s',
        marginBottom: isHorizontal ? 0 : 2,
      }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-2)' }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ fontSize: 15, flexShrink: 0 }}>{cfg.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: isActive ? 700 : 500,
          color: isActive ? cfg.color : 'var(--txt-1)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {cfg.label}
        </div>
        {status && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
            <span className={`dot ${statusDotClass(status)}`} style={{ width: 5, height: 5 }} />
            <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>{statusLabel(status)}</span>
          </div>
        )}
      </div>
    </button>
  )
}
