import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './db';
import { getRootDir } from '../shared/fs';
import { ORG_SOURCE_TABLE, SELF_ORG_ID, ORG_SOURCES } from '../shared/constants';

/**
 * 系统服务（阶段 6 打磨）：
 *   - collectOverview：各资质源 + 清单的只读数据总览（设置页展示）。
 *   - settings typed 封装：CNAS 浏览器路径 / 抓取节流间隔（key/value 存 settings 表）。
 *   - backupDatabase：用 SQLite online backup 导出整库快照（WAL 一致），供下载备份。
 *
 * 单一机构定位：机构型源（prov_cma/cnas/nat_cma）的明细按 SELF_ORG_ID 归本机构；
 * cap_lib 是能力库（无机构概念），单独统计。
 */

// ─── settings key 约定 ───────────────────────────────────────────────────────────
export const SETTING_CNAS_CHROME_PATH = 'cnas_chrome_path';
export const SETTING_CNAS_THROTTLE_MS = 'cnas_throttle_min_ms';
export const DEFAULT_CNAS_THROTTLE_MS = 1500;
export const SETTING_NAT_CMA_ENABLED = 'nat_cma_scrape_enabled';
export const SETTING_NAT_CMA_CHROME_PATH = 'nat_cma_chrome_path';
export const SETTING_NAT_CMA_THROTTLE_MS = 'nat_cma_throttle_min_ms';
export const DEFAULT_NAT_CMA_THROTTLE_MS = 1500;
const THROTTLE_MAX_MS = 60000;

/** CNAS 浏览器 executablePath：settings 非空优先，否则回退环境变量（向后兼容）。 */
export function getCnasChromePath(db: Database.Database): string {
  const fromSettings = getSetting(db, SETTING_CNAS_CHROME_PATH, '').trim();
  if (fromSettings) return fromSettings;
  const fromEnv = process.env.CNAS_CHROME_PATH?.trim();
  if (fromEnv) return fromEnv;
  return detectLocalChromiumPath();
}

function detectLocalChromiumPath(): string {
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((p) => p && !p.startsWith('Google') && !p.startsWith('Microsoft'));
  return candidates.find((p) => fs.existsSync(p)) ?? '';
}

/** CNAS 抓取每页节流下限（ms）：settings 合法值优先，否则回退默认。 */
export function getCnasThrottleMs(db: Database.Database): number {
  const raw = getSetting(db, SETTING_CNAS_THROTTLE_MS, '').trim();
  if (!raw) return DEFAULT_CNAS_THROTTLE_MS;   // 空串 Number('')===0，须先排除
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= THROTTLE_MAX_MS) return n;
  return DEFAULT_CNAS_THROTTLE_MS;
}

/** 国家 CMA 抓取开关：默认关，避免误触滑块站点；用户确认后在设置页开启。 */
export function isNatCmaScrapeEnabled(db: Database.Database): boolean {
  return getSetting(db, SETTING_NAT_CMA_ENABLED, '0').trim() === '1';
}

/** 国家 CMA 浏览器 executablePath：独立设置优先，其次 NAT_CMA_CHROME_PATH，再回退 CNAS/本机浏览器。 */
export function getNatCmaChromePath(db: Database.Database): string {
  const fromSettings = getSetting(db, SETTING_NAT_CMA_CHROME_PATH, '').trim();
  if (fromSettings) return fromSettings;
  const fromEnv = process.env.NAT_CMA_CHROME_PATH?.trim();
  if (fromEnv) return fromEnv;
  return getCnasChromePath(db);
}

/** 国家 CMA 抓取每页节流下限（ms）。 */
export function getNatCmaThrottleMs(db: Database.Database): number {
  const raw = getSetting(db, SETTING_NAT_CMA_THROTTLE_MS, '').trim();
  if (!raw) return DEFAULT_NAT_CMA_THROTTLE_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= THROTTLE_MAX_MS) return n;
  return DEFAULT_NAT_CMA_THROTTLE_MS;
}

export interface SystemSettingsInput {
  cnasChromePath?: string;
  cnasThrottleMs?: number;
  natCmaEnabled?: boolean;
  natCmaChromePath?: string;
  natCmaThrottleMs?: number;
}

/** 写入抓取设置（仅写传入的字段；number/boolean 存为字符串）。 */
export function setSystemSettings(db: Database.Database, input: SystemSettingsInput): void {
  if (input.cnasChromePath !== undefined) {
    setSetting(db, SETTING_CNAS_CHROME_PATH, input.cnasChromePath.trim());
  }
  if (input.cnasThrottleMs !== undefined) {
    setSetting(db, SETTING_CNAS_THROTTLE_MS, String(input.cnasThrottleMs));
  }
  if (input.natCmaEnabled !== undefined) {
    setSetting(db, SETTING_NAT_CMA_ENABLED, input.natCmaEnabled ? '1' : '0');
  }
  if (input.natCmaChromePath !== undefined) {
    setSetting(db, SETTING_NAT_CMA_CHROME_PATH, input.natCmaChromePath.trim());
  }
  if (input.natCmaThrottleMs !== undefined) {
    setSetting(db, SETTING_NAT_CMA_THROTTLE_MS, String(input.natCmaThrottleMs));
  }
}

/** 读取当前有效抓取设置（回退后的值，供设置页回显）。 */
export function getSystemSettings(db: Database.Database): {
  cnasChromePath: string;
  cnasThrottleMs: number;
  natCmaEnabled: boolean;
  natCmaChromePath: string;
  natCmaThrottleMs: number;
} {
  return {
    cnasChromePath: getCnasChromePath(db),
    cnasThrottleMs: getCnasThrottleMs(db),
    natCmaEnabled: isNatCmaScrapeEnabled(db),
    natCmaChromePath: getNatCmaChromePath(db),
    natCmaThrottleMs: getNatCmaThrottleMs(db),
  };
}

// ─── 数据总览 ─────────────────────────────────────────────────────────────────────

export interface OrgSourceOverview {
  source: string;
  label: string;
  count: number;                  // 本机构明细实算条数
  dataOrigin: string | null;      // scraped / imported / manual（labs 占位行，无则 null）
  lastSyncAt: string | null;
}

export interface SystemOverview {
  orgSources: OrgSourceOverview[];
  capLib: {
    total: number;
    active: number;
    subscribedDomains: number;
    lastSyncedAt: string | null;
    dataOrigin: 'scraped';
  };
  watchlists: { lists: number; items: number };
}

/** 聚合各资质源 + 清单的只读总览。纯查询，毫秒级，可单测。 */
export function collectOverview(db: Database.Database): SystemOverview {
  const orgSources: OrgSourceOverview[] = ORG_SOURCES.map((source) => {
    const meta = ORG_SOURCE_TABLE[source];
    // 条数实算（不信 labs.record_count 占位）
    const cnt = db.prepare(
      `SELECT COUNT(*) AS c FROM ${meta.qualTable} WHERE ${meta.orgCol} = ?`,
    ).get(SELF_ORG_ID) as { c: number };
    // 来源 + 最后同步取自 labs 占位行
    const lab = db.prepare(
      `SELECT data_origin, last_sync_at FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`,
    ).get(SELF_ORG_ID) as { data_origin: string | null; last_sync_at: string | null } | undefined;
    return {
      source,
      label: meta.label,
      count: cnt.c,
      dataOrigin: lab?.data_origin ?? null,
      lastSyncAt: lab?.last_sync_at ?? null,
    };
  });

  const capTotal = db.prepare('SELECT COUNT(*) AS c FROM cap_lib').get() as { c: number };
  const capActive = db.prepare(
    "SELECT COUNT(*) AS c FROM cap_lib WHERE lib_status = 'active'",
  ).get() as { c: number };
  const capSub = db.prepare(
    'SELECT COUNT(*) AS c FROM cap_lib_meta WHERE subscribed = 1',
  ).get() as { c: number };
  const capLast = db.prepare(
    "SELECT MAX(last_synced_at) AS t FROM cap_lib_meta WHERE last_synced_at <> ''",
  ).get() as { t: string | null };

  const wlLists = db.prepare('SELECT COUNT(*) AS c FROM watchlists').get() as { c: number };
  const wlItems = db.prepare('SELECT COUNT(*) AS c FROM watchlist_items').get() as { c: number };

  return {
    orgSources,
    capLib: {
      total: capTotal.c,
      active: capActive.c,
      subscribedDomains: capSub.c,
      lastSyncedAt: capLast.t ?? null,
      dataOrigin: 'scraped',
    },
    watchlists: { lists: wlLists.c, items: wlItems.c },
  };
}

// ─── 全库备份 ─────────────────────────────────────────────────────────────────────

const BACKUP_PREFIX = 'qual-match-backup-';

/** 清理 data/ 下的旧备份临时文件（best-effort，防进程崩溃残留）。 */
function cleanupStaleBackups(dataDir: string): void {
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (name.startsWith(BACKUP_PREFIX) && name.endsWith('.db')) {
        try { fs.unlinkSync(path.join(dataDir, name)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * 用 SQLite online backup 导出整库一致快照到临时文件，返回其路径。
 * 用 .backup() 而非 fs.copyFile：自动 checkpoint WAL，避免拿到不完整库。
 * 调用方负责传输后删除该临时文件。
 */
export async function backupDatabase(db: Database.Database): Promise<string> {
  const dataDir = path.join(getRootDir(), 'data');
  cleanupStaleBackups(dataDir);
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  const tmpPath = path.join(dataDir, `${BACKUP_PREFIX}${Date.now()}-${rand}.db`);
  await db.backup(tmpPath);
  return tmpPath;
}
