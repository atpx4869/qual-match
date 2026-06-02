import Database from 'better-sqlite3';
import path from 'node:path';
import { getRootDir } from '../shared/fs';
import { extractBaseCode, extractFullCode } from '../shared/std-code';

/**
 * SQLite 库（data/qual-match.db），better-sqlite3。所有列 snake_case。
 *
 * 表分四组（详见 docs/DESIGN.md 第 2 节）：
 *   - 机构型资质源：cnas / prov_cma / nat_cma 各一对 labs + qualifications（6 表）
 *   - 能力库（一单一库）：cap_lib + cap_lib_meta（2 表）
 *   - 标准清单：watchlists + watchlist_items（2 表）
 *   - 配置/日志：settings + sync_logs（2 表）
 *
 * 三层归一列契约（移植自 bzxz，单一真相源 shared/std-code.ts）：每张含标准号的表
 * 都带 std_code / std_code_norm（保年，索引）/ std_code_base（剥年，索引）三列，
 * 且**从一开始就写进 CREATE TABLE**（bzxz 教训：后置迁移加列踩过"诊断拉得到、搜索匹不上"的坑）。
 */

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db && !dbPath) return _db;

  const resolved = dbPath || path.join(getRootDir(), 'data', 'qual-match.db');
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  if (!dbPath) _db = db;
  return db;
}

export function resetDbForTesting(): void {
  if (_db) { _db.close(); _db = null; }
}

function migrate(db: Database.Database): void {
  db.exec(SCHEMA);
  renormalizeOnAlgoBump(db);
  seedSettings(db);
  seedCapLibDomains(db);
}

// ─── Schema ──────────────────────────────────────────────────────────────────
// 一次性建全部表（IF NOT EXISTS，幂等）。三层归一列 + 索引写进 CREATE TABLE。

const SCHEMA = `
-- ═══ 机构型资质源（3 组）═══

-- CNAS：以 lab_no 标识
CREATE TABLE IF NOT EXISTS cnas_labs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_no         TEXT NOT NULL UNIQUE,
  lab_name       TEXT DEFAULT '',
  source_ref     TEXT DEFAULT '',
  region         TEXT DEFAULT '',
  last_sync_at   TEXT,
  sync_status    TEXT DEFAULT 'pending',
  sync_error     TEXT,
  record_count   INTEGER DEFAULT 0,
  data_origin    TEXT DEFAULT 'manual',
  subscribed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cnas_qualifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_no          TEXT NOT NULL,
  std_code        TEXT NOT NULL,
  std_code_norm   TEXT NOT NULL DEFAULT '',
  std_code_base   TEXT NOT NULL DEFAULT '',
  std_name        TEXT DEFAULT '',
  effective_date  TEXT DEFAULT '',
  expiry_date     TEXT DEFAULT '',
  category        TEXT DEFAULT '',
  sub_category    TEXT DEFAULT '',
  test_object     TEXT DEFAULT '',
  test_param      TEXT DEFAULT '',
  test_standard   TEXT DEFAULT '',
  limit_desc      TEXT DEFAULT '',
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cnas_qual_norm ON cnas_qualifications(std_code_norm);
CREATE INDEX IF NOT EXISTS idx_cnas_qual_base ON cnas_qualifications(std_code_base);
CREATE INDEX IF NOT EXISTS idx_cnas_qual_lab  ON cnas_qualifications(lab_no);

-- 省级 CMA：以 cert_number 标识；专属列 place_name
CREATE TABLE IF NOT EXISTS prov_cma_labs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_number    TEXT NOT NULL UNIQUE,
  lab_name       TEXT DEFAULT '',
  source_ref     TEXT DEFAULT '',
  region         TEXT DEFAULT '',
  last_sync_at   TEXT,
  sync_status    TEXT DEFAULT 'pending',
  sync_error     TEXT,
  record_count   INTEGER DEFAULT 0,
  data_origin    TEXT DEFAULT 'manual',
  subscribed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prov_cma_qualifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_number     TEXT NOT NULL,
  std_code        TEXT NOT NULL,
  std_code_norm   TEXT NOT NULL DEFAULT '',
  std_code_base   TEXT NOT NULL DEFAULT '',
  std_name        TEXT DEFAULT '',
  effective_date  TEXT DEFAULT '',
  expiry_date     TEXT DEFAULT '',
  category        TEXT DEFAULT '',
  sub_category    TEXT DEFAULT '',
  test_object     TEXT DEFAULT '',
  test_param      TEXT DEFAULT '',
  test_standard   TEXT DEFAULT '',
  limit_desc      TEXT DEFAULT '',
  place_name      TEXT DEFAULT '',
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prov_cma_qual_norm ON prov_cma_qualifications(std_code_norm);
CREATE INDEX IF NOT EXISTS idx_prov_cma_qual_base ON prov_cma_qualifications(std_code_base);
CREATE INDEX IF NOT EXISTS idx_prov_cma_qual_cert ON prov_cma_qualifications(cert_number);

-- 国家 CMA：以 cert_number 标识；专属列 apply_id / place_id（cma.cnca.cn）
CREATE TABLE IF NOT EXISTS nat_cma_labs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_number    TEXT NOT NULL UNIQUE,
  lab_name       TEXT DEFAULT '',
  source_ref     TEXT DEFAULT '',
  region         TEXT DEFAULT '',
  last_sync_at   TEXT,
  sync_status    TEXT DEFAULT 'pending',
  sync_error     TEXT,
  record_count   INTEGER DEFAULT 0,
  data_origin    TEXT DEFAULT 'manual',
  subscribed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nat_cma_qualifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_number     TEXT NOT NULL,
  std_code        TEXT NOT NULL,
  std_code_norm   TEXT NOT NULL DEFAULT '',
  std_code_base   TEXT NOT NULL DEFAULT '',
  std_name        TEXT DEFAULT '',
  effective_date  TEXT DEFAULT '',
  expiry_date     TEXT DEFAULT '',
  category        TEXT DEFAULT '',
  sub_category    TEXT DEFAULT '',
  test_object     TEXT DEFAULT '',
  test_param      TEXT DEFAULT '',
  test_standard   TEXT DEFAULT '',
  limit_desc      TEXT DEFAULT '',
  apply_id        TEXT DEFAULT '',
  place_id        TEXT DEFAULT '',
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nat_cma_qual_norm ON nat_cma_qualifications(std_code_norm);
CREATE INDEX IF NOT EXISTS idx_nat_cma_qual_base ON nat_cma_qualifications(std_code_base);
CREATE INDEX IF NOT EXISTS idx_nat_cma_qual_cert ON nat_cma_qualifications(cert_number);

-- ═══ 能力库（一单一库）═══

CREATE TABLE IF NOT EXISTS cap_lib (
  source_id       INTEGER PRIMARY KEY,
  domain          TEXT NOT NULL DEFAULT '',
  standard_method TEXT NOT NULL DEFAULT '',
  std_code        TEXT NOT NULL,
  std_code_norm   TEXT NOT NULL DEFAULT '',
  std_code_base   TEXT NOT NULL DEFAULT '',
  remark          TEXT DEFAULT '',
  lib_status      TEXT NOT NULL DEFAULT 'active',
  raw_status      TEXT DEFAULT '',
  row_hash        TEXT NOT NULL DEFAULT '',
  last_seen_at    TEXT NOT NULL DEFAULT '',
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cap_lib_norm ON cap_lib(std_code_norm);
CREATE INDEX IF NOT EXISTS idx_cap_lib_base ON cap_lib(std_code_base);

CREATE TABLE IF NOT EXISTS cap_lib_meta (
  domain          TEXT PRIMARY KEY,
  subscribed      INTEGER NOT NULL DEFAULT 0,
  last_synced_at  TEXT DEFAULT '',
  remote_total    INTEGER DEFAULT 0,
  local_total     INTEGER DEFAULT 0,
  last_sync_stats TEXT DEFAULT ''
);

-- ═══ 标准清单 ═══

CREATE TABLE IF NOT EXISTS watchlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  matched_at  TEXT,
  item_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS watchlist_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  std_code      TEXT NOT NULL,
  std_code_norm TEXT NOT NULL DEFAULT '',
  std_code_base TEXT NOT NULL DEFAULT '',
  std_name      TEXT DEFAULT '',
  seq           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wl_items_wl   ON watchlist_items(watchlist_id);
CREATE INDEX IF NOT EXISTS idx_wl_items_norm ON watchlist_items(std_code_norm);

-- ═══ 配置 / 日志 ═══

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sync_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,
  target          TEXT NOT NULL,
  action          TEXT NOT NULL,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  status          TEXT DEFAULT 'success',
  records_fetched INTEGER DEFAULT 0,
  error_message   TEXT
);
`;

// ─── std_code 归一化版本回填 ───────────────────────────────────────────────────
/**
 * 改 std-code 归一化逻辑后必须 +1 此版本号（CLAUDE.md 归一化契约：改算法须触发回填）。
 * 版本不变不跑；bump 后对所有含归一列的表全量重算 std_code_norm/std_code_base 一次。
 * 新库首次启动：默认版本 '0' ≠ 当前 → 进入循环，各表 0 行 → 直接写版本号返回（幂等）。
 */
const STD_CODE_ALGO_VERSION = '1';

function renormalizeOnAlgoBump(db: Database.Database): void {
  if (getSetting(db, 'std_code_algo_version', '0') === STD_CODE_ALGO_VERSION) return;

  const tables: Array<{ name: string; idCol: string }> = [
    { name: 'cnas_qualifications', idCol: 'id' },
    { name: 'prov_cma_qualifications', idCol: 'id' },
    { name: 'nat_cma_qualifications', idCol: 'id' },
    { name: 'cap_lib', idCol: 'source_id' },
    { name: 'watchlist_items', idCol: 'id' },
  ];
  for (const t of tables) {
    const rows = db.prepare(`SELECT ${t.idCol} AS id, std_code FROM ${t.name} WHERE COALESCE(std_code, '') <> ''`)
      .all() as Array<{ id: number; std_code: string }>;
    if (!rows.length) continue;
    const update = db.prepare(`UPDATE ${t.name} SET std_code_norm = ?, std_code_base = ? WHERE ${t.idCol} = ?`);
    const txn = db.transaction((chunk: typeof rows) => {
      for (const r of chunk) update.run(extractFullCode(r.std_code), extractBaseCode(r.std_code), r.id);
    });
    const CHUNK = 2000;
    for (let i = 0; i < rows.length; i += CHUNK) txn(rows.slice(i, i + CHUNK));
    console.log(`[db] re-normalized ${rows.length} ${t.name} rows (algo v${STD_CODE_ALGO_VERSION})`);
  }
  setSetting(db, 'std_code_algo_version', STD_CODE_ALGO_VERSION);
}

// ─── 种子数据 ──────────────────────────────────────────────────────────────────

function seedSettings(db: Database.Database): void {
  // 默认配置（首次写入，已存在则不覆盖用户改动）
  const defaults: Record<string, string> = {
    nat_cma_scrape_enabled: '0',   // 国家 CMA 抓取默认关（滑块未达生产标准，走导入降级）
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
}

/**
 * 一单一库 11 个顶层领域种子。
 * ⚠️ 必须与 src/shared/cap-lib-domains.ts 的领域名保持一致（阶段 3 引入该文件后，
 * 增删领域两处一起改）。此处不 import 该文件以守住阶段 0 纯地基边界。
 */
const CAP_LIB_DOMAIN_INIT: readonly string[] = [
  '产品质量检验',
  '食品检验',
  '农产品质量检验',
  '医疗器械检验',
  '生态环境监测',
  '司法鉴定检测',
  '进出口商品检验',
  '林业产品质量检验',
  '化妆品检验',
  '机动车排放、安全技术检验',
  '林木种子、草种质量检验',
];

function seedCapLibDomains(db: Database.Database): void {
  const ins = db.prepare('INSERT OR IGNORE INTO cap_lib_meta (domain) VALUES (?)');
  for (const name of CAP_LIB_DOMAIN_INIT) ins.run(name);
}

// ─── settings 读写 ─────────────────────────────────────────────────────────────

export function getSetting(db: Database.Database, key: string, defaultValue = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
}
