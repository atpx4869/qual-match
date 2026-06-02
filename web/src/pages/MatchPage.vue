<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import type { UploadRawFile } from 'element-plus';
import {
  listWatchlists, createWatchlistFromCodes, createWatchlistFromExcel,
  deleteWatchlist, matchWatchlist, exportWatchlist,
  type WatchlistSummary, type MatchOutcome, type MatchResult,
} from '@/api/watchlist';
import CoverageTag from '@/components/CoverageTag.vue';
import QualImportDialog from '@/components/QualImportDialog.vue';

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

const filteredResults = computed<MatchResult[]>(() => {
  if (!outcome.value) return [];
  let rows = outcome.value.results;
  if (filterMode.value === 'uncovered') rows = rows.filter((r) => !r.matched);
  else if (filterMode.value === 'covered') rows = rows.filter((r) => r.matched);
  const kw = keyword.value.trim().toLowerCase();
  if (kw) rows = rows.filter((r) => r.stdCode.toLowerCase().includes(kw) || (r.stdName ?? '').toLowerCase().includes(kw));
  return rows;
});

const coverageRate = computed(() => {
  if (!outcome.value || outcome.value.total === 0) return 0;
  return Math.round((outcome.value.coveredCount / outcome.value.total) * 100);
});

async function refreshWatchlists() {
  try {
    watchlists.value = await listWatchlists();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载清单失败');
  }
}

async function runMatch(id: number) {
  loading.value = true;
  try {
    outcome.value = await matchWatchlist(id);
    currentId.value = id;
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

function rowClass({ row }: { row: MatchResult }) {
  return row.matched ? '' : 'row-uncovered';
}

onMounted(refreshWatchlists);
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
        <div class="summary-filters">
          <el-radio-group v-model="filterMode" size="small">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="covered">已覆盖</el-radio-button>
            <el-radio-button value="uncovered">未覆盖</el-radio-button>
          </el-radio-group>
          <el-input v-model="keyword" placeholder="筛选标准号/名称" clearable size="small" style="width: 180px" />
        </div>
      </div>

      <el-table :data="filteredResults" v-loading="loading" :row-class-name="rowClass" border stripe height="calc(100vh - 240px)">
        <el-table-column prop="stdCode" label="标准号" width="180" fixed />
        <el-table-column prop="stdName" label="标准名称" min-width="200" show-overflow-tooltip />
        <el-table-column label="省级CMA" width="130" align="center">
          <template #default="{ row }"><CoverageTag :coverage="row.provCma" /></template>
        </el-table-column>
        <el-table-column label="CNAS" width="130" align="center">
          <template #default="{ row }"><CoverageTag :coverage="row.cnas" /></template>
        </el-table-column>
        <el-table-column label="国家CMA" width="130" align="center">
          <template #default="{ row }"><CoverageTag :coverage="row.natCma" /></template>
        </el-table-column>
        <el-table-column label="是否覆盖" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.matched" type="success" size="small">已覆盖</el-tag>
            <el-tag v-else type="danger" size="small">未覆盖</el-tag>
          </template>
        </el-table-column>
      </el-table>
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
          <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="每行一个标准号，或用逗号/空格分隔&#10;GB/T 3325-2024&#10;GB 5009.3-2016" />
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
.upload-tip { color: var(--el-text-color-secondary); font-size: 12px; }
:deep(.row-uncovered) { background: var(--el-color-danger-light-9); }
</style>
