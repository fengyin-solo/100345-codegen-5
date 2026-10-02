import { MODULE_BY_KEY } from '@/data/modules'
import { maintenanceState, updateMaintenanceState } from '@/data/maintenance-store'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  FirebreakMaintenanceItem,
  MaintenanceBatch,
  MaintenanceImportResult,
  ModuleMeta,
  OnsiteConclusion,
  OverviewResult,
  PageResult,
  RoadInspectionTodo,
} from '@/data/types'
import { hashContent, nowStamp, parseCsv, toCsv } from '@/utils/csv'

// 防火隔离带维护资料相关：
// 1) 文件可重放——按内容指纹判重，同一文件只生成一份维护批次；
// 2) 失败留因——解析/校验失败的文件原样留存并写明原因，可一键重试；
// 3) 冲突裁定——同一条隔离带文件结论与现场复检结论冲突时，以现场复检为准；
// 4) 批次联动——解析成功后自动给林区道路模块新增一条道路巡检待办。
const FIREBREAK_KEY = 'firebreak'
const FORESTROAD_KEY = 'forestroad'

// 导入模板表头：隔离带编号、所属林区、带宽米数必须有，结论列可选（只做资料更新时可空）。
const IMPORT_HEADERS = ['隔离带编号', '所属林区', '带宽米数', '维护结论']

const FIREBREAK_STATUS_BY_CONCLUSION: Record<string, { status: string; recovery: string }> = {
  植被已恢复: { status: '正常', recovery: '已恢复' },
  需割草: { status: '需割草', recovery: '部分恢复' },
  需补植: { status: '需补植', recovery: '恢复较差' },
  已荒废: { status: '已荒废', recovery: '未恢复' },
}

// 页面上现场复检结论下拉用这一份，和导入文件允许的结论保持同一口径。
export const FIREBREAK_MAINTENANCE_CONCLUSIONS = Object.keys(FIREBREAK_STATUS_BY_CONCLUSION)

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

type ParsedMaintenance = {
  items: FirebreakMaintenanceItem[]
  warnings: string[]
}


export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 防火隔离带维护资料：文件导入、现场复检、恢复报告，以及林区道路巡检待办联动。
// ---------------------------------------------------------------------------

function nextBatchId(batches: MaintenanceBatch[]): number {
  return batches.reduce((max, batch) => Math.max(max, batch.id), 0) + 1
}

function parseMaintenanceText(text: string): ParsedMaintenance {
  const grid = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ''))
  if (grid.length === 0) {
    throw new Error('文件没有任何内容')
  }
  const header = grid[0].map((cell) => cell.trim())
  const indexOf = (name: string) => header.findIndex((cell) => cell === name)
  const codeIdx = indexOf('隔离带编号')
  const forestIdx = indexOf('所属林区')
  const widthIdx = indexOf('带宽米数')
  if (codeIdx < 0 || forestIdx < 0 || widthIdx < 0) {
    throw new Error(
      `表头缺少必需列（需要「隔离带编号 / 所属林区 / 带宽米数」，实际为：${header.join('、') || '空'}）`,
    )
  }
  const conclusionIdx = indexOf('维护结论')
  if (grid.length === 1) {
    throw new Error('只有表头没有数据行，未解析到任何隔离带维护记录')
  }
  const warnings: string[] = []
  if (conclusionIdx < 0) {
    warnings.push('文件未提供「维护结论」列，本次只更新隔离带基础资料，不改维护状态')
  }
  const allowed = Object.keys(FIREBREAK_STATUS_BY_CONCLUSION).join('、')
  const items = new Map<string, { item: FirebreakMaintenanceItem; line: number }>()

  grid.slice(1).forEach((cells, offset) => {
    const line = offset + 2
    const code = (cells[codeIdx] ?? '').trim()
    const forest = (cells[forestIdx] ?? '').trim()
    const widthRaw = (cells[widthIdx] ?? '').trim()
    const conclusion = conclusionIdx >= 0 ? (cells[conclusionIdx] ?? '').trim() : ''
    if (!code) {
      throw new Error(`第 ${line} 行缺少「隔离带编号」`)
    }
    if (!forest) {
      throw new Error(`第 ${line} 行（${code}）缺少「所属林区」`)
    }
    const widthMeters = Number(widthRaw)
    if (widthRaw === '' || Number.isNaN(widthMeters) || widthMeters <= 0) {
      throw new Error(`第 ${line} 行（${code}）的带宽米数「${widthRaw}」不是正数`)
    }
    if (conclusion && !FIREBREAK_STATUS_BY_CONCLUSION[conclusion]) {
      throw new Error(
        `第 ${line} 行（${code}）的维护结论「${conclusion}」无法识别，允许的结论：${allowed}`,
      )
    }
    const item: FirebreakMaintenanceItem = { code, forest, widthMeters, conclusion }
    const existed = items.get(code)
    if (existed && existed.item.conclusion !== conclusion) {
      // 文件内部对同一条隔离带给出两个互相冲突的结论：不擅自二选一，退回现场复检。
      throw new Error(
        `隔离带 ${code} 在第 ${existed.line}、${line} 行给出冲突结论` +
        `（「${existed.item.conclusion || '无结论'}」与「${conclusion || '无结论'}」），请现场复检后重新导入`,
      )
    }
    if (!existed) {
      items.set(code, { item, line })
    }
  })

  return { items: [...items.values()].map((entry) => entry.item), warnings }
}

function applyMaintenanceBatch(
  batch: MaintenanceBatch,
  parsed: ParsedMaintenance,
): { applied: number; warnings: string[] } {
  const state = maintenanceState()
  const rows = [...listRows(FIREBREAK_KEY)]
  const warnings = [...parsed.warnings]
  const batchDate = batch.uploadedAt.slice(0, 10)
  const lastStatus = moduleMeta(FIREBREAK_KEY).statuses.slice(-1)[0]

  parsed.items.forEach((item) => {
    const index = rows.findIndex((row) => String(row['隔离带编号'] ?? '') === item.code)
    const onsite = state.onsite[item.code]
    let adoptedConclusion = item.conclusion
    let source: 'file' | 'onsite' = 'file'
    // 冲突裁定：文件结论与现场复检结论不一致时，以现场复检为准，文件结论仍留痕。
    if (onsite && item.conclusion && onsite.conclusion !== item.conclusion) {
      adoptedConclusion = onsite.conclusion
      source = 'onsite'
      warnings.push(
        `隔离带 ${item.code}：文件结论「${item.conclusion}」与 ${onsite.checkedAt} ` +
        `现场复检结论「${onsite.conclusion}」冲突，已以现场复检为准`,
      )
    }
    const mapped = adoptedConclusion ? FIREBREAK_STATUS_BY_CONCLUSION[adoptedConclusion] : null
    const base: EntryRow =
      index >= 0
        ? { ...rows[index] }
        : {
            id: rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1,
            status: '正常',
            pending: true,
            abnormal: false,
            隔离带编号: item.code,
            所属林区: item.forest,
            起止坐标: '',
            带宽米数: item.widthMeters,
            建成日期: '',
            最近维护日期: '',
            植被恢复程度: '',
            维护状态: '',
          }
    base['所属林区'] = item.forest
    base['带宽米数'] = item.widthMeters
    if (mapped) {
      base.status = mapped.status
      base['植被恢复程度'] = mapped.recovery
      base['最近维护日期'] = batchDate
      base.pending = mapped.status !== lastStatus
      base.abnormal = mapped.status === '已荒废'
    }
    base['结论来源'] = source === 'onsite' ? '现场复检（覆盖文件）' : '维护文件'
    if (index >= 0) {
      rows[index] = base
    } else {
      rows.push(base)
    }
    batch.items.push({ ...item, source })
  })

  saveRows(FIREBREAK_KEY, rows)

  // 解析成功：其余模块（林区道路）的道路巡检待办跟着多出一条。
  const todoId = state.todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1
  const todo: RoadInspectionTodo = {
    id: todoId,
    createdAt: batch.uploadedAt,
    source: '维护批次',
    batchId: batch.id,
    fileName: batch.fileName,
    firebreakCode: '',
    forest: '',
    content: `防火隔离带维护批次《${batch.fileName}》解析成功，共 ${parsed.items.length} 条记录，请安排对应林区道路巡检`,
    done: false,
  }
  updateMaintenanceState((draft) => {
    const target = draft.batches.find((entry) => entry.id === batch.id)
    if (target) {
      target.status = 'success'
      target.failReason = ''
      target.items = batch.items
    }
    draft.todos.push(todo)
  })

  return { applied: parsed.items.length, warnings }
}

export function importMaintenanceFile(fileName: string, text: string): MaintenanceImportResult {
  const fingerprint = hashContent(text)
  const state = maintenanceState()
  const existed = state.batches.find((batch) => batch.fingerprint === fingerprint)

  if (existed && existed.status === 'success') {
    // 可重放：同一文件再次上传不新建批次、不重复联动待办，只回显原批次（原日期保留）。
    return {
      ok: true,
      duplicated: true,
      batchId: existed.id,
      message: `该文件已导入过（批次 #${existed.id}，${existed.uploadedAt}），重放未重复生成维护批次`,
      warnings: [],
      applied: existed.items.length,
    }
  }

  let parsed: ParsedMaintenance
  try {
    parsed = parseMaintenanceText(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : '文件解析失败'
    if (existed) {
      // 失败重试：保留同一条批次记录与原上传日期，只刷新失败原因。
      updateMaintenanceState((draft) => {
        const target = draft.batches.find((entry) => entry.id === existed.id)
        if (target) {
          target.status = 'failed'
          target.failReason = reason
        }
      })
      return { ok: false, duplicated: false, batchId: existed.id, message: reason, warnings: [], applied: 0 }
    }
    const batch: MaintenanceBatch = {
      id: nextBatchId(state.batches),
      fileName,
      fingerprint,
      uploadedAt: nowStamp(),
      status: 'failed',
      failReason: reason,
      rawText: text,
      items: [],
    }
    updateMaintenanceState((draft) => {
      draft.batches.push(batch)
    })
    return { ok: false, duplicated: false, batchId: batch.id, message: reason, warnings: [], applied: 0 }
  }

  // 解析通过：失败记录重试时沿用原批次（原日期兼容），否则新建批次。
  const batch: MaintenanceBatch = existed
    ? { ...existed, items: [] }
    : {
        id: nextBatchId(state.batches),
        fileName,
        fingerprint,
        uploadedAt: nowStamp(),
        status: 'success',
        failReason: '',
        rawText: text,
        items: [],
      }

  const { applied, warnings } = applyMaintenanceBatch(batch, parsed)
  if (!existed) {
    updateMaintenanceState((draft) => {
      if (!draft.batches.some((entry) => entry.id === batch.id)) {
        draft.batches.push(batch)
      }
    })
  }
  return {
    ok: true,
    duplicated: false,
    batchId: batch.id,
    message: `维护批次 #${batch.id} 导入成功，写入 ${applied} 条隔离带记录，并已生成一条道路巡检待办`,
    warnings,
    applied,
  }
}

export function listMaintenanceBatches(): MaintenanceBatch[] {
  return [...maintenanceState().batches].sort((a, b) => b.id - a.id)
}

export function retryFailedBatch(batchId: number): MaintenanceImportResult {
  const batch = maintenanceState().batches.find((entry) => entry.id === batchId)
  if (!batch) {
    return { ok: false, duplicated: false, batchId: null, message: `没有找到批次 #${batchId}`, warnings: [], applied: 0 }
  }
  if (batch.status !== 'failed') {
    return {
      ok: true,
      duplicated: true,
      batchId: batch.id,
      message: `批次 #${batch.id} 已成功，无需重试`,
      warnings: [],
      applied: batch.items.length,
    }
  }
  return importMaintenanceFile(batch.fileName, batch.rawText)
}

export function recordOnsiteConclusion(input: {
  code: string
  forest: string
  widthMeters: number | null
  conclusion: string
}): ActionResult {
  const code = input.code.trim()
  const forest = input.forest.trim()
  if (!code) {
    return { ok: false, message: '请填写隔离带编号' }
  }
  if (!input.conclusion || !FIREBREAK_STATUS_BY_CONCLUSION[input.conclusion]) {
    return {
      ok: false,
      message: `现场复检结论无法识别，允许：${Object.keys(FIREBREAK_STATUS_BY_CONCLUSION).join('、')}`,
    }
  }
  const checkedAt = nowStamp()
  const record: OnsiteConclusion = {
    code,
    forest,
    widthMeters: input.widthMeters,
    conclusion: input.conclusion,
    checkedAt,
  }
  updateMaintenanceState((draft) => {
    draft.onsite[code] = record
  })

  // 现场复检是地面实况：登记后立即落到隔离带台账上。
  const rows = [...listRows(FIREBREAK_KEY)]
  const index = rows.findIndex((row) => String(row['隔离带编号'] ?? '') === code)
  const mapped = FIREBREAK_STATUS_BY_CONCLUSION[input.conclusion]
  const lastStatus = moduleMeta(FIREBREAK_KEY).statuses.slice(-1)[0]
  const base: EntryRow =
    index >= 0
      ? { ...rows[index] }
      : {
          id: rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1,
          status: '正常',
          pending: true,
          abnormal: false,
          隔离带编号: code,
          所属林区: forest,
          起止坐标: '',
          带宽米数: input.widthMeters ?? '',
          建成日期: '',
          最近维护日期: '',
          植被恢复程度: '',
          维护状态: '',
        }
  if (forest) {
    base['所属林区'] = forest
  }
  if (input.widthMeters !== null) {
    base['带宽米数'] = input.widthMeters
  }
  base.status = mapped.status
  base['植被恢复程度'] = mapped.recovery
  base['最近维护日期'] = checkedAt.slice(0, 10)
  base.pending = mapped.status !== lastStatus
  base.abnormal = mapped.status === '已荒废'
  base['结论来源'] = '现场复检'
  if (index >= 0) {
    rows[index] = base
  } else {
    rows.push(base)
  }
  saveRows(FIREBREAK_KEY, rows)
  return { ok: true, message: `隔离带 ${code} 现场复检结论「${input.conclusion}」已登记并写入台账` }
}

export function listOnsiteConclusions(): OnsiteConclusion[] {
  return Object.values(maintenanceState().onsite).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
}

export function downloadMaintenanceTemplate(): void {
  const content = `﻿${toCsv([
    IMPORT_HEADERS,
    ['GLD-2026-001', '青松岭林区', '15', '植被已恢复'],
    ['GLD-2026-002', '白桦坡林区', '12', '需补植'],
  ])}`
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '防火隔离带维护资料-导入模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function exportRecoveryReport(batchId?: number): { filename: string; content: string } {
  const batches = listMaintenanceBatches().filter((batch) => batch.status === 'success')
  if (batches.length === 0) {
    throw new Error('暂无可生成恢复报告的成功批次')
  }
  const batch = batchId
    ? batches.find((entry) => entry.id === batchId)
    : batches[0]
  if (!batch) {
    throw new Error(`没有找到成功的批次 #${batchId}`)
  }
  const rowsById = new Map(listRows(FIREBREAK_KEY).map((row) => [String(row['隔离带编号'] ?? ''), row]))
  const state = maintenanceState()
  const todo = state.todos.find((entry) => entry.batchId === batch.id)
  const header = [
    '批次编号', '导入时间', '文件名', '隔离带编号', '所属林区', '带宽米数',
    '文件维护结论', '采纳结论', '结论来源', '现场复检时间', '当前维护状态', '植被恢复程度', '道路巡检待办',
  ]
  const lines: (string | number)[][] = [header]
  batch.items.forEach((item) => {
    const onsite = state.onsite[item.code]
    const adopted = item.source === 'onsite' && onsite ? onsite.conclusion : item.conclusion
    const row = rowsById.get(item.code)
    lines.push([
      batch.id,
      batch.uploadedAt,
      batch.fileName,
      item.code,
      item.forest,
      item.widthMeters,
      item.conclusion || '（未填）',
      adopted || '（未填）',
      item.source === 'onsite' ? '现场复检（覆盖文件）' : '维护文件',
      item.source === 'onsite' && onsite ? onsite.checkedAt : '',
      row?.status ?? '',
      String(row?.['植被恢复程度'] ?? ''),
      todo ? (todo.done ? '已完成' : '待巡检') : '',
    ])
  })
  return {
    filename: `防火隔离带恢复报告-批次${batch.id}-${batch.uploadedAt.slice(0, 10)}.csv`,
    content: `﻿${toCsv(lines)}`,
  }
}

export function downloadRecoveryReport(batchId?: number): void {
  const { filename, content } = exportRecoveryReport(batchId)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function listRoadInspectionTodos(): RoadInspectionTodo[] {
  return [...maintenanceState().todos].sort((a, b) => b.id - a.id)
}

export function toggleRoadInspectionTodo(id: number): ActionResult {
  let changed = false
  updateMaintenanceState((draft) => {
    const todo = draft.todos.find((entry) => entry.id === id)
    if (todo) {
      todo.done = !todo.done
      changed = true
    }
  })
  return changed
    ? { ok: true, message: `道路巡检待办 #${id} 状态已更新` }
    : { ok: false, message: `没有找到待办 #${id}` }
}
