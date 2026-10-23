import type { BackupRecord } from '../../src/core/backup.ts';

export function backupFixture(id: number): BackupRecord {
  return {
    version: 1,
    subject: {
      id,
      name: `作品${id}`,
      nameCn: '',
      airDate: '2026-01-01',
      platform: 'TV',
      metadataAt: 1,
      cachedAt: 1,
      pinned: false,
    },
    aliases: ['bangumi', 'manual'].map((source, i) => ({
      id: `${id}-${i}`,
      subjectId: id,
      name: `别名${id}-${i}`,
      normalizedName: `别名${id}-${i}`,
      source: source as 'bangumi' | 'manual',
      createdAt: 1,
      updatedAt: 1,
    })),
    rating: {
      subjectId: id,
      score: 8.1,
      votes: 20,
      rank: 30,
      source: 'archive',
      dataAsOf: 1,
      fetchedAt: 1,
    },
    usage: { lastAccessedAt: 1, totalHits: 3 },
    daily: [
      { day: '2026-01-01', hits: 1 },
      { day: '2026-01-02', hits: 2 },
    ],
  };
}
