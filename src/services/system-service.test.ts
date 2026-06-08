import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getDb, resetDbForTesting, setSetting } from './db';
import { importQualifications } from './import-service';
import {
  collectOverview, getCnasThrottleMs, getCnasChromePath,
  DEFAULT_CNAS_THROTTLE_MS, SETTING_CNAS_THROTTLE_MS, SETTING_CNAS_CHROME_PATH,
  getNatCmaChromePath, getNatCmaThrottleMs, isNatCmaScrapeEnabled,
  DEFAULT_NAT_CMA_THROTTLE_MS, SETTING_NAT_CMA_CHROME_PATH,
  SETTING_NAT_CMA_ENABLED, SETTING_NAT_CMA_THROTTLE_MS,
} from './system-service';

// 内存库，每个用例独立建库（getDb(':memory:') 不缓存单例）。不打网络。
function freshDb(): Database.Database {
  resetDbForTesting();
  return getDb(':memory:');
}

describe('collectOverview — 数据总览聚合', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('空库：各源 0 条、null 元信息、不崩', () => {
    const o = collectOverview(db);
    expect(o.orgSources).toHaveLength(3);
    for (const s of o.orgSources) {
      expect(s.count).toBe(0);
      expect(s.dataOrigin).toBeNull();
      expect(s.lastSyncAt).toBeNull();
    }
    expect(o.capLib.total).toBe(0);
    expect(o.capLib.active).toBe(0);
    expect(o.capLib.subscribedDomains).toBe(0);
    expect(o.capLib.lastSyncedAt).toBeNull();
    expect(o.watchlists.lists).toBe(0);
    expect(o.watchlists.items).toBe(0);
  });

  it('机构源：导入明细后 count 实算、label 正确', () => {
    importQualifications(db, 'cnas', [
      { stdCode: 'GB 5009.2-2024', stdName: '相对密度' },
      { stdCode: 'GB 5009.3-2016', stdName: '水分' },
    ]);
    const o = collectOverview(db);
    const cnas = o.orgSources.find((s) => s.source === 'cnas')!;
    expect(cnas.count).toBe(2);
    expect(cnas.label).toBe('CNAS');
    // 导入路径会维护 labs 占位行（import-service 写 data_origin=manual）
    expect(cnas.dataOrigin).toBe('manual');
  });

  it('cap_lib：total / active / 订阅领域 / 最后同步', () => {
    db.prepare(
      "INSERT INTO cap_lib (source_id, domain, std_code, std_code_norm, std_code_base, lib_status, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(1, '食品', 'GB 1-2020', 'GB1-2020', 'GB1', 'active', 'h1');
    db.prepare(
      "INSERT INTO cap_lib (source_id, domain, std_code, std_code_norm, std_code_base, lib_status, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(2, '食品', 'GB 2-2020', 'GB2-2020', 'GB2', 'deleted', 'h2');
    db.prepare(
      "INSERT INTO cap_lib_meta (domain, subscribed, last_synced_at) VALUES (?, 1, ?)",
    ).run('食品', '2026-06-01 10:00:00');
    db.prepare(
      "INSERT INTO cap_lib_meta (domain, subscribed, last_synced_at) VALUES (?, 0, '')",
    ).run('环境');

    const o = collectOverview(db);
    expect(o.capLib.total).toBe(2);
    expect(o.capLib.active).toBe(1);
    expect(o.capLib.subscribedDomains).toBe(1);
    expect(o.capLib.lastSyncedAt).toBe('2026-06-01 10:00:00');
    expect(o.capLib.dataOrigin).toBe('scraped');
  });

  it('清单：lists / items 计数', () => {
    const wl = db.prepare("INSERT INTO watchlists (name, item_count) VALUES ('清单A', 0)").run();
    const id = Number(wl.lastInsertRowid);
    db.prepare("INSERT INTO watchlist_items (watchlist_id, std_code, std_code_norm, std_code_base, std_name, seq) VALUES (?, 'GB 1', 'GB1', 'GB1', '', 0)").run(id);
    db.prepare("INSERT INTO watchlist_items (watchlist_id, std_code, std_code_norm, std_code_base, std_name, seq) VALUES (?, 'GB 2', 'GB2', 'GB2', '', 1)").run(id);
    const o = collectOverview(db);
    expect(o.watchlists.lists).toBe(1);
    expect(o.watchlists.items).toBe(2);
  });
});

describe('getCnasThrottleMs — 节流值回退与校验', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it('无设置 → 默认 1500', () => {
    expect(getCnasThrottleMs(db)).toBe(DEFAULT_CNAS_THROTTLE_MS);
  });
  it('合法值 → 原值', () => {
    setSetting(db, SETTING_CNAS_THROTTLE_MS, '3000');
    expect(getCnasThrottleMs(db)).toBe(3000);
  });
  it('非数字 / 负数 / 越界 → 回退默认', () => {
    setSetting(db, SETTING_CNAS_THROTTLE_MS, 'abc');
    expect(getCnasThrottleMs(db)).toBe(DEFAULT_CNAS_THROTTLE_MS);
    setSetting(db, SETTING_CNAS_THROTTLE_MS, '-5');
    expect(getCnasThrottleMs(db)).toBe(DEFAULT_CNAS_THROTTLE_MS);
    setSetting(db, SETTING_CNAS_THROTTLE_MS, '999999');
    expect(getCnasThrottleMs(db)).toBe(DEFAULT_CNAS_THROTTLE_MS);
  });
});

describe('getCnasChromePath — 路径回退', () => {
  let db: Database.Database;
  const ENV_KEY = 'CNAS_CHROME_PATH';
  let saved: string | undefined;
  beforeEach(() => { db = freshDb(); saved = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = saved; });

  it('settings 有值 → 优先', () => {
    setSetting(db, SETTING_CNAS_CHROME_PATH, 'C:/x/chrome.exe');
    process.env[ENV_KEY] = 'C:/env/chrome.exe';
    expect(getCnasChromePath(db)).toBe('C:/x/chrome.exe');
  });
  it('settings 空 → 回退环境变量', () => {
    process.env[ENV_KEY] = 'C:/env/chrome.exe';
    expect(getCnasChromePath(db)).toBe('C:/env/chrome.exe');
  });
  it('两者都空 → 自动探测本机浏览器或空串', () => {
    expect(typeof getCnasChromePath(db)).toBe('string');
  });
});

describe('国家 CMA 抓取设置', () => {
  let db: Database.Database;
  const NAT_ENV_KEY = 'NAT_CMA_CHROME_PATH';
  const CNAS_ENV_KEY = 'CNAS_CHROME_PATH';
  let savedNat: string | undefined;
  let savedCnas: string | undefined;

  beforeEach(() => {
    db = freshDb();
    savedNat = process.env[NAT_ENV_KEY];
    savedCnas = process.env[CNAS_ENV_KEY];
    delete process.env[NAT_ENV_KEY];
    delete process.env[CNAS_ENV_KEY];
  });
  afterEach(() => {
    if (savedNat === undefined) delete process.env[NAT_ENV_KEY]; else process.env[NAT_ENV_KEY] = savedNat;
    if (savedCnas === undefined) delete process.env[CNAS_ENV_KEY]; else process.env[CNAS_ENV_KEY] = savedCnas;
  });

  it('开关默认关闭，写 1 后开启', () => {
    expect(isNatCmaScrapeEnabled(db)).toBe(false);
    setSetting(db, SETTING_NAT_CMA_ENABLED, '1');
    expect(isNatCmaScrapeEnabled(db)).toBe(true);
  });

  it('浏览器路径优先级：国家 CMA settings → NAT_CMA_CHROME_PATH → CNAS 回退', () => {
    setSetting(db, SETTING_NAT_CMA_CHROME_PATH, 'C:/nat/settings/chrome.exe');
    process.env[NAT_ENV_KEY] = 'C:/nat/env/chrome.exe';
    process.env[CNAS_ENV_KEY] = 'C:/cnas/env/chrome.exe';
    expect(getNatCmaChromePath(db)).toBe('C:/nat/settings/chrome.exe');

    setSetting(db, SETTING_NAT_CMA_CHROME_PATH, '');
    expect(getNatCmaChromePath(db)).toBe('C:/nat/env/chrome.exe');

    delete process.env[NAT_ENV_KEY];
    expect(getNatCmaChromePath(db)).toBe('C:/cnas/env/chrome.exe');
  });

  it('节流值合法则使用，非法则回退默认', () => {
    expect(getNatCmaThrottleMs(db)).toBe(DEFAULT_NAT_CMA_THROTTLE_MS);
    setSetting(db, SETTING_NAT_CMA_THROTTLE_MS, '2500');
    expect(getNatCmaThrottleMs(db)).toBe(2500);
    setSetting(db, SETTING_NAT_CMA_THROTTLE_MS, 'bad');
    expect(getNatCmaThrottleMs(db)).toBe(DEFAULT_NAT_CMA_THROTTLE_MS);
  });
});
