import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type Database from 'better-sqlite3';
import { respond } from '../shared/response';
import { normalizeError, BadRequestError } from '../shared/errors';
import { parseExcelBuffer, importQualifications } from '../services/import-service';
import { isOrgSource } from '../shared/constants';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * 资质明细导入（阶段 1 主路径）。单一机构：导入的资质全部视作本机构持有。
 * POST /api/import/qualifications  multipart: file=Excel, source=prov_cma|cnas|nat_cma
 */
export function createImportRoutes(db: Database.Database): Router {
  const router = Router();

  router.post('/api/import/qualifications', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const source = String(req.body?.source ?? '').trim();
      if (!isOrgSource(source)) {
        throw new BadRequestError('source 必须是 prov_cma / cnas / nat_cma 之一');
      }
      if (!req.file) throw new BadRequestError('缺少上传文件（字段名 file）');

      const rows = await parseExcelBuffer(req.file.buffer);
      if (rows.length === 0) throw new BadRequestError('没有解析到任何资质行');

      const summary = importQualifications(db, source, rows);
      respond(res, { source, summary });
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}
