import type { MaintenanceBatch, OnsiteConclusion, RoadInspectionTodo } from './types'

// 维护批次、现场复检结论与道路巡检待办单独存一份：不和业务条目混在同一个 key 里。
const STORAGE_KEY = 'forest-fire-patrol:maintenance'

export type MaintenanceState = {
  batches: MaintenanceBatch[]
  onsite: Record<string, OnsiteConclusion>
  todos: RoadInspectionTodo[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyState(): MaintenanceState {
  return { batches: [], onsite: {}, todos: [] }
}

function readStorage(): MaintenanceState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MaintenanceState>
    // 历史批次按原结构兼容：老版本存下来的批次可能缺 items/failReason/rawText，逐项补默认值。
    const batches: MaintenanceBatch[] = Array.isArray(parsed.batches)
      ? parsed.batches.map(({ items, failReason, rawText, ...batch }) => ({
          ...batch,
          // 历史批次按原结构兼容：老版本存下来的批次可能缺这三项，逐项补默认值。
          items: Array.isArray(items) ? items : [],
          failReason: typeof failReason === 'string' ? failReason : '',
          rawText: typeof rawText === 'string' ? rawText : '',
        }))
      : []
    return {
      batches,
      onsite: parsed.onsite && typeof parsed.onsite === 'object' ? parsed.onsite : {},
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
    }
  } catch {
    return emptyState()
  }
}

let cache: MaintenanceState | null = null

export function maintenanceState(): MaintenanceState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveMaintenanceState(state: MaintenanceState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function updateMaintenanceState(patch: (draft: MaintenanceState) => void): MaintenanceState {
  const next = clone(maintenanceState())
  patch(next)
  saveMaintenanceState(next)
  return next
}
