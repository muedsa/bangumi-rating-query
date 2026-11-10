import type { BrowserPage, BrowserSession } from '../../src/adapters/bangumi/page.ts';
import { trendsHtml } from './trends.ts';

export type FakePageState = 'ready' | 'challenge' | 'throw';

/** 模拟 Cloudflare 验证页逐步变为真实列表，不启动真实浏览器。 */
export class FakeBrowserPage implements BrowserPage {
  readonly urls: string[] = [];
  userAgent?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  headers?: Record<string, string>;
  closed = false;
  gotoError?: unknown;
  private stateIndex = 0;

  constructor(
    private states: FakePageState[] = ['ready'],
    private html = trendsHtml([1]),
    private pageTitle = '浏览全部动画 | Bangumi 番组计划',
  ) {}

  async goto(url: string): Promise<unknown> {
    this.urls.push(url);
    if (this.gotoError !== undefined) throw this.gotoError;
    return null;
  }

  async evaluate<T>(_pageFunction: () => T): Promise<T> {
    const state =
      this.states[Math.min(this.stateIndex, this.states.length - 1)] ?? ('challenge' as const);
    this.stateIndex++;
    if (state === 'throw') throw new Error('Execution context was destroyed');
    return (state === 'ready') as unknown as T;
  }

  async content(): Promise<string> {
    return this.html;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  url(): string {
    return this.urls.at(-1) ?? '';
  }

  async setUserAgent(userAgent: string): Promise<void> {
    this.userAgent = userAgent;
  }

  async setViewport(viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }): Promise<void> {
    this.viewport = viewport;
  }

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.headers = headers;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeBrowser implements BrowserSession {
  closed = false;

  constructor(
    public page: FakeBrowserPage,
    private userAgentValue = 'HeadlessChrome/120.0.0.0',
  ) {}

  async userAgent(): Promise<string> {
    return this.userAgentValue;
  }

  async newPage(): Promise<BrowserPage> {
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
