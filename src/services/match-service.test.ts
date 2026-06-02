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
});
