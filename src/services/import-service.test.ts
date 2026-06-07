import { describe, expect, it } from 'vitest';
import { parseExcelBuffer } from './import-service';

describe('parseExcelBuffer — 清单表头识别', () => {
  it('识别标准号 / 中文标准名称 / 受控编号 / 是否有文本 / 所属部门', async () => {
    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['标准号', '中文标准名称', '受控编号', '是否有文本', '所属部门'],
      ['GB/T 3325-2024', '金属家具通用技术条件', 'K-001', '是', '质检部'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, '清单');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const rows = await parseExcelBuffer(buffer);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stdCode: 'GB/T 3325-2024',
      stdName: '金属家具通用技术条件',
      controlledNo: 'K-001',
      hasText: '是',
      department: '质检部',
    });
  });
});
