import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { getDb } from '../services/db';
import { createHealthRoutes } from './health-routes';
import { createWatchlistRoutes } from './watchlist-routes';
import { createImportRoutes } from './import-routes';
import { createQualificationRoutes } from './qualification-routes';
import { createCapLibRoutes } from './cap-lib-routes';
import { createSourceRoutes } from './source-routes';
import { createSystemRoutes } from './system-routes';
import { closeScrapers } from '../services/scrape-service';
import { AppError } from '../shared/errors';
import { respondError } from '../shared/response';
import { getRootDir } from '../shared/fs';

export interface QualMatchApp extends Express {
  shutdown(): void;
}

/**
 * 装配 Express app。
 *   - express.json
 *   - 业务路由：health / watchlist（清单导入·匹配·导出）/ import（资质明细导入）/
 *     qualification（综合查询：行级搜索·按标准号聚合·导出）/ cap-lib（一单一库：领域订阅·同步·清理）/
 *     source（省级CMA·CNAS 在线抓取）
 *   - 生产期静态托管 web/dist + SPA fallback（开发期前端走 Vite dev server，不在此托管）
 *   - 全局错误中间件（最后挂，4 参签名）
 *
 * 后续阶段挂入：国家 CMA（阶段 5，滑块已止损走导入降级）。
 */
export function createApp(): QualMatchApp {
  const app = express() as QualMatchApp;

  // 启动时打开库（触发 migrate 建表）。单例缓存于 db 模块。
  const db = getDb();

  app.use(express.json({ limit: '1mb' }));

  // ── 业务路由 ──
  app.use(createHealthRoutes());
  app.use(createWatchlistRoutes(db));
  app.use(createImportRoutes(db));
  app.use(createQualificationRoutes(db));
  app.use(createCapLibRoutes(db));
  app.use(createSourceRoutes(db));
  app.use(createSystemRoutes(db));

  // ── 生产期静态托管前端构建产物 ──
  // 开发期前端由 Vite dev server（5173）提供，/api 经 Vite proxy 转发到本服务，
  // 此处的静态托管仅在生产（已 build web/dist）时生效。
  const webDist = path.join(getRootDir(), 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback：非 /api 的 GET 请求回 index.html。
    // 用无路径 app.use 中间件兜底，避开 Express5 path-to-regexp v8 对裸 '*' 通配的限制。
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  // ── 未匹配的 /api 路由 → Result 壳 404（避免返回 Express 默认 HTML）──
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next();
    respondError(res, 404, 'NOT_FOUND', `接口不存在：${req.method} ${req.path}`);
  });

  // ── 全局错误中间件（必须最后挂，且必须 4 参，Express5 靠 arity===4 识别）──
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      respondError(res, error.statusCode, error.code, error.message, error.details);
      return;
    }
    // multer 错误（文件过大等）→ 400
    if (error instanceof Error && error.name === 'MulterError') {
      const code = (error as { code?: string }).code ?? 'UPLOAD_ERROR';
      const msg = code === 'LIMIT_FILE_SIZE' ? '上传文件过大（上限 10MB）' : `上传错误：${error.message}`;
      respondError(res, 400, code, msg);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[app] unhandled error:', message);
    respondError(res, 500, 'INTERNAL_SERVER_ERROR', '服务器内部错误');
  });

  app.shutdown = () => {
    try { void closeScrapers(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  };

  return app;
}
