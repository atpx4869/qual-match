import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CapLibService } from './cap-lib-service';
import { parseLibStatus } from '../shared/cap-lib-status';
import { extractFullCode, extractBaseCode, cleanStdCode } from '../shared/std-code';
import { matchWatchlist } from './match-service';
import { importWatchlist } from './import-service';
import { getDb, resetDbForTesting } from './db';

function freshDb(): Database.Database {
  resetDbForTesting();
  return getDb(':memory:');
}

/** 直接插一条 cap_lib 行（绕过联网同步），供 batchStatus / 匹配测试。 */
function insertLib(db: Database.Database, opts: { sourceId: number; domain: string; stdCode: string; libStatus?: string; remark?: string; synced?: boolean }) {
  const clean = cleanStdCode(opts.stdCode);
  db.prepare(`
    INSERT INTO cap_lib (source_id, domain, standard_method, std_code, std_code_norm, std_code_base, remark, lib_status, raw_status, row_hash, last_seen_at)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, '', 'h', datetime('now'))
  `).run(opts.sourceId, opts.domain, clean, extractFullCode(clean), extractBaseCode(clean), opts.remark ?? '', opts.libStatus ?? 'active');
  if (opts.synced !== false) {
    db.prepare("UPDATE cap_lib_meta SET subscribed = 1, last_synced_at = datetime('now') WHERE domain = ?").run(opts.domain);
  }
}

describe('parseLibStatus — remark 语义解析', () => {
  it('空 / null → active', () => {
    expect(parseLibStatus('')).toBe('active');
    expect(parseLibStatus(null)).toBe('active');
  });
  it('废止+仅限引用 → cite_only（必须先于 abolished 判断）', () => {
    expect(parseLibStatus('废止，仅限能力项目库范围内现行有效产品标准引用本标准及监督抽检时申请')).toBe('cite_only');
  });
  it('纯废止 / 作废 / 被替代 → abolished', () => {
    expect(parseLibStatus('废止')).toBe('abolished');
    expect(parseLibStatus('作废')).toBe('abolished');
    expect(parseLibStatus('被GB123替代')).toBe('abolished');
  });
});

describe('batchStatus — 5 档比对', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('未同步任何领域 → stale', () => {
    const svc = new CapLibService(db);
    const r = svc.batchStatus(['GB/T 3325-2024']);
    expect(r['GB/T 3325-2024'].stale).toBe(true);
    expect(r['GB/T 3325-2024'].status).toBe('not_in_lib');
  });

  it('保年命中 active → in_lib', () => {
    insertLib(db, { sourceId: 1, domain: '产品质量检验', stdCode: 'GB/T 3325-2024' });
    const r = new CapLibService(db).batchStatus(['GB/T 3325-2024']);
    expect(r['GB/T 3325-2024'].status).toBe('in_lib');
    expect(r['GB/T 3325-2024'].inLib).toBe(true);
    expect(r['GB/T 3325-2024'].libDomain).toBe('产品质量检验');
    expect(r['GB/T 3325-2024'].stale).toBe(false);
  });

  it('保年命中 cite_only → cite_only', () => {
    insertLib(db, { sourceId: 2, domain: '食品检验', stdCode: 'GB 5009.3-2016', libStatus: 'cite_only', remark: '废止，仅限引用' });
    const r = new CapLibService(db).batchStatus(['GB 5009.3-2016']);
    expect(r['GB 5009.3-2016'].status).toBe('cite_only');
  });

  it('保年命中 abolished → abolished', () => {
    insertLib(db, { sourceId: 3, domain: '食品检验', stdCode: 'GB 1-2010', libStatus: 'abolished', remark: '废止' });
    const r = new CapLibService(db).batchStatus(['GB 1-2010']);
    expect(r['GB 1-2010'].status).toBe('abolished');
  });

  it('保年未命中、剥年命中其他年版 active → series_only + 推荐年版', () => {
    insertLib(db, { sourceId: 4, domain: '产品质量检验', stdCode: 'QB/T 4463-2024' });
    const r = new CapLibService(db).batchStatus(['QB/T 4463-2013']);
    expect(r['QB/T 4463-2013'].status).toBe('series_only');
    expect(r['QB/T 4463-2013'].seriesNewCode).toBe('QB/T 4463-2024');
  });

  it('完全不在库 → not_in_lib（已同步过 → 不 stale）', () => {
    insertLib(db, { sourceId: 5, domain: '产品质量检验', stdCode: 'GB/T 100-2020' });
    const r = new CapLibService(db).batchStatus(['GB/T 9999-2099']);
    expect(r['GB/T 9999-2099'].status).toBe('not_in_lib');
    expect(r['GB/T 9999-2099'].stale).toBe(false);
  });

  it('同号跨领域 → 取最高优先级（active > cite_only > abolished）', () => {
    insertLib(db, { sourceId: 6, domain: '食品检验', stdCode: 'GB 2-2020', libStatus: 'abolished', remark: '废止' });
    insertLib(db, { sourceId: 7, domain: '产品质量检验', stdCode: 'GB 2-2020', libStatus: 'active' });
    const r = new CapLibService(db).batchStatus(['GB 2-2020']);
    expect(r['GB 2-2020'].status).toBe('in_lib');
  });
});

describe('cleanupStaleRows', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('删除 last_seen_at 早于阈值的行', () => {
    db.prepare(`
      INSERT INTO cap_lib (source_id, domain, std_code, std_code_norm, std_code_base, lib_status, row_hash, last_seen_at)
      VALUES (1, '产品质量检验', 'GB/T 1-2020', 'GB1-2020', 'GB1', 'active', 'h', '2000-01-01T00:00:00.000Z')
    `).run();
    const deleted = new CapLibService(db).cleanupStaleRows(30);
    expect(deleted).toBe(1);
  });
});

describe('匹配引擎接入 cap_lib', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('清单号在库 active → capLib.status=in_lib，但 matched 仍只由机构源决定（cap_lib 不算覆盖）', () => {
    insertLib(db, { sourceId: 1, domain: '产品质量检验', stdCode: 'GB/T 3325-2024' });
    const { watchlistId } = importWatchlist(db, '清单X', [{ stdCode: 'GB/T 3325-2024' }]);
    const out = matchWatchlist(db, watchlistId);
    const r = out.results[0];
    expect(r.capLib.status).toBe('in_lib');
    expect(r.matched).toBe(false);        // 没有机构源资质 → 未覆盖
    expect(out.coveredCount).toBe(0);
  });
});
