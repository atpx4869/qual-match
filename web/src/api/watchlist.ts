import { apiGet, apiPost, apiDelete, apiUpload, apiDownload } from './client';
import type { CapLibStatus } from './cap-lib';

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
  controlledNo: string;
  hasText: string;
  department: string;
  provCma: SourceCoverage;
  cnas: SourceCoverage;
  natCma: SourceCoverage;
  capLib: CapLibStatus;
  coveredBy: OrgSource[];
  matched: boolean;
}

export interface MatchOutcome {
  watchlistId: number;
  watchlistName: string;
  total: number;
  coveredCount: number;
  filteredTotal: number;
  page: number;
  pageSize: number;
  results: MatchResult[];
}

export type MatchSortBy = 'seq' | 'stdCode' | 'stdName' | 'controlledNo' | 'department';
export type SortOrder = 'asc' | 'desc';
export type SourceStateFilter = 'covered' | 'none' | 'series';
export type CapLibStateFilter = 'in_lib' | 'cite_only' | 'abolished' | 'series_only' | 'not_in_lib';

export interface MatchQuery {
  page?: number;
  pageSize?: number;
  filter?: 'all' | 'covered' | 'uncovered';
  keyword?: string;
  sortBy?: MatchSortBy;
  sortOrder?: SortOrder;
  provCmaState?: SourceStateFilter;
  cnasState?: SourceStateFilter;
  natCmaState?: SourceStateFilter;
  capLibState?: CapLibStateFilter;
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

export function matchWatchlist(id: number, query: MatchQuery = {}): Promise<MatchOutcome> {
  const sp = new URLSearchParams();
  if (query.page !== undefined) sp.set('page', String(query.page));
  if (query.pageSize !== undefined) sp.set('pageSize', String(query.pageSize));
  if (query.filter) sp.set('filter', query.filter);
  if (query.keyword) sp.set('keyword', query.keyword);
  if (query.sortBy && query.sortBy !== 'seq') {
    sp.set('sortBy', query.sortBy);
    sp.set('sortOrder', query.sortOrder ?? 'asc');
  }
  if (query.provCmaState) sp.set('provCmaState', query.provCmaState);
  if (query.cnasState) sp.set('cnasState', query.cnasState);
  if (query.natCmaState) sp.set('natCmaState', query.natCmaState);
  if (query.capLibState) sp.set('capLibState', query.capLibState);
  const qs = sp.toString();
  return apiGet(`/api/watchlists/${id}/match${qs ? `?${qs}` : ''}`);
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
