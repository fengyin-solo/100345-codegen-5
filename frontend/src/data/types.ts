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

/** 维护资料文件里的一行：上传内容只要求编号、林区、带宽，来源列缺省按文件提交处理。 */
export type FirebreakImportRow = {
  隔离带编号: string
  所属林区: string
  带宽米数: number
  来源: '现场复检' | '文件提交'
}

/** 防火隔离带维护资料的导入批次：一次上传一份批次，可重放、可重试。 */
export type FirebreakImportBatch = {
  id: number
  filename: string
  /** 文件内容指纹：同一文件再次上传只保留这一份维护批次。 */
  fingerprint: string
  /** 首次上传定下的原日期：重放、重试都不改，历史批次按原日期兼容。 */
  importDate: string
  status: '成功' | '失败'
  rowCount: number
  /** 成功批次覆盖到的隔离带编号，恢复报告用它回溯来源批次。 */
  codes: string[]
  /** 失败原因保留在这里，供排查后重试。 */
  failReason: string
  /** 冲突裁决等处理说明。 */
  notes: string[]
  /** 原始文件内容：失败重试、重放解析都以此为准。 */
  content: string
}
