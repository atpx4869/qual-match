import type Database from 'better-sqlite3';
import { cleanStdCode, extractFullCode, extractBaseCode } from '../shared/std-code';
import { SELF_ORG_ID, ORG_SOURCE_TABLE, type OrgSource } from '../shared/constants';
import { setProgress, eachProgress, enqueueSync, makeJobId } from './sync-progress';
import {
  getCnasChromePath, getCnasThrottleMs,
  getNatCmaChromePath, getNatCmaThrottleMs, isNatCmaScrapeEnabled,
} from './system-service';
import { CmaScraper, type CmaCapability, type CmaDetail } from '../sources/prov-cma/cma-scraper';
import { CnasScraper, type CnasCapability, type CnasLabInfo } from '../sources/cnas/cnas-scraper';
import { PRESET_CNAS_LABS } from '../sources/cnas/preset-cnas-labs';
import { NatCmaScraper, type NatCmaCapability, type NatCmaOrg } from '../sources/nat-cma/nat-cma-scraper';

/**
 * 抓取入库编排（阶段 4 + 国家 CMA）。把省级 CMA / CNAS / 国家 CMA 抓取器的产出统一：
 *   抓取 → 三层归一化 → 替换本机构旧明细（SELF_ORG_ID）→ 写 labs 占位行。
 *
 * 单一机构定位：抓来的资质全部归本机构，与 Excel 导入同表、同归一化、同匹配引擎。
 * 进度/串行队列复用公共 sync-progress（与 cap-lib 同框架，防事件循环锁死）。
 */

const cmaScraper = new CmaScraper();
const cnasScraper = new CnasScraper();
const natCmaScraper = new NatCmaScraper();

/** app shutdown 时关 CNAS / 国家 CMA 浏览器。 */
export async function closeScrapers(): Promise<void> {
  await cnasScraper.close();
  await natCmaScraper.close();
}

/** 省级 CMA 按机构名搜候选（同步，直接 await 抓取器）。 */
export function searchProvCmaLabs(orgName: string) {
  return cmaScraper.searchLabsByName(orgName);
}

export interface ProvCmaSubscribeInput {
  publicDetailId: string;
  labName: string;
  region?: string;
}

export function subscribeProvCmaLab(db: Database.Database, input: ProvCmaSubscribeInput): void {
  const meta = ORG_SOURCE_TABLE.prov_cma;
  const count = countLocalRows(db, 'prov_cma');
  upsertLabRow(db, 'prov_cma', {
    labName: input.labName,
    sourceRef: input.publicDetailId,
    region: input.region ?? '',
    recordCount: count,
    dataOrigin: count > 0 ? 'scraped' : 'subscribed',
    syncStatus: count > 0 ? 'success' : 'pending',
  });
  db.prepare(`UPDATE ${meta.labTable} SET sync_error = NULL WHERE ${meta.orgCol} = ?`).run(SELF_ORG_ID);
}

export function subscribeCnasLab(db: Database.Database, labNo: string): void {
  const preset = PRESET_CNAS_LABS.find((p) => p.labNo === labNo);
  if (!preset) throw new Error(`未找到内置 CNAS 机构：${labNo}`);
  const count = countLocalRows(db, 'cnas');
  upsertLabRow(db, 'cnas', {
    labName: preset.labName,
    sourceRef: preset.labNo,
    region: '',
    recordCount: count,
    dataOrigin: count > 0 ? 'scraped' : 'subscribed',
    syncStatus: count > 0 ? 'success' : 'pending',
  });
}

/** 列出内置 CNAS 机构 + 是否已抓（本机构在 cnas_qualifications 是否有行）。 */
export function listCnasPresets(db: Database.Database) {
  const synced = db.prepare(
    `SELECT COUNT(*) AS c FROM ${ORG_SOURCE_TABLE.cnas.qualTable} WHERE ${ORG_SOURCE_TABLE.cnas.orgCol} = ?`,
  ).get(SELF_ORG_ID) as { c: number };
  const lab = db.prepare(
    `SELECT source_ref FROM ${ORG_SOURCE_TABLE.cnas.labTable} WHERE ${ORG_SOURCE_TABLE.cnas.orgCol} = ?`,
  ).get(SELF_ORG_ID) as { source_ref: string | null } | undefined;
  return PRESET_CNAS_LABS.map((p) => ({
    labName: p.labName,
    labNo: p.labNo,
    note: p.note ?? '',
    syncedCount: synced.c,
    subscribed: lab?.source_ref === p.labNo,
  }));
}

const CHUNK = 200;

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function countLocalRows(db: Database.Database, source: OrgSource): number {
  const meta = ORG_SOURCE_TABLE[source];
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM ${meta.qualTable} WHERE ${meta.orgCol} = ?`,
  ).get(SELF_ORG_ID) as { c: number };
  return row.c;
}

interface LabRowInput {
  labName: string;
  sourceRef: string;
  region: string;
  recordCount: number;
  dataOrigin: string;
  syncStatus: string;
  syncError?: string | null;
}

function upsertLabRow(db: Database.Database, source: OrgSource, input: LabRowInput): void {
  const meta = ORG_SOURCE_TABLE[source];
  const existing = db.prepare(`SELECT id FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`).get(SELF_ORG_ID);
  if (existing) {
    db.prepare(
      `UPDATE ${meta.labTable}
       SET lab_name = ?, source_ref = ?, region = ?, record_count = ?, data_origin = ?, sync_status = ?, sync_error = ?
       WHERE ${meta.orgCol} = ?`,
    ).run(
      input.labName || '本机构', input.sourceRef, input.region, input.recordCount,
      input.dataOrigin, input.syncStatus, input.syncError ?? null, SELF_ORG_ID,
    );
  } else {
    db.prepare(
      `INSERT INTO ${meta.labTable}
        (${meta.orgCol}, lab_name, source_ref, region, record_count, data_origin, sync_status, sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SELF_ORG_ID, input.labName || '本机构', input.sourceRef, input.region,
      input.recordCount, input.dataOrigin, input.syncStatus, input.syncError ?? null,
    );
  }
}

function updateLabStatus(db: Database.Database, source: OrgSource, status: string, error?: string): void {
  const meta = ORG_SOURCE_TABLE[source];
  db.prepare(`UPDATE ${meta.labTable} SET sync_status = ?, sync_error = ? WHERE ${meta.orgCol} = ?`)
    .run(status, error ?? null, SELF_ORG_ID);
}

/** 通用：替换本机构某源旧明细 + 分块插入 + 维护 labs 占位行。 */
async function ingest(
  db: Database.Database,
  source: OrgSource,
  labName: string,
  sourceRef: string,
  region: string,
  rows: Array<Record<string, string>>,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
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
  onProgress?.(0, prepared.length);
  for (let i = 0; i < prepared.length; i += CHUNK) {
    const batch = prepared.slice(i, i + CHUNK);
    insChunk(batch);
    onProgress?.(Math.min(i + batch.length, prepared.length), prepared.length);
    await nextTick();
  }

  // 维护 labs 占位行（cert_number/lab_no = SELF_ORG_ID，真实订阅标识放 source_ref）
  ensureSelfLab(db, source, prepared.length, labName, sourceRef, region);
  return prepared.length;
}

/** 维护本机构在 labs 表的占位行（record_count / data_origin='scraped' / last_sync_at）。 */
function ensureSelfLab(
  db: Database.Database,
  source: OrgSource,
  recordCount: number,
  labName: string,
  sourceRef: string,
  region: string,
): void {
  const meta = ORG_SOURCE_TABLE[source];
  const existing = db.prepare(`SELECT id FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`).get(SELF_ORG_ID);
  if (existing) {
    db.prepare(
      `UPDATE ${meta.labTable}
       SET lab_name = ?, source_ref = ?, region = ?, record_count = ?, data_origin = 'scraped',
           sync_status = 'success', sync_error = NULL, last_sync_at = datetime('now')
       WHERE ${meta.orgCol} = ?`,
    ).run(labName || '本机构', sourceRef, region, recordCount, SELF_ORG_ID);
  } else {
    db.prepare(
      `INSERT INTO ${meta.labTable}
        (${meta.orgCol}, lab_name, source_ref, region, record_count, data_origin, sync_status, last_sync_at)
       VALUES (?, ?, ?, ?, ?, 'scraped', 'success', datetime('now'))`,
    ).run(SELF_ORG_ID, labName || '本机构', sourceRef, region, recordCount);
  }
}

// ─── 省级 CMA 同步 ──────────────────────────────────────────────────────────────
export function startProvCmaSync(db: Database.Database, publicDetailId?: string): string {
  const targetId = publicDetailId || getSubscribedSourceRef(db, 'prov_cma');
  if (!targetId) throw new Error('请先订阅省级 CMA 机构');
  for (const [jid, p] of eachProgress()) {
    if (p.target === `prov_cma:${targetId}` && p.phase !== 'done' && p.phase !== 'error') return jid;
  }
  const jobId = makeJobId('prov-cma-sync');
  const target = `prov_cma:${targetId}`;
  setProgress(jobId, { phase: 'pending', target, current: 0, total: 0 });

  enqueueSync(async () => {
    try {
      updateLabStatus(db, 'prov_cma', 'syncing');
      setProgress(jobId, { phase: 'fetching', target, current: 0, total: 0 });
      const { detail, capabilities } = await cmaScraper.scrapeFull(targetId, (_stage, fetched, total) => {
        setProgress(jobId, { phase: 'fetching', target, current: fetched, total });
      });
      setProgress(jobId, { phase: 'upserting', target, current: 0, total: capabilities.length });
      const count = await ingest(
        db, 'prov_cma', detail.sysName, targetId, detail.areaName,
        capabilities.map((c) => mapCma(c, detail)),
        (current, total) => setProgress(jobId, { phase: 'upserting', target, current, total }),
      );
      setProgress(jobId, { phase: 'done', target, current: count, total: count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateLabStatus(db, 'prov_cma', 'error', message);
      setProgress(jobId, { phase: 'error', target, current: 0, total: 0, error: message });
    }
  });
  return jobId;
}

function getSubscribedSourceRef(db: Database.Database, source: OrgSource): string {
  const meta = ORG_SOURCE_TABLE[source];
  const row = db.prepare(`SELECT source_ref FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`).get(SELF_ORG_ID) as { source_ref: string } | undefined;
  return row?.source_ref?.trim() ?? '';
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
export function startCnasSync(db: Database.Database, labNo?: string): string {
  const targetLabNo = labNo || getSubscribedSourceRef(db, 'cnas');
  if (!targetLabNo) throw new Error('请先订阅 CNAS 机构');
  const preset = PRESET_CNAS_LABS.find((p) => p.labNo === targetLabNo);
  if (!preset) throw new Error(`未找到内置 CNAS 机构：${targetLabNo}`);
  for (const [jid, p] of eachProgress()) {
    if (p.target === `cnas:${targetLabNo}` && p.phase !== 'done' && p.phase !== 'error') return jid;
  }
  const jobId = makeJobId('cnas-sync');
  const target = `cnas:${targetLabNo}`;
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
      updateLabStatus(db, 'cnas', 'syncing');
      setProgress(jobId, { phase: 'fetching', target, current: 0, total: 0 });
      const scrapeOpts = { chromePath: getCnasChromePath(db), throttleMs: getCnasThrottleMs(db) };
      const caps = await cnasScraper.fetchCapabilities(labInfo, (fetched, total) => {
        setProgress(jobId, { phase: 'fetching', target, current: fetched, total });
      }, scrapeOpts);
      setProgress(jobId, { phase: 'upserting', target, current: 0, total: caps.length });
      const count = await ingest(
        db, 'cnas', preset.labName, preset.labNo, '',
        caps.map(mapCnas),
        (current, total) => setProgress(jobId, { phase: 'upserting', target, current, total }),
      );
      setProgress(jobId, { phase: 'done', target, current: count, total: count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateLabStatus(db, 'cnas', 'error', message);
      setProgress(jobId, { phase: 'error', target, current: 0, total: 0, error: message });
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

// ─── 国家 CMA 同步 ────────────────────────────────────────────────────────────
/** 国家 CMA 按机构名搜候选机构（同步，直接 await 抓取器）。 */
export function searchNatCmaOrgs(db: Database.Database, orgName: string) {
  if (!isNatCmaScrapeEnabled(db)) throw new Error('请先在设置页开启国家 CMA 在线抓取');
  return natCmaScraper.searchOrgs(orgName, {
    chromePath: getNatCmaChromePath(db),
    throttleMs: getNatCmaThrottleMs(db),
  });
}

export interface NatCmaSubscribeInput {
  certCode: string;
  orgName: string;
  placeId: string;
  applyId: string;
  region?: string;
}

/** 订阅国家 CMA 机构：把机构标识(placeId/applyId/orgName)写入 labs 的 source_ref(JSON)。 */
export function subscribeNatCmaLab(db: Database.Database, input: NatCmaSubscribeInput): void {
  const count = countLocalRows(db, 'nat_cma');
  const sourceRef = JSON.stringify({
    placeId: input.placeId, applyId: input.applyId, certCode: input.certCode, orgName: input.orgName,
  });
  upsertLabRow(db, 'nat_cma', {
    labName: input.orgName,
    sourceRef,
    region: input.region ?? '',
    recordCount: count,
    dataOrigin: count > 0 ? 'scraped' : 'subscribed',
    syncStatus: count > 0 ? 'success' : 'pending',
  });
}

export function startNatCmaSync(db: Database.Database, org?: NatCmaOrg): string {
  if (!isNatCmaScrapeEnabled(db)) throw new Error('请先在设置页开启国家 CMA 在线抓取');
  const target = org ?? getSubscribedNatCmaOrg(db);
  if (!target) throw new Error('请先订阅国家 CMA 机构');
  const key = target.placeId || target.certCode;
  for (const [jid, p] of eachProgress()) {
    if (p.target === `nat_cma:${key}` && p.phase !== 'done' && p.phase !== 'error') return jid;
  }
  const jobId = makeJobId('nat-cma-sync');
  const targetLabel = `nat_cma:${key}`;
  setProgress(jobId, { phase: 'pending', target: targetLabel, current: 0, total: 0 });

  const scrapeOpts = { chromePath: getNatCmaChromePath(db), throttleMs: getNatCmaThrottleMs(db) };

  enqueueSync(async () => {
    try {
      updateLabStatus(db, 'nat_cma', 'syncing');
      setProgress(jobId, { phase: 'fetching', target: targetLabel, current: 0, total: 0 });
      const { capabilities } = await natCmaScraper.scrapeOrg(target, (fetched, total) => {
        setProgress(jobId, { phase: 'fetching', target: targetLabel, current: fetched, total });
      }, scrapeOpts);
      setProgress(jobId, { phase: 'upserting', target: targetLabel, current: 0, total: capabilities.length });
      const count = await ingest(
        db, 'nat_cma', target.orgName, target.certCode || target.placeId, '',
        capabilities.map(mapNatCma),
        (current, total) => setProgress(jobId, { phase: 'upserting', target: targetLabel, current, total }),
      );
      setProgress(jobId, { phase: 'done', target: targetLabel, current: count, total: count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateLabStatus(db, 'nat_cma', 'error', message);
      setProgress(jobId, { phase: 'error', target: targetLabel, current: 0, total: 0, error: message });
    }
  });
  return jobId;
}

/** 从 labs.source_ref(JSON) 还原已订阅的国家 CMA 机构标识。 */
function getSubscribedNatCmaOrg(db: Database.Database): NatCmaOrg | null {
  const meta = ORG_SOURCE_TABLE.nat_cma;
  const row = db.prepare(`SELECT source_ref FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`).get(SELF_ORG_ID) as { source_ref: string } | undefined;
  const raw = row?.source_ref?.trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { placeId: string; applyId: string; certCode?: string; orgName?: string };
    if (!j.placeId || !j.applyId) return null;
    return { placeId: j.placeId, applyId: j.applyId, certCode: j.certCode ?? '', orgName: j.orgName ?? '', address: '' };
  } catch {
    return null;
  }
}

function mapNatCma(c: NatCmaCapability): Record<string, string> {
  return {
    stdCode: c.stdCodeRaw,
    stdName: c.stdName,
    testParam: c.testParam,
    category: c.category,
    subCategory: c.subCategory,
    testObject: c.placeName,  // 场所名落入 test_object，便于区分不同场所来源
  };
}

