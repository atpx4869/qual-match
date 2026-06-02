import type Database from 'better-sqlite3';
import { ORG_SOURCES, ORG_SOURCE_TABLE, type OrgSource } from '../shared/constants';
import { NotFoundError } from '../shared/errors';

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
  provCma: SourceCoverage;
  cnas: SourceCoverage;
  natCma: SourceCoverage;
  coveredBy: OrgSource[];    // 被哪几类覆盖（保年）
  matched: boolean;          // 是否至少被一类覆盖
}

interface QualRow {
  std_code: string;
  std_code_norm: string;
  std_code_base: string;
  std_name: string;
  test_param: string;
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
  total: number;
  coveredCount: number;
  results: MatchResult[];
}

export function matchWatchlist(db: Database.Database, watchlistId: number): MatchOutcome {
  const wl = db.prepare('SELECT id, name FROM watchlists WHERE id = ?').get(watchlistId) as { id: number; name: string } | undefined;
  if (!wl) throw new NotFoundError(`清单不存在：${watchlistId}`);

  const items = db.prepare(
    'SELECT std_code, std_code_norm, std_code_base, std_name FROM watchlist_items WHERE watchlist_id = ? ORDER BY seq',
  ).all(watchlistId) as Array<{ std_code: string; std_code_norm: string; std_code_base: string; std_name: string }>;

  const norms = [...new Set(items.map((i) => i.std_code_norm).filter(Boolean))];
  const bases = [...new Set(items.map((i) => i.std_code_base).filter(Boolean))];

  // 一次性查全部源
  const perSource = {} as Record<OrgSource, { byNorm: Map<string, QualRow[]>; byBase: Map<string, QualRow[]> }>;
  for (const s of ORG_SOURCES) perSource[s] = queryBySource(db, s, norms, bases);

  const results: MatchResult[] = [];
  let coveredCount = 0;

  for (const it of items) {
    const provCma = buildCoverage(it.std_code_norm, it.std_code_base, perSource.prov_cma.byNorm, perSource.prov_cma.byBase);
    const cnas = buildCoverage(it.std_code_norm, it.std_code_base, perSource.cnas.byNorm, perSource.cnas.byBase);
    const natCma = buildCoverage(it.std_code_norm, it.std_code_base, perSource.nat_cma.byNorm, perSource.nat_cma.byBase);

    const coveredBy: OrgSource[] = [];
    if (provCma.covered) coveredBy.push('prov_cma');
    if (cnas.covered) coveredBy.push('cnas');
    if (natCma.covered) coveredBy.push('nat_cma');
    const matched = coveredBy.length > 0;
    if (matched) coveredCount++;

    results.push({ stdCode: it.std_code, stdName: it.std_name, provCma, cnas, natCma, coveredBy, matched });
  }

  // 记录本次匹配时间
  db.prepare("UPDATE watchlists SET matched_at = datetime('now') WHERE id = ?").run(watchlistId);

  return { watchlistId: wl.id, watchlistName: wl.name, total: items.length, coveredCount, results };
}
