import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { searchQualifications, searchByStandard } from './qualification-service';
import { importQualifications } from './import-service';
import { getDb, resetDbForTesting } from './db';

function freshDb(): Database.Database {
  resetDbForTesting();
  return getDb(':memory:');
}

describe('综合查询 — 行级搜索 / 按标准号聚合（单一机构）', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('关键词命中标准名：跨源 UNION 返回命中行', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 3325-2024', stdName: '金属家具通用技术条件', testParam: '甲醛释放量' }]);
    importQualifications(db, 'prov_cma', [{ stdCode: 'GB 5009.3-2016', stdName: '食品安全 水分', testParam: '水分' }]);
    const res = searchQualifications(db, { q: '家具' });
    expect(res.total).toBe(1);
    expect(res.rows[0].source).toBe('cnas');
    expect(res.rows[0].stdCode).toBe('GB/T 3325-2024');
  });

  it('关键词命中检测项目', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 3325-2024', stdName: 'X', testParam: '甲醛释放量' }]);
    const res = searchQualifications(db, { q: '甲醛' });
    expect(res.total).toBe(1);
  });

  it('带年精确：输入 2024 版只命中 2024，不召回 2013', () => {
    importQualifications(db, 'cnas', [
      { stdCode: 'QB/T 4463-2013', stdName: '旧版' },
      { stdCode: 'QB/T 4463-2024', stdName: '新版' },
    ]);
    const res = searchQualifications(db, { q: 'QB/T 4463-2024' });
    // 等值路径命中 2024；LIKE 'QB/T 4463-2024' 子串不会命中 2013 行的 std_code
    const codes = res.rows.map((r) => r.stdCode);
    expect(codes).toContain('QB/T 4463-2024');
    expect(codes).not.toContain('QB/T 4463-2013');
  });

  it('不带年跨年召回：输入剥年号召回全部年版', () => {
    importQualifications(db, 'cnas', [
      { stdCode: 'QB/T 4463-2013', stdName: '旧版' },
      { stdCode: 'QB/T 4463-2024', stdName: '新版' },
    ]);
    const res = searchQualifications(db, { q: 'QB/T 4463' });
    const codes = res.rows.map((r) => r.stdCode).sort();
    expect(codes).toEqual(['QB/T 4463-2013', 'QB/T 4463-2024']);
  });

  it('源过滤：只查 cnas 不返回 prov_cma 命中', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 1-2020', stdName: '同名标准' }]);
    importQualifications(db, 'prov_cma', [{ stdCode: 'GB/T 2-2020', stdName: '同名标准' }]);
    const res = searchQualifications(db, { q: '同名', sources: ['cnas'] });
    expect(res.total).toBe(1);
    expect(res.rows[0].source).toBe('cnas');
  });

  it('按标准号聚合：同号跨源归一组，sources 含两类', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB 5009.3-2016', stdName: '水分', testParam: '水分(CNAS)' }]);
    importQualifications(db, 'prov_cma', [{ stdCode: 'GB 5009.3-2016', stdName: '水分', testParam: '水分(省)' }]);
    const res = searchByStandard(db, { q: 'GB 5009.3-2016' });
    expect(res.total).toBe(1);
    const g = res.groups[0];
    expect(g.rows.length).toBe(2);
    expect(g.sources.sort()).toEqual(['cnas', 'prov_cma']);
  });

  it('分页：行级第二页', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ stdCode: `GB/T ${100 + i}-2020`, stdName: '电池测试' }));
    importQualifications(db, 'cnas', rows);
    const res = searchQualifications(db, { q: '电池', page: 2, pageSize: 2 });
    expect(res.total).toBe(5);
    expect(res.rows.length).toBe(2);
    expect(res.page).toBe(2);
  });

  it('空关键词 / 无命中：返回 0', () => {
    importQualifications(db, 'cnas', [{ stdCode: 'GB/T 1-2020', stdName: 'X' }]);
    expect(searchQualifications(db, { q: '' }).total).toBe(0);
    expect(searchQualifications(db, { q: '不存在的关键词zzz' }).total).toBe(0);
  });
});
