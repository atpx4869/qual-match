<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const title = computed(() => (route.meta.title as string) ?? '页面');
</script>

<template>
  <div class="placeholder-page">
    <h1 class="page-title">{{ title }}</h1>
    <el-empty :description="`${title} · 后续阶段实现`" />
  </div>
</template>

<style scoped>
.page-title { font-size: 18px; font-weight: 600; margin: 0; }
</style>
