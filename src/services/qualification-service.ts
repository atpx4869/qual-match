import type Database from 'better-sqlite3';
import { ORG_SOURCES, ORG_SOURCE_TABLE, type OrgSource } from '../shared/constants';
import { cleanStdCode, extractFullCode, extractBaseCode } from '../shared/std-code';

/**
 * 综合查询服务（阶段 2，单一机构）。
 *
 * 独立于清单，直接对本地资质库做关键词/标准号查询（DESIGN §4.2）。
 * 阶段 2 仅查 3 个机构型源（cap_lib 阶段 3 才同步，本服务预留 UNION 扩展位）。
 *
 * 两种视图：
 *   - 行级搜索 searchQualifications：关键词命中标准号/标准名/检测项目，跨源 UNION，分页。
 *   - 按标准号聚合 searchByStandard：同一 std_code_norm 下全部资质行聚合成一组。
 *
 * 带年/不带年分流（移植 bzxz 语义）：
 *   - 输入含 4 位年份 → 严格保年（std_code_norm 等值），同号不同年不混。
 *   - 输入不带年 → 保年 + 剥年双路径（std_code_base 等值），跨年版本都召回，
 *     UI 展示完整带年 std_code 让用户看清命中的是哪个年版。
 *
 * 单一机构定位：明细行机构列是占位 SELF_ORG_ID，结果不展示机构名，只标源类型。
 */

/** 一行资质命中（行级搜索 / 聚合组内行）。source 标明来自哪类资质源。 */
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
  total: number;        // 命中总行数（分页前）
  page: number;
  pageSize: number;
}

/** 按标准号聚合的一组（同一保年归一号下的全部资质行）。 */
export interface QualStandardGroup {
  stdCodeNorm: string;          // 保年归一号（聚合键）
  stdCode: string;             // 代表性原始号（取组内第一条）
  stdName: string;             // 代表性标准名（取组内第一条非空）
  sources: OrgSource[];        // 该标准号被哪几类源覆盖
  rows: QualSearchRow[];       // 组内全部行
}

export interface QualStandardResult {
  groups: QualStandardGroup[];
  total: number;        // 命中组数（分页前）
  page: number;
  pageSize: number;
}

export interface SearchOptions {
  q: string;                       // 关键词（标准号/标准名/检测项目）
  sources?: OrgSource[];           // 源过滤；空/未传 = 全部机构型源
  page?: number;                   // 1-based
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** 输入是否含 4 位年份（带年 → 严格保年匹配）。 */
function hasYear(q: string): boolean {
  return /\b\d{4}\b/.test(q) || /-\s*\d{4}/.test(q);
}

/** 规整源过滤：空/非法 → 全部机构型源。 */
function resolveSources(sources?: OrgSource[]): OrgSource[] {
  if (!sources || sources.length === 0) return [...ORG_SOURCES];
  const valid = sources.filter((s) => (ORG_SOURCES as readonly string[]).includes(s));
  return valid.length ? valid : [...ORG_SOURCES];
}

interface RawQualRow {
  std_code: string;
  std_code_norm: string;
  std_code_base: string;
  std_name: string;
  test_param: string;
  category: string;
  effective_date: string;
  expiry_date: string;
}

function toSearchRow(source: OrgSource, r: RawQualRow): QualSearchRow {
  return {
    source,
    stdCode: r.std_code,
    stdName: r.std_name ?? '',
    testParam: r.test_param ?? '',
    category: r.category ?? '',
    effectiveDate: r.effective_date ?? '',
    expiryDate: r.expiry_date ?? '',
  };
}

/**
 * 跨源拉取命中行（不分页，命中规模有限：本机构资质库 + 关键词过滤）。
 *
 * 匹配策略：
 *   1. 关键词归一化后，若是「看起来像标准号」的输入，走归一列等值（保年/剥年分流）。
 *   2. 始终叠加一条 LIKE 关键词路径，命中标准名/检测项目/原始号子串（OR）。
 *   两条路径 OR 合并，让「GB/T 3325」既精确召回该号，也召回名字含关键词的其他标准。
 *
 * 排序：std_code_norm（同号聚在一起，利于聚合视图）→ source。
 */
function collectHits(db: Database.Database, opts: SearchOptions): QualSearchRow[] {
  const q = opts.q.trim();
  const sources = resolveSources(opts.sources);
  if (!q) return [];

  // 归一化输入，得到保年/剥年键（仅当输入像标准号时有意义；纯中文关键词归一化后无 4 位年份）
  const clean = cleanStdCode(q);
  const norm = extractFullCode(clean);
  const base = extractBaseCode(clean);
  const byYear = hasYear(q);

  const like = `%${q}%`;
  const out: QualSearchRow[] = [];

  for (const source of sources) {
    const meta = ORG_SOURCE_TABLE[source];
    // 标准号等值路径：带年 → std_code_norm 等值；不带年 → std_code_base 等值（跨年召回）
    const codeClause = byYear ? 'std_code_norm = ?' : 'std_code_base = ?';
    const codeKey = byYear ? norm : base;
    const sql =
      `SELECT std_code, std_code_norm, std_code_base, std_name, test_param, category, effective_date, expiry_date
       FROM ${meta.qualTable}
       WHERE (${codeClause})
          OR std_name LIKE ? OR test_param LIKE ? OR std_code LIKE ?
       ORDER BY std_code_norm, id`;
    const rows = db.prepare(sql).all(codeKey, like, like, like) as RawQualRow[];
    for (const r of rows) out.push(toSearchRow(source, r));
  }

  // 全局按 std_code_norm 聚拢（跨源），保证聚合视图同号相邻、行级视图有序
  out.sort((a, b) => {
    const ka = extractFullCode(a.stdCode);
    const kb = extractFullCode(b.stdCode);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
  return out;
}

function clampPaging(opts: SearchOptions): { page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize };
}

// ─── 行级搜索（分页）──────────────────────────────────────────────────────────
export function searchQualifications(db: Database.Database, opts: SearchOptions): QualSearchResult {
  const all = collectHits(db, opts);
  const { page, pageSize } = clampPaging(opts);
  const start = (page - 1) * pageSize;
  return {
    rows: all.slice(start, start + pageSize),
    total: all.length,
    page,
    pageSize,
  };
}

// ─── 按标准号聚合（分页：以「组」为单位分页）──────────────────────────────────
export function searchByStandard(db: Database.Database, opts: SearchOptions): QualStandardResult {
  const all = collectHits(db, opts);

  // 按保年归一号分组。collectHits 已按 norm 排序，这里顺序聚合即可保稳定。
  const groupMap = new Map<string, QualStandardGroup>();
  for (const row of all) {
    const key = extractFullCode(row.stdCode);
    let g = groupMap.get(key);
    if (!g) {
      g = { stdCodeNorm: key, stdCode: row.stdCode, stdName: row.stdName, sources: [], rows: [] };
      groupMap.set(key, g);
    }
    if (!g.stdName && row.stdName) g.stdName = row.stdName;
    if (!g.sources.includes(row.source)) g.sources.push(row.source);
    g.rows.push(row);
  }

  const groups = [...groupMap.values()];
  const { page, pageSize } = clampPaging(opts);
  const start = (page - 1) * pageSize;
  return {
    groups: groups.slice(start, start + pageSize),
    total: groups.length,
    page,
    pageSize,
  };
}

/** 导出用：取全部命中行（不分页）。供 export-service 平铺导出。 */
export function collectAllHits(db: Database.Database, opts: SearchOptions): QualSearchRow[] {
  return collectHits(db, opts);
}
