import React, { useState } from 'react'
import { ChevronRight, ChevronDown, Edit3, Check, X, AlertTriangle, Info } from 'lucide-react'
import { useProject } from '../context/ProjectContext.jsx'
import UnitPicker, { UNIT_TIPS } from './UnitPicker.jsx'

function UnitCell({ unit, onEdit }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(unit || '')
  const tip = UNIT_TIPS[unit?.trim()]
  const isKnown = !!tip
  const isSuspect = unit && unit.length > 8  // long units are likely messy AI output

  if (editing) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:3 }} onClick={e => e.stopPropagation()}>
        <UnitPicker
          value={draft}
          onChange={v => setDraft(v)}
          style={{ width:90 }}
        />
        <button onMouseDown={() => { onEdit(draft); setEditing(false) }}
          style={{ color:'var(--green)', background:'none', border:'none', cursor:'pointer', padding:2 }}>
          <Check size={11}/>
        </button>
        <button onMouseDown={() => setEditing(false)}
          style={{ color:'var(--red)', background:'none', border:'none', cursor:'pointer', padding:2 }}>
          <X size={11}/>
        </button>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', alignItems:'center', gap:3 }}>
      <span
        title={tip || (isSuspect ? 'AI-extracted unit looks unusual — click ✎ to fix' : unit)}
        style={{
          fontSize: 10,
          color: isSuspect ? 'var(--amber)' : isKnown ? 'var(--cyan)' : 'var(--txt-3)',
          cursor: tip ? 'help' : 'default',
          borderBottom: isSuspect ? '1px dashed var(--amber)' : tip ? '1px dotted var(--cyan)' : 'none',
          paddingBottom: 1, fontFamily:'var(--font-mono)',
        }}
      >
        {unit || '—'}
        {isSuspect && <span style={{ marginLeft:3, fontSize:8, color:'var(--amber)' }}>⚠</span>}
      </span>
      <button
        onMouseDown={e => { e.stopPropagation(); setDraft(unit||''); setEditing(true) }}
        title="Edit unit"
        style={{ color:'var(--txt-4)', background:'none', border:'none', cursor:'pointer', padding:'0 1px', opacity:.5, lineHeight:1 }}
      >
        <Edit3 size={9}/>
      </button>
    </div>
  )
}

function fmtCell(v) {
  if (v === null || v === undefined) return null
  const n = parseFloat(v)
  return isNaN(n) ? String(v) : n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

export default function ParameterTable({ params, blockKey, color = '#1e90ff' }) {
  const { state, dispatch } = useProject()
  const selParams = state.project.blocks[blockKey]?.selected_params || {}
  const [expanded, setExpanded] = useState({})
  const [editDraft, setEditDraft] = useState({})

  function sel(paramId) { return selParams[paramId] || { condition_index: 0, override: null } }
  function activeCond(param) {
    const s = sel(param.id)
    return param.conditions?.[s.condition_index] || param.conditions?.[0] || {}
  }
  function activeVal(param) {
    const s = sel(param.id)
    if (s.override !== null && s.override !== undefined) return s.override
    return activeCond(param).selected
  }
  function hasOverride(param) {
    const s = sel(param.id)
    return s.override !== null && s.override !== undefined
  }
  function selectCond(paramId, idx) {
    dispatch({ type: 'SET_PARAM_SELECTION', payload: { block: blockKey, param_id: paramId, condition_index: idx } })
  }
  function editUnit(paramId, condIdx, newUnit) {
    dispatch({ type: 'SET_PARAM_UNIT', payload: { block: blockKey, param_id: paramId, cond_idx: condIdx, unit: newUnit } })
  }
  function commitEdit(paramId) {
    const v = editDraft[paramId]
    dispatch({ type: 'SET_PARAM_OVERRIDE', payload: { block: blockKey, param_id: paramId, override: v } })
    setEditDraft(p => { const n = {...p}; delete n[paramId]; return n })
  }
  function clearOverride(paramId) {
    dispatch({ type: 'SET_PARAM_OVERRIDE', payload: { block: blockKey, param_id: paramId, override: '' } })
  }

  // Count multi-condition params (need user attention)
  const attentionParams = params.filter(p => (p.conditions?.length || 0) > 1)
  const attentionCount  = attentionParams.length

  return (
    <div>
      {/* ── Attention banner ─────────────────────────────────────── */}
      {attentionCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 12px', marginBottom: 8, borderRadius: 6,
          background: 'rgba(255,171,0,.08)',
          border: '1px solid rgba(255,171,0,.25)',
        }}>
          <AlertTriangle size={13} color="var(--amber)" style={{ flexShrink: 0 }}/>
          <span style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 600 }}>
            {attentionCount} parameter{attentionCount > 1 ? 's' : ''} with multiple test conditions — review and select the most appropriate one
          </span>
        </div>
      )}

      <table className="ptable">
        <thead>
          <tr>
            <th style={{ width: 24 }}></th>
            <th>Parameter</th>
            <th>Symbol</th>
            <th>Condition</th>
            <th style={{ textAlign: 'right' }}>Min</th>
            <th style={{ textAlign: 'right', color: '#00d4e8' }}>Typ ★</th>
            <th style={{ textAlign: 'right' }}>Max</th>
            <th>Unit</th>
            <th>Active Value</th>
          </tr>
        </thead>
        <tbody>
          {params.map(p => {
            const ac        = activeCond(p)
            const av        = activeVal(p)
            const ov        = hasOverride(p)
            const isEditing = editDraft[p.id] !== undefined
            const isExp     = expanded[p.id]
            const multiCond = (p.conditions?.length || 0) > 1
            const hasNote   = ac.note && ac.note !== 'null'

            return (
              <React.Fragment key={p.id}>
                {/* ── Main summary row ────────────────────────────── */}
                <tr
                  className="row-selected"
                  onClick={() => multiCond && setExpanded(pr => ({ ...pr, [p.id]: !isExp }))}
                  style={{
                    cursor: multiCond ? 'pointer' : 'default',
                    // Amber-tinted row for multi-condition params
                    background: multiCond
                      ? 'rgba(255,171,0,0.04)'
                      : undefined,
                    borderLeft: multiCond
                      ? '2px solid rgba(255,171,0,0.5)'
                      : '2px solid transparent',
                  }}
                >
                  <td>
                    {multiCond
                      ? <span style={{ color: 'var(--amber)' }}>
                          {isExp ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
                        </span>
                      : null}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontWeight: 500, color: 'var(--txt-1)' }}>{p.name}</span>
                      {multiCond && (
                        <span style={{
                          fontSize: 9, fontFamily: 'var(--font-mono)',
                          padding: '1px 5px', borderRadius: 3,
                          background: 'rgba(255,171,0,.15)',
                          color: 'var(--amber)', fontWeight: 700,
                        }}>
                          {p.conditions.length} conditions
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)', color, fontSize: 11, fontWeight: 600 }}>
                      {p.symbol}
                    </span>
                  </td>
                  <td>
                    {/* Condition text wraps; note shown below in smaller text */}
                    <div style={{ maxWidth: 200 }}>
                      <span style={{ color: 'var(--txt-2)', fontSize: 11, display: 'block', whiteSpace: 'normal', lineHeight: 1.4 }}>
                        {ac.condition_text || '—'}
                      </span>
                      {hasNote && (
                        <span style={{
                          display: 'flex', alignItems: 'flex-start', gap: 3, marginTop: 3,
                          fontSize: 10, color: 'var(--txt-3)', fontStyle: 'italic',
                          lineHeight: 1.35, whiteSpace: 'normal',
                        }}>
                          <Info size={9} style={{ flexShrink: 0, marginTop: 1, color: 'var(--cyan)' }}/>
                          {ac.note}
                        </span>
                      )}
                    </div>
                  </td>
                  {/* Min */}
                  <td style={{ textAlign: 'right' }}>
                    {ac.min !== null && ac.min !== undefined
                      ? <span className="ptable cell-val">{fmtCell(ac.min)}</span>
                      : <span className="ptable cell-null">—</span>}
                  </td>
                  {/* Typ ★ */}
                  <td style={{ textAlign: 'right' }}>
                    {ac.typ !== null && ac.typ !== undefined
                      ? <span className="ptable cell-typ">{fmtCell(ac.typ)} ★</span>
                      : <span className="ptable cell-null">—</span>}
                  </td>
                  {/* Max */}
                  <td style={{ textAlign: 'right' }}>
                    {ac.max !== null && ac.max !== undefined
                      ? <span className="ptable cell-val">{fmtCell(ac.max)}</span>
                      : <span className="ptable cell-null">—</span>}
                  </td>
                  <td><UnitCell unit={ac.unit} onEdit={newU => editUnit(p.id, sel(p.id).condition_index || 0, newU)}/></td>

                  {/* Active value + edit */}
                  <td onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {isEditing ? (
                        <>
                          <input
                            type="number" step="any" className="inp inp-mono inp-sm"
                            style={{ width: 75 }}
                            value={editDraft[p.id]}
                            onChange={e => setEditDraft(pr => ({ ...pr, [p.id]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitEdit(p.id)
                              if (e.key === 'Escape') setEditDraft(pr => { const n={...pr}; delete n[p.id]; return n })
                            }}
                            autoFocus
                          />
                          <button onClick={() => commitEdit(p.id)} style={{ color:'var(--green)', background:'none', border:'none', cursor:'pointer', padding:2 }}><Check size={12}/></button>
                          <button onClick={() => setEditDraft(pr => { const n={...pr}; delete n[p.id]; return n })} style={{ color:'var(--red)', background:'none', border:'none', cursor:'pointer', padding:2 }}><X size={12}/></button>
                        </>
                      ) : (
                        <>
                          <span style={{
                            fontFamily:'var(--font-mono)', fontWeight:700, fontSize:11,
                            padding:'2px 7px', borderRadius:4,
                            background: ov ? 'rgba(255,171,0,.12)' : `${color}12`,
                            color: ov ? 'var(--amber)' : color,
                          }}>
                            {av !== null && av !== undefined ? fmtCell(av) : '—'}
                            {ac.unit ? ` ${ac.unit}` : ''}
                            {ov && ' ✎'}
                          </span>
                          <button
                            onClick={() => setEditDraft(pr => ({ ...pr, [p.id]: String(av ?? '') }))}
                            style={{ color:'var(--txt-3)', background:'none', border:'none', cursor:'pointer', padding:2, opacity:.6 }}
                            title="Override value"
                          ><Edit3 size={11}/></button>
                          {ov && (
                            <button onClick={() => clearOverride(p.id)} style={{ color:'var(--amber)', background:'none', border:'none', cursor:'pointer', padding:2, fontSize:10 }} title="Clear override">✕</button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>

                {/* ── Expanded condition rows ──────────────────────── */}
                {isExp && p.conditions?.map((cond, idx) => {
                  const isSel  = idx === sel(p.id).condition_index
                  const cNote  = cond.note && cond.note !== 'null'
                  return (
                    <tr
                      key={idx}
                      onClick={() => selectCond(p.id, idx)}
                      style={{
                        cursor: 'pointer',
                        background: isSel ? `${color}0a` : 'rgba(255,171,0,0.02)',
                        borderLeft: isSel ? `2px solid ${color}` : '2px solid rgba(255,171,0,0.15)',
                      }}
                    >
                      <td>
                        <span style={{
                          display:'flex', alignItems:'center', justifyContent:'center',
                          width:16, height:16, borderRadius:'50%', fontSize:9, fontWeight:700,
                          border:`1px solid ${isSel ? color : 'var(--border-3)'}`,
                          background: isSel ? color : 'transparent',
                          color: isSel ? '#fff' : 'var(--txt-3)',
                          fontFamily:'var(--font-mono)',
                        }}>{isSel ? '✓' : idx+1}</span>
                      </td>
                      <td colSpan={2} style={{ fontSize:11, color:'var(--txt-3)', paddingLeft:20 }}>
                        Condition {idx+1}
                        {isSel && <span style={{ marginLeft:5, color, fontWeight:600 }}>← selected</span>}
                      </td>
                      <td>
                        {/* Full wrapping condition text + note */}
                        <div style={{ maxWidth: 220 }}>
                          <span style={{ fontSize:11, color:'var(--txt-2)', display:'block', whiteSpace:'normal', lineHeight:1.4 }}>
                            {cond.condition_text}
                          </span>
                          {cNote && (
                            <span style={{
                              display:'flex', alignItems:'flex-start', gap:3, marginTop:3,
                              fontSize:10, color:'var(--txt-3)', fontStyle:'italic',
                              lineHeight:1.35, whiteSpace:'normal',
                            }}>
                              <Info size={9} style={{ flexShrink:0, marginTop:1, color:'var(--cyan)' }}/>
                              {cond.note}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign:'right' }}>
                        {cond.min !== null && cond.min !== undefined
                          ? <span className="ptable cell-val" style={{ fontSize:11 }}>{fmtCell(cond.min)}</span>
                          : <span className="ptable cell-null">—</span>}
                      </td>
                      <td style={{ textAlign:'right' }}>
                        {cond.typ !== null && cond.typ !== undefined
                          ? <span className="ptable cell-typ" style={{ fontSize:11 }}>{fmtCell(cond.typ)} ★</span>
                          : <span className="ptable cell-null">—</span>}
                      </td>
                      <td style={{ textAlign:'right' }}>
                        {cond.max !== null && cond.max !== undefined
                          ? <span className="ptable cell-val" style={{ fontSize:11 }}>{fmtCell(cond.max)}</span>
                          : <span className="ptable cell-null">—</span>}
                      </td>
                      <td><UnitCell unit={cond.unit} onEdit={newU => editUnit(p.id, idx, newU)}/></td>
                      <td>
                        <span style={{
                          fontSize:10, fontFamily:'var(--font-mono)', fontWeight:600,
                          padding:'1px 6px', borderRadius:3,
                          background: isSel ? `${color}18` : 'var(--bg-3)',
                          color: isSel ? color : 'var(--txt-3)',
                        }}>
                          {fmtCell(cond.selected)} {cond.unit}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
