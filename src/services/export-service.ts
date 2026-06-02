import type { MatchOutcome, SourceCoverage } from './match-service';

/**
 * 匹配结果导出 Excel（阶段 1，单一机构）。
 *
 * 产出 buffer，由路由层 res.send 流式返回（不落临时文件，沿用 bzxz 模式）。
 * 每行一个标准号，列含：标准号 / 标准名 / 省级CMA / CNAS / 国家CMA / 是否覆盖 / 检测项目。
 * 资质列用文字前缀（✓有 / —无 / ~系列），便于在 Excel 里筛选。
 */

function cellOf(c: SourceCoverage): string {
  if (c.covered) return '✓ 有';
  if (c.seriesHint) return `~ 仅其他年版（${c.seriesCodes.join('、')}）`;
  return '— 无';
}

function paramsOf(o: MatchOutcome['results'][number]): string {
  // 聚合三类资质命中的检测项目（去重）
  const all = [...o.provCma.testParams, ...o.cnas.testParams, ...o.natCma.testParams];
  return [...new Set(all.filter(Boolean))].join('；');
}

export async function exportMatchResult(outcome: MatchOutcome): Promise<{ buffer: Buffer; fileName: string }> {
  const XLSX = (await import('xlsx')).default;

  const header = ['标准号', '标准名称', '省级CMA', 'CNAS', '国家CMA', '是否覆盖', '检测项目'];
  const rows = outcome.results.map((r) => [
    r.stdCode,
    r.stdName || '',
    cellOf(r.provCma),
    cellOf(r.cnas),
    cellOf(r.natCma),
    r.matched ? '✓ 已覆盖' : '✗ 未覆盖',
    paramsOf(r),
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{ wch: 20 }, { wch: 34 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 40 }];
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '资质匹配');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const safeName = outcome.watchlistName.replace(/[\\/:*?"<>|]/g, '').trim() || '清单';
  const fileName = `资质匹配_${safeName}_${Date.now()}.xlsx`;
  return { buffer, fileName };
}
