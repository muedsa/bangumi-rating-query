import puppeteer from 'puppeteer';
import type { PageRenderer } from '../../core/ports.ts';
import {
  closeBrowserQuietly,
  prepareBrowserPage,
  readTrendsPage,
  type BrowserSession,
} from './page.ts';

export interface NodeBrowserOptions {
  timeoutMs: number;
}

export interface NodeLaunchOptions {
  headless: boolean;
  executablePath?: string;
  userDataDir?: string;
  args: string[];
  timeout: number;
  protocolTimeout: number;
}

export interface NodeBrowserDependencies {
  launch?: (options: NodeLaunchOptions) => Promise<BrowserSession>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Node 模式用 Puppeteer 启动本机 Chrome/Chromium，等待验证后返回页面 HTML。 */
export function createNodePageRenderer(
  options: NodeBrowserOptions,
  dependencies: NodeBrowserDependencies = {},
): PageRenderer {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const launch =
    dependencies.launch ??
    (puppeteer.launch as unknown as (options: NodeLaunchOptions) => Promise<BrowserSession>);
  // 持久化用户目录不能被两个 Chrome 同时加锁；同进程内的手动与定时任务串行执行。
  let queue: Promise<unknown> = Promise.resolve();
  const render = async (url: string): Promise<string> => {
    let browser: BrowserSession;
    try {
      browser = await launch({
        headless: env.PUPPETEER_HEADLESS !== 'false',
        executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
        userDataDir: env.PUPPETEER_USER_DATA_DIR || undefined,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--lang=zh-CN',
          ...(platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
        ],
        timeout: Math.min(options.timeoutMs, 30000),
        protocolTimeout: options.timeoutMs,
      });
    } catch (error) {
      throw new Error(
        '启动浏览器失败，请确认已安装 Chrome/Chromium，必要时配置 PUPPETEER_EXECUTABLE_PATH',
        { cause: error },
      );
    }
    try {
      const page = await browser.newPage();
      await prepareBrowserPage(page, await browser.userAgent());
      return await readTrendsPage(page, url, { timeoutMs: options.timeoutMs });
    } finally {
      await closeBrowserQuietly(browser);
    }
  };
  return {
    render(url) {
      const current = queue.then(
        () => render(url),
        () => render(url),
      );
      queue = current.catch(() => {});
      return current;
    },
  };
}
