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
  searchNatCma, listNatCmaPlaces, syncNatCma, syncSubscribedNatCma, subscribeNatCma,
  getSourceSyncProgress, getSourceOrg, deleteLocalSource, listSubscribedNatCmaPlaces,
  type ProvCmaSearchResult, type CnasPreset, type NatCmaSearchResult, type NatCmaPlace,
  type NatCmaSubscribedPlace, type SourceOrgState, type OrgSource,
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
const natCmaOrg = ref<SourceOrgState | null>(null);
const natCmaSubscribedPlaces = ref<NatCmaSubscribedPlace[]>([]);
const sourceLoading = ref(false);

async function refreshSourceOrgs() {
  sourceLoading.value = true;
  try {
    const [prov, cnas, nat, natPlaces] = await Promise.all([
      getSourceOrg('prov_cma'),
      getSourceOrg('cnas'),
      getSourceOrg('nat_cma'),
      listSubscribedNatCmaPlaces(),
    ]);
    cmaOrg.value = prov;
    cnasOrg.value = cnas;
    natCmaOrg.value = nat;
    natCmaSubscribedPlaces.value = natPlaces.items;
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

async function onDeleteLocalSource(source: OrgSource, label: string) {
  try {
    await ElMessageBox.confirm(`删除「${label}」本地资质明细和订阅信息？此操作不可恢复。`, '确认删除', { type: 'warning' });
  } catch { return; }
  try {
    const res = await deleteLocalSource(source);
    ElMessage.success(`已删除 ${res.deletedRows} 条本地明细`);
    await refreshSourceOrgs();
    if (source === 'cnas') await refreshCnasPresets();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败');
  }
}

function parseNatCmaSourceRef(raw: string | null | undefined): Partial<NatCmaSearchResult> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<NatCmaSearchResult>;
  } catch {
    return null;
  }
}

function natCmaRefLabel(raw: string | null | undefined): string {
  const parsed = parseNatCmaSourceRef(raw);
  if (!parsed) return raw || '—';
  const placeCount = parsed.seeds?.length ? ` · ${parsed.seeds.length} 个场所` : '';
  return ([parsed.certCode, parsed.placeId].filter(Boolean).join(' / ') || '—') + placeCount;
}

function isNatCmaSubscribed(r: NatCmaSearchResult): boolean {
  const parsed = parseNatCmaSourceRef(natCmaOrg.value?.lab?.sourceRef);
  return parsed?.placeId === r.placeId && parsed?.applyId === r.applyId;
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

// ─── 国家 CMA ──
const natCmaQuery = ref('');
const natCmaSearching = ref(false);
const natCmaResults = ref<NatCmaSearchResult[]>([]);
const natCmaProgress = ref<SyncProgress | null>(null);
const natCmaPlaceDialogVisible = ref(false);
const natCmaPlaceLoading = ref(false);
const natCmaPlaceOrg = ref<NatCmaSearchResult | null>(null);
const natCmaPlaces = ref<NatCmaPlace[]>([]);
const natCmaSelectedPlaces = ref<NatCmaPlace[]>([]);
let natCmaTimer: ReturnType<typeof setInterval> | null = null;

async function doNatCmaSearch() {
  if (!natCmaQuery.value.trim()) { ElMessage.warning('请输入机构名'); return; }
  natCmaSearching.value = true;
  try {
    const res = await searchNatCma(natCmaQuery.value.trim());
    natCmaResults.value = res.items;
    if (res.total === 0) ElMessage.info('没有搜到机构');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '搜索失败');
  } finally {
    natCmaSearching.value = false;
  }
}

function withSelectedNatCmaPlaces(): NatCmaSearchResult | null {
  const org = natCmaPlaceOrg.value;
  if (!org) return null;
  if (!natCmaSelectedPlaces.value.length) {
    ElMessage.warning('请至少选择一个场所');
    return null;
  }
  return {
    ...org,
    seeds: natCmaSelectedPlaces.value.map((p) => ({
      placeId: p.placeId,
      applyId: org.applyId,
      address: p.placeAddress,
      placeAttr: p.placeAttr,
      placeName: p.placeName,
      placeAddress: p.placeAddress,
    })),
  };
}

function onNatCmaPlaceSelectionChange(rows: NatCmaPlace[]) {
  natCmaSelectedPlaces.value = rows;
}

async function openNatCmaPlaces(r: NatCmaSearchResult) {
  natCmaPlaceOrg.value = r;
  natCmaPlaces.value = [];
  natCmaSelectedPlaces.value = [];
  natCmaPlaceDialogVisible.value = true;
  natCmaPlaceLoading.value = true;
  try {
    const res = await listNatCmaPlaces(r);
    natCmaPlaces.value = res.items;
    if (!res.items.length) ElMessage.warning('该机构未返回场所列表');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载场所失败');
  } finally {
    natCmaPlaceLoading.value = false;
  }
}

async function doNatCmaSync(r: NatCmaSearchResult) {
  try {
    await subscribeNatCma(r);
    await refreshSourceOrgs();
    const { jobId } = await syncNatCma(r);
    pollSource('nat_cma', jobId, natCmaProgress, natCmaTimer, (t) => { natCmaTimer = t; });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '抓取启动失败');
  }
}

async function doNatCmaSubscribe(r: NatCmaSearchResult) {
  try {
    await subscribeNatCma(r);
    await refreshSourceOrgs();
    ElMessage.success('国家 CMA 机构已订阅');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '订阅失败');
  }
}

async function doNatCmaSubscribeSelected() {
  const item = withSelectedNatCmaPlaces();
  if (!item) return;
  await doNatCmaSubscribe(item);
  natCmaPlaceDialogVisible.value = false;
}

async function doNatCmaSyncSelected() {
  const item = withSelectedNatCmaPlaces();
  if (!item) return;
  await doNatCmaSync(item);
  natCmaPlaceDialogVisible.value = false;
}

async function doNatCmaSyncSubscribed() {
  if (!natCmaOrg.value?.lab?.sourceRef) { ElMessage.warning('请先订阅国家 CMA 机构'); return; }
  try {
    const { jobId } = await syncSubscribedNatCma();
    pollSource('nat_cma', jobId, natCmaProgress, natCmaTimer, (t) => { natCmaTimer = t; });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '同步启动失败');
  }
}

/** 通用抓取进度轮询（省级 CMA / CNAS / 国家 CMA 共用，单任务串行）。 */
function pollSource(
  source: OrgSource,
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
  if (natCmaTimer) clearInterval(natCmaTimer);
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
          <el-button size="small" type="danger" plain :disabled="!cmaOrg?.lab && !cmaOrg?.localCount" @click="onDeleteLocalSource('prov_cma', '省级 CMA')">删除本地资质</el-button>
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
          <el-button size="small" type="danger" plain :disabled="!cnasOrg?.lab && !cnasOrg?.localCount" @click="onDeleteLocalSource('cnas', 'CNAS')">删除本地资质</el-button>
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
        <div class="tab-toolbar">
          <span class="hint">国家 CMA 认可能力库 · 需先在设置页开启在线抓取，再按机构订阅并同步</span>
          <el-button size="small" @click="refreshSourceOrgs">刷新本地状态</el-button>
          <el-button size="small" type="primary" :disabled="!natCmaOrg?.lab?.sourceRef" @click="doNatCmaSyncSubscribed">同步订阅</el-button>
          <el-button size="small" type="danger" plain :disabled="!natCmaOrg?.lab && !natCmaOrg?.localCount" @click="onDeleteLocalSource('nat_cma', '国家 CMA')">删除本地资质</el-button>
        </div>
        <div v-loading="sourceLoading" class="source-status">
          <div class="status-main">
            <div class="status-title">{{ natCmaOrg?.lab?.labName || '未订阅国家 CMA 机构' }}</div>
            <div class="status-sub">
              <span>订阅标识：{{ natCmaRefLabel(natCmaOrg?.lab?.sourceRef) }}</span>
              <span>地址：{{ natCmaOrg?.lab?.region || '—' }}</span>
              <span>上次同步：{{ fmtNullableTime(natCmaOrg?.lab?.lastSyncAt) }}</span>
            </div>
          </div>
          <div class="status-metrics">
            <el-statistic title="本地明细" :value="natCmaOrg?.localCount || 0" />
            <el-tag :type="statusTagType(natCmaOrg?.lab?.syncStatus)">{{ statusLabel(natCmaOrg?.lab?.syncStatus) }}</el-tag>
            <el-tag type="info">{{ originLabel(natCmaOrg?.lab?.dataOrigin) }}</el-tag>
          </div>
        </div>
        <el-alert
          v-if="natCmaOrg?.lab?.syncError"
          :title="natCmaOrg.lab.syncError"
          type="error"
          show-icon
          :closable="false"
          class="source-error"
        />
        <SyncProgressBar v-if="natCmaProgress" :progress="natCmaProgress" style="margin-bottom: 12px" />
        <el-table
          v-if="natCmaSubscribedPlaces.length"
          :data="natCmaSubscribedPlaces"
          border
          stripe
          class="subscribed-place-table"
        >
          <el-table-column prop="placeAttr" label="类型" width="100" />
          <el-table-column prop="placeName" label="已订阅场所" min-width="180" show-overflow-tooltip />
          <el-table-column prop="placeAddress" label="场所地址" min-width="240" show-overflow-tooltip />
          <el-table-column prop="localCount" label="本地资质条数" width="130" align="center" />
        </el-table>
        <div class="query-bar">
          <el-input v-model="natCmaQuery" placeholder="本机构名称，如 湖北省产品质量监督检验研究院" clearable
            style="width: 380px" @keyup.enter="doNatCmaSearch" />
          <el-button type="primary" :loading="natCmaSearching" @click="doNatCmaSearch">搜索</el-button>
        </div>
        <el-table v-if="natCmaResults.length" :data="natCmaResults" border stripe>
          <el-table-column prop="orgName" label="机构名称" min-width="240" show-overflow-tooltip />
          <el-table-column prop="certCode" label="证书编号" width="150" show-overflow-tooltip />
          <el-table-column prop="address" label="地址" min-width="220" show-overflow-tooltip />
          <el-table-column label="候选入口" width="100" align="center">
            <template #default="{ row }">{{ (row as NatCmaSearchResult).seeds?.length || 1 }}</template>
          </el-table-column>
          <el-table-column label="订阅" width="100" align="center">
            <template #default="{ row }">
              <el-tag v-if="isNatCmaSubscribed(row as NatCmaSearchResult)" type="success" size="small">当前</el-tag>
              <span v-else>—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="openNatCmaPlaces(row as NatCmaSearchResult)">选择场所</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-dialog
          v-model="natCmaPlaceDialogVisible"
          title="订阅国家 CMA 场所"
          width="760px"
        >
          <div class="dialog-summary">
            <div class="status-title">{{ natCmaPlaceOrg?.orgName }}</div>
            <div class="status-sub">
              <span>证书编号：{{ natCmaPlaceOrg?.certCode || '—' }}</span>
              <span>机构地址：{{ natCmaPlaceOrg?.address || '—' }}</span>
            </div>
          </div>
          <el-table
            :data="natCmaPlaces"
            v-loading="natCmaPlaceLoading"
            border
            stripe
            max-height="420"
            @selection-change="onNatCmaPlaceSelectionChange"
          >
            <el-table-column type="selection" width="48" />
            <el-table-column prop="placeAttr" label="类型" width="100" />
            <el-table-column prop="placeName" label="场所名称" min-width="180" show-overflow-tooltip />
            <el-table-column prop="placeAddress" label="场所地址" min-width="240" show-overflow-tooltip />
          </el-table>
          <template #footer>
            <el-button @click="natCmaPlaceDialogVisible = false">取消</el-button>
            <el-button :disabled="!natCmaSelectedPlaces.length" @click="doNatCmaSubscribeSelected">订阅场所</el-button>
            <el-button type="primary" :disabled="!natCmaSelectedPlaces.length" @click="doNatCmaSyncSelected">订阅并同步</el-button>
          </template>
        </el-dialog>
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
.dialog-summary { margin-bottom: 12px; }
.subscribed-place-table { margin-bottom: 12px; }
</style>
