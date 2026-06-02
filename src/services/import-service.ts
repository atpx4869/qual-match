import type Database from 'better-sqlite3';
import { cleanStdCode, extractFullCode, extractBaseCode } from '../shared/std-code';
import { SELF_ORG_ID, ORG_SOURCE_TABLE, type OrgSource } from '../shared/constants';
import { BadRequestError } from '../shared/errors';

/**
 * Excel 导入服务（阶段 1）。
 *
 *   - importWatchlist：导入一份标准清单（创建 watchlist + items）
 *   - importQualifications：导入本机构某类资质明细（入对应机构型明细表，机构列用 SELF_ORG_ID）
 *
 * 两条入库路径都强制过三层归一化（cleanStdCode → extractFullCode/extractBaseCode），
 * 这是匹配命中的前提（CLAUDE.md 归一化契约）。空号/无效行跳过并在结果里回报。
 */

// 解析出的通用行：标准号必需，其余可选。
export interface ParsedRow {
  stdCode: string;
  stdName?: string;
  testParam?: string;
  category?: string;
  effectiveDate?: string;
  expiryDate?: string;
}

export interface ImportSummary {
  inserted: number;
  skipped: number;
  skippedReasons: string[]; // 前 N 条跳过原因，供 UI 提示
}

// ─── 列名识别（容错：同一字段的多种中文/英文别名）──────────────────────────────
const COLUMN_ALIASES: Record<keyof ParsedRow, string[]> = {
  stdCode:       ['标准号', '标准编号', '标准代号', 'stdcode', 'std_code', 'code', '标准'],
  stdName:       ['标准名称', '标准名', 'name', 'stdname', '名称'],
  testParam:     ['检测项目', '检测参数', '项目/参数', '参数', 'testparam', 'item', '项目'],
  category:      ['类别', '大类', '领域', 'category'],
  effectiveDate: ['有效期起', '生效日期', '批准日期', 'effectivedate', '有效日期'],
  expiryDate:    ['有效期止', '失效日期', '到期日期', 'expirydate'],
};

function buildColumnMap(headerRow: string[]): Partial<Record<keyof ParsedRow, number>> {
  const map: Partial<Record<keyof ParsedRow, number>> = {};
  headerRow.forEach((raw, idx) => {
    const h = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<[keyof ParsedRow, string[]]>) {
      if (map[field] !== undefined) continue;
      if (aliases.some((a) => a.toLowerCase() === h)) { map[field] = idx; break; }
    }
  });
  return map;
}

/**
 * 解析 Excel buffer → ParsedRow[]。第一行作表头，按别名映射列。
 * 标准号列识别不到时抛 BadRequestError（让用户知道表头不对）。
 */
export async function parseExcelBuffer(buffer: Buffer): Promise<ParsedRow[]> {
  const XLSX = (await import('xlsx')).default;
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new BadRequestError('Excel 没有工作表');
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: '' });
  if (aoa.length < 2) throw new BadRequestError('Excel 至少需要表头 + 1 行数据');

  const headerRow = (aoa[0] as unknown[]).map((c) => String(c ?? ''));
  const colMap = buildColumnMap(headerRow);
  if (colMap.stdCode === undefined) {
    throw new BadRequestError('未找到「标准号」列，请检查表头（支持：标准号/标准编号/标准代号 等）');
  }

  const pick = (row: unknown[], field: keyof ParsedRow): string | undefined => {
    const idx = colMap[field];
    if (idx === undefined) return undefined;
    const v = String(row[idx] ?? '').trim();
    return v || undefined;
  };

  const rows: ParsedRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i] as unknown[];
    const stdCode = pick(row, 'stdCode');
    if (!stdCode) continue; // 空号行静默跳过（解析阶段不计入 skip，由入库阶段统一统计）
    rows.push({
      stdCode,
      stdName: pick(row, 'stdName'),
      testParam: pick(row, 'testParam'),
      category: pick(row, 'category'),
      effectiveDate: pick(row, 'effectiveDate'),
      expiryDate: pick(row, 'expiryDate'),
    });
  }
  return rows;
}

// ─── 导入标准清单 ──────────────────────────────────────────────────────────────
export function importWatchlist(db: Database.Database, name: string, rows: ParsedRow[]): { watchlistId: number; summary: ImportSummary } {
  const trimmedName = name.trim();
  if (!trimmedName) throw new BadRequestError('清单名称不能为空');

  const summary: ImportSummary = { inserted: 0, skipped: 0, skippedReasons: [] };

  const insertWl = db.prepare('INSERT INTO watchlists (name, item_count) VALUES (?, 0)');
  const insertItem = db.prepare(
    'INSERT INTO watchlist_items (watchlist_id, std_code, std_code_norm, std_code_base, std_name, seq) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const txn = db.transaction(() => {
    const wlId = Number(insertWl.run(trimmedName).lastInsertRowid);
    let seq = 0;
    for (const r of rows) {
      const clean = cleanStdCode(r.stdCode);
      const norm = extractFullCode(clean);
      if (!clean || !norm) {
        summary.skipped++;
        if (summary.skippedReasons.length < 10) summary.skippedReasons.push(`无效标准号：${r.stdCode}`);
        continue;
      }
      insertItem.run(wlId, clean, norm, extractBaseCode(clean), r.stdName ?? '', seq++);
      summary.inserted++;
    }
    db.prepare('UPDATE watchlists SET item_count = ? WHERE id = ?').run(summary.inserted, wlId);
    return wlId;
  });

  const watchlistId = txn();
  return { watchlistId, summary };
}

// ─── 导入本机构资质明细 ────────────────────────────────────────────────────────
export function importQualifications(db: Database.Database, source: OrgSource, rows: ParsedRow[], replace = true): ImportSummary {
  const meta = ORG_SOURCE_TABLE[source];
  const summary: ImportSummary = { inserted: 0, skipped: 0, skippedReasons: [] };

  const insert = db.prepare(
    `INSERT INTO ${meta.qualTable} (${meta.orgCol}, std_code, std_code_norm, std_code_base, std_name, test_param, category, effective_date, expiry_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const txn = db.transaction(() => {
    // replace：本机构是单一机构，重新导入时清掉旧明细（同 SELF_ORG_ID），避免重复累积
    if (replace) db.prepare(`DELETE FROM ${meta.qualTable} WHERE ${meta.orgCol} = ?`).run(SELF_ORG_ID);

    for (const r of rows) {
      const clean = cleanStdCode(r.stdCode);
      const norm = extractFullCode(clean);
      if (!clean || !norm) {
        summary.skipped++;
        if (summary.skippedReasons.length < 10) summary.skippedReasons.push(`无效标准号：${r.stdCode}`);
        continue;
      }
      insert.run(
        SELF_ORG_ID, clean, norm, extractBaseCode(clean),
        r.stdName ?? '', r.testParam ?? '', r.category ?? '', r.effectiveDate ?? '', r.expiryDate ?? '',
      );
      summary.inserted++;
    }

    // 维护本机构 labs 表一行（占位），记录数同步
    ensureSelfLab(db, source, summary.inserted);
  });

  txn();
  return summary;
}

/** 确保本机构在 labs 表有占位行，并更新 record_count / data_origin。 */
function ensureSelfLab(db: Database.Database, source: OrgSource, recordCount: number): void {
  const meta = ORG_SOURCE_TABLE[source];
  const existing = db.prepare(`SELECT id FROM ${meta.labTable} WHERE ${meta.orgCol} = ?`).get(SELF_ORG_ID);
  if (existing) {
    db.prepare(`UPDATE ${meta.labTable} SET record_count = ?, data_origin = 'manual', last_sync_at = datetime('now') WHERE ${meta.orgCol} = ?`)
      .run(recordCount, SELF_ORG_ID);
  } else {
    db.prepare(`INSERT INTO ${meta.labTable} (${meta.orgCol}, lab_name, record_count, data_origin, sync_status) VALUES (?, ?, ?, 'manual', 'success')`)
      .run(SELF_ORG_ID, '本机构', recordCount);
  }
}
