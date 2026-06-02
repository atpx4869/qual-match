import { apiGet, apiPost, apiDelete, apiUpload, apiDownload } from './client';

// ─── 类型（与后端 match-service / import-service 对齐，camelCase）──────────────

export interface WatchlistSummary {
  id: number;
  name: string;
  createdAt: string;
  matchedAt: string | null;
  itemCount: number;
}

export interface ImportSummary {
  inserted: number;
  skipped: number;
  skippedReasons: string[];
}

export interface SourceCoverage {
  covered: boolean;
  testParams: string[];
  seriesHint: boolean;
  seriesCodes: string[];
}

export type OrgSource = 'prov_cma' | 'cnas' | 'nat_cma';

export interface MatchResult {
  stdCode: string;
  stdName: string;
  provCma: SourceCoverage;
  cnas: SourceCoverage;
  natCma: SourceCoverage;
  coveredBy: OrgSource[];
  matched: boolean;
}

export interface MatchOutcome {
  watchlistId: number;
  watchlistName: string;
  total: number;
  coveredCount: number;
  results: MatchResult[];
}

// ─── API ───────────────────────────────────────────────────────────────────

export function listWatchlists(): Promise<WatchlistSummary[]> {
  return apiGet('/api/watchlists');
}

/** 创建清单：粘贴标准号 */
export function createWatchlistFromCodes(name: string, codes: string[]): Promise<{ watchlistId: number; summary: ImportSummary }> {
  return apiPost('/api/watchlists', { name, codes });
}

/** 创建清单：上传 Excel */
export function createWatchlistFromExcel(name: string, file: File): Promise<{ watchlistId: number; summary: ImportSummary }> {
  const form = new FormData();
  form.append('file', file);
  form.append('name', name);
  return apiUpload('/api/watchlists', form);
}

export function deleteWatchlist(id: number): Promise<{ ok: boolean }> {
  return apiDelete(`/api/watchlists/${id}`);
}

export function matchWatchlist(id: number): Promise<MatchOutcome> {
  return apiGet(`/api/watchlists/${id}/match`);
}

export function exportWatchlist(id: number): Promise<void> {
  return apiDownload(`/api/watchlists/${id}/export`);
}

/** 导入本机构资质明细 */
export function importQualifications(source: OrgSource, file: File): Promise<{ source: string; summary: ImportSummary }> {
  const form = new FormData();
  form.append('file', file);
  form.append('source', source);
  return apiUpload('/api/import/qualifications', form);
}
