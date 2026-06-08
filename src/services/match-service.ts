import type Database from 'better-sqlite3';
import { ORG_SOURCES, ORG_SOURCE_TABLE, type OrgSource } from '../shared/constants';
import { NotFoundError } from '../shared/errors';
import { CapLibService, type CapLibStatus } from './cap-lib-service';

/**
 * 匹配引擎（阶段 1，单一机构）。
 *
 * 输入一份清单，输出每个标准号是否被本机构的各类资质覆盖。
 * 算法（参照 bzxz queryByStdCodes 的批量 IN 查询）：
 *   1. 取清单全部 std_code_norm（保年）+ std_code_base（剥年），去重。
 *   2. 对每个机构型源（省CMA/CNAS/国CMA）一次性 IN 查询命中行。
 *   3. 按「输入标准号」归集成 MatchResult。
 *
 * 保年优先、剥年兜底（bzxz 语义铁律）：
 *   - 主匹配走 std_code_norm（保年）—— GB/T 3325-2024 只命中库里 2024 版的资质。
 *   - 剥年 std_code_base 仅作「跨年提示」：保年没命中但剥年命中其他年版 → seriesHint。
 *
 * 一单一库（cap_lib）阶段 3 接入，本阶段不查。
 */

export interface SourceCoverage {
  covered: boolean;          // 本机构在该类资质下是否有此标准（保年命中）
  testParams: string[];      // 命中行的检测项目（去重，聚合展示）
  seriesHint: boolean;       // 保年没命中、但剥年命中了其他年版（系列提示，非覆盖）
  seriesCodes: string[];     // 跨年命中的具体标准号（带年），供提示
}

export interface MatchResult {
  stdCode: string;           // 清单原始号
  stdName: string;
  controlledNo: string;      // 清单原始字段：受控编号
  hasText: string;           // 清单原始字段：是否有文本
  department: string;        // 清单原始字段：所属部门
  provCma: SourceCoverage;
  cnas: SourceCoverage;
  natCma: SourceCoverage;
  capLib: CapLibStatus;      // 一单一库 5 档状态（政策范围，独立维度，不计入 matched）
  coveredBy: OrgSource[];    // 被哪几类机构源覆盖（保年）
  matched: boolean;          // 是否至少被一类机构源覆盖（cap_lib「在库」不算本机构有资质）
}

export type MatchFilterMode = 'all' | 'covered' | 'uncovered';

// 排序字段：清单文本列（seq=原始导入顺序，默认）。资质列是状态，不参与排序，用筛选。
export type MatchSortBy = 'seq' | 'stdCode' | 'stdName' | 'controlledNo' | 'department';
export type SortOrder = 'asc' | 'desc';

// 机构源单列状态筛选：covered=有 / none=无 / series=仅其他年版（seriesHint）。
export type SourceStateFilter = 'covered' | 'none' | 'series';
// 一单一库列状态筛选：对齐 CapLibStatus.status 5 档。
export type CapLibStateFilter = 'in_lib' | 'cite_only' | 'abolished' | 'series_only' | 'not_in_lib';

export interface MatchOptions {
  page?: number;
  pageSize?: number;
  filter?: MatchFilterMode;
  keyword?: string;
  sortBy?: MatchSortBy;
  sortOrder?: SortOrder;
  // 各资质列状态筛选（可选；省略=不限）
  provCmaState?: SourceStateFilter;
  cnasState?: SourceStateFilter;
  natCmaState?: SourceStateFilter;
  capLibState?: CapLibStateFilter;
}

interface QualRow {
  std_code: string;
  std_code_norm: string;
  std_code_base: string;
  std_name: string;
  test_param: string;
}

interface WatchlistItem {
  std_code: string;
  std_code_norm: string;
  std_code_base: string;
  std_name: string;
  controlled_no: string;
  has_text: string;
  department: string;
}

const CHUNK = 500; // SQLite 默认变量上限 999，分块查询保险

function queryBySource(db: Database.Database, source: OrgSource, norms: string[], bases: string[]): { byNorm: Map<string, QualRow[]>; byBase: Map<string, QualRow[]> } {
  const meta = ORG_SOURCE_TABLE[source];
  const byNorm = new Map<string, QualRow[]>();
  const byBase = new Map<string, QualRow[]>();

  const run = (col: 'std_code_norm' | 'std_code_base', keys: string[], bucket: Map<string, QualRow[]>) => {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT std_code, std_code_norm, std_code_base, std_name, test_param FROM ${meta.qualTable} WHERE ${col} IN (${placeholders})`,
      ).all(...chunk) as QualRow[];
      for (const r of rows) {
        const k = r[col];
        const arr = bucket.get(k);
        if (arr) arr.push(r); else bucket.set(k, [r]);
      }
    }
  };

  run('std_code_norm', norms, byNorm);
  run('std_code_base', bases, byBase);
  return { byNorm, byBase };
}

function buildCoverage(norm: string, base: string, byNorm: Map<string, QualRow[]>, byBase: Map<string, QualRow[]>): SourceCoverage {
  const hits = byNorm.get(norm) ?? [];
  const covered = hits.length > 0;
  const testParams = covered
    ? [...new Set(hits.map((h) => h.test_param).filter(Boolean))]
    : [];

  // 剥年兜底：保年没命中，但剥年命中了别的年版
  let seriesHint = false;
  const seriesCodes: string[] = [];
  if (!covered) {
    const baseHits = (byBase.get(base) ?? []).filter((h) => h.std_code_norm !== norm);
    if (baseHits.length > 0) {
      seriesHint = true;
      for (const h of baseHits) if (!seriesCodes.includes(h.std_code)) seriesCodes.push(h.std_code);
    }
  }
  return { covered, testParams, seriesHint, seriesCodes };
}

export interface MatchOutcome {
  watchlistId: number;
  watchlistName: string;
  total: number;             // 清单总条数
  coveredCount: number;      // 全清单已覆盖条数（不受筛选影响）
  filteredTotal: number;     // 当前筛选条件下的总条数
  page: number;
  pageSize: number;
  results: MatchResult[];    // 当前页结果；未传 pageSize 时为全量（导出用）
}

function clampPage(n: number | undefined): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n ?? 1));
}

function clampPageSize(n: number | undefined, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n ?? fallback));
}

/** 机构源单列状态：covered=有 / series=仅其他年版 / none=无。供排序无关的列筛选用。 */
function sourceState(c: SourceCoverage): SourceStateFilter {
  if (c.covered) return 'covered';
  if (c.seriesHint) return 'series';
  return 'none';
}

const DEFAULT_CAP_LIB: CapLibStatus = {
  status: 'not_in_lib', inLib: false, libDomain: '', libStatus: '', libRemark: '', seriesNewCode: '', stale: true,
};

// 排序字段 → 取值器（资质列不排序，只有清单文本列）。seq 用导入原序。
const SORT_ACCESSOR: Record<MatchSortBy, (r: MatchResult) => string> = {
  seq: () => '',
  stdCode: (r) => r.stdCode,
  stdName: (r) => r.stdName,
  controlledNo: (r) => r.controlledNo,
  department: (r) => r.department,
};

export function matchWatchlist(db: Database.Database, watchlistId: number, opts: MatchOptions = {}): MatchOutcome {
  const wl = db.prepare('SELECT id, name FROM watchlists WHERE id = ?').get(watchlistId) as { id: number; name: string } | undefined;
  if (!wl) throw new NotFoundError(`清单不存在：${watchlistId}`);

  const items = db.prepare(
    `SELECT std_code, std_code_norm, std_code_base, std_name, controlled_no, has_text, department
     FROM watchlist_items WHERE watchlist_id = ? ORDER BY seq`,
  ).all(watchlistId) as WatchlistItem[];

  const norms = [...new Set(items.map((i) => i.std_code_norm).filter(Boolean))];
  const bases = [...new Set(items.map((i) => i.std_code_base).filter(Boolean))];

  // 一次性查全部机构源
  const perSource = {} as Record<OrgSource, { byNorm: Map<string, QualRow[]>; byBase: Map<string, QualRow[]> }>;
  for (const s of ORG_SOURCES) perSource[s] = queryBySource(db, s, norms, bases);

  // 一单一库 5 档状态：全量算（筛选/排序需要在全量基础上做），批量 IN 查询。
  const capLibSvc = new CapLibService(db);
  const capLibMap = capLibSvc.batchStatus(items.map((i) => i.std_code));

  // 先为全量每行算好 coverage + capLib + matched（后续筛选/排序复用，避免重算）。
  const enriched = items.map((it) => {
    const provCma = buildCoverage(it.std_code_norm, it.std_code_base, perSource.prov_cma.byNorm, perSource.prov_cma.byBase);
    const cnas = buildCoverage(it.std_code_norm, it.std_code_base, perSource.cnas.byNorm, perSource.cnas.byBase);
    const natCma = buildCoverage(it.std_code_norm, it.std_code_base, perSource.nat_cma.byNorm, perSource.nat_cma.byBase);
    const capLib = capLibMap[it.std_code] ?? DEFAULT_CAP_LIB;
    const coveredBy: OrgSource[] = [];
    if (provCma.covered) coveredBy.push('prov_cma');
    if (cnas.covered) coveredBy.push('cnas');
    if (natCma.covered) coveredBy.push('nat_cma');
    const result: MatchResult = {
      stdCode: it.std_code,
      stdName: it.std_name,
      controlledNo: it.controlled_no,
      hasText: it.has_text,
      department: it.department,
      provCma,
      cnas,
      natCma,
      capLib,
      coveredBy,
      matched: coveredBy.length > 0,
    };
    return result;
  });

  const coveredCount = enriched.filter((r) => r.matched).length;

  // ── 筛选（全量）：覆盖态 + 关键词 + 各资质列状态 ──
  const filter = opts.filter ?? 'all';
  const keyword = (opts.keyword ?? '').trim().toLowerCase();

  let filtered = enriched.filter((r) => {
    if (filter === 'covered' && !r.matched) return false;
    if (filter === 'uncovered' && r.matched) return false;
    if (keyword) {
      const haystack = [r.stdCode, r.stdName, r.controlledNo, r.hasText, r.department]
        .map((v) => (v ?? '').toLowerCase());
      if (!haystack.some((v) => v.includes(keyword))) return false;
    }
    if (opts.provCmaState && sourceState(r.provCma) !== opts.provCmaState) return false;
    if (opts.cnasState && sourceState(r.cnas) !== opts.cnasState) return false;
    if (opts.natCmaState && sourceState(r.natCma) !== opts.natCmaState) return false;
    if (opts.capLibState && r.capLib.status !== opts.capLibState) return false;
    return true;
  });

  // ── 排序（全量，稳定）：seq 保持导入原序；其余按文本列 localeCompare（中文友好）──
  const sortBy = opts.sortBy ?? 'seq';
  if (sortBy !== 'seq') {
    const dir = opts.sortOrder === 'desc' ? -1 : 1;
    const accessor = SORT_ACCESSOR[sortBy];
    filtered = filtered
      .map((r, i) => [r, i] as const)
      .sort(([a, ia], [b, ib]) => {
        const cmp = accessor(a).localeCompare(accessor(b), 'zh-Hans-CN', { numeric: true });
        return cmp !== 0 ? cmp * dir : ia - ib; // 稳定排序：相等时保持原序
      })
      .map(([r]) => r);
  }

  const filteredTotal = filtered.length;
  const page = clampPage(opts.page);
  const effectivePageSize = opts.pageSize === undefined
    ? Math.max(1, filteredTotal)
    : clampPageSize(opts.pageSize, 200);
  const start = opts.pageSize === undefined ? 0 : (page - 1) * effectivePageSize;
  const results = filtered.slice(start, start + effectivePageSize);

  // 记录本次匹配时间
  db.prepare("UPDATE watchlists SET matched_at = datetime('now') WHERE id = ?").run(watchlistId);

  return {
    watchlistId: wl.id,
    watchlistName: wl.name,
    total: items.length,
    coveredCount,
    filteredTotal,
    page,
    pageSize: effectivePageSize,
    results,
  };
}
