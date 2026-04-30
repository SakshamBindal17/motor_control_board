import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

/**
 * Global smart tooltip — attaches to any element with a `data-tip` or `data-tip-json` attribute.
 * Uses event delegation on `document` so it works everywhere without per-element wiring.
 */
export default function SmartTooltip() {
  const [tip, setTip] = useState(null)      // { content, x, y, isJson }
  const hideTimer = useRef(null)
  const currentEl = useRef(null)
  const tooltipRef = useRef(null)

  const PADDING = 8
  const GAP = 6

  const show = useCallback((el) => {
    clearTimeout(hideTimer.current)
    const text = el.getAttribute('data-tip')
    const jsonStr = el.getAttribute('data-tip-json')
    if (!text && !jsonStr) return

    currentEl.current = el
    let content = text
    let isJson = false
    
    if (jsonStr) {
      try {
        content = JSON.parse(jsonStr)
        isJson = true
      } catch(e) {}
    }

    setTip({ content, isJson, phase: 'measure', anchorEl: el })
  }, [])

  const hide = useCallback(() => {
    // Add a slight delay to allow moving mouse into the tooltip
    hideTimer.current = setTimeout(() => {
      currentEl.current = null
      setTip(null)
    }, 150)
  }, [])

  const cancelHide = useCallback(() => {
    clearTimeout(hideTimer.current)
  }, [])

  useEffect(() => {
    if (!tip || tip.phase !== 'measure' || !tooltipRef.current) return

    const el = tip.anchorEl
    const rect = el.getBoundingClientRect()
    const tt = tooltipRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    const spaceBelow = vh - rect.bottom - GAP
    const spaceAbove = rect.top - GAP
    let y, placement

    if (spaceBelow >= tt.height + PADDING) {
      y = rect.bottom + GAP
      placement = 'below'
    } else if (spaceAbove >= tt.height + PADDING) {
      y = rect.top - GAP - tt.height
      placement = 'above'
    } else {
      if (spaceBelow >= spaceAbove) {
        y = rect.bottom + GAP
        placement = 'below'
      } else {
        y = rect.top - GAP - tt.height
        placement = 'above'
      }
    }

    let x = rect.left
    if (x + tt.width + PADDING > vw) {
      x = vw - tt.width - PADDING
    }
    if (x < PADDING) {
      x = PADDING
    }

    setTip(prev => ({ ...prev, phase: 'show', x, y, placement }))
  }, [tip])

  useEffect(() => {
    function onOver(e) {
      const el = e.target.closest('[data-tip], [data-tip-json]')
      if (el && (el.getAttribute('data-tip') || el.getAttribute('data-tip-json'))) {
        if (el !== currentEl.current) show(el)
      }
    }
    function onOut(e) {
      const el = e.target.closest('[data-tip], [data-tip-json]')
      if (el) {
        // If moving to the tooltip itself, don't hide
        const related = e.relatedTarget
        if (!related || (!el.contains(related) && !tooltipRef.current?.contains(related))) {
          hide()
        }
      }
    }
    function onScroll() {
      if (currentEl.current) {
        currentEl.current = null
        setTip(null)
      }
    }

    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [show, hide])

  if (!tip) return null

  const style = {
    position: 'fixed',
    zIndex: 99999,
    left: tip.phase === 'show' ? tip.x : -9999,
    top: tip.phase === 'show' ? tip.y : -9999,
    opacity: tip.phase === 'show' ? 1 : 0,
    transition: 'opacity .12s',
    pointerEvents: 'auto', // Allow interaction for links/buttons
  }

  return createPortal(
    <div 
      ref={tooltipRef} 
      className="smart-tooltip" 
      style={style}
      onMouseEnter={cancelHide}
      onMouseLeave={hide}
    >
      {tip.isJson ? <RichTooltip data={tip.content} /> : tip.content}
    </div>,
    document.body
  )
}

function RichTooltip({ data }) {
  const sectionMap = {
    drv_qg_charge: "Gate Drive",
    vbs_max_check: "Bootstrap Supply",
    vcc_uvlo_margin: "Gate Drive",
    vbs_uvlo_data_quality: "Bootstrap Supply",
    mcu_dt_resolution: "Dead-Time Timing",
    adc_ref_consistency: "MCU Protection",
    vds_ringing: "MOSFET Ratings",
    vgs_max_safety: "Gate Drive",
    vgs_headroom: "Gate Drive",
    drv_thermal_shutdown: "Thermal Budget",
    mcu_pwm_capability: "MCU PWM Generation",
    mcu_complementary: "MCU PWM Generation",
    thermal_budget: "Thermal Budget",
    boot_vs_qg: "Bootstrap Supply",
    shunt_vs_adc: "Current Sensing",
    rg_vs_drv: "Gate Drive"
  }
  
  const sectionName = sectionMap[data.id] || "relevant section"

  return (
    <div className="rich-tooltip-content" style={{ maxWidth: '380px', display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none' }}>
      
      {/* Title & Parts */}
      <div style={{ fontWeight: 600, color: 'var(--txt-1)', fontSize: '13px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px' }}>
        {data.title}
        {data.part_names && <span style={{ fontWeight: 400, color: 'var(--txt-3)', marginLeft: '6px' }}>[{data.part_names}]</span>}
      </div>

      {/* The Actual Result / Math Trace */}
      <div style={{ color: 'var(--txt-1)', fontSize: '13px', lineHeight: '1.4' }}>
        {data.detail}
      </div>

      {/* Theory & Formula (Merged as clean text) */}
      {(data.theory || data.formula) && (
        <div style={{ color: 'var(--txt-2)', fontSize: '12px', lineHeight: '1.4' }}>
          {data.theory} {data.formula && <span style={{ fontFamily: 'monospace' }}>({data.formula})</span>}
        </div>
      )}

      {/* Actionable Advice */}
      {data.advice && (
        <div style={{ color: 'var(--txt-1)', fontSize: '12px', marginTop: '4px' }}>
          💡 {data.advice}
        </div>
      )}

      {/* Footer */}
      <div style={{ color: 'var(--txt-3)', fontSize: '11px', marginTop: '6px', fontStyle: 'italic' }}>
        View the <strong>{sectionName}</strong> section in the Calculations tab for full mathematical breakdown.
      </div>
    </div>
  )
}
