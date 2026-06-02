<script setup lang="ts">
import { computed } from 'vue';
import type { SourceCoverage } from '@/api/watchlist';

const props = defineProps<{ coverage: SourceCoverage }>();

// 状态 → 标签类型/文案（色板单一真相源）
const tag = computed(() => {
  const c = props.coverage;
  if (c.covered) return { type: 'success' as const, text: '✓ 有' };
  if (c.seriesHint) return { type: 'warning' as const, text: '~ 仅其他年版' };
  return { type: 'info' as const, text: '— 无' };
});

const tooltip = computed(() => {
  const c = props.coverage;
  if (c.covered && c.testParams.length) return `检测项目：${c.testParams.join('；')}`;
  if (c.seriesHint && c.seriesCodes.length) return `本机构持有其他年版：${c.seriesCodes.join('、')}（不等于覆盖该年版）`;
  return '';
});
</script>

<template>
  <el-tooltip v-if="tooltip" :content="tooltip" placement="top">
    <el-tag :type="tag.type" size="small" effect="light">{{ tag.text }}</el-tag>
  </el-tooltip>
  <el-tag v-else :type="tag.type" size="small" effect="light">{{ tag.text }}</el-tag>
</template>
