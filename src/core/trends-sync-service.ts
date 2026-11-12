import { AppError, importSchema, type ImportRecord } from './models.ts';
import type { ApplicationRepository, TrendsSource } from './ports.ts';
import {
  TRENDS_PAGE_SIZE,
  trendsPageSchema,
  trendsSnapshotSchema,
  type TrendsSyncResult,
} from './trends.ts';

export class TrendsSyncService {
  constructor(
    private repo: Pick<ApplicationRepository, 'mergeTrends'>,
    private source?: TrendsSource,
  ) {}

  async sync(
    page = 1,
    onSubjectError?: (id: number, error: unknown) => void,
  ): Promise<TrendsSyncResult> {
    trendsPageSchema.parse(page);
    if (!this.source)
      throw new AppError(
        503,
        'BANGUMI_SYNC_DISABLED',
        '请在服务端配置 BANGUMI_USER_AGENT 以启用同步',
      );
    let snapshot;
    try {
      snapshot = trendsSnapshotSchema.parse(await this.source.getTrends(page));
    } catch (error) {
      throw new AppError(
        503,
        'BANGUMI_TRENDS_ERROR',
        'Bangumi 近期热门动画搜索或校验失败，请稍后重试',
        { cause: error },
      );
    }
    const ids = [...new Set(snapshot.subjectIds)];
    const records: ImportRecord[] = [];
    const failedIds: number[] = [];
    let lastError: unknown;
    for (const id of ids) {
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
    if (ids.length && !records.length)
      throw new AppError(503, 'BANGUMI_API_ERROR', 'Bangumi 热度条目详情均获取失败，请稍后重试', {
        cause: lastError,
      });
    const result: TrendsSyncResult = {
      page,
      pageSize: TRENDS_PAGE_SIZE,
      total: snapshot.total,
      nextPage:
        ids.length > 0 && snapshot.total - (page - 1) * TRENDS_PAGE_SIZE > TRENDS_PAGE_SIZE
          ? page + 1
          : null,
      discovered: ids.length,
      attempted: ids.length,
      imported: records.length,
      failedIds,
      dataAsOf: new Date(snapshot.fetchedAt).toISOString(),
      status: failedIds.length ? 'partial' : 'complete',
    };
    await this.repo.mergeTrends(records, result);
    return result;
  }
}
