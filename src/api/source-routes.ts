import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { respond } from '../shared/response';
import { normalizeError, BadRequestError } from '../shared/errors';
import { toCamelCase } from '../shared/case';
import { getSyncProgress } from '../services/sync-progress';
import {
  searchProvCmaLabs, startProvCmaSync, listCnasPresets, startCnasSync,
  subscribeProvCmaLab, subscribeCnasLab,
  searchNatCmaOrgs, listNatCmaPlaces, startNatCmaSync, subscribeNatCmaLab,
  deleteLocalSourceData, listSubscribedNatCmaPlaces,
} from '../services/scrape-service';
import { ORG_SOURCE_TABLE, SELF_ORG_ID, isOrgSource } from '../shared/constants';

/**
 * 抓取源路由（阶段 4）。省级 CMA（HTTP）+ CNAS（playwright）在线抓取。无 auth（单用户）。
 *   GET  /api/sources/prov_cma/search?q=   省级 CMA 按机构名搜候选
 *   POST /api/sources/prov_cma/subscribe    订阅省级 CMA 机构
 *   POST /api/sources/prov_cma/sync         抓取（body { publicDetailId }）→ { jobId }
 *   GET  /api/sources/cnas/presets          内置 CNAS 机构列表
 *   POST /api/sources/cnas/subscribe        订阅 CNAS 机构
 *   POST /api/sources/cnas/sync             抓取（body { labNo }）→ { jobId }
 *   GET  /api/sources/sync-progress/:jobId  进度轮询（复用公共 sync-progress）
 *   GET  /api/sources/:source/orgs          本机构在该源已抓概况
 */
export function createSourceRoutes(db: Database.Database): Router {
  const router = Router();

  // ── 省级 CMA：搜机构 ──
  router.get('/api/sources/prov_cma/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q } = z.object({ q: z.string().trim().min(1, '请输入机构名') }).parse(req.query);
      const items = await searchProvCmaLabs(q);
      respond(res, { items: toCamelCase(items), total: items.length });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 省级 CMA：抓取 ──
  router.post('/api/sources/prov_cma/sync', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { publicDetailId } = z.object({ publicDetailId: z.string().trim().min(1).optional() }).parse(req.body ?? {});
      const jobId = startProvCmaSync(db, publicDetailId);
      respond(res, { jobId });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 省级 CMA：订阅机构 ──
  router.post('/api/sources/prov_cma/subscribe', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({
        publicDetailId: z.string().trim().min(1),
        labName: z.string().trim().min(1),
        region: z.string().trim().optional().default(''),
      }).parse(req.body);
      subscribeProvCmaLab(db, body);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── CNAS：内置机构 ──
  router.get('/api/sources/cnas/presets', (_req, res, next) => {
    try {
      respond(res, { items: listCnasPresets(db) });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── CNAS：抓取 ──
  router.post('/api/sources/cnas/sync', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labNo } = z.object({ labNo: z.string().trim().min(1).optional() }).parse(req.body ?? {});
      const jobId = startCnasSync(db, labNo);
      respond(res, { jobId });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── CNAS：订阅内置机构 ──
  router.post('/api/sources/cnas/subscribe', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labNo } = z.object({ labNo: z.string().trim().min(1) }).parse(req.body);
      subscribeCnasLab(db, labNo);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 国家 CMA：搜机构（cma.cnca.cn，playwright 过滑块）──
  router.get('/api/sources/nat_cma/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q } = z.object({ q: z.string().trim().min(1, '请输入机构名') }).parse(req.query);
      const items = await searchNatCmaOrgs(db, q);
      respond(res, { items: toCamelCase(items), total: items.length });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 国家 CMA：订阅机构 ──
  const natCmaSeedSchema = z.object({
    placeId: z.string().trim().min(1),
    applyId: z.string().trim().min(1),
    address: z.string().trim().optional().default(''),
    placeAttr: z.string().trim().optional().default(''),
    placeName: z.string().trim().optional().default(''),
    placeAddress: z.string().trim().optional().default(''),
  });

  // ── 国家 CMA：列出机构场所 ──
  router.post('/api/sources/nat_cma/places', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({
        certCode: z.string().trim().default(''),
        orgName: z.string().trim().min(1),
        address: z.string().trim().optional().default(''),
        placeId: z.string().trim().min(1),
        applyId: z.string().trim().min(1),
        seeds: z.array(natCmaSeedSchema).optional(),
      }).parse(req.body);
      const items = await listNatCmaPlaces(db, body);
      respond(res, { items: toCamelCase(items), total: items.length });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 国家 CMA：订阅机构下的场所 ──
  router.post('/api/sources/nat_cma/subscribe', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({
        certCode: z.string().trim().default(''),
        orgName: z.string().trim().min(1),
        placeId: z.string().trim().min(1),
        applyId: z.string().trim().min(1),
        region: z.string().trim().optional().default(''),
        seeds: z.array(natCmaSeedSchema).min(1, '请至少选择一个场所').optional(),
      }).parse(req.body);
      subscribeNatCmaLab(db, body);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 国家 CMA：抓取（body 可带完整机构标识，否则用已订阅的）──
  router.post('/api/sources/nat_cma/sync', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({
        certCode: z.string().trim().optional(),
        orgName: z.string().trim().optional(),
        placeId: z.string().trim().optional(),
        applyId: z.string().trim().optional(),
        seeds: z.array(natCmaSeedSchema).optional(),
      }).parse(req.body ?? {});
      const org = (body.placeId && body.applyId)
        ? {
            placeId: body.placeId,
            applyId: body.applyId,
            certCode: body.certCode ?? '',
            orgName: body.orgName ?? '',
            address: '',
            seeds: body.seeds,
          }
        : undefined;
      const jobId = startNatCmaSync(db, org);
      respond(res, { jobId });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 进度轮询 ──
  router.get('/api/sources/sync-progress/:jobId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = getSyncProgress(String(req.params.jobId));
      if (!p) throw new BadRequestError('任务不存在或已过期');
      respond(res, toCamelCase(p));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 国家 CMA：已订阅场所及本地条数 ──
  router.get('/api/sources/nat_cma/places/subscribed', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = listSubscribedNatCmaPlaces(db);
      respond(res, { items: toCamelCase(items), total: items.length });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 本机构在某机构型源的已抓概况 ──
  router.get('/api/sources/:source/orgs', (req: Request, res: Response, next: NextFunction) => {
    try {
      const source = String(req.params.source);
      if (!isOrgSource(source)) throw new BadRequestError('source 必须是 prov_cma / cnas / nat_cma 之一');
      const meta = ORG_SOURCE_TABLE[source];
      const cnt = db.prepare(`SELECT COUNT(*) AS c FROM ${meta.qualTable} WHERE ${meta.orgCol} = ?`)
        .get(SELF_ORG_ID) as { c: number };
      const lab = db.prepare(
        `SELECT lab_name, source_ref, region, record_count, data_origin, last_sync_at, sync_status, sync_error
         FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`,
      ).get(SELF_ORG_ID);
      respond(res, toCamelCase({ source, localCount: cnt.c, lab: lab ?? null }));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 删除某机构型源的本地资质和订阅占位 ──
  router.delete('/api/sources/:source/local', (req: Request, res: Response, next: NextFunction) => {
    try {
      const source = String(req.params.source);
      if (!isOrgSource(source)) throw new BadRequestError('source 必须是 prov_cma / cnas / nat_cma 之一');
      respond(res, deleteLocalSourceData(db, source));
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}
