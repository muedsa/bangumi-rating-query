import { expect, test } from 'bun:test';
import { prepareBrowserPage, readTrendsPage } from '../../src/adapters/bangumi/page.ts';
import { MAX_TRENDS_HTML_BYTES, TRENDS_URL } from '../../src/adapters/bangumi/trends.ts';
import { FakeBrowserPage } from '../helpers/browser.ts';
import { trendsHtml } from '../helpers/trends.ts';

function manualClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

test('浏览器页面等待验证完成后读取列表，验证页的异常不影响轮询', async () => {
  const page = new FakeBrowserPage(['challenge', 'throw', 'challenge', 'ready']);
  const clock = manualClock();
  const html = await readTrendsPage(page, TRENDS_URL, {
    timeoutMs: 5000,
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(html).toBe(trendsHtml([1]));
  expect(page.urls).toEqual([TRENDS_URL]);
  expect(clock.sleeps).toEqual([1000, 1000, 1000]);
});

test('浏览器导航被验证跳转中断时仍继续等待列表', async () => {
  const page = new FakeBrowserPage(['ready']);
  page.gotoError = new Error('net::ERR_ABORTED');
  const clock = manualClock();
  expect(
    await readTrendsPage(page, TRENDS_URL, {
      timeoutMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
    }),
  ).toBe(trendsHtml([1]));
});

test('浏览器等待验证超时后报告页面标题，并保留最后一次上下文错误', async () => {
  const page = new FakeBrowserPage(['throw'], trendsHtml([1]), 'Just a moment...');
  const clock = manualClock();
  const error = await readTrendsPage(page, TRENDS_URL, {
    timeoutMs: 5000,
    now: clock.now,
    sleep: clock.sleep,
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('Cloudflare 验证超时');
  expect((error as Error).message).toContain('Just a moment...');
  expect(((error as Error).cause as Error).message).toContain('Execution context was destroyed');
  expect(clock.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
});

test('浏览器读取的 HTML 超过 2 MiB 时立即拒绝，不继续轮询', async () => {
  const page = new FakeBrowserPage(['ready'], 'x'.repeat(MAX_TRENDS_HTML_BYTES + 1));
  const clock = manualClock();
  await expect(
    readTrendsPage(page, TRENDS_URL, {
      timeoutMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
    }),
  ).rejects.toThrow('超过 2 MiB');
  expect(clock.sleeps).toEqual([]);
});

test('浏览器读取后列表消失时继续等待而不是返回验证页', async () => {
  const page = new FakeBrowserPage(['ready', 'ready']);
  (page as unknown as { content: () => Promise<string> }).content = async () => '<html></html>';
  const clock = manualClock();
  await expect(
    readTrendsPage(page, TRENDS_URL, {
      timeoutMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
    }),
  ).rejects.toThrow('Cloudflare 验证超时');
  expect(clock.sleeps).toEqual([1000, 1000, 1000]);
});

test('浏览器页面使用普通 Chrome UA、中文请求头和桌面视口', async () => {
  const page = new FakeBrowserPage();
  await prepareBrowserPage(page, 'HeadlessChrome/120.0.0.0');
  expect(page.userAgent).toBe('Chrome/120.0.0.0');
  expect(page.viewport).toEqual({ width: 1366, height: 768, deviceScaleFactor: 1 });
  expect(page.headers).toEqual({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  });
});
