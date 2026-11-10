import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import type { PageRenderer } from '../../core/ports.ts';
import {
  closeBrowserQuietly,
  prepareBrowserPage,
  readTrendsPage,
  type BrowserSession,
} from './page.ts';

export interface WorkerBrowserOptions {
  timeoutMs: number;
}

export interface WorkerBrowserDependencies {
  launch?: (binding: BrowserWorker, options: { keep_alive: number }) => Promise<BrowserSession>;
}

/** Worker 模式使用 Cloudflare Browser Rendering；BROWSER 缺失时只让热度同步失败。 */
export function createWorkerPageRenderer(
  binding: BrowserWorker | undefined,
  options: WorkerBrowserOptions,
  dependencies: WorkerBrowserDependencies = {},
): PageRenderer {
  const launch =
    dependencies.launch ??
    (puppeteer.launch as unknown as (
      binding: BrowserWorker,
      options: { keep_alive: number },
    ) => Promise<BrowserSession>);
  return {
    async render(url) {
      if (!binding)
        throw new Error(
          'Worker 未绑定 Browser Rendering（BROWSER），无法使用浏览器模式获取 Bangumi 热度页面',
        );
      let browser: BrowserSession;
      try {
        browser = await launch(binding, {
          keep_alive: Math.min(Math.max(options.timeoutMs + 30000, 60000), 600000),
        });
      } catch (error) {
        throw new Error('启动 Cloudflare Browser Rendering 会话失败', { cause: error });
      }
      try {
        const page = await browser.newPage();
        await prepareBrowserPage(page, await browser.userAgent());
        return await readTrendsPage(page, url, { timeoutMs: options.timeoutMs });
      } finally {
        await closeBrowserQuietly(browser);
      }
    },
  };
}
