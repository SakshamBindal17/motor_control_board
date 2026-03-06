import React, { useState, useRef, useEffect } from 'react'

// Full canonical unit list with tooltips
export const ALL_UNITS = [
  // Resistance
  { unit: 'mΩ', label: 'milliohm', tip: '1 mΩ = 1×10⁻³ Ω', group: 'Resistance' },
  { unit: 'Ω', label: 'ohm', tip: 'SI base unit', group: 'Resistance' },
  { unit: 'kΩ', label: 'kilohm', tip: '1 kΩ = 1×10³ Ω', group: 'Resistance' },
  { unit: 'MΩ', label: 'megaohm', tip: '1 MΩ = 1×10⁶ Ω', group: 'Resistance' },
  // Capacitance
  { unit: 'pF', label: 'picofarad', tip: '1 pF = 1×10⁻¹² F', group: 'Capacitance' },
  { unit: 'nF', label: 'nanofarad', tip: '1 nF = 1×10⁻⁹ F', group: 'Capacitance' },
  { unit: 'µF', label: 'microfarad', tip: '1 µF = 1×10⁻⁶ F', group: 'Capacitance' },
  { unit: 'mF', label: 'millifarad', tip: '1 mF = 1×10⁻³ F', group: 'Capacitance' },
  { unit: 'F', label: 'farad', tip: 'SI base unit', group: 'Capacitance' },
  // Charge
  { unit: 'pC', label: 'picocoulomb', tip: '1 pC = 1×10⁻¹² C', group: 'Charge' },
  { unit: 'nC', label: 'nanocoulomb', tip: '1 nC = 1×10⁻⁹ C', group: 'Charge' },
  { unit: 'µC', label: 'microcoulomb', tip: '1 µC = 1×10⁻⁶ C', group: 'Charge' },
  { unit: 'mC', label: 'millicoulomb', tip: '1 mC = 1×10⁻³ C', group: 'Charge' },
  { unit: 'C', label: 'coulomb', tip: 'SI base unit', group: 'Charge' },
  // Time
  { unit: 'ps', label: 'picosecond', tip: '1 ps = 1×10⁻¹² s', group: 'Time' },
  { unit: 'ns', label: 'nanosecond', tip: '1 ns = 1×10⁻⁹ s', group: 'Time' },
  { unit: 'µs', label: 'microsecond', tip: '1 µs = 1×10⁻⁶ s', group: 'Time' },
  { unit: 'ms', label: 'millisecond', tip: '1 ms = 1×10⁻³ s', group: 'Time' },
  { unit: 's', label: 'second', tip: 'SI base unit', group: 'Time' },
  // Current
  { unit: 'µA', label: 'microampere', tip: '1 µA = 1×10⁻⁶ A', group: 'Current' },
  { unit: 'mA', label: 'milliampere', tip: '1 mA = 1×10⁻³ A', group: 'Current' },
  { unit: 'A', label: 'ampere', tip: 'SI base unit', group: 'Current' },
  { unit: 'kA', label: 'kiloampere', tip: '1 kA = 1×10³ A', group: 'Current' },
  // Voltage
  { unit: 'mV', label: 'millivolt', tip: '1 mV = 1×10⁻³ V', group: 'Voltage' },
  { unit: 'V', label: 'volt', tip: 'SI base unit', group: 'Voltage' },
  { unit: 'kV', label: 'kilovolt', tip: '1 kV = 1×10³ V', group: 'Voltage' },
  // Power
  { unit: 'mW', label: 'milliwatt', tip: '1 mW = 1×10⁻³ W', group: 'Power' },
  { unit: 'W', label: 'watt', tip: 'SI base unit', group: 'Power' },
  { unit: 'kW', label: 'kilowatt', tip: '1 kW = 1×10³ W', group: 'Power' },
  // Frequency
  { unit: 'Hz', label: 'hertz', tip: 'SI base unit', group: 'Frequency' },
  { unit: 'kHz', label: 'kilohertz', tip: '1 kHz = 1×10³ Hz', group: 'Frequency' },
  { unit: 'MHz', label: 'megahertz', tip: '1 MHz = 1×10⁶ Hz', group: 'Frequency' },
  { unit: 'GHz', label: 'gigahertz', tip: '1 GHz = 1×10⁹ Hz', group: 'Frequency' },
  // Thermal
  { unit: '°C', label: 'celsius', tip: 'Temperature in °C', group: 'Thermal' },
  { unit: '°C/W', label: 'celsius/watt', tip: 'Thermal resistance', group: 'Thermal' },
  { unit: 'K/W', label: 'kelvin/watt', tip: 'Thermal resistance', group: 'Thermal' },
  // Memory
  { unit: 'B', label: 'bytes', tip: 'Memory size in bytes', group: 'Memory' },
  { unit: 'KB', label: 'kilobytes', tip: '1 KB = 1024 B', group: 'Memory' },
  { unit: 'MB', label: 'megabytes', tip: '1 MB = 1024² B', group: 'Memory' },
  // Misc
  // Inductance
  { unit: 'nH', label: 'nanohenry', tip: '1 nH = 1×10⁻⁹ H', group: 'Inductance' },
  { unit: 'µH', label: 'microhenry', tip: '1 µH = 1×10⁻⁶ H', group: 'Inductance' },
  { unit: 'mH', label: 'millihenry', tip: '1 mH = 1×10⁻³ H', group: 'Inductance' },
  { unit: 'H', label: 'henry', tip: 'SI base unit', group: 'Inductance' },
  // Misc & Motor
  { unit: 'bits', label: 'bits', tip: 'Resolution in bits', group: 'Digital' },
  { unit: '%', label: 'percent', tip: 'Percentage', group: 'Misc' },
  { unit: 'rpm', label: 'RPM', tip: 'Revolutions per min', group: 'Misc' },
  { unit: 'V/µs', label: 'volt/microsec', tip: 'Slew rate', group: 'Misc' },
  { unit: 'V/V', label: 'volt/volt', tip: 'Voltage gain', group: 'Misc' },
  { unit: 'rpm/V', label: 'rpm/volt', tip: 'Motor velocity const', group: 'Motor' },
  { unit: 'Nm/A', label: 'nm/amp', tip: 'Motor torque const', group: 'Motor' },
]

// Build quick lookup for tooltip
export const UNIT_TIPS = Object.fromEntries(ALL_UNITS.map(u => [u.unit, `${u.label}  (${u.tip})`]))

/**
 * UnitPicker — searchable unit dropdown
 * Props: value, onChange, placeholder, style
 */
export default function UnitPicker({ value, onChange, placeholder = 'unit', style = {} }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value || '')
  const [hiIdx, setHiIdx] = useState(0)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)

  // Keep query in sync when value changes externally
  useEffect(() => { setQuery(value || '') }, [value])

  // Close on outside click
  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = query.trim() === ''
    ? ALL_UNITS
    : ALL_UNITS.filter(u =>
      u.unit.toLowerCase().includes(query.toLowerCase()) ||
      u.label.toLowerCase().includes(query.toLowerCase()) ||
      u.group.toLowerCase().includes(query.toLowerCase())
    )

  function pick(u) {
    onChange(u.unit)
    setQuery(u.unit)
    setOpen(false)
  }

  function handleKey(e) {
    if (!open) { if (e.key === 'ArrowDown' || e.key === 'Enter') setOpen(true); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHiIdx(i => Math.min(i + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHiIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter') { if (filtered[hiIdx]) pick(filtered[hiIdx]); else { onChange(query); setOpen(false) } }
    if (e.key === 'Escape') { setOpen(false) }
    if (e.key === 'Tab') { setOpen(false) }
  }

  // Group the filtered results
  const grouped = {}
  for (const u of filtered) {
    if (!grouped[u.group]) grouped[u.group] = []
    grouped[u.group].push(u)
  }

  const isKnown = UNIT_TIPS[value?.trim()]

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          className="inp inp-mono inp-sm"
          style={{
            width: '100%',
            paddingRight: 22,
            borderColor: open ? 'var(--cyan)' : isKnown ? 'var(--border-2)' : value ? 'rgba(255,171,0,.5)' : 'var(--border-2)',
            color: isKnown ? 'var(--cyan)' : value ? 'var(--amber)' : 'var(--txt-2)',
          }}
          value={query}
          placeholder={placeholder}
          onChange={e => { setQuery(e.target.value); onChange(e.target.value); setHiIdx(0); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
        />
        {/* small chevron icon */}
        <span style={{
          position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)',
          fontSize: 8, color: 'var(--txt-4)', pointerEvents: 'none',
        }}>▾</span>
      </div>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 9999,
          minWidth: 220, maxHeight: 260, overflowY: 'auto',
          background: 'var(--bg-1)', border: '1px solid var(--border-2)',
          borderRadius: 7, boxShadow: '0 8px 24px rgba(0,0,0,.4)',
          marginTop: 2,
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--txt-3)' }}>
              No matching unit — press Enter to use "{query}" anyway
            </div>
          ) : (
            Object.entries(grouped).map(([grp, units]) => (
              <div key={grp}>
                <div style={{
                  padding: '4px 10px 2px',
                  fontSize: 9, fontWeight: 700, letterSpacing: '.06em',
                  color: 'var(--txt-4)', textTransform: 'uppercase',
                  borderTop: '1px solid var(--border-1)',
                }}>
                  {grp}
                </div>
                {units.map((u, i) => {
                  const globalIdx = filtered.indexOf(u)
                  const isHi = globalIdx === hiIdx
                  return (
                    <div
                      key={u.unit}
                      onMouseDown={() => pick(u)}
                      onMouseEnter={() => setHiIdx(globalIdx)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 12px', cursor: 'pointer',
                        background: isHi ? 'var(--bg-3)' : 'transparent',
                      }}
                    >
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11,
                        minWidth: 36, color: 'var(--cyan)',
                      }}>{u.unit}</span>
                      <span style={{ fontSize: 10, color: 'var(--txt-3)', flex: 1 }}>{u.label}</span>
                      <span style={{
                        fontSize: 9, color: 'var(--txt-4)', fontFamily: 'var(--font-mono)',
                        maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{u.tip}</span>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
