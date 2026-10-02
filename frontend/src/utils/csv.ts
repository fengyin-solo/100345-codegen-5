// 维护资料文件走 CSV：只做纯文本解析与序列化，不碰业务数据。

// 去掉 UTF-8 BOM，统一换行，去掉首尾空白行——同一份文件换台机器导出也应得到同一指纹。
export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

// 简易 FNV-1a 指纹 + 长度：纯前端单机场景足够判定「同一文件再次上传」。
export function hashContent(text: string): string {
  const normalized = normalizeText(text)
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${normalized.length}`
}

// 支持引号包裹、引号转义（""）和 CRLF/LF 换行。
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
  }

  for (let i = 0; i < src.length; i += 1) {
    const char = src[i]
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      pushRow()
    } else if (char === '\r') {
      if (src[i + 1] === '\n') {
        i += 1
      }
      pushRow()
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    pushRow()
  }
  return rows
}

function escapeCell(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\n')
}

// 2026-10-02 13:45 这种本地时间戳，批次日期要按原日期保留，不做 UTC 换算。
export function nowStamp(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function todayStamp(): string {
  return nowStamp().slice(0, 10)
}
