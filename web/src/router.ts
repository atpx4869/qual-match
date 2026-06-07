import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import MatchPage from '@/pages/MatchPage.vue';
import SearchPage from '@/pages/SearchPage.vue';
import SourcesPage from '@/pages/SourcesPage.vue';
import SettingsPage from '@/pages/SettingsPage.vue';

// 阶段 0/1：清单匹配；阶段 2：综合查询；阶段 3：资质管理（一单一库 tab 实做）；阶段 6：设置页。
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/match' },
  { path: '/match', name: 'match', component: MatchPage, meta: { title: '清单匹配' } },
  { path: '/search', name: 'search', component: SearchPage, meta: { title: '综合查询' } },
  { path: '/sources', name: 'sources', component: SourcesPage, meta: { title: '资质管理' } },
  { path: '/settings', name: 'settings', component: SettingsPage, meta: { title: '设置' } },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
