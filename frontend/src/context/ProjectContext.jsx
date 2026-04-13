import React, { createContext, useContext, useReducer, useEffect } from 'react'
import { PARAM_LABELS } from '../constants.js'

const ProjectContext = createContext(null)

/** Validate a numeric value — returns the value if finite, or fallback if NaN/Infinity */
function _validNum(val, fallback = null) {
  if (val === '' || val === null || val === undefined) return fallback
  const n = typeof val === 'number' ? val : parseFloat(val)
  if (!Number.isFinite(n)) return fallback
  return n
}

/** Sanitize an object of specs — reject NaN/Infinity, keep valid values */
function _sanitizeSpecs(incoming, current) {
  const result = {}
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v === 'string' && typeof current[k] === 'string') {
      // String fields (motor_type, control_mode, cooling, etc.) pass through
      result[k] = v
    } else if (v === '' || v === null || v === undefined) {
      // Allow clearing fields (e.g. motor spec inputs)
      result[k] = v
    } else {
      const n = _validNum(v)
      result[k] = n !== null ? n : current[k]  // reject invalid, keep current
    }
  }
  return result
}

const DEFAULT_SYSTEM_SPECS = {
  bus_voltage: 48,
  peak_voltage: 60,
  power: 3000,
  max_phase_current: 80,
  pwm_freq_hz: 20000,
  ambient_temp_c: 30,
  gate_drive_voltage: 12,
  motor_type: 'PMSM',
  control_mode: 'FOC',
  cooling: 'natural',
  pcb_layers: 6,
  num_fets: 6,               // Total MOSFETs in inverter (6 = 3-phase half-bridge)
  mosfets_parallel_per_switch: 1, // Parallel MOSFETs per switch position (upper/lower device of each limb)
  // Phase 2: PCB trace dimensions (mm) — used to auto-calculate parasitic inductance
  gate_trace_length_mm: 0,    // Gate driver → MOSFET gate trace length
  gate_trace_width_mm: 0,     // Gate trace width
  gate_trace_height_mm: 0,    // Height above ground plane (dielectric thickness)
  power_trace_length_mm: 0,   // Power loop total trace length (bus cap → drain → source → return)
  power_trace_width_mm: 0,    // Power trace width
  power_trace_height_mm: 0,   // Height above ground plane
  // Waveform overrides — editable from both Passives and Waveform tabs
  rg_on_override: '',         // Source resistor override (Ω) — empty = use calculated
  rg_off_override: '',        // Sink resistor override (Ω) — empty = use calculated
  vds_override: '',           // Drain-source voltage override (V)
  id_override: '',            // Drain current override (A)
  vgs_drive_override: '',     // Gate drive voltage override (V)
}

const DEFAULT_MOTOR_SPECS = {
  type: 'PMSM',
  max_speed_rpm: 6000,
  pole_pairs: 4,
  rph_mohm: '',
  lph_uh: '',
  kt_nm_per_a: '',
  rated_torque_nm: '',
  back_emf_v_per_krpm: '',
}

const DEFAULT_BLOCK = {
  status: 'idle',        // idle | uploading | extracting | done | error
  filename: null,
  raw_data: null,        // full JSON from Claude
  selected_params: {},   // param_id → { condition_index, override }
  error: null,
}

const INITIAL_STATE = {
  // Settings
  settings: {
    api_key: '',
    theme: 'dark',
    model: 'claude-haiku-4-5-20251001',
  },
  // Project
  project: {
    name: 'Untitled MC Project',
    system_specs: DEFAULT_SYSTEM_SPECS,
    blocks: {
      mcu: { ...DEFAULT_BLOCK },
      driver: { ...DEFAULT_BLOCK },
      mosfet: { ...DEFAULT_BLOCK },
      mosfet_b: null,  // null = no comparison, DEFAULT_BLOCK shape when active
      motor: { specs: DEFAULT_MOTOR_SPECS },
      passives: { overrides: {}, calculated: null },
      feedback: { calculated: null },
    },
    calculations: null,
    comparison_results: null,
    design_constants: {},
    pcb_trace_thermal: {
      common: {
        current_a: null,
        ambient_c: null,
        pcb_thickness_mm: 1.6,
        max_conductor_temp_c: 105,
        model: '2221',
        cooling_mode: 'natural',
        orientation: 'vertical',
        spreading_factor: 1.5,
        air_velocity_ms: 1,
        hs_theta_sa: 5,
        hs_theta_int: 0.5,
        hs_contact_area_cm2: 10,
        plane_dist_mm: 0,
        copper_fill_pct: 0,
      },
      sections: [
        {
          id: 'sec_1',
          name: 'Section 1',
          trace_width_mm: 7,
          trace_length_mm: 20,
          copper_oz: 2,
          n_external_layers: 2,
          n_internal_layers: 0,
          vias_on: true,
          n_vias: 10,
          via_drill_mm: 0.3,
          via_plating_um: 25,
          busbar_area_mm2: null,
        }
      ],
      results: null,
    },
    last_saved: null,
  },
  // UI state
  active_block: 'dashboard',
  settings_open: false,
  constants_open: false,
  report_open: false,
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.payload } }

    case 'SET_ACTIVE_BLOCK':
      return { ...state, active_block: action.payload }

    case 'TOGGLE_SETTINGS':
      return { ...state, settings_open: !state.settings_open }

    case 'TOGGLE_REPORT':
      return { ...state, report_open: !state.report_open }

    case 'TOGGLE_CONSTANTS':
      return { ...state, constants_open: !state.constants_open }

    case 'SET_DESIGN_CONSTANT': {
      const { key, value } = action.payload
      const dc = { ...state.project.design_constants }
      if (value === null || value === undefined) {
        delete dc[key]
      } else {
        const n = _validNum(value)
        if (n === null) return state  // reject NaN/Infinity
        dc[key] = n
      }
      return { ...state, project: { ...state.project, design_constants: dc } }
    }

    case 'RESET_ALL_DESIGN_CONSTANTS':
      return { ...state, project: { ...state.project, design_constants: {} } }

    case 'SET_BLOCK_STATUS': {
      const { block, status, error } = action.payload
      return {
        ...state,
        project: {
          ...state.project,
          blocks: {
            ...state.project.blocks,
            [block]: { ...state.project.blocks[block], status, error: error || null },
          },
        },
      }
    }

    case 'SET_BLOCK_DATA': {
      const { block, filename, raw_data } = action.payload
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          blocks: {
            ...state.project.blocks,
            [block]: {
              ...state.project.blocks[block],
              status: 'done',
              filename,
              raw_data,
              selected_params: _buildDefaultSelections(raw_data),
              error: null,
            },
          },
        },
      }
    }

    case 'SET_PARAM_SELECTION': {
      const { block, param_id, condition_index } = action.payload
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          blocks: {
            ...state.project.blocks,
            [block]: {
              ...state.project.blocks[block],
              selected_params: {
                ...state.project.blocks[block].selected_params,
                [param_id]: {
                  ...state.project.blocks[block].selected_params[param_id],
                  condition_index,
                  override: null,
                },
              },
            },
          },
        },
      }
    }

    case 'SET_PARAM_OVERRIDE': {
      const { block, param_id, override } = action.payload
      const parsed = override === '' ? null : _validNum(override)
      // If user typed something invalid (NaN/Infinity), don't apply it
      if (override !== '' && parsed === null) return state
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          blocks: {
            ...state.project.blocks,
            [block]: {
              ...state.project.blocks[block],
              selected_params: {
                ...state.project.blocks[block].selected_params,
                [param_id]: {
                  ...state.project.blocks[block].selected_params[param_id],
                  override: parsed,
                },
              },
            },
          },
        },
      }
    }

    case 'SET_MOTOR_SPECS': {
      const sanitized = _sanitizeSpecs(action.payload, state.project.blocks.motor.specs)
      return {
        ...state,
        project: {
          ...state.project,
          blocks: {
            ...state.project.blocks,
            motor: { specs: { ...state.project.blocks.motor.specs, ...sanitized } },
          },
        },
      }
    }

    case 'SET_SYSTEM_SPECS': {
      const sanitized = _sanitizeSpecs(action.payload, state.project.system_specs)
      return {
        ...state,
        project: {
          ...state.project,
          system_specs: { ...state.project.system_specs, ...sanitized },
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
        },
      }
    }

    case 'SET_PASSIVES_OVERRIDE': {
      const { key, value } = action.payload
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          blocks: {
            ...state.project.blocks,
            passives: {
              ...state.project.blocks.passives,
              overrides: { ...state.project.blocks.passives.overrides, [key]: value },
            },
          },
        },
      }
    }

    case 'SET_MANUAL_PARAM': {
      // User manually entered a value for a param that wasn't extracted
      // Store as an override in selected_params AND inject a synthetic raw_data entry
      const { block, param_id, value, unit } = action.payload
      // Reject NaN/Infinity
      if (!Number.isFinite(typeof value === 'number' ? value : parseFloat(value))) return state
      const blockData = state.project.blocks[block]
      const existingParams = blockData.raw_data?.parameters || []
      // Add/replace the synthetic param in raw_data
      const syntheticParam = {
        id: param_id,
        name: PARAM_LABELS[param_id] || param_id,
        symbol: param_id,
        category: 'Manual Entry',
        conditions: [{
          condition_text: 'Manually entered',
          note: null,
          min: null, typ: value, max: null,
          unit: unit,
          selected: value,
          override: null,
        }]
      }
      const updatedParams = [
        ...existingParams.filter(p => p.id !== param_id),
        syntheticParam,
      ]
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          blocks: {
            ...state.project.blocks,
            [block]: {
              ...blockData,
              raw_data: { ...blockData.raw_data, parameters: updatedParams },
              selected_params: {
                ...blockData.selected_params,
                [param_id]: { condition_index: 0, override: null },
              },
            },
          },
        },
      }
    }

    case 'SET_PARAM_UNIT': {
      // Edit the unit string on a specific condition of a parameter
      const { block, param_id, cond_idx, unit } = action.payload
      const blockData = state.project.blocks[block]
      const updatedParams = (blockData.raw_data?.parameters || []).map(param => {
        if (param.id !== param_id) return param
        const updatedConds = param.conditions.map((c, i) =>
          i === cond_idx ? { ...c, unit } : c
        )
        return { ...param, conditions: updatedConds }
      })
      return {
        ...state,
        project: {
          ...state.project,
          blocks: {
            ...state.project.blocks,
            [block]: { ...blockData, raw_data: { ...blockData.raw_data, parameters: updatedParams } },
          },
        },
      }
    }

    case 'DELETE_MANUAL_PARAM': {
      const { block, param_id } = action.payload
      const blockData = state.project.blocks[block]
      const updatedParams = (blockData.raw_data?.parameters || []).filter(p => p.id !== param_id)
      const updatedSel = { ...blockData.selected_params }
      delete updatedSel[param_id]
      return {
        ...state,
        project: {
          ...state.project,
          blocks: {
            ...state.project.blocks,
            [block]: {
              ...blockData,
              raw_data: { ...blockData.raw_data, parameters: updatedParams },
              selected_params: updatedSel,
            },
          },
        },
      }
    }

    case 'SET_CALCULATIONS':
      return {
        ...state,
        project: { ...state.project, calculations: action.payload, calcs_stale: false },
      }

    case 'SET_COMPARISON_RESULTS':
      return {
        ...state,
        project: { ...state.project, comparison_results: action.payload },
      }

    // ── Multi-section PCB Trace Thermal actions ──────────────────────
    // SET_PCB_TRACE_PARAMS kept for backward compat (PassivesPanel Power Loop)
    // — maps to updating common params + first section's trace dims
    case 'SET_PCB_TRACE_PARAMS': {
      const ptt = state.project.pcb_trace_thermal
      // Figure out which keys are common vs section-specific
      const commonKeys = new Set([
        'current_a', 'ambient_c', 'pcb_thickness_mm', 'max_conductor_temp_c',
        'model', 'cooling_mode', 'orientation', 'spreading_factor',
        'air_velocity_ms', 'hs_theta_sa', 'hs_theta_int', 'hs_contact_area_cm2',
        'plane_dist_mm', 'copper_fill_pct',
      ])
      const commonUpdates = {}
      const sectionUpdates = {}
      for (const [k, v] of Object.entries(action.payload)) {
        if (commonKeys.has(k)) commonUpdates[k] = v
        else sectionUpdates[k] = v
      }
      const newCommon = { ...ptt.common, ...commonUpdates }
      let newSections = ptt.sections
      if (Object.keys(sectionUpdates).length > 0 && newSections.length > 0) {
        // Update the first section with any section-specific keys
        newSections = newSections.map((s, i) =>
          i === 0 ? { ...s, ...sectionUpdates } : s
        )
      }
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          pcb_trace_thermal: { ...ptt, common: newCommon, sections: newSections },
        },
      }
    }

    case 'SET_PCB_TRACE_COMMON': {
      const ptt = state.project.pcb_trace_thermal
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          pcb_trace_thermal: {
            ...ptt,
            common: { ...ptt.common, ...action.payload },
          },
        },
      }
    }

    case 'SET_PCB_TRACE_SECTION': {
      const { sectionId, ...updates } = action.payload
      const ptt = state.project.pcb_trace_thermal
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          pcb_trace_thermal: {
            ...ptt,
            sections: ptt.sections.map(s =>
              s.id === sectionId ? { ...s, ...updates } : s
            ),
          },
        },
      }
    }

    case 'ADD_PCB_TRACE_SECTION': {
      const ptt = state.project.pcb_trace_thermal
      const newId = 'sec_' + Date.now()
      const template = action.payload || {}
      const newSection = {
        id: newId,
        name: template.name || `Section ${ptt.sections.length + 1}`,
        trace_width_mm: template.trace_width_mm ?? 7,
        trace_length_mm: template.trace_length_mm ?? 20,
        copper_oz: template.copper_oz ?? 2,
        n_external_layers: template.n_external_layers ?? 2,
        n_internal_layers: template.n_internal_layers ?? 0,
        vias_on: template.vias_on ?? true,
        n_vias: template.n_vias ?? 10,
        via_drill_mm: template.via_drill_mm ?? 0.3,
        via_plating_um: template.via_plating_um ?? 25,
        busbar_area_mm2: template.busbar_area_mm2 ?? null,
      }
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          pcb_trace_thermal: {
            ...ptt,
            sections: [...ptt.sections, newSection],
          },
        },
      }
    }

    case 'REMOVE_PCB_TRACE_SECTION': {
      const ptt = state.project.pcb_trace_thermal
      if (ptt.sections.length <= 1) return state  // can't remove last section
      return {
        ...state,
        project: {
          ...state.project,
          calcs_stale: state.project.calculations ? true : state.project.calcs_stale,
          pcb_trace_thermal: {
            ...ptt,
            sections: ptt.sections.filter(s => s.id !== action.payload),
          },
        },
      }
    }

    case 'SET_PCB_TRACE_RESULTS':
      return {
        ...state,
        project: {
          ...state.project,
          pcb_trace_thermal: {
            ...state.project.pcb_trace_thermal,
            results: action.payload,
          },
        },
      }

    case 'SET_PROJECT_NAME':
      return {
        ...state,
        project: { ...state.project, name: action.payload },
      }

    case 'LOAD_PROJECT': {
      const payload = action.payload
      if (payload.version === 2 && payload.state) {
        const restored = { ...payload.state }
        // Backward compat: ensure design_constants exists
        if (!restored.project.design_constants) {
          restored.project = { ...restored.project, design_constants: {} }
        }
        // Ensure constants_open UI flag exists
        if (restored.constants_open === undefined) {
          restored.constants_open = false
        }
        // Backward compat: ensure mosfet_b exists (can be null)
        if (!('mosfet_b' in (restored.project?.blocks || {}))) {
          restored.project = {
            ...restored.project,
            blocks: { ...restored.project.blocks, mosfet_b: null },
          }
        }
        // Backward compat: ensure comparison_results exists
        if (restored.project.comparison_results === undefined) {
          restored.project = { ...restored.project, comparison_results: null }
        }
        // Backward compat: ensure pcb_trace_thermal exists
        if (!restored.project.pcb_trace_thermal) {
          restored.project = {
            ...restored.project,
            pcb_trace_thermal: INITIAL_STATE.project.pcb_trace_thermal,
          }
        }
        // Migrate old flat params → new sections[] + common{} format
        const ptt = restored.project.pcb_trace_thermal
        if (ptt && ptt.params && !ptt.sections) {
          const oldP = ptt.params
          const commonKeys = new Set([
            'current_a', 'ambient_c', 'pcb_thickness_mm', 'max_conductor_temp_c',
            'model', 'cooling_mode', 'orientation', 'spreading_factor',
            'air_velocity_ms', 'hs_theta_sa', 'hs_theta_int', 'hs_contact_area_cm2',
            'plane_dist_mm', 'copper_fill_pct',
          ])
          const migratedCommon = {}
          const migratedSection = { id: 'sec_1', name: 'Section 1' }
          for (const [k, v] of Object.entries(oldP)) {
            if (commonKeys.has(k)) migratedCommon[k] = v
            else migratedSection[k] = v
          }
          restored.project = {
            ...restored.project,
            pcb_trace_thermal: {
              common: { ...INITIAL_STATE.project.pcb_trace_thermal.common, ...migratedCommon },
              sections: [{ ...INITIAL_STATE.project.pcb_trace_thermal.sections[0], ...migratedSection }],
              results: ptt.results,
            },
          }
        }
        return restored
      }
      // Legacy fallback
      return { ...state, project: payload.project || payload }
    }

    case 'RESET_BLOCK': {
      const block = action.payload
      // Resetting mosfet_b sets it back to DEFAULT_BLOCK (not null — use REMOVE_MOSFET_B for that)
      return {
        ...state,
        project: {
          ...state.project,
          blocks: {
            ...state.project.blocks,
            [block]: { ...DEFAULT_BLOCK },
          },
        },
      }
    }

    case 'ADD_MOSFET_B':
      if (state.project.blocks.mosfet_b) return state  // already exists
      return {
        ...state,
        project: {
          ...state.project,
          blocks: {
            ...state.project.blocks,
            mosfet_b: { ...DEFAULT_BLOCK },
          },
        },
      }

    case 'REMOVE_MOSFET_B':
      return {
        ...state,
        project: {
          ...state.project,
          blocks: {
            ...state.project.blocks,
            mosfet_b: null,
          },
        },
      }

    default:
      return state
  }
}

function _buildDefaultSelections(raw_data) {
  const selections = {}
  if (!raw_data?.parameters) return selections
  for (const param of raw_data.parameters) {
    selections[param.id] = { condition_index: 0, override: null }
  }
  return selections
}

export function ProjectProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE, (init) => {
    try {
      const saved = localStorage.getItem('mc_designer_state')
      if (saved) {
        const parsed = JSON.parse(saved)
        return { ...init, settings: parsed.settings || init.settings }
      }
    } catch { }
    return init
  })

  // Persist settings to localStorage
  useEffect(() => {
    localStorage.setItem('mc_designer_state', JSON.stringify({ settings: state.settings }))
    // Apply theme explicitly so user selection wins over OS/browser preference.
    const isDark = state.settings.theme === 'dark'
    const root = document.documentElement
    root.classList.toggle('dark', isDark)
    root.classList.toggle('light', !isDark)
    root.style.colorScheme = isDark ? 'dark' : 'light'
  }, [state.settings])

  return (
    <ProjectContext.Provider value={{ state, dispatch }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject must be used within ProjectProvider')
  return ctx
}

/** Get the currently selected value for a parameter in a block */
export function getSelectedValue(block_state, param_id) {
  const sel = block_state.selected_params?.[param_id]
  if (!sel) return null
  if (sel.override !== null && sel.override !== undefined) return sel.override
  const param = block_state.raw_data?.parameters?.find(p => p.id === param_id)
  if (!param) return null
  const cond = param.conditions?.[sel.condition_index]
  if (!cond) return null
  return cond.selected
}

/** Build a flat params dict for the calculation engine — sends {value, unit} pairs */
export function buildParamsDict(block_state) {
  const result = {}
  if (!block_state?.raw_data?.parameters) return result
  for (const param of block_state.raw_data.parameters) {
    const sel = block_state.selected_params?.[param.id]
    if (!sel) continue
    const cond = param.conditions?.[sel.condition_index]
    if (!cond) continue
    const val = sel.override !== null && sel.override !== undefined
      ? sel.override
      : cond.selected
    // Send both value and unit so backend can normalize to SI
    result[param.id] = val
    result[param.id + '__unit'] = cond.unit || ''
    result[param.id + '__cond_text'] = cond.condition_text || ''
  }
  return result
}
