import { Router } from 'express';
import { respond } from '../shared/response';

const startedAt = Date.now();

export function createHealthRoutes(): Router {
  const router = Router();

  router.get('/api/health', (_req, res) => {
    respond(res, {
      status: 'ok',
      version: '0.1.0',
      uptimeMs: Date.now() - startedAt,
      time: new Date().toISOString(),
    });
  });

  return router;
}
