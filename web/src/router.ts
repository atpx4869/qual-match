import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import MatchPage from '@/pages/MatchPage.vue';
import PlaceholderPage from '@/pages/PlaceholderPage.vue';

// 阶段 0：仅清单匹配页有实体内容（含 health 连通性测试），其余三页为占位，
// 后续阶段（综合查询 / 资质管理 / 设置）逐步实现。
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/match' },
  { path: '/match', name: 'match', component: MatchPage, meta: { title: '清单匹配' } },
  { path: '/search', name: 'search', component: PlaceholderPage, meta: { title: '综合查询' } },
  { path: '/sources', name: 'sources', component: PlaceholderPage, meta: { title: '资质管理' } },
  { path: '/settings', name: 'settings', component: PlaceholderPage, meta: { title: '设置' } },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
