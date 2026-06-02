import { describe, it, expect } from 'vitest';
import { cleanStdCode, extractFullCode, extractBaseCode } from './std-code';

// 用例取自 std-code.ts 注释中列举的真实脏数据样本（CNAS/CMA 抓取、用户手输、Excel 全角）。
// 这是全项目归一化的地基，任何脏数据变体回归都先在这里挂。

describe('cleanStdCode — 入库前轻量清洗（保前缀、保大小写）', () => {
  it('折叠年份连字符附近的脏空格', () => {
    expect(cleanStdCode('GB/T 3325 -2024')).toBe('GB/T 3325-2024');   // CNAS 抓取脏空格
    expect(cleanStdCode('GB/T 3325- 2024')).toBe('GB/T 3325-2024');
    expect(cleanStdCode('GB/T 3325 - 2024')).toBe('GB/T 3325-2024');
  });
  it('折叠多空格但保留前缀写法', () => {
    expect(cleanStdCode('GB/T   3325-2024')).toBe('GB/T 3325-2024');
    expect(cleanStdCode('  GB/T 3325-2024  ')).toBe('GB/T 3325-2024');
  });
  it('不改大小写、不剥前缀', () => {
    expect(cleanStdCode('gb/t 3325-2024')).toBe('gb/t 3325-2024');
  });
});

describe('extractFullCode — 保年归一（精确匹配键）', () => {
  it('剥前缀 type designator + 紧凑化，保留年份', () => {
    expect(extractFullCode('GB/T 23440-2009')).toBe('GB23440-2009');
    expect(extractFullCode('GBZ/T 188-2014')).toBe('GBZ188-2014');
  });
  it('不同源同号同年归一为同一字符串（索引等值匹配前提）', () => {
    const a = extractFullCode('GB/T 3325 -2024');   // CNAS 脏空格
    const b = extractFullCode('GB/T 3325-2024');     // CMA 干净
    expect(a).toBe(b);
    expect(a).toBe('GB3325-2024');
  });
  it('无空格变体不被剥空', () => {
    expect(extractFullCode('GB/T3325-2024')).toBe('GB3325-2024');
  });
  it('全角整串归一', () => {
    expect(extractFullCode('ＧＢ／Ｔ ３３２５－２０２４')).toBe('GB3325-2024');
  });
  it('ISO 冒号年份分隔归一为连字符', () => {
    expect(extractFullCode('ISO 4287:1997')).toBe('ISO4287-1997');
  });
  it('年份是天然终止符：年份后的条款/附录引用一律丢弃', () => {
    expect(extractFullCode('GB/T 3325-2024 第8.3.1.3条')).toBe('GB3325-2024');
    expect(extractFullCode('GB/T 3325-2024 附录A')).toBe('GB3325-2024');
  });
  it('保留修订标记 A/B/R', () => {
    expect(extractFullCode('GB/T 3836-2010A')).toBe('GB3836-2010A');
  });
  it('问号噪声删除', () => {
    expect(extractFullCode('？QB/T？4566-2025')).toBe('QB4566-2025');
  });
  it('无年份的老式号保留', () => {
    expect(extractFullCode('JB 4730')).toBe('JB4730');
  });
});

describe('extractBaseCode — 剥年归一（跨年兜底）', () => {
  it('剥掉年份后缀', () => {
    expect(extractBaseCode('GB/T 23440-2009')).toBe('GB23440');
    expect(extractBaseCode('GB/T 3325-2024')).toBe('GB3325');
  });
  it('同号不同年剥到同一 base', () => {
    expect(extractBaseCode('QB/T 4463-2013')).toBe(extractBaseCode('QB/T 4463-2025'));
  });
  it('剥掉带修订标记的年份', () => {
    expect(extractBaseCode('GB/T 3836-2010A')).toBe('GB3836');
  });
  it('无年份号 base 等于 full', () => {
    expect(extractBaseCode('JB 4730')).toBe('JB4730');
  });
});

describe('边界与异常输入', () => {
  it('空串/纯空白', () => {
    expect(extractFullCode('')).toBe('');
    expect(extractBaseCode('   ')).toBe('');
    expect(cleanStdCode('   ')).toBe('');
  });
});
