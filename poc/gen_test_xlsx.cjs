const XLSX = require('xlsx');
const path = require('path');
const dir = process.argv[2] || '.';

function write(file, aoa, sheet) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  XLSX.writeFile(wb, path.join(dir, file));
}

// 资质明细（CNAS，本机构）
write('qual_cnas.xlsx', [
  ['标准号', '标准名称', '检测项目'],
  ['GB/T 3325-2024', '金属家具', '甲醛释放量'],
  ['GB 5009.3-2016', '食品水分', '水分'],
  ['QB/T 4463-2013', '旧版标准', '某项目'],
  ['', '空号应跳过', 'x'],
], 'CNAS资质');

// 标准清单
write('list.xlsx', [
  ['标准号', '标准名称'],
  ['GB/T 3325 -2024', '金属家具（脏空格测归一）'],
  ['QB/T 4463-2025', '新版（应给跨年提示）'],
  ['GB/T 9999-2021', '未覆盖标准'],
], '清单');

console.log('wrote qual_cnas.xlsx + list.xlsx to', dir);
