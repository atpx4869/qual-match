import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { matchWatchlist } from './match-service';
import { importWatchlist, importQualifications } from './import-service';
import { getDb, resetDbForTesting } from './db';

// 用内存库（getDb 注入 ':memory:' 不缓存单例），每个用例独立建库。
function freshDb(): Database.Database {
  resetDbForTesting();
  return getDb(':memory:');
}

describe('matchWatchlist — 单一机构匹配引擎', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('保年精确命中：本机构有 2024 版资质 → covered', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 3325-2024', stdName: '金属家具', testParam: '甲醛释放量' }]);
    const { watchlistId } = importWatchlist(db, '清单A', [{ stdCode: 'GB/T 3325-2024' }]);
    const out = matchWatchlist(db, watchlistId);
    expect(out.total).toBe(1);
    expect(out.coveredCount).toBe(1);
    const r = out.results[0];
    expect(r.cnas.covered).toBe(true);
    expect(r.cnas.testParams).toContain('甲醛释放量');
    expect(r.coveredBy).toEqual(['cnas']);
    expect(r.matched).toBe(true);
  });

  it('同号不同年不误命中：库里只有 2013 版，查 2025 版 → 不 covered，但给跨年提示', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'QB/T 4463-2013', stdName: '旧版' }]);
    const { watchlistId } = importWatchlist(db, '清单B', [{ stdCode: 'QB/T 4463-2025' }]);
    const out = matchWatchlist(db, watchlistId);
    const r = out.results[0];
    expect(r.cnas.covered).toBe(false);
    expect(r.matched).toBe(false);
    expect(r.cnas.seriesHint).toBe(true);
    expect(r.cnas.seriesCodes).toContain('QB/T 4463-2013');
  });

  it('完全未覆盖：本机构没有该标准 → matched=false', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 1000-2020' }]);
    const { watchlistId } = importWatchlist(db, '清单C', [{ stdCode: 'GB/T 9999-2021' }]);
    const out = matchWatchlist(db, watchlistId);
    expect(out.coveredCount).toBe(0);
    expect(out.results[0].matched).toBe(false);
  });

  it('分页：只返回当前页，total/filteredTotal 保持全量统计', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ stdCode: `GB/T ${100 + i}-2020` }));
    const { watchlistId } = importWatchlist(db, '清单分页', rows);
    const out = matchWatchlist(db, watchlistId, { page: 2, pageSize: 2 });
    expect(out.total).toBe(5);
    expect(out.filteredTotal).toBe(5);
    expect(out.page).toBe(2);
    expect(out.pageSize).toBe(2);
    expect(out.results.map((r) => r.stdCode)).toEqual(['GB/T 102-2020', 'GB/T 103-2020']);
  });

  it('筛选：covered/uncovered 在服务端过滤，coveredCount 仍是全清单覆盖数', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 1-2020' }]);
    const { watchlistId } = importWatchlist(db, '清单筛选', [
      { stdCode: 'GB/T 1-2020' },
      { stdCode: 'GB/T 2-2020' },
    ]);
    const covered = matchWatchlist(db, watchlistId, { filter: 'covered', pageSize: 200 });
    expect(covered.total).toBe(2);
    expect(covered.coveredCount).toBe(1);
    expect(covered.filteredTotal).toBe(1);
    expect(covered.results[0].stdCode).toBe('GB/T 1-2020');

    const uncovered = matchWatchlist(db, watchlistId, { filter: 'uncovered', pageSize: 200 });
    expect(uncovered.filteredTotal).toBe(1);
    expect(uncovered.results[0].stdCode).toBe('GB/T 2-2020');
  });

  it('多源命中：省CMA + 国家CMA 都有 → coveredBy 含两类', () => {
    importQualifications(db, 'prov_cma', [{ stdCode: 'GB 5009.3-2016', testParam: '水分' }]);
    importQualifications(db, 'nat_cma', [{ stdCode: 'GB 5009.3-2016', testParam: '水分（国）' }]);
    const { watchlistId } = importWatchlist(db, '清单D', [{ stdCode: 'GB 5009.3-2016' }]);
    const out = matchWatchlist(db, watchlistId);
    const r = out.results[0];
    expect(r.provCma.covered).toBe(true);
    expect(r.natCma.covered).toBe(true);
    expect(r.cnas.covered).toBe(false);
    expect(r.coveredBy.sort()).toEqual(['nat_cma', 'prov_cma']);
  });

  it('脏数据归一：清单写脏空格、资质写干净，仍命中（三层归一化生效）', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 3325-2024' }]);
    const { watchlistId } = importWatchlist(db, '清单E', [{ stdCode: 'GB/T 3325 -2024' }]); // 脏空格
    const out = matchWatchlist(db, watchlistId);
    expect(out.results[0].cnas.covered).toBe(true);
  });

  it('重复导入资质 replace：第二次导入覆盖第一次，不累积', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 1-2020' }, { stdCode: 'GB/T 2-2020' }]);
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 3-2020' }]); // replace 默认 true
    const cnt = db.prepare('SELECT COUNT(*) c FROM cnas_qualifications').get() as { c: number };
    expect(cnt.c).toBe(1);
  });

  it('排序：按标准号升序/降序（全量排序，不只当前页）', () => {
    const { watchlistId } = importWatchlist(db, '清单排序', [
      { stdCode: 'GB/T 200-2020' },
      { stdCode: 'GB/T 100-2020' },
      { stdCode: 'GB/T 300-2020' },
    ]);
    const asc = matchWatchlist(db, watchlistId, { sortBy: 'stdCode', sortOrder: 'asc', pageSize: 200 });
    expect(asc.results.map((r) => r.stdCode)).toEqual(['GB/T 100-2020', 'GB/T 200-2020', 'GB/T 300-2020']);
    const desc = matchWatchlist(db, watchlistId, { sortBy: 'stdCode', sortOrder: 'desc', pageSize: 200 });
    expect(desc.results.map((r) => r.stdCode)).toEqual(['GB/T 300-2020', 'GB/T 200-2020', 'GB/T 100-2020']);
  });

  it('排序默认 seq：不传 sortBy 时保持导入原序', () => {
    const { watchlistId } = importWatchlist(db, '清单原序', [
      { stdCode: 'GB/T 300-2020' },
      { stdCode: 'GB/T 100-2020' },
      { stdCode: 'GB/T 200-2020' },
    ]);
    const out = matchWatchlist(db, watchlistId, { pageSize: 200 });
    expect(out.results.map((r) => r.stdCode)).toEqual(['GB/T 300-2020', 'GB/T 100-2020', 'GB/T 200-2020']);
  });

  it('排序跨页一致：第 2 页是全量排序后的切片，不是页内排序', () => {
    const rows = [
      { stdCode: 'GB/T 500-2020' }, { stdCode: 'GB/T 100-2020' },
      { stdCode: 'GB/T 400-2020' }, { stdCode: 'GB/T 200-2020' },
      { stdCode: 'GB/T 300-2020' },
    ];
    const { watchlistId } = importWatchlist(db, '清单排序分页', rows);
    const p2 = matchWatchlist(db, watchlistId, { sortBy: 'stdCode', sortOrder: 'asc', page: 2, pageSize: 2 });
    // 全量升序：100,200,300,400,500 → 第 2 页（pageSize 2）= 300,400
    expect(p2.results.map((r) => r.stdCode)).toEqual(['GB/T 300-2020', 'GB/T 400-2020']);
  });

  it('资质列状态筛选：provCmaState=covered 只留省CMA有覆盖的', () => {
    importQualifications(db, 'prov_cma', [{ stdCode: 'GB/T 1-2020' }]);
    const { watchlistId } = importWatchlist(db, '清单源筛选', [
      { stdCode: 'GB/T 1-2020' }, // 省CMA有
      { stdCode: 'GB/T 2-2020' }, // 无
    ]);
    const covered = matchWatchlist(db, watchlistId, { provCmaState: 'covered', pageSize: 200 });
    expect(covered.filteredTotal).toBe(1);
    expect(covered.results[0].stdCode).toBe('GB/T 1-2020');

    const none = matchWatchlist(db, watchlistId, { provCmaState: 'none', pageSize: 200 });
    expect(none.filteredTotal).toBe(1);
    expect(none.results[0].stdCode).toBe('GB/T 2-2020');
    // coveredCount 不受列筛选影响，仍是全清单覆盖数
    expect(none.coveredCount).toBe(1);
  });

  it('资质列状态筛选：series 命中跨年提示行', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'QB/T 4463-2013' }]);
    const { watchlistId } = importWatchlist(db, '清单系列筛选', [
      { stdCode: 'QB/T 4463-2025' }, // 保年没命中，剥年命中 2013 → series
      { stdCode: 'GB/T 9-2020' },    // 完全无
    ]);
    const series = matchWatchlist(db, watchlistId, { cnasState: 'series', pageSize: 200 });
    expect(series.filteredTotal).toBe(1);
    expect(series.results[0].stdCode).toBe('QB/T 4463-2025');
  });
});
