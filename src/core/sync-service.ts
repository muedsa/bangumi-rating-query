import { AppError } from './models.ts';
import type { AnimeRepository, SubjectSource } from './ports.ts';

export class SubjectSyncService {
  constructor(
    private repo: Pick<AnimeRepository, 'importRecord'>,
    private source?: SubjectSource,
  ) {}

  async sync(id: number) {
    if (!this.source)
      throw new AppError(
        503,
        'BANGUMI_SYNC_DISABLED',
        '请在服务端配置 BANGUMI_USER_AGENT 以启用同步',
      );
    let record;
    try {
      record = await this.source.getSubject(id);
    } catch {
      throw new AppError(
        503,
        'BANGUMI_API_ERROR',
        'Bangumi 数据获取失败，请检查服务端认证配置或稍后重试',
      );
    }
    await this.repo.importRecord(record);
    return { imported: record.subject.id };
  }
}
