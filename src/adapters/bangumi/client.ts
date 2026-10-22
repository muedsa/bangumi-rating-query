import { fromApi, fromApiPlatform, fromCalendar, fromSearch } from './parse.ts';
import type { CalendarSource, SubjectSource, SubjectSearchSource } from '../../core/ports.ts';
import { subjectSearchRequestSchema } from '../../core/subject-search.ts';

interface BangumiClientOptions {
  accessToken?: string;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class BangumiClient implements SubjectSource, CalendarSource, SubjectSearchSource {
  private readonly accessToken: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private userAgent: string,
    options: BangumiClientOptions = {},
  ) {
    if (!userAgent.trim()) throw new Error('请配置包含开发者和应用标识的 BANGUMI_USER_AGENT');
    this.accessToken = options.accessToken?.trim() ?? '';
    this.fetcher = options.fetcher ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }
  async getSubject(id: number) {
    const record = fromApi(await this.request(`/v0/subjects/${id}`));
    if (record.subject.id !== id) throw new Error('Bangumi 详情条目 ID 与请求不一致');
    return record;
  }
  async searchSubjects(keyword: string, limit: number) {
    const request = subjectSearchRequestSchema.parse({ keyword, limit });
    return fromSearch(
      await this.request(`/v0/search/subjects?limit=${request.limit}&offset=0`, {
        keyword: request.keyword,
        sort: 'match',
        filter: { type: [2] },
      }),
      request.limit,
    );
  }
  async getCalendar() {
    return fromCalendar(await this.request('/calendar'));
  }
  async getSubjectPlatform(id: number) {
    return fromApiPlatform(await this.request(`/v0/subjects/${id}`), id);
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    // Workers 的全局 fetch 不能以客户端实例作为 this 调用。
    const fetcher = this.fetcher;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = new Headers({ 'User-Agent': this.userAgent, Accept: 'application/json' });
      if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      const response = await fetcher(`https://api.bgm.tv${path}`, {
        headers,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        // Worker 不支持 redirect=error；不跟随跳转，并在下方按非成功状态拒绝。
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return await response.json();
      await response.body?.cancel();
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2)
        throw new Error(`Bangumi 返回 HTTP ${response.status}`);
      const retry = response.headers.get('Retry-After');
      const wait = retry
        ? /^\d+$/u.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now()
        : 1000 * 2 ** attempt;
      // 长等待交由下一次定时任务处理，不能截短 Retry-After 后提前重试。
      if (Number.isFinite(wait) && wait > 60000)
        throw new Error('Bangumi 要求较长时间后重试，请延后同步任务');
      await this.sleep(Math.max(1000, Number.isFinite(wait) ? wait : 1000));
    }
    throw new Error('Bangumi 重试失败');
  }
}

export function createBangumiSource(config: {
  BANGUMI_USER_AGENT: string;
  BANGUMI_ACCESS_TOKEN: string;
}): BangumiClient | undefined {
  return config.BANGUMI_USER_AGENT
    ? new BangumiClient(config.BANGUMI_USER_AGENT, {
        accessToken: config.BANGUMI_ACCESS_TOKEN,
      })
    : undefined;
}
