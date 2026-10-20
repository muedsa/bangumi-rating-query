import type { ImportRecord } from '../core/models.ts';
import type { BackupRecord } from '../core/backup.ts';
import type { CalendarSyncResult } from '../core/calendar.ts';
import type { LogWriter } from './logger.ts';

interface RemoteTargetOptions {
  requestDelayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: LogWriter;
}

export function remoteTarget(base: string, token: string, options: RemoteTargetOptions = {}) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('远程管理需要 HTTPS');
  if (!token) throw new Error('远程管理需要 ADMIN_TOKEN');
  const requestDelayMs = options.requestDelayMs ?? 0;
  if (!Number.isSafeInteger(requestDelayMs) || requestDelayMs < 0 || requestDelayMs > 2147483647)
    throw new Error('请求延迟必须为 0～2147483647 毫秒的整数');
  const fetcher = options.fetcher ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let previous: Promise<void> = Promise.resolve();
  let requested = false;

  async function execute<T>(path: string, method: string, body?: unknown): Promise<T> {
    const startedAt = performance.now();
    // 路径不含凭证，不记录请求头、请求正文或完整 URL。
    const details = { method, path: path.startsWith('/sync-state/') ? '/sync-state/:key' : path };
    options.log?.('debug', 'api_request_started', '发送管理 API 请求', details);
    let status: number | undefined;
    let ray: string | null = null;
    let requestId: string | null = null;
    try {
      const response = await fetcher(new URL(`/api/v1/admin${path}`, url), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = response.status;
      ray = response.headers.get('cf-ray');
      const returnedRequestId = response.headers.get('x-request-id') ?? '';
      requestId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(returnedRequestId)
        ? returnedRequestId
        : null;
      if (!response.ok)
        throw new Error(
          `管理 API 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      const result = (await response.json()) as T;
      options.log?.('debug', 'api_request_completed', '管理 API 请求完成', {
        ...details,
        status,
        ray,
        requestId,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      options.log?.('error', 'api_request_failed', '管理 API 请求失败', {
        ...details,
        status,
        ray,
        requestId,
        durationMs: Math.round(performance.now() - startedAt),
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }
  function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!requestDelayMs) return execute<T>(path, method, body);
    const result = previous.then(async () => {
      if (requested) {
        options.log?.('debug', 'api_request_delay', '等待远程请求间隔', { requestDelayMs });
        await sleep(requestDelayMs);
      }
      requested = true;
      return await execute<T>(path, method, body);
    });
    // 等待前一次响应体处理结束；请求失败仍向调用者抛出，但不锁死后续队列。
    previous = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return {
    close() {},
    syncSubject: (id: number) => request<{ imported: number }>(`/subjects/${id}/sync`, 'POST'),
    syncCalendar: () => request<CalendarSyncResult>('/calendar/sync', 'POST'),
    importRecord: async (record: ImportRecord) => {
      await request('/import', 'POST', record);
    },
    getState: async (key: string) =>
      (await request<{ value: string | null }>(`/sync-state/${encodeURIComponent(key)}`)).value,
    setState: async (key: string, value: string) => {
      await request(`/sync-state/${encodeURIComponent(key)}`, 'PUT', { value });
    },
    exportPage: (after: number) =>
      request<{ records: BackupRecord[]; nextCursor: number | null }>(`/export?after=${after}`),
    restore: async (record: BackupRecord) => {
      await request('/restore', 'POST', record);
    },
    stats: () => request('/stats'),
    prune: (days: number) => request('/stats/prune', 'POST', { days }),
    retention: (days: number, _enabled: boolean) => request(`/retention?days=${days}`),
    alias: (id: number, name: string) => request(`/subjects/${id}/aliases`, 'POST', { name }),
  };
}
