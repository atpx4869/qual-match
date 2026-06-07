<script setup lang="ts">
import { computed } from 'vue';
import type { SyncProgress } from '@/api/cap-lib';

const props = defineProps<{ progress: SyncProgress }>();

const PHASE_TEXT: Record<SyncProgress['phase'], string> = {
  pending: '排队中',
  fetching: '拉取中',
  upserting: '入库中',
  done: '已完成',
  error: '失败',
};

const percent = computed(() => {
  const p = props.progress;
  if (p.phase === 'done') return 100;
  if (!p.total) return 0;
  return Math.min(99, Math.round((p.current / p.total) * 100));
});

const status = computed(() => {
  if (props.progress.phase === 'error') return 'exception';
  if (props.progress.phase === 'done') return 'success';
  return undefined;
});

const label = computed(() => {
  const p = props.progress;
  const phase = PHASE_TEXT[p.phase];
  if (p.phase === 'error') return `${phase}：${p.error ?? ''}`;
  if (p.phase === 'done' && p.stats) {
    const s = p.stats;
    return `${phase} · 新增 ${s.added}、变更 ${s.changed}、未变 ${s.unchanged}、软删 ${s.removedSoft}`;
  }
  if (!p.total) return `${phase} · 正在获取总量`;
  return `${phase} ${p.current}/${p.total || '?'}`;
});
</script>

<template>
  <div class="sync-progress">
    <el-progress :percentage="percent" :status="status" :stroke-width="14" />
    <div class="sync-label">{{ label }}</div>
  </div>
</template>

<style scoped>
.sync-progress { min-width: 240px; }
.sync-label { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px; }
</style>
