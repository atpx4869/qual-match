import { apiGet, apiPost } from './client';
import type { SyncProgress } from './cap-lib';

// ─── 类型 ──────────────────────────────────────────────────────────────────

export interface ProvCmaSearchResult {
  publicDetailId: string;
  sysName: string;
  areaName: string;
  majorCategory: string;
  licState: string;
}

export interface CnasPreset {
  labName: string;
  labNo: string;
  note: string;
  syncedCount: number;
}

// 复用 cap-lib 的 SyncProgress 类型（target/phase/current/total/error）
export type { SyncProgress };

// ─── API ───────────────────────────────────────────────────────────────────

export function searchProvCma(q: string): Promise<{ items: ProvCmaSearchResult[]; total: number }> {
  return apiGet(`/api/sources/prov_cma/search?q=${encodeURIComponent(q)}`);
}

export function syncProvCma(publicDetailId: string): Promise<{ jobId: string }> {
  return apiPost('/api/sources/prov_cma/sync', { publicDetailId });
}

export function listCnasPresets(): Promise<{ items: CnasPreset[] }> {
  return apiGet('/api/sources/cnas/presets');
}

export function syncCnas(labNo: string): Promise<{ jobId: string }> {
  return apiPost('/api/sources/cnas/sync', { labNo });
}

export function getSourceSyncProgress(jobId: string): Promise<SyncProgress> {
  return apiGet(`/api/sources/sync-progress/${encodeURIComponent(jobId)}`);
}
