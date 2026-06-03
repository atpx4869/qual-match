/**
 * 统一 API 客户端：封装 fetch，解 Result 壳 { data, error }。
 * 成功返回 data；失败抛 ApiClientError（带 code/message），页面 try/catch 弹 ElMessage。
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  code: string;
  details?: unknown;
  constructor(err: ApiError) {
    super(err.message);
    this.name = 'ApiClientError';
    this.code = err.code;
    this.details = err.details;
  }
}

interface ResultShell<T> {
  data: T | null;
  error: ApiError | null;
}

async function unwrap<T>(resp: Response): Promise<T> {
  const json = (await resp.json()) as ResultShell<T>;
  if (json.error) throw new ApiClientError(json.error);
  return json.data as T;
}

/** GET，返回解包后的 data。 */
export async function apiGet<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  return unwrap<T>(resp);
}

/** POST JSON，返回解包后的 data。 */
export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return unwrap<T>(resp);
}

/** DELETE，返回解包后的 data。 */
export async function apiDelete<T>(url: string): Promise<T> {
  const resp = await fetch(url, { method: 'DELETE' });
  return unwrap<T>(resp);
}

/** PUT JSON，返回解包后的 data。 */
export async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return unwrap<T>(resp);
}

/** POST FormData（文件上传），返回解包后的 data。 */
export async function apiUpload<T>(url: string, form: FormData): Promise<T> {
  const resp = await fetch(url, { method: 'POST', body: form });
  return unwrap<T>(resp);
}

/** POST 触发下载（导出 Excel）。不解 Result 壳，直接拿 blob 触发浏览器下载。
 *  可选 body：综合查询导出需要传 { q, sources } 等查询条件（JSON）。 */
export async function apiDownload(url: string, body?: unknown): Promise<void> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    // 错误时后端返回 Result 壳 JSON
    try {
      const json = (await resp.json()) as ResultShell<unknown>;
      if (json.error) throw new ApiClientError(json.error);
    } catch (e) {
      if (e instanceof ApiClientError) throw e;
    }
    throw new ApiClientError({ code: 'DOWNLOAD_FAILED', message: '导出失败' });
  }
  const blob = await resp.blob();
  const disposition = resp.headers.get('Content-Disposition') ?? '';
  const m = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const fileName = m ? decodeURIComponent(m[1]) : 'export.xlsx';
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}
