import type { MatchOutcome, SourceCoverage } from './match-service';
import { ORG_SOURCE_TABLE } from '../shared/constants';
import type { QualSearchRow } from './qualification-service';

/**
 * 匹配结果导出 Excel（阶段 1，单一机构）。
 *
 * 产出 buffer，由路由层 res.send 流式返回（不落临时文件，沿用 bzxz 模式）。
 * 每行一个标准号，列含：标准号 / 清单原始信息 / 省级CMA / CNAS / 国家CMA / 是否覆盖 / 检测项目。
 * 资质列用文字前缀（✓有 / —无 / ~系列），便于在 Excel 里筛选。
 */

function cellOf(c: SourceCoverage): string {
  if (c.covered) return '✓ 有';
  if (c.seriesHint) return `~ 仅其他年版（${c.seriesCodes.join('、')}）`;
  return '— 无';
}

/** 一单一库 5 档状态 → 导出文字（含 emoji 前缀，便于 Excel 筛选）。 */
function capLibCellOf(o: MatchOutcome['results'][number]): string {
  const c = o.capLib;
  switch (c.status) {
    case 'in_lib':      return '🟢 在库';
    case 'cite_only':   return '🟡 仅引用';
    case 'abolished':   return '🟠 已废止';
    case 'series_only': return `🔴 仅系列${c.seriesNewCode ? `（现行 ${c.seriesNewCode}）` : ''}`;
    default:            return '⚪ 不在库';
  }
}

function paramsOf(o: MatchOutcome['results'][number]): string {
  // 聚合三类资质命中的检测项目（去重）
  const all = [...o.provCma.testParams, ...o.cnas.testParams, ...o.natCma.testParams];
  return [...new Set(all.filter(Boolean))].join('；');
}

export async function exportMatchResult(outcome: MatchOutcome): Promise<{ buffer: Buffer; fileName: string }> {
  const XLSX = (await import('xlsx')).default;

  const header = ['标准号', '中文标准名称', '受控编号', '是否有文本', '所属部门', '省级CMA', 'CNAS', '国家CMA', '一单一库', '是否覆盖', '检测项目'];
  const rows = outcome.results.map((r) => [
    r.stdCode,
    r.stdName || '',
    r.controlledNo || '',
    r.hasText || '',
    r.department || '',
    cellOf(r.provCma),
    cellOf(r.cnas),
    cellOf(r.natCma),
    capLibCellOf(r),
    r.matched ? '✓ 已覆盖' : '✗ 未覆盖',
    paramsOf(r),
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [
    { wch: 20 }, { wch: 34 }, { wch: 16 }, { wch: 12 }, { wch: 16 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 40 },
  ];
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '资质匹配');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const safeName = outcome.watchlistName.replace(/[\\/:*?"<>|]/g, '').trim() || '清单';
  const fileName = `资质匹配_${safeName}_${Date.now()}.xlsx`;
  return { buffer, fileName };
}

/**
 * 综合查询结果导出（阶段 2）。平铺导出全部命中行（不分页）。
 * 列：源类型 / 标准号 / 标准名称 / 检测项目 / 类别 / 有效期起 / 有效期止。
 * 沿用流式 buffer 模式，不落临时文件。
 */
export async function exportQualificationSearch(rows: QualSearchRow[], keyword: string): Promise<{ buffer: Buffer; fileName: string }> {
  const XLSX = (await import('xlsx')).default;

  const header = ['资质源', '标准号', '标准名称', '检测项目', '类别', '有效期起', '有效期止'];
  const data = rows.map((r) => [
    ORG_SOURCE_TABLE[r.source].label,
    r.stdCode,
    r.stdName || '',
    r.testParam || '',
    r.category || '',
    r.effectiveDate || '',
    r.expiryDate || '',
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  ws['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 34 }, { wch: 40 }, { wch: 16 }, { wch: 14 }, { wch: 14 }];
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: header.length - 1 } }) };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '综合查询');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const safeKw = keyword.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30) || '全部';
  const fileName = `资质查询_${safeKw}_${Date.now()}.xlsx`;
  return { buffer, fileName };
}
