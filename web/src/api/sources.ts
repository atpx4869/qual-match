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
  subscribed: boolean;
}

export interface NatCmaSearchResult {
  certCode: string;
  orgName: string;
  address: string;
  placeId: string;
  applyId: string;
}

export type OrgSource = 'prov_cma' | 'cnas' | 'nat_cma';

export interface SourceLab {
  labName: string;
  sourceRef: string;
  region: string;
  recordCount: number;
  dataOrigin: string;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
}

export interface SourceOrgState {
  source: OrgSource;
  localCount: number;
  lab: SourceLab | null;
}

// 复用 cap-lib 的 SyncProgress 类型（target/phase/current/total/error）
export type { SyncProgress };

// ─── API ───────────────────────────────────────────────────────────────────

export function searchProvCma(q: string): Promise<{ items: ProvCmaSearchResult[]; total: number }> {
  return apiGet(`/api/sources/prov_cma/search?q=${encodeURIComponent(q)}`);
}

export function syncProvCma(publicDetailId: string): Promise<{ jobId: string }> {
  return apiPost('/api/sources/prov_cma/sync', publicDetailId ? { publicDetailId } : {});
}

export function syncSubscribedProvCma(): Promise<{ jobId: string }> {
  return apiPost('/api/sources/prov_cma/sync', {});
}

export function subscribeProvCma(item: ProvCmaSearchResult): Promise<{ ok: boolean }> {
  return apiPost('/api/sources/prov_cma/subscribe', {
    publicDetailId: item.publicDetailId,
    labName: item.sysName,
    region: item.areaName,
  });
}

export function listCnasPresets(): Promise<{ items: CnasPreset[] }> {
  return apiGet('/api/sources/cnas/presets');
}

export function syncCnas(labNo: string): Promise<{ jobId: string }> {
  return apiPost('/api/sources/cnas/sync', labNo ? { labNo } : {});
}

export function syncSubscribedCnas(): Promise<{ jobId: string }> {
  return apiPost('/api/sources/cnas/sync', {});
}

export function subscribeCnas(labNo: string): Promise<{ ok: boolean }> {
  return apiPost('/api/sources/cnas/subscribe', { labNo });
}

export function searchNatCma(q: string): Promise<{ items: NatCmaSearchResult[]; total: number }> {
  return apiGet(`/api/sources/nat_cma/search?q=${encodeURIComponent(q)}`);
}

export function syncNatCma(item: NatCmaSearchResult): Promise<{ jobId: string }> {
  return apiPost('/api/sources/nat_cma/sync', {
    certCode: item.certCode,
    orgName: item.orgName,
    placeId: item.placeId,
    applyId: item.applyId,
  });
}

export function syncSubscribedNatCma(): Promise<{ jobId: string }> {
  return apiPost('/api/sources/nat_cma/sync', {});
}

export function subscribeNatCma(item: NatCmaSearchResult): Promise<{ ok: boolean }> {
  return apiPost('/api/sources/nat_cma/subscribe', {
    certCode: item.certCode,
    orgName: item.orgName,
    placeId: item.placeId,
    applyId: item.applyId,
    region: item.address,
  });
}

export function getSourceSyncProgress(jobId: string): Promise<SyncProgress> {
  return apiGet(`/api/sources/sync-progress/${encodeURIComponent(jobId)}`);
}

export function getSourceOrg(source: OrgSource): Promise<SourceOrgState> {
  return apiGet(`/api/sources/${source}/orgs`);
}
