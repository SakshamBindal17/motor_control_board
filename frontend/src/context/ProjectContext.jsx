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
    design_constants: {},
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
        },
      }
    }

    case 'SET_PASSIVES_OVERRIDE': {
      const { key, value } = action.payload
      return {
        ...state,
        project: {
          ...state.project,
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
        project: { ...state.project, calculations: action.payload },
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
    // Apply theme
    document.documentElement.classList.toggle('dark', state.settings.theme === 'dark')
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
  }
  return result
}
