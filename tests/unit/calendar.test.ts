import { expect, test } from 'bun:test';
import { fromCalendar } from '../../src/adapters/bangumi/parse.ts';
import { BangumiClient } from '../../src/adapters/bangumi/client.ts';
import { millisecondsUntilDailyHour } from '../../src/scheduling/calendar.ts';
import { readConfig } from '../../src/config.ts';
import { CalendarSyncService } from '../../src/core/calendar-sync-service.ts';

test('作品形式补全批次允许大于 10，并拒绝非正整数', async () => {
  expect(readConfig({ CALENDAR_PLATFORM_BATCH_SIZE: '200' }).CALENDAR_PLATFORM_BATCH_SIZE).toBe(
    200,
  );
  for (const value of ['0', '-1', '1.5', 'Infinity'])
    expect(() => readConfig({ CALENDAR_PLATFORM_BATCH_SIZE: value })).toThrow();
  const missing = Array.from({ length: 12 }, (_, i) => i + 1);
  let filled = false;
  const service = new CalendarSyncService(
    {
      mergeCalendar: async () => {},
      findMissingPlatformIds: async () => (filled ? [] : missing),
      fillPlatforms: async (items) => {
        filled = true;
        return items.length;
      },
      getState: async () => null,
      setState: async () => {},
    },
    {
      getCalendar: async () => ({
        fetchedAt: 1000,
        items: missing.map((id) => ({
          id,
          name: `动画${id}`,
          nameCn: '',
          airDate: null,
          rating: null,
        })),
      }),
      getSubjectPlatform: async () => 'WEB',
    },
    200,
  );
  expect(await service.sync()).toMatchObject({
    platformsUpdated: 12,
    platformsRemaining: 0,
    status: 'complete',
  });
});

test('日历同步自动补全旧条目的空 platform，分批轮转失败项', async () => {
  const platforms = new Map(Array.from({ length: 12 }, (_, index) => [index + 1, '']));
  const requests: number[] = [];
  let cursor: string | null = null;
  const service = new CalendarSyncService(
    {
      mergeCalendar: async () => {},
      findMissingPlatformIds: async () =>
        [...platforms].filter(([, platform]) => !platform).map(([id]) => id),
      fillPlatforms: async (items) => {
        for (const item of items) platforms.set(item.id, item.platform);
        return items.length;
      },
      getState: async () => cursor,
      setState: async (_key, value) => {
        cursor = value;
      },
    },
    {
      getCalendar: async () => ({
        fetchedAt: 1000,
        items: [...platforms.keys()].map((id) => ({
          id,
          name: `动画${id}`,
          nameCn: '',
          airDate: null,
          rating: null,
        })),
      }),
      getSubjectPlatform: async (id) => {
        requests.push(id);
        if (id === 1) throw new Error('upstream error');
        return id % 2 ? 'TV' : 'WEB';
      },
    },
  );
  const first = await service.sync();
  expect(requests).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(first).toMatchObject({
    platformsUpdated: 9,
    platformsRemaining: 3,
    status: 'partial',
    platformFailures: [1],
  });
  requests.length = 0;
  expect(await service.sync()).toMatchObject({
    platformsUpdated: 2,
    platformsRemaining: 1,
    status: 'partial',
  });
  expect(requests).toEqual([11, 12, 1]);
});

test('详情只需读取 platform，并验证条目 ID，不依赖评分或 infobox', async () => {
  const client = new BangumiClient('tester/app', {
    fetcher: (async () =>
      Response.json({ id: 123, type: 2, platform: 'WEB' })) as unknown as typeof fetch,
  });
  expect(await client.getSubjectPlatform(123)).toBe('WEB');
  await expect(client.getSubjectPlatform(456)).rejects.toThrow();
});

test('日历按 ID 去重、排除非动画，并将未评分与缺少评分区分', () => {
  const snapshot = fromCalendar(
    [
      {
        items: [
          {
            id: 1,
            type: 2,
            name: '动画',
            name_cn: '中文',
            air_date: '2026-10-01',
            rating: { total: 10, score: 8 },
          },
          { id: 2, type: 2, name: '未评分', rating: { total: 0, score: 0 } },
          { id: 3, type: 2, name: '无评分字段' },
          { id: 4, type: 1, name: '书籍' },
        ],
      },
      { items: [{ id: 1, type: 2, name: '重复动画' }] },
    ],
    1000,
  );
  expect(snapshot.items.map((item) => item.id)).toEqual([1, 2, 3]);
  expect(snapshot.items[0]).toMatchObject({
    airDate: '2026-10-01',
    rating: { score: 8, votes: 10 },
  });
  expect(snapshot.items[1]?.rating).toEqual({ score: null, votes: 0 });
  expect(snapshot.items[2]?.rating).toBeNull();
  expect(snapshot.fetchedAt).toBe(1000);
});

test('日历结构损坏时拒绝整份数据，避免部分覆盖', () => {
  expect(() => fromCalendar({ items: [] })).toThrow();
  expect(() =>
    fromCalendar([{ items: [{ id: 1, type: 2, name: '动画', rating: { total: -1, score: 8 } }] }]),
  ).toThrow();
});

test('calendar 请求使用同一 Bearer Token、User-Agent 和重试规则', async () => {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const client = new BangumiClient('tester/app', {
    accessToken: 'calendar-secret',
    sleep: async () => {},
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      headers.push(new Headers(init?.headers));
      return urls.length === 1 ? new Response('', { status: 503 }) : Response.json([{ items: [] }]);
    }) as typeof fetch,
  });
  expect((await client.getCalendar()).items).toEqual([]);
  expect(urls).toEqual(['https://api.bgm.tv/calendar', 'https://api.bgm.tv/calendar']);
  expect(
    headers.every(
      (h) =>
        h.get('Authorization') === 'Bearer calendar-secret' && h.get('User-Agent') === 'tester/app',
    ),
  ).toBe(true);
});

test('每日调度使用 UTC 并正确跨天和跨年', () => {
  expect(millisecondsUntilDailyHour(Date.parse('2026-10-20T19:00:00Z'), 20)).toBe(3600000);
  expect(millisecondsUntilDailyHour(Date.parse('2026-10-20T20:00:00Z'), 20)).toBe(86400000);
  expect(millisecondsUntilDailyHour(Date.parse('2026-12-31T23:30:00Z'), 0)).toBe(1800000);
  expect(readConfig({}).CALENDAR_SYNC_ENABLED).toBe(false);
  expect(readConfig({ CALENDAR_SYNC_ENABLED: 'true' }).CALENDAR_SYNC_HOUR_UTC).toBe(20);
  expect(() => readConfig({ CALENDAR_SYNC_HOUR_UTC: '24' })).toThrow();
});
