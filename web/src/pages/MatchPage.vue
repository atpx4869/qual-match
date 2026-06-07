<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import type { UploadRawFile } from 'element-plus';
import {
  listWatchlists, createWatchlistFromCodes, createWatchlistFromExcel,
  deleteWatchlist, matchWatchlist, exportWatchlist,
  type WatchlistSummary, type MatchOutcome, type MatchResult,
  type MatchSortBy, type SortOrder, type SourceStateFilter, type CapLibStateFilter,
} from '@/api/watchlist';
import CoverageTag from '@/components/CoverageTag.vue';
import CapLibStatusTag from '@/components/CapLibStatusTag.vue';
import QualImportDialog from '@/components/QualImportDialog.vue';

const PAGE_SIZE_OPTIONS = [200, 300, 500, 1000, 2000];

const watchlists = ref<WatchlistSummary[]>([]);
const currentId = ref<number | null>(null);
const outcome = ref<MatchOutcome | null>(null);
const loading = ref(false);
const showImport = ref(false);

// 创建清单对话框
const showCreate = ref(false);
const createMode = ref<'excel' | 'paste'>('excel');
const newName = ref('');
const pasteText = ref('');
const excelFile = ref<File | null>(null);
const creating = ref(false);

// 筛选
const filterMode = ref<'all' | 'uncovered' | 'covered'>('all');
const keyword = ref('');
const page = ref(1);
const pageSize = ref(500);

// 排序（服务端）：seq=原始导入顺序
const sortBy = ref<MatchSortBy>('seq');
const sortOrder = ref<SortOrder>('asc');

// 资质列状态筛选（服务端；undefined=不限）
const provCmaState = ref<SourceStateFilter | undefined>(undefined);
const cnasState = ref<SourceStateFilter | undefined>(undefined);
const natCmaState = ref<SourceStateFilter | undefined>(undefined);
const capLibState = ref<CapLibStateFilter | undefined>(undefined);

// 资质源列筛选下拉项（covered/none/series）
const SOURCE_STATE_OPTIONS: { value: SourceStateFilter; label: string }[] = [
  { value: 'covered', label: '✓ 有覆盖' },
  { value: 'none', label: '— 无' },
  { value: 'series', label: '~ 仅其他年版' },
];
// 一单一库列筛选下拉项（5 档）
const CAP_LIB_STATE_OPTIONS: { value: CapLibStateFilter; label: string }[] = [
  { value: 'in_lib', label: '🟢 在库' },
  { value: 'cite_only', label: '🟡 仅引用' },
  { value: 'abolished', label: '🟠 已废止' },
  { value: 'series_only', label: '🔴 仅系列' },
  { value: 'not_in_lib', label: '⚪ 不在库' },
];

const filteredResults = computed<MatchResult[]>(() => {
  return outcome.value?.results ?? [];
});

const coverageRate = computed(() => {
  if (!outcome.value || outcome.value.total === 0) return 0;
  return Math.round((outcome.value.coveredCount / outcome.value.total) * 100);
});

const resultTotal = computed(() => outcome.value?.filteredTotal ?? 0);

async function refreshWatchlists() {
  try {
    watchlists.value = await listWatchlists();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载清单失败');
  }
}

async function runMatch(id: number, resetPage = true) {
  if (resetPage) page.value = 1;
  loading.value = true;
  try {
    outcome.value = await matchWatchlist(id, {
      page: page.value,
      pageSize: pageSize.value,
      filter: filterMode.value,
      keyword: keyword.value.trim() || undefined,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      provCmaState: provCmaState.value,
      cnasState: cnasState.value,
      natCmaState: natCmaState.value,
      capLibState: capLibState.value,
    });
    currentId.value = id;
    page.value = outcome.value.page;
    pageSize.value = outcome.value.pageSize;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '匹配失败');
  } finally {
    loading.value = false;
  }
}

function onExcelChange(f: { raw?: UploadRawFile }) { excelFile.value = f.raw ?? null; }

async function doCreate() {
  creating.value = true;
  try {
    let res;
    if (createMode.value === 'excel') {
      if (!excelFile.value) { ElMessage.warning('请选择 Excel'); return; }
      res = await createWatchlistFromExcel(newName.value || excelFile.value.name.replace(/\.[^.]+$/, ''), excelFile.value);
    } else {
      // 分隔符只用换行/逗号/分号/Tab —— 不能含普通空格，否则会把 "GB/T 3325-2024" 拆开
      const codes = pasteText.value.split(/[\r\n,，;；\t]+/).map((s) => s.trim()).filter(Boolean);
      if (!codes.length) { ElMessage.warning('请粘贴至少一个标准号'); return; }
      if (!newName.value.trim()) { ElMessage.warning('请填写清单名称'); return; }
      res = await createWatchlistFromCodes(newName.value, codes);
    }
    ElMessage.success(`清单已创建：${res.summary.inserted} 条标准${res.summary.skipped ? `，跳过 ${res.summary.skipped}` : ''}`);
    showCreate.value = false;
    newName.value = ''; pasteText.value = ''; excelFile.value = null;
    await refreshWatchlists();
    await runMatch(res.watchlistId);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '创建失败');
  } finally {
    creating.value = false;
  }
}

async function onDelete(id: number) {
  try {
    await ElMessageBox.confirm('删除该清单（不可恢复）？', '确认', { type: 'warning' });
  } catch { return; }
  try {
    await deleteWatchlist(id);
    ElMessage.success('已删除');
    if (currentId.value === id) { currentId.value = null; outcome.value = null; }
    await refreshWatchlists();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败');
  }
}

async function onExport() {
  if (!currentId.value) return;
  try {
    await exportWatchlist(currentId.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导出失败');
  }
}

function onFilterChange() {
  if (currentId.value) void runMatch(currentId.value, true);
}

// Element Plus 服务端排序：sort-change 给 { prop, order }，prop/order 可能为空。
function onSortChange({ prop, order }: { prop: string | null; order: 'ascending' | 'descending' | null }) {
  if (!order || !prop) {
    sortBy.value = 'seq';
    sortOrder.value = 'asc';
  } else {
    sortBy.value = prop as MatchSortBy;
    sortOrder.value = order === 'descending' ? 'desc' : 'asc';
  }
  if (currentId.value) void runMatch(currentId.value, true);
}

// 资质列状态筛选变化（下拉选/清空）→ 回到第 1 页重新匹配
function onSourceStateChange() {
  if (currentId.value) void runMatch(currentId.value, true);
}

function onPageChange(p: number) {
  page.value = p;
  if (currentId.value) void runMatch(currentId.value, false);
}

function onPageSizeChange(size: number) {
  pageSize.value = size;
  if (currentId.value) void runMatch(currentId.value, true);
}

function rowClass({ row }: { row: MatchResult }) {
  return row.matched ? '' : 'row-uncovered';
}

onMounted(async () => {
  await refreshWatchlists();
  // 默认显示最新导入的清单（列表已按 id DESC，取第一个）
  if (watchlists.value.length > 0) {
    void runMatch(watchlists.value[0].id);
  }
});
</script>

<template>
  <div class="match-page">
    <div class="toolbar">
      <h1 class="page-title">清单匹配</h1>
      <div class="toolbar-actions">
        <el-select
          :model-value="currentId ?? undefined"
          placeholder="选择清单" style="width: 220px"
          @change="(v: number) => runMatch(v)"
        >
          <el-option v-for="w in watchlists" :key="w.id" :label="`${w.name}（${w.itemCount}）`" :value="w.id" />
        </el-select>
        <el-button type="primary" @click="showCreate = true">+ 新建清单</el-button>
        <el-button @click="showImport = true">导入本机构资质</el-button>
        <el-button :disabled="!outcome" @click="onExport">导出结果</el-button>
        <el-button v-if="currentId" text type="danger" @click="onDelete(currentId)">删除当前清单</el-button>
      </div>
    </div>

    <el-empty v-if="!outcome && !loading" description="选择或新建一份标准清单开始匹配" />

    <template v-if="outcome">
      <div class="summary-bar">
        <span class="summary-name">{{ outcome.watchlistName }}</span>
        <el-tag>共 {{ outcome.total }} 个标准</el-tag>
        <el-tag type="success">已覆盖 {{ outcome.coveredCount }}</el-tag>
        <el-tag type="info">覆盖率 {{ coverageRate }}%</el-tag>
        <el-tag v-if="resultTotal !== outcome.total" type="warning">筛选 {{ resultTotal }} 条</el-tag>
        <div class="summary-filters">
          <el-radio-group v-model="filterMode" size="small" @change="onFilterChange">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="covered">已覆盖</el-radio-button>
            <el-radio-button value="uncovered">未覆盖</el-radio-button>
          </el-radio-group>
          <el-input
            v-model="keyword"
            placeholder="筛选清单字段"
            clearable
            size="small"
            style="width: 180px"
            @keyup.enter="onFilterChange"
            @clear="onFilterChange"
          />
          <el-button size="small" @click="onFilterChange">筛选</el-button>
        </div>
      </div>

      <el-table
        :data="filteredResults" v-loading="loading" :row-class-name="rowClass"
        border stripe height="calc(100vh - 285px)"
        @sort-change="onSortChange"
      >
        <el-table-column prop="stdCode" label="标准号" width="180" fixed sortable="custom" />
        <el-table-column prop="stdName" label="中文标准名称" min-width="220" show-overflow-tooltip sortable="custom" />
        <el-table-column prop="controlledNo" label="受控编号" width="140" show-overflow-tooltip sortable="custom" />
        <el-table-column prop="hasText" label="是否有文本" width="110" align="center" show-overflow-tooltip />
        <el-table-column prop="department" label="所属部门" width="140" show-overflow-tooltip sortable="custom" />

        <el-table-column width="140" align="center">
          <template #header>
            <div class="col-filter-header">
              <span>省级CMA</span>
              <el-select
                v-model="provCmaState" placeholder="全部" clearable size="small"
                class="col-filter-select" @change="onSourceStateChange"
              >
                <el-option v-for="o in SOURCE_STATE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
            </div>
          </template>
          <template #default="{ row }"><CoverageTag :coverage="row.provCma" /></template>
        </el-table-column>

        <el-table-column width="140" align="center">
          <template #header>
            <div class="col-filter-header">
              <span>CNAS</span>
              <el-select
                v-model="cnasState" placeholder="全部" clearable size="small"
                class="col-filter-select" @change="onSourceStateChange"
              >
                <el-option v-for="o in SOURCE_STATE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
            </div>
          </template>
          <template #default="{ row }"><CoverageTag :coverage="row.cnas" /></template>
        </el-table-column>

        <el-table-column width="140" align="center">
          <template #header>
            <div class="col-filter-header">
              <span>国家CMA</span>
              <el-select
                v-model="natCmaState" placeholder="全部" clearable size="small"
                class="col-filter-select" @change="onSourceStateChange"
              >
                <el-option v-for="o in SOURCE_STATE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
            </div>
          </template>
          <template #default="{ row }"><CoverageTag :coverage="row.natCma" /></template>
        </el-table-column>

        <el-table-column width="150" align="center">
          <template #header>
            <div class="col-filter-header">
              <span>一单一库</span>
              <el-select
                v-model="capLibState" placeholder="全部" clearable size="small"
                class="col-filter-select" @change="onSourceStateChange"
              >
                <el-option v-for="o in CAP_LIB_STATE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
            </div>
          </template>
          <template #default="{ row }"><CapLibStatusTag :cap-lib="row.capLib" /></template>
        </el-table-column>

        <el-table-column label="是否覆盖" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.matched" type="success" size="small">已覆盖</el-tag>
            <el-tag v-else type="danger" size="small">未覆盖</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          layout="total, sizes, prev, pager, next, jumper"
          :total="resultTotal"
          :page-sizes="PAGE_SIZE_OPTIONS"
          :current-page="page"
          :page-size="pageSize"
          @current-change="onPageChange"
          @size-change="onPageSizeChange"
        />
      </div>
    </template>

    <!-- 新建清单对话框 -->
    <el-dialog v-model="showCreate" title="新建标准清单" width="560px">
      <el-radio-group v-model="createMode" style="margin-bottom: 16px">
        <el-radio-button value="excel">上传 Excel</el-radio-button>
        <el-radio-button value="paste">粘贴标准号</el-radio-button>
      </el-radio-group>
      <el-form label-width="80px">
        <el-form-item label="清单名称">
          <el-input v-model="newName" placeholder="留空则用文件名" />
        </el-form-item>
        <el-form-item v-if="createMode === 'excel'" label="Excel">
          <el-upload
            drag :auto-upload="false" :limit="1" accept=".xlsx,.xls"
            :on-change="onExcelChange" :on-exceed="() => ElMessage.warning('只能选一个文件')"
          >
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">拖拽文件到此或<em>点击选择</em></div>
            <template #tip><div class="upload-tip">表头需含「标准号」列</div></template>
          </el-upload>
        </el-form-item>
        <el-form-item v-else label="标准号">
          <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="每行一个标准号，或用逗号/分号/Tab 分隔&#10;GB/T 3325-2024&#10;GB 5009.3-2016" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="doCreate">创建并匹配</el-button>
      </template>
    </el-dialog>

    <QualImportDialog v-model:visible="showImport" @imported="currentId && runMatch(currentId)" />
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.page-title { font-size: 18px; font-weight: 600; margin: 0; }
.toolbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.summary-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.summary-name { font-weight: 600; }
.summary-filters { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
.upload-tip { color: var(--el-text-color-secondary); font-size: 12px; }
:deep(.row-uncovered) { background: var(--el-color-danger-light-9); }
.col-filter-header { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.col-filter-select { width: 100%; }
/* 表头下拉不撑高表头：去掉 select 自带的最小高度感 */
.col-filter-header :deep(.el-select__wrapper) { min-height: 24px; font-weight: normal; }
</style>
