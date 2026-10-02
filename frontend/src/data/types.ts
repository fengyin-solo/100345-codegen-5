/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 一条隔离带在维护批次里的结论：只关心隔离带编号、所属林区、带宽米数与维护结论。
export type FirebreakMaintenanceItem = {
  code: string
  forest: string
  widthMeters: number
  conclusion: string
}

export type MaintenanceBatchStatus = 'success' | 'failed'

export type MaintenanceBatch = {
  id: number
  fileName: string
  // 文件内容指纹：同一文件再次上传据此判重，重放只保留一份批次。
  fingerprint: string
  uploadedAt: string
  status: MaintenanceBatchStatus
  // 解析失败或校验失败时保留原因，文件本身也留在记录里供原样重试。
  failReason: string
  rawText: string
  // 结论来源：批次结论被现场复检推翻时留痕，便于追溯裁定。
  items: (FirebreakMaintenanceItem & { source: 'file' | 'onsite' })[]
}

// 现场复检结论按隔离带编号留存：与后提交文件冲突时以它为准。
export type OnsiteConclusion = {
  code: string
  conclusion: string
  forest: string
  widthMeters: number | null
  checkedAt: string
}

export type RoadInspectionTodo = {
  id: number
  createdAt: string
  source: '维护批次'
  batchId: number
  fileName: string
  firebreakCode: string
  forest: string
  content: string
  done: boolean
}

export type MaintenanceImportResult = {
  ok: boolean
  // true 表示同一文件再次上传命中幂等：没有新建批次，也没有重复联动待办。
  duplicated: boolean
  batchId: number | null
  message: string
  warnings: string[]
  applied: number
}
