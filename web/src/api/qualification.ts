import { apiGet, apiDownload } from './client';

// ─── 类型（与后端 qualification-service 对齐，camelCase）────────────────────────

export type OrgSource = 'prov_cma' | 'cnas' | 'nat_cma';

export interface QualSearchRow {
  source: OrgSource;
  stdCode: string;
  stdName: string;
  testParam: string;
  category: string;
  effectiveDate: string;
  expiryDate: string;
}

export interface QualSearchResult {
  rows: QualSearchRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface QualStandardGroup {
  stdCodeNorm: string;
  stdCode: string;
  stdName: string;
  sources: OrgSource[];
  rows: QualSearchRow[];
}

export interface QualStandardResult {
  groups: QualStandardGroup[];
  total: number;
  page: number;
  pageSize: number;
}

/** 源类型 → 中文标签（前端展示单一真相源）。 */
export const SOURCE_LABEL: Record<OrgSource, string> = {
  prov_cma: '省级 CMA',
  cnas: 'CNAS',
  nat_cma: '国家 CMA',
};

export interface SearchParams {
  q: string;
  sources?: OrgSource[];
  page?: number;
  pageSize?: number;
}

// ─── API ───────────────────────────────────────────────────────────────────

function buildQuery(p: SearchParams): string {
  const sp = new URLSearchParams();
  sp.set('q', p.q);
  if (p.sources && p.sources.length) sp.set('sources', p.sources.join(','));
  if (p.page) sp.set('page', String(p.page));
  if (p.pageSize) sp.set('pageSize', String(p.pageSize));
  return sp.toString();
}

/** 行级搜索（分页）。 */
export function searchQualifications(p: SearchParams): Promise<QualSearchResult> {
  return apiGet(`/api/qualifications/search?${buildQuery(p)}`);
}

/** 按标准号聚合（分页）。 */
export function searchByStandard(p: SearchParams): Promise<QualStandardResult> {
  return apiGet(`/api/qualifications/by-standard?${buildQuery(p)}`);
}

/** 导出查询结果 Excel（全部命中行）。 */
export function exportQualifications(q: string, sources?: OrgSource[]): Promise<void> {
  return apiDownload('/api/qualifications/export', { q, sources });
}
