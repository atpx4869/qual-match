import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { respond } from '../shared/response';
import { normalizeError, BadRequestError } from '../shared/errors';
import { toCamelCase } from '../shared/case';
import { getSyncProgress } from '../services/sync-progress';
import {
  searchProvCmaLabs, startProvCmaSync, listCnasPresets, startCnasSync,
} from '../services/scrape-service';
import { ORG_SOURCE_TABLE, SELF_ORG_ID, isOrgSource } from '../shared/constants';

/**
 * 抓取源路由（阶段 4）。省级 CMA（HTTP）+ CNAS（playwright）在线抓取。无 auth（单用户）。
 *   GET  /api/sources/prov_cma/search?q=   省级 CMA 按机构名搜候选
 *   POST /api/sources/prov_cma/sync         抓取（body { publicDetailId }）→ { jobId }
 *   GET  /api/sources/cnas/presets          内置 CNAS 机构列表
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
      const { publicDetailId } = z.object({ publicDetailId: z.string().trim().min(1) }).parse(req.body);
      const jobId = startProvCmaSync(db, publicDetailId);
      respond(res, { jobId });
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
      const { labNo } = z.object({ labNo: z.string().trim().min(1) }).parse(req.body);
      const jobId = startCnasSync(db, labNo);
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

  // ── 本机构在某机构型源的已抓概况 ──
  router.get('/api/sources/:source/orgs', (req: Request, res: Response, next: NextFunction) => {
    try {
      const source = String(req.params.source);
      if (!isOrgSource(source)) throw new BadRequestError('source 必须是 prov_cma / cnas / nat_cma 之一');
      const meta = ORG_SOURCE_TABLE[source];
      const lab = db.prepare(
        `SELECT lab_name, record_count, data_origin, last_sync_at, sync_status FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`,
      ).get(SELF_ORG_ID);
      respond(res, toCamelCase({ source, lab: lab ?? null }));
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}
