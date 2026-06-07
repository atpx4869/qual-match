import { apiGet, apiPut, apiDownloadGet } from './client';

// ─── 类型（对齐后端 system-service camel 输出）────────────────────────────────

export interface OrgSourceOverview {
  source: string;
  label: string;
  count: number;
  dataOrigin: string | null;
  lastSyncAt: string | null;
}

export interface SystemOverview {
  orgSources: OrgSourceOverview[];
  capLib: {
    total: number;
    active: number;
    subscribedDomains: number;
    lastSyncedAt: string | null;
    dataOrigin: string;
  };
  watchlists: { lists: number; items: number };
}

export interface SystemSettings {
  cnasChromePath: string;
  cnasThrottleMs: number;
}

// ─── API ───────────────────────────────────────────────────────────────────

export function getOverview(): Promise<SystemOverview> {
  return apiGet('/api/system/overview');
}

export function getSettings(): Promise<SystemSettings> {
  return apiGet('/api/system/settings');
}

export function updateSettings(body: Partial<SystemSettings>): Promise<SystemSettings> {
  return apiPut('/api/system/settings', body);
}

export function downloadBackup(): Promise<void> {
  return apiDownloadGet('/api/system/backup', 'qual-match-backup.db');
}

/** 数据来源标签（labs.data_origin → 中文）。 */
export const DATA_ORIGIN_LABEL: Record<string, string> = {
  scraped: '在线抓取',
  subscribed: '已订阅',
  imported: 'Excel 导入',
  manual: '手工录入',
};
