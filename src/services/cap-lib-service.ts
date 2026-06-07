/**
 * 一单一库（能力项目库）镜像与比对服务（阶段 3）。
 *
 * 三个核心能力（移植自 bzxz cap-lib-service，去多用户 + 去 bzxz 专属功能）：
 * 1) syncDomain：抓取一个领域全量行，hash diff 后 upsert + 标记 last_seen_at（soft delete）
 * 2) batchStatus：把一批标准号与 cap_lib 对比，输出 5 档状态（匹配引擎/综合查询复用）
 * 3) listDomains / cleanupStaleRows：领域元数据 + 孤儿行清理
 *
 * 远端接口（实测无鉴权）：
 *   GET https://cma.caqit.org.cn/cma-admin/system/standardData/list?pageNum=N&pageSize=2000&domain=<name>
 * 返回 RuoYi 标准 { total, rows[], code, msg }。**分页拉取**（远端按行数线性变慢，
 * 41k 行单请求会超时），pageSize=2000 逐页拉、边拉边报进度。
 *
 * 与机构型源正交：本表是「政策范围内合法标准号清单」，机构源是「本机构持有的资质行」。
 * 一单一库「在库」≠「本机构有资质」，故匹配引擎的 matched 不看 cap_lib（独立维度展示）。
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { cleanStdCode, extractFullCode, extractBaseCode } from '../shared/std-code';
import { parseLibStatus, libStatusPriority, type LibStatus, type DiffStatus } from '../shared/cap-lib-status';
import { CAP_LIB_DOMAINS, isValidCapLibDomain } from '../shared/cap-lib-domains';
import { setSetting } from './db';
import {
  setProgress, pruneProgressStore, eachProgress, enqueueSync, makeJobId,
  getSyncProgress, type SyncProgress as BaseSyncProgress,
} from './sync-progress';

export { getSyncProgress };

const REMOTE_BASE = 'https://cma.caqit.org.cn/cma-admin/system/standardData/list';
/** 分页每页行数。单页 2000 行实测 ~36s，远低于超时且能边拉边报进度。 */
const REMOTE_PAGE_SIZE = 2000;
/** 单页响应超时（留余量覆盖远端抖动）。 */
const REMOTE_TIMEOUT_MS = 90_000;
/** 安全上限：最多拉多少页，防远端 total 异常死循环。41285/2000≈21 页，留到 100。 */
const REMOTE_MAX_PAGES = 100;

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface RemoteRow {
  id: number;
  domain: string | null;
  standardMethod: string | null;
  standardCode: string | null;
  remark: string | null;
  status: string | null;
  updateTime: string | null;
}

interface RemoteListResp {
  total: number;
  rows: RemoteRow[];
  code: number;
  msg: string;
}

export interface SyncStats {
  added: number;
  changed: number;
  unchanged: number;
  removedSoft: number;   // 远端不再出现、本地仍保留
  durationMs: number;
}

/** cap-lib 进度：通用进度 + cap-lib 专属 SyncStats。target 承载领域名。 */
export type SyncProgress = BaseSyncProgress<SyncStats>;

export interface DomainMeta {
  domain: string;
  subscribed: boolean;
  lastSyncedAt: string;
  remoteTotal: number;
  localTotal: number;
  approxCount: number;          // 静态预估（仅 UI 初显）
  recommendedDefault: boolean;
  lastSyncStats: SyncStats | null;
}

/** 单个标准号 vs 一单一库的 5 档比对结果（匹配引擎/综合查询用）。 */
export interface CapLibStatus {
  status: DiffStatus;
  inLib: boolean;               // in_lib / cite_only / abolished 任一（保年命中库）
  libDomain: string;            // 命中领域
  libStatus: LibStatus | '';    // 库内 active/cite_only/abolished
  libRemark: string;
  seriesNewCode: string;        // series_only 时给出推荐替代年版（库内现行 active 号）
  stale: boolean;               // 尚无任何领域同步过 → 状态不可信
}

// ─── 同步进度 / 串行队列：复用公共 sync-progress 模块 ─────────────────────────────

/** 行内容指纹（diff 用）：内容不变则跳过重写，只 touch last_seen_at。 */
function hashRow(
  domain: string, standardMethod: string, stdCode: string, remark: string, libStatus: string, rawStatus: string,
): string {
  return crypto.createHash('sha1')
    .update([domain, standardMethod, stdCode, remark, libStatus, rawStatus].join(''))
    .digest('hex');
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class CapLibService {
  constructor(private db: Database.Database) {}

  // ── 元数据 ──
  listDomains(): DomainMeta[] {
    const rows = this.db.prepare(`
      SELECT domain, subscribed, last_synced_at, remote_total, local_total, last_sync_stats
      FROM cap_lib_meta
    `).all() as Array<{
      domain: string; subscribed: number; last_synced_at: string;
      remote_total: number; local_total: number; last_sync_stats: string;
    }>;
    const metaByDomain = new Map(rows.map((r) => [r.domain, r]));

    // 以 CAP_LIB_DOMAINS 顺序为准（占库大的在前），合并静态预估值
    return CAP_LIB_DOMAINS.map((d) => {
      const r = metaByDomain.get(d.name);
      return {
        domain: d.name,
        subscribed: !!(r && r.subscribed),
        lastSyncedAt: r?.last_synced_at || '',
        remoteTotal: r?.remote_total || 0,
        localTotal: r?.local_total || 0,
        approxCount: d.approxCount,
        recommendedDefault: d.recommendedDefault,
        lastSyncStats: this.parseStats(r?.last_sync_stats),
      };
    });
  }

  private parseStats(raw: string | null | undefined): SyncStats | null {
    if (!raw) return null;
    try { return JSON.parse(raw) as SyncStats; } catch { return null; }
  }

  setSubscribed(domain: string, subscribed: boolean): void {
    if (!isValidCapLibDomain(domain)) throw new Error(`非法领域名: ${domain}`);
    this.db.prepare('UPDATE cap_lib_meta SET subscribed = ? WHERE domain = ?')
      .run(subscribed ? 1 : 0, domain);
  }

  // ── 抓取 ──

  /**
   * 同步单一领域。fire-and-forget —— 调用方拿到 jobId 后通过 getSyncProgress 轮询。
   * 同一领域并发触发会复用 running job 的 jobId。
   */
  startSync(domain: string): string {
    if (!isValidCapLibDomain(domain)) throw new Error(`非法领域名: ${domain}`);
    for (const [jid, p] of eachProgress()) {
      if (p.target === domain && p.phase !== 'done' && p.phase !== 'error') return jid;
    }
    const jobId = makeJobId('cap-lib-sync');
    setProgress(jobId, { phase: 'pending', target: domain, current: 0, total: 0 });
    pruneProgressStore();

    enqueueSync(() => this.runSync(jobId, domain).catch((err) => {
      setProgress(jobId, {
        phase: 'error', target: domain, current: 0, total: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }));
    return jobId;
  }

  private async runSync(jobId: string, domain: string): Promise<void> {
    const startedAt = Date.now();
    setProgress(jobId, { phase: 'fetching', target: domain, current: 0, total: 0 });

    // 1) 远端分页拉全。远端按行数线性变慢，单次拉 41k 行要 5-7 分钟会超时；按页拉，
    //    每页独立短请求 + 实时报「拉取中 X/total」。第一页拿到 total 后算总页数。
    const rows: RemoteRow[] = [];
    let remoteTotal = 0;
    for (let pageNum = 1; pageNum <= REMOTE_MAX_PAGES; pageNum++) {
      const url = `${REMOTE_BASE}?pageNum=${pageNum}&pageSize=${REMOTE_PAGE_SIZE}&domain=${encodeURIComponent(domain)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      } catch (e) {
        throw new Error(`远端第 ${pageNum} 页请求失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`远端第 ${pageNum} 页 HTTP ${resp.status}`);
      const data = await resp.json() as RemoteListResp;
      if (data.code !== 200) throw new Error(`远端返回 code=${data.code} msg=${data.msg}`);
      const pageRows = Array.isArray(data.rows) ? data.rows : [];
      if (pageNum === 1) remoteTotal = Number(data.total) || pageRows.length;
      rows.push(...pageRows);
      setProgress(jobId, { phase: 'fetching', target: domain, current: rows.length, total: remoteTotal });
      if (rows.length >= remoteTotal || pageRows.length < REMOTE_PAGE_SIZE) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const total = rows.length;

    // 2) 解析 + 入库
    setProgress(jobId, { phase: 'upserting', target: domain, current: 0, total });
    const now = new Date().toISOString();
    const stats: SyncStats = { added: 0, changed: 0, unchanged: 0, removedSoft: 0, durationMs: 0 };

    // 本次未出现的旧 source_id 算 removedSoft
    const prevIds = new Set<number>(
      (this.db.prepare('SELECT source_id FROM cap_lib WHERE domain = ?')
        .all(domain) as Array<{ source_id: number }>).map((r) => r.source_id),
    );
    const seenIds = new Set<number>();

    const selStmt = this.db.prepare('SELECT row_hash FROM cap_lib WHERE source_id = ?');
    const insStmt = this.db.prepare(`
      INSERT INTO cap_lib
        (source_id, domain, standard_method, std_code, std_code_norm, std_code_base,
         remark, lib_status, raw_status, row_hash, last_seen_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        domain          = excluded.domain,
        standard_method = excluded.standard_method,
        std_code        = excluded.std_code,
        std_code_norm   = excluded.std_code_norm,
        std_code_base   = excluded.std_code_base,
        remark          = excluded.remark,
        lib_status      = excluded.lib_status,
        raw_status      = excluded.raw_status,
        row_hash        = excluded.row_hash,
        last_seen_at    = excluded.last_seen_at
    `);
    const touchStmt = this.db.prepare('UPDATE cap_lib SET last_seen_at = ? WHERE source_id = ?');

    // 分块事务：每批 CHUNK 行一个 transaction，批次间 setImmediate 让出事件循环，
    // 避免 41k 行单事务长时间锁死主线程（CLAUDE.md 约定）。stats/seenIds 批外累计。
    const CHUNK = 2000;
    const runChunk = this.db.transaction((batch: RemoteRow[]) => {
      for (const r of batch) {
        if (typeof r.id !== 'number') continue;
        const sourceId = r.id;
        seenIds.add(sourceId);

        const stdCode = cleanStdCode(r.standardCode || '');
        const stdCodeNorm = extractFullCode(stdCode);
        const stdCodeBase = extractBaseCode(stdCode);
        const remark = r.remark || '';
        const libStatus = parseLibStatus(remark);
        const rawStatus = r.status || '';
        const standardMethod = r.standardMethod || '';
        const rowHash = hashRow(domain, standardMethod, stdCode, remark, libStatus, rawStatus);

        const existing = selStmt.get(sourceId) as { row_hash: string } | undefined;
        if (existing && existing.row_hash === rowHash) {
          touchStmt.run(now, sourceId);
          stats.unchanged++;
        } else {
          insStmt.run(
            sourceId, domain, standardMethod, stdCode, stdCodeNorm, stdCodeBase,
            remark, libStatus, rawStatus, rowHash, now, now,
          );
          if (existing) stats.changed++; else stats.added++;
        }
      }
    });

    for (let i = 0; i < rows.length; i += CHUNK) {
      runChunk(rows.slice(i, i + CHUNK));
      const done = Math.min(i + CHUNK, rows.length);
      setProgress(jobId, { phase: 'upserting', target: domain, current: done, total });
      if (done < rows.length) await new Promise<void>((resolve) => setImmediate(resolve));
    }

    for (const id of prevIds) if (!seenIds.has(id)) stats.removedSoft++;
    stats.durationMs = Date.now() - startedAt;

    const localTotal = (this.db.prepare('SELECT COUNT(*) AS c FROM cap_lib WHERE domain = ?')
      .get(domain) as { c: number }).c;
    this.db.prepare(`
      UPDATE cap_lib_meta
      SET subscribed = 1, last_synced_at = ?, remote_total = ?, local_total = ?, last_sync_stats = ?
      WHERE domain = ?
    `).run(now, total, localTotal, JSON.stringify(stats), domain);
    setSetting(this.db, 'cap_lib_last_synced_at', now);

    setProgress(jobId, { phase: 'done', target: domain, current: total, total, stats });
  }

  /** 清理 N 天未见的孤儿行。返回删除条数。 */
  cleanupStaleRows(daysThreshold = 30): number {
    const cutoff = new Date(Date.now() - daysThreshold * 86400_000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM cap_lib WHERE last_seen_at != '' AND last_seen_at < ?",
    ).run(cutoff);
    this.db.prepare(`
      UPDATE cap_lib_meta
      SET local_total = (SELECT COUNT(*) FROM cap_lib WHERE domain = cap_lib_meta.domain)
    `).run();
    return result.changes ?? 0;
  }

  /**
   * 一批标准号 vs 一单一库的 5 档比对（匹配引擎 / 综合查询复用）。
   *
   * 算法：每个输入号算 fullCode + baseCode，分别在 cap_lib 走 std_code_norm 等值（保年命中）
   * 和 std_code_base 等值（剥年兜底，只看 active）两路索引。
   *   - 保年命中 active     → in_lib
   *   - 保年命中 cite_only  → cite_only
   *   - 保年命中 abolished  → abolished
   *   - 保年未命中、剥年命中其他年版 active → series_only（给推荐替代年版）
   *   - 都未命中            → not_in_lib
   *
   * stale：尚无任何领域同步过 → 状态不可信（前端提示「先同步」）。
   */
  batchStatus(stdCodes: string[]): Record<string, CapLibStatus> {
    const result: Record<string, CapLibStatus> = {};
    if (stdCodes.length === 0) return result;

    const anySynced = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM cap_lib_meta WHERE last_synced_at != ''",
    ).get() as { c: number }).c > 0;

    type Key = { input: string; full: string; base: string };
    const keys: Key[] = [];
    const fullSet = new Set<string>();
    const baseSet = new Set<string>();
    for (const c of stdCodes) {
      const full = extractFullCode(c);
      const base = extractBaseCode(c);
      keys.push({ input: c, full, base });
      if (full) fullSet.add(full);
      if (base) baseSet.add(base);
    }
    const fulls = [...fullSet];
    const bases = [...baseSet];

    // 分块 IN 查询上限（SQLite 变量上限保险；全量清单 2 万+ 也安全）
    const IN_CHUNK = 500;

    // 保年命中：std_code_norm IN (...)，同号跨领域取最高优先级状态
    const exactMap = new Map<string, { libStatus: LibStatus; remark: string; domain: string }>();
    for (let i = 0; i < fulls.length; i += IN_CHUNK) {
      const chunk = fulls.slice(i, i + IN_CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT std_code_norm, lib_status, remark, domain FROM cap_lib WHERE std_code_norm IN (${ph})
      `).all(...chunk) as Array<{ std_code_norm: string; lib_status: LibStatus; remark: string; domain: string }>;
      for (const r of rows) {
        const prev = exactMap.get(r.std_code_norm);
        if (!prev || libStatusPriority(r.lib_status) > libStatusPriority(prev.libStatus)) {
          exactMap.set(r.std_code_norm, { libStatus: r.lib_status, remark: r.remark || '', domain: r.domain });
        }
      }
    }

    // 剥年命中（只看 active 最新年版）。分块后不能靠 SQL 全局排序取首条，
    // 改为按 std_code_norm 跨块比较取最大（最新年版），保证与未分块时一致。
    const seriesMap = new Map<string, { stdCode: string; domain: string; norm: string }>();
    for (let i = 0; i < bases.length; i += IN_CHUNK) {
      const chunk = bases.slice(i, i + IN_CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT std_code_base, std_code, std_code_norm, domain FROM cap_lib
        WHERE std_code_base IN (${ph}) AND lib_status = 'active'
      `).all(...chunk) as Array<{ std_code_base: string; std_code: string; std_code_norm: string; domain: string }>;
      for (const r of rows) {
        const prev = seriesMap.get(r.std_code_base);
        if (!prev || r.std_code_norm > prev.norm) {
          seriesMap.set(r.std_code_base, { stdCode: r.std_code, domain: r.domain, norm: r.std_code_norm });
        }
      }
    }

    for (const k of keys) {
      const exact = k.full ? exactMap.get(k.full) : undefined;
      const series = k.base ? seriesMap.get(k.base) : undefined;
      let status: DiffStatus;
      if (exact) {
        status = exact.libStatus === 'active' ? 'in_lib'
          : exact.libStatus === 'cite_only' ? 'cite_only'
          : 'abolished';
      } else if (series && series.stdCode && extractFullCode(series.stdCode) !== k.full) {
        status = 'series_only';
      } else {
        status = 'not_in_lib';
      }
      result[k.input] = {
        status,
        inLib: status === 'in_lib' || status === 'cite_only' || status === 'abolished',
        libDomain: exact?.domain || '',
        libStatus: exact?.libStatus || '',
        libRemark: exact?.remark || '',
        seriesNewCode: status === 'series_only' ? (series?.stdCode || '') : '',
        stale: !anySynced,
      };
    }
    return result;
  }
}
