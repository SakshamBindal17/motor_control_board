import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

/**
 * Global smart tooltip — attaches to any element with a `data-tip` attribute.
 * Uses event delegation on `document` so it works everywhere without per-element wiring.
 *
 * Positioning logic:
 *  1. Prefer BELOW the element (like Windows taskbar tooltips)
 *  2. If not enough room below → flip ABOVE
 *  3. Horizontally: align left edge to element, but clamp so it never overflows viewport
 */
export default function SmartTooltip() {
  const [tip, setTip] = useState(null)      // { text, x, y }
  const hideTimer = useRef(null)
  const currentEl = useRef(null)

  const PADDING = 8       // min gap from viewport edges
  const GAP = 6           // gap between element and tooltip

  const show = useCallback((el) => {
    clearTimeout(hideTimer.current)
    const text = el.getAttribute('data-tip')
    if (!text) return

    currentEl.current = el

    // We render first with opacity:0 so we can measure the tooltip,
    // then reposition. Use a two-phase approach.
    setTip({ text, phase: 'measure', anchorEl: el })
  }, [])

  const hide = useCallback(() => {
    hideTimer.current = setTimeout(() => {
      currentEl.current = null
      setTip(null)
    }, 80)
  }, [])

  // After measure phase, compute final position
  const tooltipRef = useRef(null)
  useEffect(() => {
    if (!tip || tip.phase !== 'measure' || !tooltipRef.current) return

    const el = tip.anchorEl
    const rect = el.getBoundingClientRect()
    const tt = tooltipRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Vertical: prefer below, flip above if not enough space
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
      // Neither fits perfectly — pick whichever has more room
      if (spaceBelow >= spaceAbove) {
        y = rect.bottom + GAP
        placement = 'below'
      } else {
        y = rect.top - GAP - tt.height
        placement = 'above'
      }
    }

    // Horizontal: align to element left, clamp to viewport
    let x = rect.left
    if (x + tt.width + PADDING > vw) {
      x = vw - tt.width - PADDING
    }
    if (x < PADDING) {
      x = PADDING
    }

    setTip(prev => ({ ...prev, phase: 'show', x, y, placement }))
  }, [tip])

  // Event delegation
  useEffect(() => {
    function onOver(e) {
      const el = e.target.closest('[data-tip]')
      if (el && el.getAttribute('data-tip')) {
        if (el !== currentEl.current) show(el)
      }
    }
    function onOut(e) {
      const el = e.target.closest('[data-tip]')
      if (el) {
        const related = e.relatedTarget
        if (!related || !el.contains(related)) hide()
      }
    }
    // Also hide on scroll so stale tooltips don't linger
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
    pointerEvents: 'none',
  }

  return createPortal(
    <div ref={tooltipRef} className="smart-tooltip" style={style}>
      {tip.text}
    </div>,
    document.body
  )
}
