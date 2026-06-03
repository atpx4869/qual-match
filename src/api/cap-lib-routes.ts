import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { respond, respondError } from '../shared/response';
import { normalizeError, BadRequestError } from '../shared/errors';
import { toCamelCase } from '../shared/case';
import { isValidCapLibDomain } from '../shared/cap-lib-domains';
import { CapLibService, getSyncProgress } from '../services/cap-lib-service';

/**
 * 一单一库（能力项目库）路由（阶段 3）。无 auth（单用户无登录）。
 *   GET  /api/cap-lib/domains                    11 领域订阅状态
 *   PUT  /api/cap-lib/domains/:name/subscribe    订阅/退订
 *   POST /api/cap-lib/domains/:name/sync         触发同步 → { jobId }
 *   GET  /api/cap-lib/sync-progress/:jobId        进度轮询
 *   POST /api/cap-lib/cleanup                     清理 N 天孤儿行
 *
 * 领域名是中文且走 URL path 段 → decodeURIComponent。
 */
export function createCapLibRoutes(db: Database.Database): Router {
  const router = Router();
  const svc = new CapLibService(db);

  // ── 领域元数据 ──
  router.get('/api/cap-lib/domains', (_req, res, next) => {
    try {
      respond(res, toCamelCase({ items: svc.listDomains() }));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 订阅 / 退订 ──
  router.put('/api/cap-lib/domains/:name/subscribe', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { subscribed } = z.object({ subscribed: z.boolean() }).parse(req.body);
      const name = decodeURIComponent(String(req.params.name));
      if (!isValidCapLibDomain(name)) throw new BadRequestError(`非法领域名：${name}`);
      svc.setSubscribed(name, subscribed);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 触发同步 ──
  router.post('/api/cap-lib/domains/:name/sync', (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = decodeURIComponent(String(req.params.name));
      if (!isValidCapLibDomain(name)) throw new BadRequestError(`非法领域名：${name}`);
      const jobId = svc.startSync(name);
      respond(res, { jobId, domain: name });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 同步进度轮询 ──
  router.get('/api/cap-lib/sync-progress/:jobId', (req: Request, res: Response) => {
    const p = getSyncProgress(String(req.params.jobId));
    if (!p) { respondError(res, 404, 'NOT_FOUND', '任务不存在或已过期'); return; }
    respond(res, toCamelCase(p));
  });

  // ── 清理孤儿行 ──
  router.post('/api/cap-lib/cleanup', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { days } = z.object({ days: z.coerce.number().int().positive().optional() }).parse(req.body ?? {});
      const deleted = svc.cleanupStaleRows(days ?? 30);
      respond(res, { deleted });
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}
