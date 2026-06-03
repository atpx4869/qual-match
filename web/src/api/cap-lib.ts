import { apiGet, apiPost, apiPut } from './client';

// ─── 类型（与后端 cap-lib-service 对齐，camelCase）─────────────────────────────

/** 5 档比对状态。 */
export type DiffStatus = 'in_lib' | 'cite_only' | 'abolished' | 'series_only' | 'not_in_lib';
export type LibStatus = 'active' | 'cite_only' | 'abolished';

export interface SyncStats {
  added: number;
  changed: number;
  unchanged: number;
  removedSoft: number;
  durationMs: number;
}

export interface DomainMeta {
  domain: string;
  subscribed: boolean;
  lastSyncedAt: string;
  remoteTotal: number;
  localTotal: number;
  approxCount: number;
  recommendedDefault: boolean;
  lastSyncStats: SyncStats | null;
}

export interface SyncProgress {
  phase: 'pending' | 'fetching' | 'upserting' | 'done' | 'error';
  target: string;
  current: number;
  total: number;
  error?: string;
  stats?: SyncStats;
}

/** 单标准号 vs 一单一库的 5 档状态（匹配结果第 5 列用）。 */
export interface CapLibStatus {
  status: DiffStatus;
  inLib: boolean;
  libDomain: string;
  libStatus: LibStatus | '';
  libRemark: string;
  seriesNewCode: string;
  stale: boolean;
}

// ─── API ───────────────────────────────────────────────────────────────────

export function listCapLibDomains(): Promise<{ items: DomainMeta[] }> {
  return apiGet('/api/cap-lib/domains');
}

export function setCapLibSubscribed(domain: string, subscribed: boolean): Promise<{ ok: boolean }> {
  return apiPut(`/api/cap-lib/domains/${encodeURIComponent(domain)}/subscribe`, { subscribed });
}

export function startCapLibSync(domain: string): Promise<{ jobId: string; domain: string }> {
  return apiPost(`/api/cap-lib/domains/${encodeURIComponent(domain)}/sync`);
}

export function getCapLibSyncProgress(jobId: string): Promise<SyncProgress> {
  return apiGet(`/api/cap-lib/sync-progress/${encodeURIComponent(jobId)}`);
}

export function cleanupCapLib(days?: number): Promise<{ deleted: number }> {
  return apiPost('/api/cap-lib/cleanup', days ? { days } : {});
}
