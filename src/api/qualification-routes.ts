import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { respond } from '../shared/response';
import { normalizeError, BadRequestError } from '../shared/errors';
import { ORG_SOURCES, type OrgSource } from '../shared/constants';
import {
  searchQualifications, searchByStandard, collectAllHits, type SearchOptions,
} from '../services/qualification-service';
import { exportQualificationSearch } from '../services/export-service';

/**
 * 综合查询路由（阶段 2）。独立于清单，直查本地资质库。
 *   GET  /api/qualifications/search       行级搜索（分页）
 *   GET  /api/qualifications/by-standard  按标准号聚合（分页）
 *   POST /api/qualifications/export       导出查询结果 Excel
 *
 * 源过滤 sources 用逗号分隔（prov_cma,cnas,nat_cma）；空 = 全部机构型源。
 */

const orgSourceEnum = z.enum(ORG_SOURCES);

/** 解析逗号分隔的 sources 字符串 → 合法 OrgSource[]（非法值丢弃）。 */
function parseSources(raw: unknown): OrgSource[] | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  const valid = parts.filter((p): p is OrgSource => orgSourceEnum.safeParse(p).success);
  return valid.length ? valid : undefined;
}

// GET query 参数校验（全部 string，page/pageSize 转数字）
const searchQuerySchema = z.object({
  q: z.string().min(1, '查询关键词不能为空'),
  sources: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

// POST 导出请求体（JSON camelCase）
const exportBodySchema = z.object({
  q: z.string().min(1, '查询关键词不能为空'),
  sources: z.array(orgSourceEnum).optional(),
});

export function createQualificationRoutes(db: Database.Database): Router {
  const router = Router();

  // ── 行级搜索 ──
  router.get('/api/qualifications/search', (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = searchQuerySchema.parse(req.query);
      const opts: SearchOptions = { q: p.q, sources: parseSources(p.sources), page: p.page, pageSize: p.pageSize };
      respond(res, searchQualifications(db, opts));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 按标准号聚合 ──
  router.get('/api/qualifications/by-standard', (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = searchQuerySchema.parse(req.query);
      const opts: SearchOptions = { q: p.q, sources: parseSources(p.sources), page: p.page, pageSize: p.pageSize };
      respond(res, searchByStandard(db, opts));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 导出查询结果（全部命中行，流式 buffer）──
  router.post('/api/qualifications/export', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = exportBodySchema.parse(req.body);
      const rows = collectAllHits(db, { q: body.q, sources: body.sources });
      if (rows.length === 0) throw new BadRequestError('没有可导出的查询结果');
      const { buffer, fileName } = await exportQualificationSearch(rows, body.q);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.send(buffer);
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}
