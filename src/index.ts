import { loadDotEnvLocal } from './shared/env-loader';
import { ensureDataDirs } from './shared/fs';
import { createApp, type QualMatchApp } from './api/app';
import { createServer, type Server } from 'node:http';

// 凭据加载必须最先（让后续 import 的 adapter 在构造时已有 process.env）。
loadDotEnvLocal();

function listenWithFallback(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.warn(`[server] port ${port} in use, falling back to a random port`);
        server.removeListener('error', onError);
        server.listen(0, '0.0.0.0');
      } else {
        reject(e);
      }
    };
    server.on('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

async function main(): Promise<void> {
  await ensureDataDirs();

  const app: QualMatchApp = createApp();
  const server = createServer(app);

  const port = Number(process.env.PORT ?? 3000);
  const actualPort = await listenWithFallback(server, port);
  console.log(`[server] qual-match listening on http://localhost:${actualPort}`);

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => {
      app.shutdown();
      process.exit(0);
    });
    // 兜底：5s 内没关干净就强退
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[server] fatal startup error:', e);
  process.exit(1);
});
