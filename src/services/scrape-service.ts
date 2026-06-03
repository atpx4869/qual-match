import type Database from 'better-sqlite3';
import { cleanStdCode, extractFullCode, extractBaseCode } from '../shared/std-code';
import { SELF_ORG_ID, ORG_SOURCE_TABLE } from '../shared/constants';
import { setProgress, eachProgress, enqueueSync, makeJobId } from './sync-progress';
import { CmaScraper, type CmaCapability, type CmaDetail } from '../sources/prov-cma/cma-scraper';
import { CnasScraper, type CnasCapability, type CnasLabInfo } from '../sources/cnas/cnas-scraper';
import { PRESET_CNAS_LABS } from '../sources/cnas/preset-cnas-labs';

/**
 * 抓取入库编排（阶段 4）。把省级 CMA / CNAS 抓取器的产出统一：
 *   抓取 → 三层归一化 → 替换本机构旧明细（SELF_ORG_ID）→ 写 labs 占位行。
 *
 * 单一机构定位：抓来的资质全部归本机构，与 Excel 导入同表、同归一化、同匹配引擎。
 * 进度/串行队列复用公共 sync-progress（与 cap-lib 同框架，防事件循环锁死）。
 */

const cmaScraper = new CmaScraper();
const cnasScraper = new CnasScraper();

/** app shutdown 时关 CNAS 浏览器。 */
export async function closeScrapers(): Promise<void> {
  await cnasScraper.close();
}

/** 省级 CMA 按机构名搜候选（同步，直接 await 抓取器）。 */
export function searchProvCmaLabs(orgName: string) {
  return cmaScraper.searchLabsByName(orgName);
}

/** 列出内置 CNAS 机构 + 是否已抓（本机构在 cnas_qualifications 是否有行）。 */
export function listCnasPresets(db: Database.Database) {
  const synced = db.prepare(
    `SELECT COUNT(*) AS c FROM ${ORG_SOURCE_TABLE.cnas.qualTable} WHERE ${ORG_SOURCE_TABLE.cnas.orgCol} = ?`,
  ).get(SELF_ORG_ID) as { c: number };
  return PRESET_CNAS_LABS.map((p) => ({
    labName: p.labName,
    labNo: p.labNo,
    note: p.note ?? '',
    syncedCount: synced.c,
  }));
}

const CHUNK = 200;

/** 通用：替换本机构某源旧明细 + 分块插入 + 维护 labs 占位行。 */
function ingest(
  db: Database.Database,
  source: 'prov_cma' | 'cnas',
  certNumber: string,
  labName: string,
  rows: Array<Record<string, string>>,
): number {
  const meta = ORG_SOURCE_TABLE[source];
  const cols = [
    meta.orgCol, 'std_code', 'std_code_norm', 'std_code_base', 'std_name',
    'effective_date', 'expiry_date', 'category', 'sub_category',
    'test_object', 'test_param', 'test_standard', 'limit_desc',
  ];
  const placeholders = cols.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO ${meta.qualTable} (${cols.join(', ')}) VALUES (${placeholders})`);

  // 归一化 + 过滤空号
  const prepared = rows.map((r) => {
    const clean = cleanStdCode(r.stdCode ?? '');
    if (!clean) return null;
    const norm = extractFullCode(clean);
    if (!norm) return null;
    return [
      SELF_ORG_ID, clean, norm, extractBaseCode(clean), r.stdName ?? '',
      r.effectiveDate ?? '', r.expiryDate ?? '', r.category ?? '', r.subCategory ?? '',
      r.testObject ?? '', r.testParam ?? '', r.testStandard ?? '', r.limitDesc ?? '',
    ];
  }).filter((x): x is string[] => x !== null);

  // replace：清掉本机构旧明细，分块插入
  const delTxn = db.transaction(() => {
    db.prepare(`DELETE FROM ${meta.qualTable} WHERE ${meta.orgCol} = ?`).run(SELF_ORG_ID);
  });
  delTxn();

  const insChunk = db.transaction((batch: string[][]) => {
    for (const vals of batch) insert.run(...vals);
  });
  for (let i = 0; i < prepared.length; i += CHUNK) insChunk(prepared.slice(i, i + CHUNK));

  // 维护 labs 占位行（cert_number/lab_no = certNumber 或 SELF_ORG_ID 时一致用占位）
  ensureSelfLab(db, source, prepared.length, labName);
  return prepared.length;
}

/** 维护本机构在 labs 表的占位行（record_count / data_origin='scraped' / last_sync_at）。 */
function ensureSelfLab(db: Database.Database, source: 'prov_cma' | 'cnas', recordCount: number, labName: string): void {
  const meta = ORG_SOURCE_TABLE[source];
  const existing = db.prepare(`SELECT id FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`).get(SELF_ORG_ID);
  if (existing) {
    db.prepare(`UPDATE ${meta.labTable} SET lab_name = ?, record_count = ?, data_origin = 'scraped', sync_status = 'success', last_sync_at = datetime('now') WHERE ${meta.orgCol} = ?`)
      .run(labName || '本机构', recordCount, SELF_ORG_ID);
  } else {
    db.prepare(`INSERT INTO ${meta.labTable} (${meta.orgCol}, lab_name, record_count, data_origin, sync_status, last_sync_at) VALUES (?, ?, ?, 'scraped', 'success', datetime('now'))`)
      .run(SELF_ORG_ID, labName || '本机构', recordCount);
  }
}

// ─── 省级 CMA 同步 ──────────────────────────────────────────────────────────────
export function startProvCmaSync(db: Database.Database, publicDetailId: string): string {
  for (const [jid, p] of eachProgress()) {
    if (p.target === `prov_cma:${publicDetailId}` && p.phase !== 'done' && p.phase !== 'error') return jid;
  }
  const jobId = makeJobId('prov-cma-sync');
  const target = `prov_cma:${publicDetailId}`;
  setProgress(jobId, { phase: 'pending', target, current: 0, total: 0 });

  enqueueSync(async () => {
    try {
      setProgress(jobId, { phase: 'fetching', target, current: 0, total: 0 });
      const { detail, capabilities } = await cmaScraper.scrapeFull(publicDetailId);
      setProgress(jobId, { phase: 'upserting', target, current: 0, total: capabilities.length });
      const count = ingest(db, 'prov_cma', detail.certificateNumber, detail.sysName, capabilities.map((c) => mapCma(c, detail)));
      setProgress(jobId, { phase: 'done', target, current: count, total: count });
    } catch (err) {
      setProgress(jobId, { phase: 'error', target, current: 0, total: 0, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return jobId;
}

function mapCma(c: CmaCapability, detail: CmaDetail): Record<string, string> {
  return {
    stdCode: c.yjbzNumber,
    stdName: c.yjbzNameNumber,
    testParam: c.cpName,
    category: c.parentName,
    limitDesc: c.xzfw,
    effectiveDate: detail.licValidTimeBegin,
    expiryDate: detail.licValidTimeEnd,
  };
}

// ─── CNAS 同步 ──────────────────────────────────────────────────────────────────
export function startCnasSync(db: Database.Database, labNo: string): string {
  const preset = PRESET_CNAS_LABS.find((p) => p.labNo === labNo);
  if (!preset) throw new Error(`未找到内置 CNAS 机构：${labNo}`);
  for (const [jid, p] of eachProgress()) {
    if (p.target === `cnas:${labNo}` && p.phase !== 'done' && p.phase !== 'error') return jid;
  }
  const jobId = makeJobId('cnas-sync');
  const target = `cnas:${labNo}`;
  setProgress(jobId, { phase: 'pending', target, current: 0, total: 0 });

  const labInfo: CnasLabInfo = {
    baseInfoId: preset.baseInfoId,
    labNo: preset.labNo,
    labName: preset.labName,
    certUpdateTs: preset.certUpdateTs ?? '',
    validate: preset.validate ?? '',
    urlParams: preset.urlParams ?? {},
  };

  enqueueSync(async () => {
    try {
      setProgress(jobId, { phase: 'fetching', target, current: 0, total: 0 });
      const caps = await cnasScraper.fetchCapabilities(labInfo, (fetched, total) => {
        setProgress(jobId, { phase: 'fetching', target, current: fetched, total });
      });
      setProgress(jobId, { phase: 'upserting', target, current: 0, total: caps.length });
      const count = ingest(db, 'cnas', preset.labNo, preset.labName, caps.map(mapCnas));
      setProgress(jobId, { phase: 'done', target, current: count, total: count });
    } catch (err) {
      setProgress(jobId, { phase: 'error', target, current: 0, total: 0, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return jobId;
}

function mapCnas(c: CnasCapability): Record<string, string> {
  return {
    stdCode: c.stdCode || c.stdDescAndClause,
    stdName: c.stdAllDesc || c.stdDescAndClause,
    testObject: c.objCh,
    testParam: c.paramCh,
    testStandard: c.stdDescAndClause,
    category: c.bigTypeName,
    subCategory: c.typeName,
    limitDesc: c.limitCh,
  };
}
