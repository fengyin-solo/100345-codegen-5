import type { FirebreakImportBatch } from './types'

// 维护资料导入批次单独存一份：和业务记录分开，重放、重试都只动这里。
const STORAGE_KEY = 'forest-fire-patrol:firebreak-imports'

let cache: FirebreakImportBatch[] | null = null

function readStorage(): FirebreakImportBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as FirebreakImportBatch[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function allBatches(): FirebreakImportBatch[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listBatches(): FirebreakImportBatch[] {
  // 历史批次按原日期排：导入日期定下后不动，重放、重试都不改日期。
  return [...allBatches()].sort(
    (a, b) => a.importDate.localeCompare(b.importDate) || a.id - b.id,
  )
}

export function findBatchByFingerprint(fingerprint: string): FirebreakImportBatch | undefined {
  return allBatches().find((batch) => batch.fingerprint === fingerprint)
}

export function findBatchById(id: number): FirebreakImportBatch | undefined {
  return allBatches().find((batch) => batch.id === id)
}

export function nextBatchId(): number {
  return Math.max(0, ...allBatches().map((batch) => batch.id)) + 1
}

export function addBatch(batch: FirebreakImportBatch): void {
  saveBatches([...allBatches(), batch])
}

export function updateBatch(batch: FirebreakImportBatch): void {
  saveBatches(allBatches().map((item) => (item.id === batch.id ? batch : item)))
}

function saveBatches(batches: FirebreakImportBatch[]): void {
  cache = [...batches]
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}
