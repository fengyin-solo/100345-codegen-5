<template>
  <section class="page" data-module="firebreak">
    <header class="page-head">
      <div>
        <h2>防火隔离带管理</h2>
        <p class="page-desc">维护防火隔离带，围绕隔离带编号、所属林区、起止坐标、带宽米数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="fileInput?.click()">导入维护资料</button>
        <button class="btn" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="downloadLatestReport">下载恢复报告</button>
        <button class="btn" type="button" @click="exportRows">导出隔离带清单</button>
        <input
          ref="fileInput"
          type="file"
          accept=".csv,text/csv"
          hidden
          @change="onFilePicked"
        />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="importMessage" :class="['result-banner', importOk ? 'ok' : 'fail']">
      {{ importMessage }}
      <button v-if="importWarnings.length" class="link" type="button" @click="showWarnings = !showWarnings">
        {{ showWarnings ? '收起提示' : `查看 ${importWarnings.length} 条裁定提示` }}
      </button>
    </p>
    <ul v-if="showWarnings" class="warning-list">
      <li v-for="(warning, idx) in importWarnings" :key="idx">{{ warning }}</li>
    </ul>

    <section class="panel">
      <h3 class="panel-title">维护批次（导入可重放：同一文件重复上传只保留一份批次）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次</th>
            <th>上传时间</th>
            <th>文件名</th>
            <th>状态</th>
            <th>条数</th>
            <th>说明 / 失败原因</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>#{{ batch.id }}</td>
            <td>{{ batch.uploadedAt }}</td>
            <td>{{ batch.fileName }}</td>
            <td>
              <span :class="['badge', batch.status === 'success' ? 'badge-ok' : 'badge-fail']">
                {{ batch.status === 'success' ? '成功' : '失败' }}
              </span>
            </td>
            <td>{{ batch.items.length }}</td>
            <td class="reason-cell">
              <span v-if="batch.status === 'failed'" class="error-text">{{ batch.failReason }}</span>
              <span v-else-if="batch.items.some((item) => item.source === 'onsite')" class="warn-text">
                含现场复检覆盖文件结论的记录
              </span>
              <span v-else class="muted-text">解析成功，已联动一条道路巡检待办</span>
            </td>
            <td class="row-actions">
              <button v-if="batch.status === 'failed'" class="link" type="button" @click="retryBatch(batch.id)">
                按原文件重试
              </button>
              <button v-else class="link" type="button" @click="downloadReport(batch.id)">
                恢复报告
              </button>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="7" class="empty-state">还没有维护批次，可先下载模板再导入 CSV 文件</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">现场复检登记（与文件结论冲突时，以现场复检为准）</h3>
      <form class="filter-bar" @submit.prevent="submitOnsite">
        <label class="filter-item">
          <span>隔离带编号</span>
          <input v-model="onsiteForm.code" list="firebreak-code-list" placeholder="如 GLD-2026-001" />
          <datalist id="firebreak-code-list">
            <option v-for="row in rows" :key="String(row.id)" :value="String(row['隔离带编号'] ?? '')" />
          </datalist>
        </label>
        <label class="filter-item">
          <span>所属林区</span>
          <input v-model="onsiteForm.forest" placeholder="可留空则沿用台账" />
        </label>
        <label class="filter-item">
          <span>带宽米数</span>
          <input v-model="onsiteForm.width" type="number" min="0" step="0.1" placeholder="可留空" />
        </label>
        <label class="filter-item">
          <span>复检结论</span>
          <select v-model="onsiteForm.conclusion">
            <option value="" disabled>请选择结论</option>
            <option v-for="conclusion in conclusions" :key="conclusion" :value="conclusion">
              {{ conclusion }}
            </option>
          </select>
        </label>
        <button class="btn primary" type="submit">登记复检结论</button>
      </form>
      <p v-if="onsiteMessage" :class="['result-banner', onsiteOk ? 'ok' : 'fail']">{{ onsiteMessage }}</p>
      <p v-if="onsiteList.length" class="muted-text small-text">
        最近复检：
        <span v-for="(record, idx) in onsiteList.slice(0, 3)" :key="record.code">
          {{ record.code }} {{ record.conclusion }}（{{ record.checkedAt }}）<span v-if="idx < Math.min(onsiteList.length, 3) - 1">；</span>
        </span>
      </p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>结论来源</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row['结论来源'] ?? '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无防火隔离带数据，可先登记防火隔离带</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火隔离带记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  FIREBREAK_MAINTENANCE_CONCLUSIONS,
  downloadEntries,
  downloadMaintenanceTemplate,
  downloadRecoveryReport,
  importMaintenanceFile,
  listEntries,
  listMaintenanceBatches,
  listOnsiteConclusions,
  moduleMeta,
  recordOnsiteConclusion,
  retryFailedBatch,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, MaintenanceBatch, MaintenanceImportResult, OnsiteConclusion } from '@/data/types'

const meta = moduleMeta('firebreak')
const columns = ["隔离带编号", "所属林区", "起止坐标", "带宽米数", "建成日期", "最近维护日期", "植被恢复程度", "维护状态"]
const actions = ["安排维护", "确认恢复", "标记荒废"]
const statuses = ["正常", "需割草", "需补植", "已荒废"]
const conclusions = FIREBREAK_MAINTENANCE_CONCLUSIONS
const stats = [{"label": "隔离带总长", "value": 0}, {"label": "需维护条数", "value": 0}, {"label": "荒废条数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const fileInput = ref<HTMLInputElement | null>(null)
const batches = ref<MaintenanceBatch[]>([])
const importMessage = ref('')
const importOk = ref(true)
const importWarnings = ref<string[]>([])
const showWarnings = ref(false)

const onsiteForm = reactive({ code: '', forest: '', width: '', conclusion: '' })
const onsiteList = ref<OnsiteConclusion[]>([])
const onsiteMessage = ref('')
const onsiteOk = ref(true)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function downloadTemplate() {
  downloadMaintenanceTemplate()
}

function downloadLatestReport() {
  try {
    downloadRecoveryReport()
  } catch (error) {
    importOk.value = false
    importMessage.value = error instanceof Error ? error.message : '恢复报告生成失败'
  }
}

function downloadReport(batchId: number) {
  downloadRecoveryReport(batchId)
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const text = await file.text()
  const result: MaintenanceImportResult = importMaintenanceFile(file.name, text)
  importOk.value = result.ok
  importMessage.value = result.message
  importWarnings.value = result.warnings
  showWarnings.value = result.warnings.length > 0 && !result.ok ? false : result.warnings.length > 0
  input.value = ''
  reloadBatches()
  reload()
}

function retryBatch(batchId: number) {
  const result = retryFailedBatch(batchId)
  importOk.value = result.ok
  importMessage.value = result.message
  importWarnings.value = result.warnings
  showWarnings.value = result.warnings.length > 0
  reloadBatches()
  reload()
}

function submitOnsite() {
  const widthRaw = onsiteForm.width.trim()
  const result = recordOnsiteConclusion({
    code: onsiteForm.code,
    forest: onsiteForm.forest,
    widthMeters: widthRaw === '' ? null : Number(widthRaw),
    conclusion: onsiteForm.conclusion,
  })
  onsiteOk.value = result.ok
  onsiteMessage.value = result.message
  if (result.ok) {
    onsiteForm.code = ''
    onsiteForm.forest = ''
    onsiteForm.width = ''
    onsiteForm.conclusion = ''
    onsiteList.value = listOnsiteConclusions()
    reload()
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reloadBatches() {
  batches.value = listMaintenanceBatches()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火隔离带列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadBatches()
  onsiteList.value = listOnsiteConclusions()
})
</script>
