import { AppError, importSchema, type ImportRecord } from './models.ts';
import type { ApplicationRepository, TrendsSource } from './ports.ts';
import { trendsSnapshotSchema, type TrendsSyncResult } from './trends.ts';

export class TrendsSyncService {
  constructor(
    private repo: Pick<ApplicationRepository, 'mergeTrends'>,
    private source?: TrendsSource,
    private limit = 24,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('热度同步条目数量必须为 1～100 的整数');
  }

  async sync(onSubjectError?: (id: number, error: unknown) => void): Promise<TrendsSyncResult> {
    if (!this.source)
      throw new AppError(
        503,
        'BANGUMI_SYNC_DISABLED',
        '请在服务端配置 BANGUMI_USER_AGENT 以启用同步',
      );
    let snapshot;
    try {
      snapshot = trendsSnapshotSchema.parse(await this.source.getTrends(this.limit));
    } catch (error) {
      throw new AppError(
        503,
        'BANGUMI_TRENDS_ERROR',
        'Bangumi 近期热门动画搜索或校验失败，请稍后重试',
        { cause: error },
      );
    }
    const ids = [...new Set(snapshot.subjectIds)];
    const selected = ids.slice(0, this.limit);
    const records: ImportRecord[] = [];
    const failedIds: number[] = [];
    let lastError: unknown;
    for (const id of selected) {
      try {
        const record = importSchema.parse(await this.source.getSubject(id));
        if (record.subject.id !== id) throw new Error('Bangumi 详情条目 ID 与请求不一致');
        records.push(record);
      } catch (error) {
        failedIds.push(id);
        lastError = error;
        onSubjectError?.(id, error);
      }
    }
    if (selected.length && !records.length)
      throw new AppError(503, 'BANGUMI_API_ERROR', 'Bangumi 热度条目详情均获取失败，请稍后重试', {
        cause: lastError,
      });
    const result: TrendsSyncResult = {
      discovered: ids.length,
      attempted: selected.length,
      imported: records.length,
      failedIds,
      dataAsOf: new Date(snapshot.fetchedAt).toISOString(),
      status: failedIds.length ? 'partial' : 'complete',
    };
    await this.repo.mergeTrends(records, result);
    return result;
  }
}
