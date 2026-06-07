import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { respond } from '../shared/response';
import { normalizeError, BadRequestError, NotFoundError } from '../shared/errors';
import { toCamelCase } from '../shared/case';
import { parseExcelBuffer, importWatchlist, type ParsedRow } from '../services/import-service';
import { matchWatchlist } from '../services/match-service';
import { exportMatchResult } from '../services/export-service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 粘贴标准号导入：name + codes[]（每个元素是一个标准号，可选附名称用 "号\t名" 不支持，保持简单）
const pasteSchema = z.object({
  name: z.string().min(1, '清单名称不能为空'),
  codes: z.array(z.string()).min(1, '至少一个标准号'),
});

const matchQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().refine((v) => [200, 300, 500, 1000, 2000].includes(v), 'pageSize 必须是 200/300/500/1000/2000').optional().default(500),
  filter: z.enum(['all', 'covered', 'uncovered']).optional().default('all'),
  keyword: z.string().trim().optional().default(''),
  // 排序：清单文本列（seq=原始导入顺序）
  sortBy: z.enum(['seq', 'stdCode', 'stdName', 'controlledNo', 'department']).optional().default('seq'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
  // 各资质列状态筛选（可选；省略=不限）
  provCmaState: z.enum(['covered', 'none', 'series']).optional(),
  cnasState: z.enum(['covered', 'none', 'series']).optional(),
  natCmaState: z.enum(['covered', 'none', 'series']).optional(),
  capLibState: z.enum(['in_lib', 'cite_only', 'abolished', 'series_only', 'not_in_lib']).optional(),
});

export function createWatchlistRoutes(db: Database.Database): Router {
  const router = Router();

  // ── 创建清单：multipart Excel 上传 或 JSON 粘贴标准号 ──
  router.post('/api/watchlists', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      let name: string;
      let rows: ParsedRow[];

      if (req.file) {
        // Excel 上传：name 从 form 字段取，缺省用文件名
        name = String(req.body?.name ?? '').trim() || (req.file.originalname || '').replace(/\.[^.]+$/, '') || '导入清单';
        rows = await parseExcelBuffer(req.file.buffer);
      } else {
        const parsed = pasteSchema.parse(req.body);
        name = parsed.name;
        rows = parsed.codes.map((c) => ({ stdCode: c }));
      }

      if (rows.length === 0) throw new BadRequestError('没有解析到任何标准号');
      const { watchlistId, summary } = importWatchlist(db, name, rows);
      respond(res, { watchlistId, summary });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 清单列表 ──
  router.get('/api/watchlists', (_req, res, next) => {
    try {
      const rows = db.prepare('SELECT id, name, created_at, matched_at, item_count FROM watchlists ORDER BY id DESC').all();
      respond(res, toCamelCase(rows));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 清单详情（含条目）──
  router.get('/api/watchlists/:id', (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw new BadRequestError('无效的清单 id');
      const wl = db.prepare('SELECT id, name, created_at, matched_at, item_count FROM watchlists WHERE id = ?').get(id);
      if (!wl) throw new NotFoundError(`清单不存在：${id}`);
      const items = db.prepare(
        `SELECT std_code, std_name, controlled_no, has_text, department, seq
         FROM watchlist_items WHERE watchlist_id = ? ORDER BY seq`,
      ).all(id);
      respond(res, toCamelCase({ ...wl, items }));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 删除清单 ──
  router.delete('/api/watchlists/:id', (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw new BadRequestError('无效的清单 id');
      const info = db.prepare('DELETE FROM watchlists WHERE id = ?').run(id);
      if (info.changes === 0) throw new NotFoundError(`清单不存在：${id}`);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 执行匹配 ──
  router.get('/api/watchlists/:id/match', (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw new BadRequestError('无效的清单 id');
      const query = matchQuerySchema.parse(req.query);
      const outcome = matchWatchlist(db, id, query);
      respond(res, outcome);
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 导出匹配结果 Excel（流式 buffer）──
  router.post('/api/watchlists/:id/export', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw new BadRequestError('无效的清单 id');
      const outcome = matchWatchlist(db, id);
      const { buffer, fileName } = await exportMatchResult(outcome);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.send(buffer);
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}
