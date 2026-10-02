import {
  addBatch,
  findBatchByFingerprint,
  findBatchById,
  listBatches,
  nextBatchId,
  updateBatch,
} from '@/data/import-store'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow, FirebreakImportBatch, FirebreakImportRow } from '@/data/types'

// 上传文件只要求这三列，其余列（比如从清单导出再导入）直接忽略。
const REQUIRED_HEADERS = ['隔离带编号', '所属林区', '带宽米数'] as const
const SOURCE_HEADER = '来源'
const RECHECK = '现场复检'
const FILE_SOURCE = '文件提交'

// 冲突裁决规则：同一条隔离带出现两个冲突结论时，以现场复检为准。
// 现场复检是实地丈量的一手结论，后提交的文件可能转抄自旧台账，防火设施以物理现状为准。
const CONFLICT_RULE_NOTE = '同一条隔离带结论冲突时以现场复检为准'

export function conflictRuleNote(): string {
  return CONFLICT_RULE_NOTE
}

export type ImportOutcome = {
  batch: FirebreakImportBatch
  /** true 表示这次上传命中了已有批次，没有重复建档。 */
  replayed: boolean
  message: string
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 同一文件的判定看内容不看文件名：归一化换行和 BOM 后取摘要。 */
function fingerprint(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  let hash = 5381
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) >>> 0
  }
  return `${normalized.length}-${hash.toString(16)}`
}

type ParseResult = { rows: FirebreakImportRow[]; errors: string[] }

function parseMaintenanceFile(content: string): ParseResult {
  const errors: string[] = []
  const rows: FirebreakImportRow[] = []
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) {
    return { rows, errors: ['文件为空，没有可解析的内容'] }
  }
  const header = lines[0].split(/[,，]/).map((cell) => cell.trim())
  const columnOf = (name: string) => header.indexOf(name)
  const missing = REQUIRED_HEADERS.filter((name) => columnOf(name) < 0)
  if (missing.length > 0) {
    return { rows, errors: [`缺少必需列：${missing.join('、')}`] }
  }
  const sourceColumn = columnOf(SOURCE_HEADER)
  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index].split(/[,，]/).map((cell) => cell.trim())
    const lineNo = index + 1
    const code = cells[columnOf('隔离带编号')] ?? ''
    const district = cells[columnOf('所属林区')] ?? ''
    const widthText = cells[columnOf('带宽米数')] ?? ''
    if (code === '') {
      errors.push(`第${lineNo}行：隔离带编号为空`)
      continue
    }
    if (district === '') {
      errors.push(`第${lineNo}行：所属林区为空`)
      continue
    }
    const width = Number(widthText)
    if (widthText === '' || Number.isNaN(width) || width <= 0) {
      errors.push(`第${lineNo}行：带宽米数「${widthText}」不是正数`)
      continue
    }
    const sourceText = sourceColumn >= 0 ? (cells[sourceColumn] ?? '') : ''
    rows.push({
      隔离带编号: code,
      所属林区: district,
      带宽米数: width,
      来源: sourceText === RECHECK ? RECHECK : FILE_SOURCE,
    })
  }
  if (errors.length === 0 && rows.length === 0) {
    errors.push('文件里没有可导入的数据行')
  }
  return { rows, errors }
}

/** 文件内部同一条隔离带多行结论冲突：现场复检优先，同为文件提交取后出现的行。 */
function resolveFileConflicts(rows: FirebreakImportRow[], notes: string[]): FirebreakImportRow[] {
  const groups = new Map<string, FirebreakImportRow[]>()
  for (const row of rows) {
    const group = groups.get(row.隔离带编号) ?? []
    group.push(row)
    groups.set(row.隔离带编号, group)
  }
  const resolved: FirebreakImportRow[] = []
  for (const [code, group] of groups) {
    const winner = group.find((row) => row.来源 === RECHECK) ?? group[group.length - 1]
    const conflicted = group.some(
      (row) => row.所属林区 !== winner.所属林区 || row.带宽米数 !== winner.带宽米数,
    )
    if (conflicted) {
      notes.push(
        winner.来源 === RECHECK
          ? `${code} 结论冲突：以现场复检为准`
          : `${code} 结论冲突：同为文件提交，以后提交的行为准`,
      )
    }
    resolved.push(winner)
  }
  return resolved
}

/** 把解析结果合并进隔离带台账：已有记录按冲突规则更新，没有的就补登记。 */
function mergeIntoFirebreak(
  rows: FirebreakImportRow[],
  batch: FirebreakImportBatch,
  notes: string[],
): void {
  const entries = listRows('firebreak')
  const next = [...entries]
  let maxId = Math.max(0, ...entries.map((entry) => Number(entry.id)))
  for (const row of rows) {
    const index = next.findIndex((entry) => String(entry['隔离带编号']) === row.隔离带编号)
    if (index < 0) {
      maxId += 1
      next.push({
        id: maxId,
        status: '正常',
        pending: true,
        abnormal: false,
        隔离带编号: row.隔离带编号,
        所属林区: row.所属林区,
        带宽米数: row.带宽米数,
        维护状态: '正常',
        最近维护日期: batch.importDate,
        资料来源: row.来源,
      })
      continue
    }
    const current = next[index]
    const currentSource = String(current['资料来源'] ?? FILE_SOURCE)
    if (currentSource === RECHECK && row.来源 !== RECHECK) {
      // 现场复检为准：文件提交的结论不覆盖复检结论，冲突时留一条说明。
      const differs =
        String(current['所属林区']) !== row.所属林区 ||
        Number(current['带宽米数']) !== row.带宽米数
      if (differs) {
        notes.push(`${row.隔离带编号} 与现场复检结论冲突，保留现场复检结果`)
      }
      continue
    }
    const maintained = String(current['最近维护日期'] ?? '')
    next[index] = {
      ...current,
      所属林区: row.所属林区,
      带宽米数: row.带宽米数,
      资料来源: row.来源,
      // 历史批次按原日期兼容：维护日期只往新走，不被旧批次往回带。
      最近维护日期: maintained > batch.importDate ? maintained : batch.importDate,
    }
  }
  saveRows('firebreak', next)
}

/** 解析成功后林区道路模块跟着多出一条巡检待办；按批次幂等，重放不会再加。 */
function ensureRoadInspectionTodo(batch: FirebreakImportBatch, rows: FirebreakImportRow[]): void {
  const roads = listRows('forestroad')
  const batchKey = String(batch.id)
  if (roads.some((road) => String(road['来源批次'] ?? '') === batchKey)) {
    return
  }
  const first = rows[0]
  const maxId = Math.max(0, ...roads.map((road) => Number(road.id)))
  const todo: EntryRow = {
    id: maxId + 1,
    status: '需维护',
    pending: true,
    abnormal: false,
    道路编号: `INSP-${String(batch.id).padStart(4, '0')}`,
    道路名称: `隔离带维护批次#${batch.id}沿线道路巡检`,
    起点位置: first?.所属林区 ?? '',
    终点位置: first?.所属林区 ?? '',
    道路等级: '',
    通行宽度: '',
    最近巡检日: batch.importDate,
    通行状态: '需维护',
    来源批次: batchKey,
  }
  saveRows('forestroad', [...roads, todo])
}

/** 解析 → 裁决 → 合并 → 联动巡检待办；失败只改批次状态，不动台账。 */
function processBatch(batch: FirebreakImportBatch): FirebreakImportBatch {
  const { rows, errors } = parseMaintenanceFile(batch.content)
  if (errors.length > 0) {
    const failed: FirebreakImportBatch = {
      ...batch,
      status: '失败',
      rowCount: 0,
      codes: [],
      failReason: errors.join('；'),
    }
    updateBatch(failed)
    return failed
  }
  const notes: string[] = []
  const resolved = resolveFileConflicts(rows, notes)
  mergeIntoFirebreak(resolved, batch, notes)
  ensureRoadInspectionTodo(batch, resolved)
  const done: FirebreakImportBatch = {
    ...batch,
    status: '成功',
    rowCount: resolved.length,
    codes: resolved.map((row) => row.隔离带编号),
    failReason: '',
    notes,
  }
  updateBatch(done)
  return done
}

function outcomeMessage(batch: FirebreakImportBatch, replayed: boolean): string {
  if (batch.status === '失败') {
    return `批次 #${batch.id} 导入失败：${batch.failReason}`
  }
  const prefix = replayed ? `批次 #${batch.id} 重试成功` : `批次 #${batch.id} 导入成功`
  return `${prefix}（${batch.importDate}），合并 ${batch.rowCount} 条维护资料，林区道路已新增 1 条巡检待办`
}

/** 导入属于可重放操作：同一文件再次上传只保留一份维护批次。 */
export function importMaintenanceFile(filename: string, content: string): ImportOutcome {
  const print = fingerprint(content)
  const existing = findBatchByFingerprint(print)
  if (existing) {
    if (existing.status === '成功') {
      return {
        batch: existing,
        replayed: true,
        message: `该文件已导入过（批次 #${existing.id}，${existing.importDate}），本次不重复建档`,
      }
    }
    // 同一文件的失败批次再次上传，相当于直接重试。
    const retried = processBatch(existing)
    return { batch: retried, replayed: true, message: outcomeMessage(retried, true) }
  }
  const batch: FirebreakImportBatch = {
    id: nextBatchId(),
    filename,
    fingerprint: print,
    importDate: today(),
    status: '失败',
    rowCount: 0,
    codes: [],
    failReason: '',
    notes: [],
    content,
  }
  addBatch(batch)
  const done = processBatch(batch)
  return { batch: done, replayed: false, message: outcomeMessage(done, false) }
}

/** 失败批次按原样重试：内容、原日期都不变，只重新走一遍解析。 */
export function retryImportBatch(id: number): ImportOutcome {
  const batch = findBatchById(id)
  if (!batch) {
    throw new Error(`没有找到批次 #${id}`)
  }
  const done = processBatch(batch)
  return { batch: done, replayed: true, message: outcomeMessage(done, true) }
}

export function listImportBatches(): FirebreakImportBatch[] {
  return listBatches()
}

export function buildRecoveryReport(): { filename: string; content: string } {
  const succeeded = listBatches().filter((batch) => batch.status === '成功')
  const latestBatchOf = (code: string): FirebreakImportBatch | undefined =>
    succeeded
      .filter((batch) => batch.codes.includes(code))
      .sort((a, b) => b.importDate.localeCompare(a.importDate) || b.id - a.id)[0]
  const header = [
    '隔离带编号',
    '所属林区',
    '带宽米数',
    '维护状态',
    '植被恢复程度',
    '最近维护日期',
    '资料来源',
    '最近维护批次',
    '批次导入日期',
  ]
  const lines = [header.join(',')]
  for (const row of listRows('firebreak')) {
    const code = String(row['隔离带编号'] ?? '')
    const batch = latestBatchOf(code)
    lines.push(
      [
        code,
        row['所属林区'] ?? '',
        row['带宽米数'] ?? '',
        row['status'] ?? '',
        row['植被恢复程度'] ?? '',
        row['最近维护日期'] ?? '',
        row['资料来源'] ?? '',
        batch ? `#${batch.id}` : '',
        batch?.importDate ?? '',
      ].join(','),
    )
  }
  return { filename: `防火隔离带-恢复报告-${today()}.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadRecoveryReport(): void {
  const { filename, content } = buildRecoveryReport()
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
