<script setup lang="ts">
import { computed } from 'vue';
import type { CapLibStatus } from '@/api/cap-lib';

const props = defineProps<{ capLib: CapLibStatus }>();

// 5 档状态 → 标签类型/文案（色板单一真相源）
const META: Record<CapLibStatus['status'], { type: 'success' | 'warning' | 'danger' | 'info'; text: string }> = {
  in_lib:      { type: 'success', text: '🟢 在库' },
  cite_only:   { type: 'warning', text: '🟡 仅引用' },
  abolished:   { type: 'warning', text: '🟠 已废止' },
  series_only: { type: 'danger',  text: '🔴 仅系列' },
  not_in_lib:  { type: 'info',    text: '⚪ 不在库' },
};

const meta = computed(() => META[props.capLib.status]);

const tooltip = computed(() => {
  const c = props.capLib;
  if (c.stale) return '一单一库尚未同步，状态不可信 —— 请先到「资质管理」同步领域';
  if (c.status === 'in_lib' || c.status === 'cite_only' || c.status === 'abolished') {
    const parts = [`领域：${c.libDomain}`];
    if (c.libRemark) parts.push(`备注：${c.libRemark}`);
    return parts.join('\n');
  }
  if (c.status === 'series_only' && c.seriesNewCode) return `库内现行年版：${c.seriesNewCode}（不等于本号在库）`;
  return '该标准号不在能力项目库内';
});
</script>

<template>
  <el-tooltip :content="tooltip" placement="top">
    <el-tag :type="meta.type" size="small" effect="light" :class="{ stale: capLib.stale }">{{ meta.text }}</el-tag>
  </el-tooltip>
</template>

<style scoped>
.stale { opacity: 0.55; }
</style>
