import { assertTrendsHtmlSize, TRENDS_LIST_ID } from './trends.ts';

/** Puppeteer 与 @cloudflare/puppeteer 的 Page 都满足该结构。 */
export interface BrowserPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  setUserAgent(userAgent: string): Promise<void>;
  setViewport(viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }): Promise<void>;
  setExtraHTTPHeaders?(headers: Record<string, string>): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserSession {
  userAgent(): Promise<string>;
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserPageOptions {
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 统一浏览器指纹：去掉 HeadlessChrome 标识，并声明中文浏览器环境。 */
export async function prepareBrowserPage(page: BrowserPage, userAgent: string): Promise<void> {
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.setUserAgent(userAgent.replace(/HeadlessChrome\//u, 'Chrome/'));
  await page.setExtraHTTPHeaders?.({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  });
}

/**
 * 打开 Bangumi 页面并等待 Cloudflare 浏览器验证结束。
 * 验证页会自行刷新或重定向，期间 evaluate 可能因执行上下文销毁而失败，继续轮询即可。
 */
export async function readTrendsPage(
  page: BrowserPage,
  url: string,
  options: BrowserPageOptions,
): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 1000;
  const deadline = now() + options.timeoutMs;
  let lastError: unknown;
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(options.timeoutMs, 15000),
    });
  } catch (error) {
    // 验证页可能在 DOMContentLoaded 后立刻跳转，导致 goto 被中断；继续等待列表。
    lastError = error;
  }
  while (true) {
    let ready = false;
    try {
      ready = await page.evaluate(() => Boolean(document.getElementById('browserItemList')));
    } catch (error) {
      lastError = error;
    }
    if (ready) {
      let html = '';
      try {
        html = await page.content();
      } catch (error) {
        lastError = error;
      }
      if (html) {
        assertTrendsHtmlSize(html);
        if (html.includes(TRENDS_LIST_ID)) return html;
        lastError = new Error('页面列表在读取前发生变化');
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      let title = '';
      try {
        title = (await page.title()).trim().slice(0, 120);
      } catch {
        /* 页面已关闭时标题不可读，错误信息保留 URL 以外的通用描述。 */
      }
      throw new Error(
        `等待 Bangumi 热度页面通过 Cloudflare 验证超时${title ? `（${title}）` : ''}`,
        lastError === undefined ? undefined : { cause: lastError },
      );
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function closeBrowserQuietly(browser: Pick<BrowserSession, 'close'>): Promise<void> {
  try {
    await browser.close();
  } catch {
    /* 关闭失败不能覆盖页面抓取错误，浏览器会话会由平台超时回收。 */
  }
}
