<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Document, Search, Files, Setting } from '@element-plus/icons-vue';

const route = useRoute();
const activeMenu = computed(() => route.path);
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="200px" class="app-aside">
      <div class="app-brand">qual-match</div>
      <el-menu :default-active="activeMenu" router :collapse="false">
        <el-menu-item index="/match">
          <el-icon><Document /></el-icon>
          <span>清单匹配</span>
        </el-menu-item>
        <el-menu-item index="/search">
          <el-icon><Search /></el-icon>
          <span>综合查询</span>
        </el-menu-item>
        <el-menu-item index="/sources">
          <el-icon><Files /></el-icon>
          <span>资质管理</span>
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon><Setting /></el-icon>
          <span>设置</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
.app-shell { height: 100vh; }
.app-aside { border-right: 1px solid var(--el-border-color-light); }
.app-brand {
  font-size: 18px;
  font-weight: 600;
  padding: 18px 20px;
  color: var(--el-color-primary);
}
.app-aside .el-menu { border-right: none; }
.app-main { padding: 24px; background: var(--el-bg-color-page); }
</style>
