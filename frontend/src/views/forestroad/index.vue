<template>
  <section class="page" data-module="forestroad">
    <header class="page-head">
      <div>
        <h2>林区道路管理</h2>
        <p class="page-desc">维护林区道路，围绕道路编号、道路名称、起点位置、终点位置做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记林区道路</button>
        <button class="btn" type="button" @click="exportRows">导出林区道路清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3 class="panel-title">
        道路巡检待办
        <span class="sub-count">待处理 {{ pendingTodoCount }} / 共 {{ todos.length }} 条</span>
      </h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>生成时间</th>
            <th>来源</th>
            <th>关联文件</th>
            <th>巡检内容</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.id">
            <td>{{ todo.createdAt }}</td>
            <td>{{ todo.source }} #{{ todo.batchId }}</td>
            <td>{{ todo.fileName }}</td>
            <td>{{ todo.content }}</td>
            <td>
              <span :class="['badge', todo.done ? 'badge-ok' : 'badge-wait']">
                {{ todo.done ? '已完成' : '待巡检' }}
              </span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleTodo(todo.id)">
                {{ todo.done ? '标记待巡检' : '完成巡检' }}
              </button>
            </td>
          </tr>
          <tr v-if="!todos.length">
            <td colspan="6" class="empty-state">暂无巡检待办，防火隔离带维护资料导入成功后会自动生成一条</td>
          </tr>
        </tbody>
      </table>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无林区道路数据，可先登记林区道路</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条林区道路记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listRoadInspectionTodos,
  moduleMeta,
  runAction as applyAction,
  toggleRoadInspectionTodo,
} from '@/api/local-service'
import type { EntryRow, RoadInspectionTodo } from '@/data/types'

const meta = moduleMeta('forestroad')
const columns = ["道路编号", "道路名称", "起点位置", "终点位置", "道路等级", "通行宽度", "最近巡检日", "通行状态"]
const actions = ["安排巡检", "登记施工", "封闭道路"]
const statuses = ["正常通行", "需维护", "正在施工", "禁止通行"]
const stats = [{"label": "道路总里程", "value": 0}, {"label": "需维护段数", "value": 0}, {"label": "施工段数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const todos = ref<RoadInspectionTodo[]>([])
const pendingTodoCount = computed(() => todos.value.filter((todo) => !todo.done).length)
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
  errorMessage.value = '林区道路登记入口尚未接入审批流'
}

function toggleTodo(id: number) {
  const result = toggleRoadInspectionTodo(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reloadTodos()
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

function reloadTodos() {
  todos.value = listRoadInspectionTodos()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '林区道路列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadTodos()
})
</script>
