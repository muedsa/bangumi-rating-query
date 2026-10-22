import type { ImportRecord } from '../core/models.ts';
import type { BackupRecord } from '../core/backup.ts';
import type { CalendarSyncResult } from '../core/calendar.ts';
import type { AliasMiss } from '../core/ports.ts';
import type { LogWriter } from './logger.ts';
import { subjectSearchResultSchema } from '../core/subject-search.ts';

interface RemoteTargetOptions {
  requestDelayMs?: number;
  requestRetries?: number;
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
  const requestRetries = options.requestRetries ?? 0;
  if (!Number.isSafeInteger(requestRetries) || requestRetries < 0)
    throw new Error('请求重试次数必须为非负安全整数');
  const fetcher = options.fetcher ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let previous: Promise<void> = Promise.resolve();
  let requested = false;

  async function execute<T>(path: string, method: string, body?: unknown): Promise<T> {
    // 路径不含凭证，不记录请求头、请求正文或完整 URL。
    const details = { method, path: path.startsWith('/sync-state/') ? '/sync-state/:key' : path };
    // 同一次逻辑请求始终重放相同正文；序列化错误不属于网络错误。
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let retry = 0; ; retry++) {
      const startedAt = performance.now();
      const attemptDetails = { ...details, attempt: retry + 1, requestRetries };
      options.log?.('debug', 'api_request_started', '发送管理 API 请求', attemptDetails);
      let status: number | undefined;
      let ray: string | null = null;
      let requestId: string | null = null;
      let retryAfterMs = 0;
      try {
        const response = await fetcher(new URL(`/api/v1/admin${path}`, url), {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: payload,
        });
        status = response.status;
        ray = response.headers.get('cf-ray');
        const returnedRequestId = response.headers.get('x-request-id') ?? '';
        requestId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(returnedRequestId)
          ? returnedRequestId
          : null;
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after')?.trim();
          if (retryAfter) {
            const wait = /^\d+$/u.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now();
            retryAfterMs = Number.isNaN(wait) ? 0 : Math.max(0, wait);
          }
          throw new Error(
            `管理 API 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`,
          );
        }
        const result = (await response.json()) as T;
        options.log?.('debug', 'api_request_completed', '管理 API 请求完成', {
          ...attemptDetails,
          status,
          ray,
          requestId,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        const retryable =
          status === 408 ||
          status === 429 ||
          (status !== undefined && status >= 500) ||
          ((status === undefined || (status >= 200 && status < 300)) &&
            (error instanceof TypeError ||
              (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))));
        // 不截短服务端要求的长等待，交由用户稍后续跑。
        const retryAfterTooLong = retryAfterMs > 60000;
        const willRetry = retryable && retry < requestRetries && !retryAfterTooLong;
        const failureDetails = {
          ...attemptDetails,
          status,
          ray,
          requestId,
          durationMs: Math.round(performance.now() - startedAt),
          errorType: error instanceof Error ? error.name : 'UnknownError',
          retryable,
          retryAfterTooLong,
        };
        if (!willRetry) {
          options.log?.(
            'error',
            'api_request_failed',
            retryAfterTooLong ? '管理 API 要求等待超过一分钟，请稍后续跑' : '管理 API 请求失败',
            failureDetails,
          );
          throw error;
        }
        // 重试间隔同时满足配置限速与服务端 Retry-After，避免叠加等待。
        const waitMs = Math.max(requestDelayMs, Math.min(1000 * 2 ** retry, 30000), retryAfterMs);
        options.log?.('warn', 'api_request_retry', '管理 API 请求失败，等待后重试', {
          ...failureDetails,
          retry: retry + 1,
          waitMs,
        });
        await sleep(waitMs);
      }
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
    searchSubjects: async (keyword: string, limit: number) =>
      subjectSearchResultSchema.parse(
        await request('/subjects/search', 'POST', { keyword, limit }),
      ),
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
    aliasMisses: async () =>
      (await request<{ aliases: AliasMiss[] }>('/stats/alias-misses')).aliases,
    prune: (days: number) => request('/stats/prune', 'POST', { days }),
    retention: (days: number, _enabled: boolean) => request(`/retention?days=${days}`),
    alias: (id: number, name: string) => request(`/subjects/${id}/aliases`, 'POST', { name }),
  };
}
