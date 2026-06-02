import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 运行时根目录。默认 process.cwd()，可用环境变量 QM_BASE_DIR 覆盖（部署/测试用）。
 * 移植自 bzxz src/shared/fs.ts（裁剪：去掉导出/库/Electron 相关，仅留根目录与 data 目录）。
 */
export function getRootDir(): string {
  return process.env.QM_BASE_DIR || process.cwd();
}

/** 运行时数据目录（SQLite 库所在）。 */
export function getDataDir(): string {
  return path.join(getRootDir(), 'data');
}

/** 确保 data/ 目录存在（启动时调用，库文件在此创建）。 */
export async function ensureDataDirs(): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
}
