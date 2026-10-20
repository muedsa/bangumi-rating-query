import { parseToMap } from '@bgm38/wiki';
import { z } from 'zod';
import { importSchema, positiveId, type ImportRecord } from '../../core/models.ts';
import { calendarSnapshotSchema, type CalendarSnapshot } from '../../core/calendar.ts';

export function wikiAliases(infobox: string): string[] {
  if (!infobox.trim()) return [];
  const wiki = parseToMap(infobox);
  const aliases = wiki.data.get('别名');
  if (typeof aliases === 'string') return aliases.trim() ? [aliases.trim()] : [];
  return (aliases ?? [])
    .map((entry) => entry.v ?? '')
    .filter((name) => name.trim())
    .map((name) => name.trim());
}
const archiveSchema = z.object({
  id: positiveId,
  type: z.number().int(),
  name: z.string(),
  name_cn: z.string().default(''),
  date: z.string().nullish(),
  platform: z.union([z.string(), z.number()]).default(''),
  infobox: z.string().default(''),
  score: z.number().min(0).max(10).default(0),
  score_details: z.record(z.string(), z.number().int().nonnegative()).default({}),
  rank: z.number().int().nonnegative().default(0),
});
// Archive 的 platform 为数字时使用官方动画分类常量；未知值保留，避免误分类。
const animePlatforms: Record<string, string> = {
  '0': '其他',
  '1': 'TV',
  '2': 'OVA',
  '3': '剧场版',
  '4': '短片',
  '5': 'WEB',
  '2006': '动态漫画',
};
export function fromArchive(
  input: unknown,
  dataAsOf: number,
  now = Date.now(),
): ImportRecord | null {
  if (typeof input === 'object' && input !== null && 'type' in input && input.type !== 2)
    return null;
  const raw = archiveSchema.parse(input);
  if (raw.type !== 2) return null;
  const votes = Object.values(raw.score_details).reduce((a, b) => a + b, 0);
  const platform = String(raw.platform);
  return importSchema.parse({
    subject: {
      id: raw.id,
      name: raw.name,
      nameCn: raw.name_cn,
      airDate: validDate(raw.date),
      platform: animePlatforms[platform] ?? platform,
      metadataAt: dataAsOf,
      cachedAt: now,
    },
    aliases: wikiAliases(raw.infobox),
    rating: {
      subjectId: raw.id,
      score: votes ? raw.score : null,
      votes,
      rank: raw.rank || null,
      source: 'archive',
      dataAsOf,
      fetchedAt: now,
    },
  });
}

const apiSchema = z.object({
  id: positiveId,
  type: z.literal(2),
  name: z.string(),
  name_cn: z.string().default(''),
  date: z.string().nullish(),
  platform: z.string().default(''),
  infobox: z
    .array(
      z.object({
        key: z.string(),
        value: z.union([
          z.string(),
          z.array(z.object({ k: z.string().optional(), v: z.string() })),
        ]),
      }),
    )
    .default([]),
  rating: z.object({
    score: z.number().min(0).max(10),
    total: z.number().int().nonnegative(),
    rank: z.number().int().nonnegative().default(0),
  }),
});
export function fromApi(input: unknown, now = Date.now()): ImportRecord {
  const raw = apiSchema.parse(input);
  const aliases = raw.infobox
    .filter((entry) => entry.key === '别名')
    .flatMap((entry) =>
      typeof entry.value === 'string' ? [entry.value] : entry.value.map((v) => v.v),
    );
  return importSchema.parse({
    subject: {
      id: raw.id,
      name: raw.name,
      nameCn: raw.name_cn,
      airDate: validDate(raw.date),
      platform: raw.platform,
      metadataAt: now,
      cachedAt: now,
    },
    aliases,
    rating: {
      subjectId: raw.id,
      score: raw.rating.total ? raw.rating.score : null,
      votes: raw.rating.total,
      rank: raw.rating.rank || null,
      source: 'api',
      dataAsOf: now,
      fetchedAt: now,
    },
  });
}
function validDate(date: string | null | undefined) {
  return date && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null;
}

export function fromApiPlatform(input: unknown, subjectId: number): string {
  const data = z
    .object({ id: positiveId, type: z.literal(2), platform: z.string().trim().min(1).max(100) })
    .parse(input);
  if (data.id !== subjectId) throw new Error('Bangumi 详情条目 ID 与请求不一致');
  return data.platform;
}

const calendarRawItemSchema = z.object({
  id: positiveId,
  type: z.literal(2),
  name: z.string(),
  name_cn: z.string().default(''),
  air_date: z.string().nullish(),
  rating: z
    .object({ score: z.number().min(0).max(10), total: z.number().int().nonnegative() })
    .nullish(),
});

export function fromCalendar(input: unknown, now = Date.now()): CalendarSnapshot {
  const groups = z
    .array(z.object({ items: z.array(z.unknown()).max(1000) }))
    .max(7)
    .parse(input);
  const items = new Map<number, CalendarSnapshot['items'][number]>();
  for (const item of groups.flatMap((group) => group.items)) {
    if (typeof item === 'object' && item !== null && 'type' in item && item.type !== 2) continue;
    const raw = calendarRawItemSchema.parse(item);
    if (items.has(raw.id)) continue;
    items.set(raw.id, {
      id: raw.id,
      name: raw.name,
      nameCn: raw.name_cn,
      airDate: validDate(raw.air_date),
      rating: raw.rating
        ? { score: raw.rating.total ? raw.rating.score : null, votes: raw.rating.total }
        : null,
    });
  }
  return calendarSnapshotSchema.parse({ items: [...items.values()], fetchedAt: now });
}
