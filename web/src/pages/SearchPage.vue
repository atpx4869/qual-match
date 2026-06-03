<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import {
  searchQualifications, searchByStandard, exportQualifications,
  SOURCE_LABEL,
  type OrgSource, type QualSearchRow, type QualStandardGroup,
} from '@/api/qualification';

const SOURCE_OPTIONS: { value: OrgSource; label: string }[] = [
  { value: 'prov_cma', label: SOURCE_LABEL.prov_cma },
  { value: 'cnas', label: SOURCE_LABEL.cnas },
  { value: 'nat_cma', label: SOURCE_LABEL.nat_cma },
];

// 查询条件
const q = ref('');
const sources = ref<OrgSource[]>([]);          // 空 = 全部
const viewMode = ref<'rows' | 'grouped'>('rows');
const page = ref(1);
const pageSize = ref(50);

// 结果
const loading = ref(false);
const searched = ref(false);
const rows = ref<QualSearchRow[]>([]);
const groups = ref<QualStandardGroup[]>([]);
const total = ref(0);

const sourceTagType = (s: OrgSource) =>
  s === 'prov_cma' ? 'success' : s === 'cnas' ? 'warning' : 'primary';

async function doSearch(resetPage = true) {
  if (!q.value.trim()) { ElMessage.warning('请输入查询关键词或标准号'); return; }
  if (resetPage) page.value = 1;
  loading.value = true;
  try {
    const params = { q: q.value.trim(), sources: sources.value, page: page.value, pageSize: pageSize.value };
    if (viewMode.value === 'rows') {
      const res = await searchQualifications(params);
      rows.value = res.rows;
      total.value = res.total;
    } else {
      const res = await searchByStandard(params);
      groups.value = res.groups;
      total.value = res.total;
    }
    searched.value = true;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '查询失败');
  } finally {
    loading.value = false;
  }
}

// 切换视图 / 翻页时重查（保持关键词）
function onViewChange() { if (searched.value) doSearch(true); }
function onPageChange(p: number) { page.value = p; doSearch(false); }

async function onExport() {
  if (!q.value.trim()) { ElMessage.warning('请先查询'); return; }
  try {
    await exportQualifications(q.value.trim(), sources.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导出失败');
  }
}

const emptyHint = computed(() => (searched.value ? '没有命中任何资质' : '输入标准号或关键词，查询本机构资质库'));
</script>

<template>
  <div class="search-page">
    <div class="toolbar">
      <h1 class="page-title">综合查询</h1>
    </div>

    <div class="query-bar">
      <el-input
        v-model="q" placeholder="标准号 / 标准名 / 检测项目" clearable style="width: 320px"
        @keyup.enter="doSearch(true)"
      />
      <el-select v-model="sources" multiple collapse-tags placeholder="全部资质源" style="width: 240px">
        <el-option v-for="o in SOURCE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-button type="primary" :loading="loading" @click="doSearch(true)">查询</el-button>
      <el-radio-group v-model="viewMode" @change="onViewChange">
        <el-radio-button value="rows">行级列表</el-radio-button>
        <el-radio-button value="grouped">按标准号聚合</el-radio-button>
      </el-radio-group>
      <el-button :disabled="!searched || total === 0" @click="onExport" style="margin-left: auto">导出</el-button>
    </div>

    <div v-if="searched" class="result-summary">
      <el-tag type="info">{{ viewMode === 'rows' ? `共 ${total} 行` : `共 ${total} 个标准号` }}</el-tag>
    </div>

    <el-empty v-if="searched && total === 0" :description="emptyHint" />
    <el-empty v-else-if="!searched" :description="emptyHint" />

    <!-- 行级列表 -->
    <template v-if="searched && total > 0 && viewMode === 'rows'">
      <el-table :data="rows" v-loading="loading" border stripe height="calc(100vh - 280px)">
        <el-table-column label="资质源" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="sourceTagType(row.source)" size="small">{{ SOURCE_LABEL[row.source as OrgSource] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="stdCode" label="标准号" width="180" />
        <el-table-column prop="stdName" label="标准名称" min-width="200" show-overflow-tooltip />
        <el-table-column prop="testParam" label="检测项目" min-width="200" show-overflow-tooltip />
        <el-table-column prop="category" label="类别" width="140" show-overflow-tooltip />
      </el-table>
    </template>

    <!-- 按标准号聚合 -->
    <template v-if="searched && total > 0 && viewMode === 'grouped'">
      <el-table :data="groups" v-loading="loading" border stripe row-key="stdCodeNorm" height="calc(100vh - 280px)">
        <el-table-column type="expand">
          <template #default="{ row }">
            <el-table :data="row.rows" size="small" border style="margin: 8px 24px">
              <el-table-column label="资质源" width="110" align="center">
                <template #default="{ row: r }">
                  <el-tag :type="sourceTagType(r.source)" size="small">{{ SOURCE_LABEL[r.source as OrgSource] }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="stdCode" label="标准号" width="180" />
              <el-table-column prop="testParam" label="检测项目" min-width="200" show-overflow-tooltip />
              <el-table-column prop="category" label="类别" width="140" show-overflow-tooltip />
            </el-table>
          </template>
        </el-table-column>
        <el-table-column prop="stdCode" label="标准号" width="200" />
        <el-table-column prop="stdName" label="标准名称" min-width="220" show-overflow-tooltip />
        <el-table-column label="覆盖资质源" min-width="220">
          <template #default="{ row }">
            <el-tag
              v-for="s in row.sources" :key="s" :type="sourceTagType(s)" size="small" style="margin-right: 4px"
            >{{ SOURCE_LABEL[s as OrgSource] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="行数" width="80" align="center">
          <template #default="{ row }">{{ row.rows.length }}</template>
        </el-table-column>
      </el-table>
    </template>

    <div v-if="searched && total > pageSize" class="pager">
      <el-pagination
        layout="prev, pager, next, total" :total="total" :page-size="pageSize" :current-page="page"
        @current-change="onPageChange"
      />
    </div>
  </div>
</template>

<style scoped>
.toolbar { margin-bottom: 16px; }
.page-title { font-size: 18px; font-weight: 600; margin: 0; }
.query-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.result-summary { margin-bottom: 12px; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>


