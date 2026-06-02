/**
 * 加载 `.env.local` 到 process.env。
 *
 * - 单次幂等：内部用 module 级 flag 防重复加载
 * - override: false：真实环境变量（CI / shell `set` / pm2 注入）优先级最高，
 *   .env.local 只做本机默认值兜底
 * - 不抛错：dotenv 找不到文件时静默跳过；解析错误打 warn 后继续
 *
 * 凭据约定（与项目 CLAUDE.md 一致）：源 adapter 的账号密码必须通过 .env.local
 * （gitignored）注入，键名 `<SOURCE>_USERNAME` / `<SOURCE>_PASSWORD`，绝不写进代码。
 *
 * 移植自 bzxz src/shared/env-loader.ts（裁剪：本项目仅 Web、无 Electron，
 * 只从 cwd 找 .env.local，去掉 bzxz 的 execPath 安装目录候选）。
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

let loaded = false;

export function loadDotEnvLocal(): { loaded: boolean; path?: string } {
  if (loaded) return { loaded: true };
  loaded = true;

  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return { loaded: false };

  try {
    // 延迟 require：dotenv 是可选依赖（npm i 漏装也不应让进程崩）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dotenv = require('dotenv') as typeof import('dotenv');
    const result = dotenv.config({ path: envPath, override: false });
    if (result.error) {
      console.warn('[env] .env.local parse error:', result.error.message);
      return { loaded: false };
    }
    console.log('[env] loaded .env.local from:', envPath);
    return { loaded: true, path: envPath };
  } catch (e) {
    console.warn('[env] dotenv not installed, skipped .env.local:', e instanceof Error ? e.message : String(e));
    return { loaded: false };
  }
}
