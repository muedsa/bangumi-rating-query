import { fromApi, fromApiPlatform, fromCalendar } from './parse.ts';
import type { CalendarSource, SubjectSource } from '../../core/ports.ts';

interface BangumiClientOptions {
  accessToken?: string;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class BangumiClient implements SubjectSource, CalendarSource {
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
    return fromApi(await this.request(`/v0/subjects/${id}`));
  }
  async getCalendar() {
    return fromCalendar(await this.request('/calendar'));
  }
  async getSubjectPlatform(id: number) {
    return fromApiPlatform(await this.request(`/v0/subjects/${id}`), id);
  }
  private async request(path: string): Promise<unknown> {
    // Workers 的全局 fetch 不能以客户端实例作为 this 调用。
    const fetcher = this.fetcher;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = new Headers({ 'User-Agent': this.userAgent, Accept: 'application/json' });
      if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
      const response = await fetcher(`https://api.bgm.tv${path}`, {
        headers,
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
