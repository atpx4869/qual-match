<script setup lang="ts">
import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  listCapLibDomains, setCapLibSubscribed, startCapLibSync, getCapLibSyncProgress, cleanupCapLib,
  type DomainMeta, type SyncProgress,
} from '@/api/cap-lib';
import {
  searchProvCma, syncProvCma, syncSubscribedProvCma, subscribeProvCma,
  listCnasPresets, syncCnas, syncSubscribedCnas, subscribeCnas,
  getSourceSyncProgress, getSourceOrg,
  type ProvCmaSearchResult, type CnasPreset, type SourceOrgState, type OrgSource,
} from '@/api/sources';
import SyncProgressBar from '@/components/SyncProgress.vue';

const activeTab = ref<'cap_lib' | 'prov_cma' | 'cnas' | 'nat_cma'>('cap_lib');

// 一单一库
const domains = ref<DomainMeta[]>([]);
const loading = ref(false);
// domain → 进行中的 SyncProgress（轮询）
const progressMap = ref<Record<string, SyncProgress>>({});
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

async function refreshDomains() {
  loading.value = true;
  try {
    const res = await listCapLibDomains();
    domains.value = res.items;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载领域失败');
  } finally {
    loading.value = false;
  }
}

async function onToggleSubscribe(d: DomainMeta) {
  try {
    await setCapLibSubscribed(d.domain, !d.subscribed);
    await refreshDomains();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

async function onSync(d: DomainMeta) {
  try {
    const { jobId } = await startCapLibSync(d.domain);
    pollProgress(d.domain, jobId);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '同步启动失败');
  }
}

function pollProgress(domain: string, jobId: string) {
  // 清掉该领域旧轮询
  const old = pollTimers.get(domain);
  if (old) clearInterval(old);

  const timer = setInterval(async () => {
    try {
      const p = await getCapLibSyncProgress(jobId);
      progressMap.value = { ...progressMap.value, [domain]: p };
      if (p.phase === 'done' || p.phase === 'error') {
        clearInterval(timer);
        pollTimers.delete(domain);
        if (p.phase === 'done') ElMessage.success(`「${domain}」同步完成`);
        else ElMessage.error(`「${domain}」同步失败：${p.error ?? ''}`);
        await refreshDomains();
        // 保留进度条几秒再清
        setTimeout(() => {
          const { [domain]: _, ...rest } = progressMap.value;
          progressMap.value = rest;
        }, 4000);
      }
    } catch {
      clearInterval(timer);
      pollTimers.delete(domain);
    }
  }, 1000);
  pollTimers.set(domain, timer);
}

async function onCleanup() {
  try {
    await ElMessageBox.confirm('清理 30 天未再出现的孤儿行（软删除残留）？', '确认', { type: 'warning' });
  } catch { return; }
  try {
    const { deleted } = await cleanupCapLib(30);
    ElMessage.success(`已清理 ${deleted} 行`);
    await refreshDomains();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '清理失败');
  }
}

function fmtTime(s: string): string {
  return s ? s.replace('T', ' ').slice(0, 19) : '从未';
}

function fmtNullableTime(s: string | null | undefined): string {
  return s ? fmtTime(s) : '从未';
}

const DATA_ORIGIN_LABEL: Record<string, string> = {
  subscribed: '已订阅',
  scraped: '在线抓取',
  manual: '手工导入',
};

const SYNC_STATUS_LABEL: Record<string, string> = {
  pending: '待同步',
  syncing: '同步中',
  success: '成功',
  error: '失败',
};

const cmaOrg = ref<SourceOrgState | null>(null);
const cnasOrg = ref<SourceOrgState | null>(null);
const sourceLoading = ref(false);

async function refreshSourceOrgs() {
  sourceLoading.value = true;
  try {
    const [prov, cnas] = await Promise.all([
      getSourceOrg('prov_cma'),
      getSourceOrg('cnas'),
    ]);
    cmaOrg.value = prov;
    cnasOrg.value = cnas;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载本地存量失败');
  } finally {
    sourceLoading.value = false;
  }
}

function originLabel(v: string | null | undefined): string {
  if (!v) return '未订阅';
  return DATA_ORIGIN_LABEL[v] ?? v;
}

function statusLabel(v: string | null | undefined): string {
  if (!v) return '待同步';
  return SYNC_STATUS_LABEL[v] ?? v;
}

function statusTagType(v: string | null | undefined) {
  if (v === 'success') return 'success';
  if (v === 'error') return 'danger';
  if (v === 'syncing') return 'warning';
  return 'info';
}

function isCmaSubscribed(r: ProvCmaSearchResult): boolean {
  return cmaOrg.value?.lab?.sourceRef === r.publicDetailId;
}

// ─── 省级 CMA ──
const cmaQuery = ref('');
const cmaSearching = ref(false);
const cmaResults = ref<ProvCmaSearchResult[]>([]);
const cmaProgress = ref<SyncProgress | null>(null);
let cmaTimer: ReturnType<typeof setInterval> | null = null;

async function doCmaSearch() {
  if (!cmaQuery.value.trim()) { ElMessage.warning('请输入机构名'); return; }
  cmaSearching.value = true;
  try {
    const res = await searchProvCma(cmaQuery.value.trim());
    cmaResults.value = res.items;
    if (res.total === 0) ElMessage.info('没有搜到机构');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '搜索失败');
  } finally {
    cmaSearching.value = false;
  }
}

async function doCmaSync(r: ProvCmaSearchResult) {
  try {
    await subscribeProvCma(r);
    await refreshSourceOrgs();
    const { jobId } = await syncProvCma(r.publicDetailId);
    pollSource('prov_cma', jobId, cmaProgress, cmaTimer, (t) => { cmaTimer = t; });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '抓取启动失败');
  }
}

async function doCmaSubscribe(r: ProvCmaSearchResult) {
  try {
    await subscribeProvCma(r);
    await refreshSourceOrgs();
    ElMessage.success('省级 CMA 机构已订阅');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '订阅失败');
  }
}

async function doCmaSyncSubscribed() {
  if (!cmaOrg.value?.lab?.sourceRef) { ElMessage.warning('请先订阅省级 CMA 机构'); return; }
  try {
    const { jobId } = await syncSubscribedProvCma();
    pollSource('prov_cma', jobId, cmaProgress, cmaTimer, (t) => { cmaTimer = t; });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '同步启动失败');
  }
}

// ─── CNAS ──
const cnasPresets = ref<CnasPreset[]>([]);
const cnasProgress = ref<SyncProgress | null>(null);
let cnasTimer: ReturnType<typeof setInterval> | null = null;

async function refreshCnasPresets() {
  try {
    const res = await listCnasPresets();
    cnasPresets.value = res.items;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载内置机构失败');
  }
}

async function doCnasSync(p: CnasPreset) {
  try {
    await subscribeCnas(p.labNo);
    await refreshSourceOrgs();
    await refreshCnasPresets();
    const { jobId } = await syncCnas(p.labNo);
    pollSource('cnas', jobId, cnasProgress, cnasTimer, (t) => { cnasTimer = t; });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '抓取启动失败');
  }
}

async function doCnasSubscribe(p: CnasPreset) {
  try {
    await subscribeCnas(p.labNo);
    await refreshSourceOrgs();
    await refreshCnasPresets();
    ElMessage.success('CNAS 机构已订阅');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '订阅失败');
  }
}

async function doCnasSyncSubscribed() {
  if (!cnasOrg.value?.lab?.sourceRef) { ElMessage.warning('请先订阅 CNAS 机构'); return; }
  try {
    const { jobId } = await syncSubscribedCnas();
    pollSource('cnas', jobId, cnasProgress, cnasTimer, (t) => { cnasTimer = t; });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '同步启动失败');
  }
}

/** 通用抓取进度轮询（省级 CMA / CNAS 共用，单任务串行）。 */
function pollSource(
  source: Extract<OrgSource, 'prov_cma' | 'cnas'>,
  jobId: string,
  slot: Ref<SyncProgress | null>,
  oldTimer: ReturnType<typeof setInterval> | null,
  setTimer: (t: ReturnType<typeof setInterval>) => void,
) {
  if (oldTimer) clearInterval(oldTimer);
  slot.value = { phase: 'pending', target: source, current: 0, total: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = async () => {
    try {
      const p = await getSourceSyncProgress(jobId);
      slot.value = p;
      if (p.phase === 'done' || p.phase === 'error') {
        if (timer) clearInterval(timer);
        if (p.phase === 'done') ElMessage.success(`抓取完成：${p.total} 条`);
        else ElMessage.error(`抓取失败：${p.error ?? ''}`);
        await refreshSourceOrgs();
        if (source === 'cnas') await refreshCnasPresets();
        setTimeout(() => { slot.value = null; }, 5000);
      }
    } catch {
      if (timer) clearInterval(timer);
    }
  };
  void tick();
  timer = setInterval(tick, 1500);
  setTimer(timer);
}

onMounted(() => { refreshDomains(); refreshSourceOrgs(); refreshCnasPresets(); });
onUnmounted(() => {
  for (const t of pollTimers.values()) clearInterval(t);
  if (cmaTimer) clearInterval(cmaTimer);
  if (cnasTimer) clearInterval(cnasTimer);
});
</script>

<template>
  <div class="sources-page">
    <h1 class="page-title">资质管理</h1>

    <el-tabs v-model="activeTab">
      <!-- 一单一库（本阶段实做）-->
      <el-tab-pane label="一单一库" name="cap_lib">
        <div class="tab-toolbar">
          <span class="hint">市场监管总局能力项目库 · 按领域订阅后同步到本地，匹配/查询自动比对 5 档状态</span>
          <el-button size="small" @click="onCleanup">清理孤儿行</el-button>
          <el-button size="small" @click="refreshDomains">刷新</el-button>
        </div>

        <el-table :data="domains" v-loading="loading" border stripe>
          <el-table-column prop="domain" label="领域" min-width="180" />
          <el-table-column label="订阅" width="90" align="center">
            <template #default="{ row }">
              <el-switch :model-value="row.subscribed" @change="() => onToggleSubscribe(row as DomainMeta)" />
            </template>
          </el-table-column>
          <el-table-column label="本地条数" width="110" align="center">
            <template #default="{ row }">{{ row.localTotal || 0 }}</template>
          </el-table-column>
          <el-table-column label="远端预估" width="110" align="center">
            <template #default="{ row }">{{ row.remoteTotal || row.approxCount }}</template>
          </el-table-column>
          <el-table-column label="上次同步" width="180">
            <template #default="{ row }">{{ fmtTime(row.lastSyncedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="280">
            <template #default="{ row }">
              <SyncProgressBar v-if="progressMap[row.domain]" :progress="progressMap[row.domain]" />
              <el-button v-else size="small" type="primary" @click="onSync(row as DomainMeta)">同步</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 省级 CMA（HTTP 抓取，搜机构 → 抓取入库到本机构）-->
      <el-tab-pane label="省级 CMA" name="prov_cma">
        <div class="tab-toolbar">
          <span class="hint">湖北省级 CMA 公示库 · 先订阅本机构，再同步能力明细入库（归本机构）</span>
          <el-button size="small" @click="refreshSourceOrgs">刷新本地状态</el-button>
          <el-button size="small" type="primary" :disabled="!cmaOrg?.lab?.sourceRef" @click="doCmaSyncSubscribed">同步订阅</el-button>
        </div>
        <div v-loading="sourceLoading" class="source-status">
          <div class="status-main">
            <div class="status-title">{{ cmaOrg?.lab?.labName || '未订阅省级 CMA 机构' }}</div>
            <div class="status-sub">
              <span>订阅标识：{{ cmaOrg?.lab?.sourceRef || '—' }}</span>
              <span>地区：{{ cmaOrg?.lab?.region || '—' }}</span>
              <span>上次同步：{{ fmtNullableTime(cmaOrg?.lab?.lastSyncAt) }}</span>
            </div>
          </div>
          <div class="status-metrics">
            <el-statistic title="本地明细" :value="cmaOrg?.localCount || 0" />
            <el-tag :type="statusTagType(cmaOrg?.lab?.syncStatus)">{{ statusLabel(cmaOrg?.lab?.syncStatus) }}</el-tag>
            <el-tag type="info">{{ originLabel(cmaOrg?.lab?.dataOrigin) }}</el-tag>
          </div>
        </div>
        <el-alert
          v-if="cmaOrg?.lab?.syncError"
          :title="cmaOrg.lab.syncError"
          type="error"
          show-icon
          :closable="false"
          class="source-error"
        />
        <SyncProgressBar v-if="cmaProgress" :progress="cmaProgress" style="margin-bottom: 12px" />
        <div class="query-bar">
          <el-input v-model="cmaQuery" placeholder="本机构名称，如 湖北省产品质量监督检验研究院" clearable
            style="width: 380px" @keyup.enter="doCmaSearch" />
          <el-button type="primary" :loading="cmaSearching" @click="doCmaSearch">搜索</el-button>
        </div>
        <el-table v-if="cmaResults.length" :data="cmaResults" border stripe>
          <el-table-column prop="sysName" label="机构名称" min-width="240" show-overflow-tooltip />
          <el-table-column prop="areaName" label="地区" width="120" />
          <el-table-column prop="majorCategory" label="大类" width="120" show-overflow-tooltip />
          <el-table-column prop="licState" label="状态" width="100" />
          <el-table-column label="订阅" width="100" align="center">
            <template #default="{ row }">
              <el-tag v-if="isCmaSubscribed(row as ProvCmaSearchResult)" type="success" size="small">当前</el-tag>
              <el-button v-else size="small" @click="doCmaSubscribe(row as ProvCmaSearchResult)">订阅</el-button>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="doCmaSync(row as ProvCmaSearchResult)">订阅并同步</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- CNAS（playwright 抓取，内置本机构）-->
      <el-tab-pane label="CNAS" name="cnas">
        <div class="tab-toolbar">
          <span class="hint">CNAS · 先订阅内置本机构，再同步能力明细；缺 Playwright 浏览器时会自动尝试本机 Chrome/Edge</span>
          <el-button size="small" @click="refreshCnasPresets">刷新</el-button>
          <el-button size="small" type="primary" :disabled="!cnasOrg?.lab?.sourceRef" @click="doCnasSyncSubscribed">同步订阅</el-button>
        </div>
        <div v-loading="sourceLoading" class="source-status">
          <div class="status-main">
            <div class="status-title">{{ cnasOrg?.lab?.labName || '未订阅 CNAS 机构' }}</div>
            <div class="status-sub">
              <span>实验室号：{{ cnasOrg?.lab?.sourceRef || '—' }}</span>
              <span>上次同步：{{ fmtNullableTime(cnasOrg?.lab?.lastSyncAt) }}</span>
            </div>
          </div>
          <div class="status-metrics">
            <el-statistic title="本地明细" :value="cnasOrg?.localCount || 0" />
            <el-tag :type="statusTagType(cnasOrg?.lab?.syncStatus)">{{ statusLabel(cnasOrg?.lab?.syncStatus) }}</el-tag>
            <el-tag type="info">{{ originLabel(cnasOrg?.lab?.dataOrigin) }}</el-tag>
          </div>
        </div>
        <el-alert
          v-if="cnasOrg?.lab?.syncError"
          :title="cnasOrg.lab.syncError"
          type="error"
          show-icon
          :closable="false"
          class="source-error"
        />
        <SyncProgressBar v-if="cnasProgress" :progress="cnasProgress" style="margin-bottom: 12px" />
        <el-table :data="cnasPresets" border stripe>
          <el-table-column prop="labName" label="机构名称" min-width="200" />
          <el-table-column prop="labNo" label="证书编号" width="120" />
          <el-table-column prop="note" label="备注" min-width="240" show-overflow-tooltip />
          <el-table-column label="本地条数" width="110" align="center">
            <template #default="{ row }">{{ row.syncedCount || 0 }}</template>
          </el-table-column>
          <el-table-column label="订阅" width="100" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.subscribed" type="success" size="small">当前</el-tag>
              <el-button v-else size="small" @click="doCnasSubscribe(row as CnasPreset)">订阅</el-button>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="doCnasSync(row as CnasPreset)">订阅并同步</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="国家 CMA" name="nat_cma">
        <el-empty description="国家 CMA · 阶段 5 接入（滑块已止损，走 Excel 导入降级）" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.page-title { font-size: 18px; font-weight: 600; margin: 0 0 16px; }
.tab-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.hint { color: var(--el-text-color-secondary); font-size: 13px; margin-right: auto; }
.query-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.source-status {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 14px 16px;
  margin-bottom: 12px;
  background: var(--el-bg-color);
  flex-wrap: wrap;
}
.status-main { min-width: 260px; }
.status-title { font-weight: 600; margin-bottom: 6px; }
.status-sub { display: flex; gap: 14px; flex-wrap: wrap; color: var(--el-text-color-secondary); font-size: 12px; }
.status-metrics { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.source-error { margin-bottom: 12px; }
</style>
