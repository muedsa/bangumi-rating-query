// 所有示例均为虚构数据，不读取运行环境或生产数据库。
const time = 1767225600000;
export const subjectExample = {
  id: 100,
  name: '示例动画',
  nameCn: '示例动画中文名',
  airDate: '2026-01-01',
  platform: 'TV',
  metadataAt: time,
  cachedAt: time,
  pinned: false,
};
export const aliasExample = {
  id: 'example-alias-100',
  subjectId: 100,
  name: '示例动画',
  normalizedName: '示例动画',
  source: 'bangumi',
  createdAt: time,
  updatedAt: time,
};
export const ratingExample = {
  subjectId: 100,
  score: 8.1,
  votes: 120,
  rank: 50,
  source: 'archive',
  dataAsOf: time,
  fetchedAt: time,
};
const publicSubject = {
  id: 100,
  name: '示例动画',
  nameCn: '示例动画中文名',
  airDate: '2026-01-01',
  platform: 'TV',
  url: 'https://bgm.tv/subject/100',
};
export const matchedExample = {
  inputId: 'item-1',
  status: 'matched',
  subject: publicSubject,
  matchReason: 'exact_alias',
  matchedAliases: [{ name: '示例动画', source: 'bangumi' }],
  rating: { score: 8.1, votes: 120, rank: 50, source: 'archive' },
  ratingStatus: 'available',
  dataAsOf: '2026-01-01T00:00:00.000Z',
  stale: false,
};
export const ambiguousExample = {
  inputId: 'item-3',
  status: 'ambiguous',
  matchReason: 'shared_alias',
  candidates: [
    {
      ...publicSubject,
      rating: matchedExample.rating,
      ratingStatus: matchedExample.ratingStatus,
      dataAsOf: matchedExample.dataAsOf,
      stale: matchedExample.stale,
    },
    {
      ...publicSubject,
      id: 101,
      name: '另一部示例动画',
      url: 'https://bgm.tv/subject/101',
      rating: null,
      ratingStatus: 'unavailable',
      dataAsOf: null,
      stale: true,
    },
  ],
  candidatesTruncated: false,
};
export const backupExample = {
  version: 1,
  subject: subjectExample,
  aliases: [aliasExample],
  rating: ratingExample,
  usage: { lastAccessedAt: time, totalHits: 3 },
  daily: [{ day: '2026-01-01', hits: 3 }],
};
export const aliasMissExample = {
  name: '尚未收录的名称',
  normalizedName: '尚未收录的名称',
  missCount: 3,
  firstMissedAt: time,
  lastMissedAt: time + 60000,
  planned: true,
};
export function example(value: unknown, summary = '示例') {
  return { summary, value };
}
