<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import {
  getOverview, getSettings, updateSettings, downloadBackup,
  DATA_ORIGIN_LABEL, type SystemOverview, type SystemSettings,
} from '@/api/system';

const overview = ref<SystemOverview | null>(null);
const overviewLoading = ref(false);

const settings = reactive<SystemSettings>({
  cnasChromePath: '',
  cnasThrottleMs: 1500,
  natCmaEnabled: false,
  natCmaChromePath: '',
  natCmaThrottleMs: 1500,
});
const settingsLoading = ref(false);
const saving = ref(false);
const backuping = ref(false);

function originLabel(origin: string | null): string {
  if (!origin) return '—';
  return DATA_ORIGIN_LABEL[origin] ?? origin;
}

function fmtTime(t: string | null): string {
  return t && t.trim() ? t : '—';
}

async function loadOverview() {
  overviewLoading.value = true;
  try {
    overview.value = await getOverview();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载总览失败');
  } finally {
    overviewLoading.value = false;
  }
}

async function loadSettings() {
  settingsLoading.value = true;
  try {
    const s = await getSettings();
    settings.cnasChromePath = s.cnasChromePath;
    settings.cnasThrottleMs = s.cnasThrottleMs;
    settings.natCmaEnabled = s.natCmaEnabled;
    settings.natCmaChromePath = s.natCmaChromePath;
    settings.natCmaThrottleMs = s.natCmaThrottleMs;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载设置失败');
  } finally {
    settingsLoading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  try {
    const s = await updateSettings({
      cnasChromePath: settings.cnasChromePath,
      cnasThrottleMs: settings.cnasThrottleMs,
      natCmaEnabled: settings.natCmaEnabled,
      natCmaChromePath: settings.natCmaChromePath,
      natCmaThrottleMs: settings.natCmaThrottleMs,
    });
    settings.cnasChromePath = s.cnasChromePath;
    settings.cnasThrottleMs = s.cnasThrottleMs;
    settings.natCmaEnabled = s.natCmaEnabled;
    settings.natCmaChromePath = s.natCmaChromePath;
    settings.natCmaThrottleMs = s.natCmaThrottleMs;
    ElMessage.success('设置已保存');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function onBackup() {
  backuping.value = true;
  try {
    await downloadBackup();
    ElMessage.success('备份已开始下载');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '备份失败');
  } finally {
    backuping.value = false;
  }
}

onMounted(() => {
  void loadOverview();
  void loadSettings();
});
</script>

<template>
  <div class="settings-page">
    <h1 class="page-title">设置</h1>

    <!-- A 数据总览（只读） -->
    <el-card v-loading="overviewLoading" class="block" shadow="never">
      <template #header><span class="block-title">数据总览</span></template>
      <el-row v-if="overview" :gutter="16">
        <el-col
          v-for="src in overview.orgSources"
          :key="src.source"
          :xs="24" :sm="12" :md="8"
        >
          <div class="stat-card">
            <div class="stat-label">{{ src.label }}</div>
            <div class="stat-num">{{ src.count.toLocaleString() }}</div>
            <div class="stat-meta">
              <el-tag size="small" type="info">{{ originLabel(src.dataOrigin) }}</el-tag>
              <span class="stat-time">{{ fmtTime(src.lastSyncAt) }}</span>
            </div>
          </div>
        </el-col>

        <el-col :xs="24" :sm="12" :md="8">
          <div class="stat-card">
            <div class="stat-label">一单一库（能力库）</div>
            <div class="stat-num">{{ overview.capLib.total.toLocaleString() }}</div>
            <div class="stat-meta">
              <el-tag size="small">在库 {{ overview.capLib.active.toLocaleString() }}</el-tag>
              <el-tag size="small" type="success">订阅 {{ overview.capLib.subscribedDomains }} 领域</el-tag>
            </div>
            <div class="stat-time">{{ fmtTime(overview.capLib.lastSyncedAt) }}</div>
          </div>
        </el-col>

        <el-col :xs="24" :sm="12" :md="8">
          <div class="stat-card">
            <div class="stat-label">标准清单</div>
            <div class="stat-num">{{ overview.watchlists.lists.toLocaleString() }}</div>
            <div class="stat-meta">
              <el-tag size="small" type="info">共 {{ overview.watchlists.items.toLocaleString() }} 条标准</el-tag>
            </div>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <!-- B 设置表单 -->
    <el-card v-loading="settingsLoading" class="block" shadow="never">
      <template #header><span class="block-title">在线抓取设置</span></template>
      <el-form label-width="160px" style="max-width: 640px">
        <el-form-item label="CNAS 浏览器路径">
          <el-input
            v-model="settings.cnasChromePath"
            placeholder="留空则用环境变量 CNAS_CHROME_PATH 或 playwright 自带 chromium"
            clearable
          />
          <div class="form-hint">指向现成 chrome.exe，免下载 playwright 浏览器。改后需重启服务生效。</div>
        </el-form-item>
        <el-form-item label="翻页节流下限">
          <el-input-number
            v-model="settings.cnasThrottleMs"
            :min="0" :max="60000" :step="500"
          />
          <span class="form-unit">毫秒</span>
          <div class="form-hint">CNAS 反爬节流，每页实际等待 = 此值 + 随机 0~2000ms。默认 1500。</div>
        </el-form-item>
        <el-divider />
        <el-form-item label="国家 CMA 抓取">
          <el-switch
            v-model="settings.natCmaEnabled"
            active-text="开启"
            inactive-text="关闭"
          />
          <div class="form-hint">国家 CMA 需要滑块校验，默认关闭；开启后资质管理页可搜索、订阅并同步。</div>
        </el-form-item>
        <el-form-item label="国家 CMA 浏览器路径">
          <el-input
            v-model="settings.natCmaChromePath"
            placeholder="留空则用 NAT_CMA_CHROME_PATH，再回退 CNAS 浏览器路径"
            clearable
          />
          <div class="form-hint">可指向现成 chrome.exe；留空时会复用 CNAS 浏览器配置。</div>
        </el-form-item>
        <el-form-item label="国家 CMA 节流下限">
          <el-input-number
            v-model="settings.natCmaThrottleMs"
            :min="0" :max="60000" :step="500"
          />
          <span class="form-unit">毫秒</span>
          <div class="form-hint">用于国家 CMA 场所/能力分页抓取，默认 1500。</div>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="saveSettings">保存设置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- C 全库备份 -->
    <el-card class="block" shadow="never">
      <template #header><span class="block-title">数据备份</span></template>
      <p class="backup-desc">导出当前完整数据库（sqlite 一致快照），可用于备份或迁移。</p>
      <el-button :loading="backuping" @click="onBackup">下载全库备份</el-button>
    </el-card>
  </div>
</template>

<style scoped>
.page-title { font-size: 18px; font-weight: 600; margin: 0 0 16px; }
.block { margin-bottom: 16px; }
.block-title { font-weight: 600; }
.stat-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 16px;
}
.stat-label { font-size: 13px; color: var(--el-text-color-secondary); }
.stat-num { font-size: 28px; font-weight: 700; line-height: 1.4; }
.stat-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.stat-time { font-size: 12px; color: var(--el-text-color-placeholder); }
.form-hint { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; margin-top: 4px; }
.form-unit { margin-left: 8px; color: var(--el-text-color-secondary); }
.backup-desc { color: var(--el-text-color-secondary); margin: 0 0 12px; }
</style>
