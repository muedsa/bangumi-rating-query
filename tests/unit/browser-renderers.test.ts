import { expect, test } from 'bun:test';
import type { BrowserWorker } from '@cloudflare/puppeteer';
import {
  createNodePageRenderer,
  type NodeLaunchOptions,
} from '../../src/adapters/bangumi/browser-node.ts';
import { createWorkerPageRenderer } from '../../src/adapters/bangumi/browser-worker.ts';
import { TRENDS_URL } from '../../src/adapters/bangumi/trends.ts';
import { FakeBrowser, FakeBrowserPage } from '../helpers/browser.ts';
import { trendsHtml } from '../helpers/trends.ts';

test('Node 渲染器启动 Chrome、使用普通 UA 并在成功或失败后关闭浏览器', async () => {
  const page = new FakeBrowserPage();
  const browser = new FakeBrowser(page);
  let launchOptions: NodeLaunchOptions | undefined;
  const renderer = createNodePageRenderer(
    { timeoutMs: 5000 },
    {
      env: {
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
        PUPPETEER_USER_DATA_DIR: '/tmp/profile',
      },
      platform: 'linux',
      launch: async (options) => {
        launchOptions = options;
        return browser;
      },
    },
  );
  expect(await renderer.render(TRENDS_URL)).toBe(trendsHtml([1]));
  expect(launchOptions).toMatchObject({
    headless: true,
    executablePath: '/usr/bin/chromium',
    userDataDir: '/tmp/profile',
    timeout: 5000,
    protocolTimeout: 5000,
  });
  expect(launchOptions!.args).toContain('--no-sandbox');
  expect(launchOptions!.args).toContain('--disable-blink-features=AutomationControlled');
  expect(page.userAgent).toBe('Chrome/120.0.0.0');
  expect(browser.closed).toBe(true);

  const failedBrowser = new FakeBrowser(new FakeBrowserPage());
  failedBrowser.newPage = async () => {
    throw new Error('page failed');
  };
  const failing = createNodePageRenderer(
    { timeoutMs: 5000 },
    { env: {}, platform: 'win32', launch: async () => failedBrowser },
  );
  await expect(failing.render(TRENDS_URL)).rejects.toThrow('page failed');
  expect(failedBrowser.closed).toBe(true);
});

test('Node 渲染器支持有头模式，Windows 不强制关闭沙箱', async () => {
  let launchOptions: NodeLaunchOptions | undefined;
  const renderer = createNodePageRenderer(
    { timeoutMs: 5000 },
    {
      env: { PUPPETEER_HEADLESS: 'false' },
      platform: 'win32',
      launch: async (options) => {
        launchOptions = options;
        return new FakeBrowser(new FakeBrowserPage(['ready']));
      },
    },
  );
  await renderer.render(TRENDS_URL);
  expect(launchOptions!.headless).toBe(false);
  expect(launchOptions!.executablePath).toBeUndefined();
  expect(launchOptions!.userDataDir).toBeUndefined();
  expect(launchOptions!.args).not.toContain('--no-sandbox');
});

test('Node 浏览器启动失败时给出可操作的错误并保留原因', async () => {
  const failure = new Error('chrome not found');
  const renderer = createNodePageRenderer(
    { timeoutMs: 5000 },
    {
      env: {},
      platform: 'win32',
      launch: async () => {
        throw failure;
      },
    },
  );
  const error = await renderer.render(TRENDS_URL).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('启动浏览器失败');
  expect((error as Error).cause).toBe(failure);
});

test('Node 渲染器串行化同进程浏览器启动，避免用户目录锁冲突', async () => {
  let active = 0;
  let maxActive = 0;
  const releases: (() => void)[] = [];
  const renderer = createNodePageRenderer(
    { timeoutMs: 5000 },
    {
      env: { PUPPETEER_USER_DATA_DIR: '/tmp/profile' },
      platform: 'win32',
      launch: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return new FakeBrowser(new FakeBrowserPage(['ready']));
      },
    },
  );
  const first = renderer.render(TRENDS_URL);
  const second = renderer.render(TRENDS_URL);
  while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(maxActive).toBe(1);
  releases.shift()!();
  while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(maxActive).toBe(1);
  releases.shift()!();
  await Promise.all([first, second]);
  expect(maxActive).toBe(1);
});

test('Worker 渲染器在缺少 Browser Rendering 绑定时只让热度同步失败', async () => {
  let launched = 0;
  const renderer = createWorkerPageRenderer(
    undefined,
    { timeoutMs: 5000 },
    {
      launch: async () => {
        launched++;
        return new FakeBrowser(new FakeBrowserPage());
      },
    },
  );
  await expect(renderer.render(TRENDS_URL)).rejects.toThrow('未绑定 Browser Rendering');
  expect(launched).toBe(0);
});

test('Worker 渲染器通过绑定启动浏览器、设置会话保活并关闭', async () => {
  const page = new FakeBrowserPage();
  const browser = new FakeBrowser(page);
  const binding: BrowserWorker = {
    fetch: (async () => new Response()) as unknown as typeof fetch,
  };
  let launchBinding: BrowserWorker | undefined;
  let keepAlive: number | undefined;
  const renderer = createWorkerPageRenderer(
    binding,
    { timeoutMs: 5000 },
    {
      launch: async (worker, options) => {
        launchBinding = worker;
        keepAlive = options.keep_alive;
        return browser;
      },
    },
  );
  expect(await renderer.render(TRENDS_URL)).toBe(trendsHtml([1]));
  expect(launchBinding).toBe(binding);
  expect(keepAlive).toBe(60000);
  expect(page.userAgent).toBe('Chrome/120.0.0.0');
  expect(browser.closed).toBe(true);

  const failedBrowser = new FakeBrowser(new FakeBrowserPage());
  failedBrowser.newPage = async () => {
    throw new Error('session failed');
  };
  const failing = createWorkerPageRenderer(
    binding,
    { timeoutMs: 5000 },
    {
      launch: async () => failedBrowser,
    },
  );
  await expect(failing.render(TRENDS_URL)).rejects.toThrow('session failed');
  expect(failedBrowser.closed).toBe(true);
});

test('Worker 会话启动失败时保留原因', async () => {
  const binding: BrowserWorker = {
    fetch: (async () => new Response()) as unknown as typeof fetch,
  };
  const failure = new Error('browser rendering unavailable');
  const renderer = createWorkerPageRenderer(
    binding,
    { timeoutMs: 5000 },
    {
      launch: async () => {
        throw failure;
      },
    },
  );
  const error = await renderer.render(TRENDS_URL).catch((cause: unknown) => cause);
  expect((error as Error).message).toContain('Browser Rendering 会话失败');
  expect((error as Error).cause).toBe(failure);
});
