import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { respond } from '../shared/response';
import { normalizeError } from '../shared/errors';
import {
  collectOverview, getSystemSettings, setSystemSettings, backupDatabase,
} from '../services/system-service';

/**
 * 系统路由（阶段 6 打磨）。设置页用：数据总览 / 设置读写 / 全库备份下载。无 auth（单用户）。
 *   GET  /api/system/overview   各资质源 + 清单数据总览（只读）
 *   GET  /api/system/settings   当前有效抓取设置（回退后的值）
 *   PUT  /api/system/settings   写抓取设置
 *   GET  /api/system/backup     下载整库 sqlite 一致快照（二进制流）
 */
export function createSystemRoutes(db: Database.Database): Router {
  const router = Router();

  // ── 数据总览 ──
  router.get('/api/system/overview', (_req, res, next) => {
    try {
      respond(res, collectOverview(db));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 设置读 ──
  router.get('/api/system/settings', (_req, res, next) => {
    try {
      respond(res, getSystemSettings(db));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 设置写 ──
  router.put('/api/system/settings', (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = z.object({
        cnasChromePath: z.string().trim().optional(),
        cnasThrottleMs: z.number().int().min(0).max(60000).optional(),
        natCmaEnabled: z.boolean().optional(),
        natCmaChromePath: z.string().trim().optional(),
        natCmaThrottleMs: z.number().int().min(0).max(60000).optional(),
      }).parse(req.body);
      setSystemSettings(db, input);
      respond(res, getSystemSettings(db));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 全库备份下载 ──
  router.get('/api/system/backup', async (_req: Request, res: Response, next: NextFunction) => {
    let tmpPath: string;
    try {
      tmpPath = await backupDatabase(db);
    } catch (e) {
      // 备份失败时响应头未发，正常回 Result 壳 JSON
      next(normalizeError(e));
      return;
    }
    // 备份成功 → 二进制流。文件名用 RFC5987 UTF-8（前端正则按 filename*=UTF-8'' 解析）
    const ts = tmpPath.match(/backup-(\d+)-/)?.[1] ?? String(Date.now());
    const fileName = `qual-match-backup-${ts}.db`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.sendFile(tmpPath, (err) => {
      // 无论成败都删临时文件；头已发，send 阶段错误只能 log
      fs.unlink(tmpPath, () => { /* ignore */ });
      if (err && !res.headersSent) next(normalizeError(err));
      else if (err) console.error('[system] backup send error:', err.message);
    });
  });

  return router;
}
