<template>
  <section class="page" data-module="firebreak">
    <header class="page-head">
      <div>
        <h2>防火隔离带管理</h2>
        <p class="page-desc">维护防火隔离带，围绕隔离带编号、所属林区、起止坐标、带宽米数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火隔离带</button>
        <button class="btn" type="button" @click="triggerImport">导入维护资料</button>
        <button class="btn" type="button" @click="downloadReport">下载恢复报告</button>
        <button class="btn" type="button" @click="exportRows">导出防火隔离带清单</button>
        <input
          ref="fileInput"
          type="file"
          accept=".csv,text/csv"
          class="visually-hidden"
          @change="onFilePicked"
        />
      </div>
    </header>

    <p v-if="notice" class="import-notice">{{ notice }}</p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无防火隔离带数据，可先登记防火隔离带</td>
        </tr>
      </tbody>
    </table>

    <section class="batch-panel">
      <h3 class="batch-title">维护资料导入批次</h3>
      <p class="batch-rule">
        上传文件需包含隔离带编号、所属林区、带宽米数三列；{{ conflictRule }}；同一文件重复上传只保留一份批次，失败批次保留原因可重试。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次</th>
            <th>文件名</th>
            <th>导入日期</th>
            <th>状态</th>
            <th>行数</th>
            <th>失败原因 / 处理说明</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>#{{ batch.id }}</td>
            <td>{{ batch.filename }}</td>
            <td>{{ batch.importDate }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ batch.status === '成功' ? batch.rowCount : '—' }}</td>
            <td>
              <span v-if="batch.failReason" class="error-text">{{ batch.failReason }}</span>
              <span v-for="note in batch.notes" :key="note" class="batch-note">{{ note }}</span>
              <span v-if="!batch.failReason && !batch.notes.length">—</span>
            </td>
            <td class="row-actions">
              <button
                v-if="batch.status === '失败'"
                class="link"
                type="button"
                @click="retryBatch(batch.id)"
              >
                重试
              </button>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="7" class="empty-state">还没有导入批次，点击「导入维护资料」上传 CSV 文件</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火隔离带记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  conflictRuleNote,
  downloadRecoveryReport,
  importMaintenanceFile,
  listImportBatches,
  retryImportBatch,
} from '@/api/firebreak-import'
import type { EntryRow, FirebreakImportBatch } from '@/data/types'

const meta = moduleMeta('firebreak')
const columns = ["隔离带编号", "所属林区", "起止坐标", "带宽米数", "建成日期", "最近维护日期", "植被恢复程度", "维护状态"]
const actions = ["安排维护", "确认恢复", "标记荒废"]
const statuses = ["正常", "需割草", "需补植", "已荒废"]
const stats = [{"label": "隔离带总长", "value": 0}, {"label": "需维护条数", "value": 0}, {"label": "荒废条数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const batches = ref<FirebreakImportBatch[]>([])
const notice = ref('')
const conflictRule = conflictRuleNote()
const fileInput = ref<HTMLInputElement | null>(null)
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火隔离带登记入口尚未接入审批流'
}

function triggerImport() {
  fileInput.value?.click()
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空选择，允许同一文件再次上传（走重放 / 重试逻辑，不会重复建档）。
  input.value = ''
  if (!file) {
    return
  }
  const content = await file.text()
  const outcome = importMaintenanceFile(file.name, content)
  notice.value = outcome.message
  errorMessage.value = ''
  reloadBatches()
  reload()
}

function retryBatch(id: number) {
  notice.value = retryImportBatch(id).message
  errorMessage.value = ''
  reloadBatches()
  reload()
}

function downloadReport() {
  downloadRecoveryReport()
}

function reloadBatches() {
  batches.value = listImportBatches()
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
})
</script>
