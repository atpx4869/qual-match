/**
 * 同步进度内存 store + 全局串行队列（阶段 3/4 共用）。
 *
 * 抽出的原因：cap-lib（一单一库领域同步）与 scrape（省级 CMA / CNAS 机构抓取）都需要
 *   - 一个 jobId → 进度 的内存 Map，供前端轮询；
 *   - 一条全局串行 chain，保证任意时刻最多 1 个大入库事务在跑（better-sqlite3 事务同步
 *     阻塞主线程，N 个并发会连环锁死事件循环）。
 * 两处逻辑此前各写一份（DRY 红线），统一到这里。
 *
 * 进度形态对两类源做了泛化：phase 用共同集合，target 承载领域名或机构标识，
 * stats 是可选的源专属统计载荷（cap-lib 带 removedSoft，scrape 不带）。
 */

/** 同步阶段（两类源共用；cap-lib 用 fetching/upserting，scrape 同）。 */
export type SyncPhase = 'pending' | 'fetching' | 'upserting' | 'done' | 'error';

/** 通用进度。target = 领域名（cap-lib）或机构标识（scrape）。stats 源专属。 */
export interface SyncProgress<TStats = unknown> {
  phase: SyncPhase;
  target: string;
  current: number;
  total: number;
  error?: string;
  stats?: TStats;
}

const progressStore = new Map<string, SyncProgress>();

export function getSyncProgress(jobId: string): SyncProgress | null {
  return progressStore.get(jobId) || null;
}

export function setProgress(jobId: string, p: SyncProgress): void {
  progressStore.set(jobId, p);
}

/** 防 progressStore 无限增长：保留最近 50 个 job。 */
export function pruneProgressStore(): void {
  if (progressStore.size <= 50) return;
  const keys = [...progressStore.keys()];
  for (const k of keys.slice(0, keys.length - 50)) progressStore.delete(k);
}

/** 遍历当前所有进度（用于「同一 target 已有 running job 则复用」的去重判断）。 */
export function eachProgress(): IterableIterator<[string, SyncProgress]> {
  return progressStore.entries();
}

/**
 * 全局同步串行队列（并发 1）。所有抓取/同步任务串到这条 chain 上，任意时刻最多一个
 * 入库事务在跑 —— 配合任务内分块让出（setImmediate），事件循环始终可响应。
 *
 * task 内部应自行 catch 把错误写进 progressStore（chain 不能因单任务失败中断后续）。
 */
let syncChain: Promise<void> = Promise.resolve();

export function enqueueSync(task: () => Promise<void>): void {
  syncChain = syncChain.then(task);
}

/** 生成一个 jobId（前缀区分来源）。 */
export function makeJobId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
