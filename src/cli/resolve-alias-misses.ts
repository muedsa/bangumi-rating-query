import { z } from 'zod';
import { nameSchema, positiveId } from '../core/models.ts';
import type { AliasMiss } from '../core/ports.ts';
import { MAX_SEARCH_CANDIDATES, type SubjectSearchResult } from '../core/subject-search.ts';
import type { createCliLogger } from './logger.ts';

export const aliasReviewOptionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  searchLimit: z.coerce.number().int().min(1).max(MAX_SEARCH_CANDIDATES).default(10),
});
export interface AliasReviewTarget {
  aliasMisses(): Promise<AliasMiss[]>;
  searchSubjects(keyword: string, limit: number): Promise<SubjectSearchResult>;
  syncSubject(id: number): Promise<{ imported: number }>;
  alias(id: number, name: string): Promise<unknown>;
}
export interface AliasReviewUI {
  choose(
    miss: AliasMiss,
    result: SubjectSearchResult,
    index: number,
    total: number,
  ): Promise<number | 'skip' | 'quit'>;
  write(message: string): void;
}

export async function resolveAliasMisses(options: {
  target: AliasReviewTarget;
  ui: AliasReviewUI;
  logger: ReturnType<typeof createCliLogger>;
  limit?: number;
  searchLimit?: number;
}) {
  const { limit, searchLimit } = aliasReviewOptionsSchema.parse(options);
  const { target, ui, logger } = options;
  logger.update({ phase: 'alias_misses_loading', limit, searchLimit });
  const misses = (await target.aliasMisses()).slice(0, limit);
  const results: {
    name: string;
    status: 'resolved' | 'skipped' | 'no_candidates';
    subjectId?: number;
  }[] = [];
  const synced = new Set<number>();
  let stopped = false;
  ui.write(
    `本批处理 ${misses.length} 个未命中别名，每个最多 ${searchLimit} 个候选。输入候选序号后立即导入，0/回车跳过，q 退出。`,
  );
  for (const [index, miss] of misses.entries()) {
    const name = nameSchema.parse(miss.name);
    const context = { index: index + 1, total: misses.length, name, completed: results.length };
    logger.update({ phase: 'alias_search', ...context });
    logger.log('info', 'alias_search_started', '搜索未命中别名的候选条目', context);
    let selected: number | 'skip' | 'quit' | undefined;
    try {
      const result = await target.searchSubjects(name, searchLimit);
      if (!result.candidates.length) {
        ui.write(`[${index + 1}/${misses.length}] ${name}：没有搜索到动画候选，保留未命中记录。`);
        results.push({ name, status: 'no_candidates' });
        continue;
      }
      logger.update({ phase: 'alias_selection', ...context });
      selected = await ui.choose(miss, result, index + 1, misses.length);
      if (selected === 'quit') {
        stopped = true;
        break;
      }
      if (selected === 'skip') {
        results.push({ name, status: 'skipped' });
        continue;
      }
      const id = positiveId.parse(selected);
      if (!result.candidates.some((candidate) => candidate.id === id))
        throw new Error('选择的条目不在当前候选列表中');
      logger.update({ phase: 'alias_import', ...context, subjectId: id });
      logger.log('info', 'alias_selected', '已选择候选，开始导入并添加手动别名', {
        ...context,
        subjectId: id,
      });
      if (!synced.has(id)) {
        const imported = await target.syncSubject(id);
        if (imported.imported !== id) throw new Error('导入结果条目 ID 与选择不一致');
        synced.add(id);
      }
      // 使用手动来源，避免后续上游刷新覆盖用户确认的映射。
      await target.alias(id, name);
      results.push({ name, status: 'resolved', subjectId: id });
      ui.write(`已导入：${name} → https://bgm.tv/subject/${id}`);
      logger.log('info', 'alias_resolved', '条目与手动别名已保存', { ...context, subjectId: id });
    } catch (error) {
      throw new Error(
        `第 ${index + 1} 个别名 ${JSON.stringify(name)} 处理失败${typeof selected === 'number' ? `（目标条目 ID：${selected}）` : ''}；此前完成的结果已保存。若条目已导入，可使用 alias-add 补充该别名。`,
        { cause: error },
      );
    }
  }
  const summary = {
    status: stopped ? 'stopped' : 'completed',
    total: misses.length,
    processed: results.length,
    resolved: results.filter((r) => r.status === 'resolved').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    noCandidates: results.filter((r) => r.status === 'no_candidates').length,
    remaining: misses.length - results.length,
    importedSubjects: synced.size,
    results,
  };
  logger.update({ phase: 'alias_review_completed', ...summary, results: undefined });
  return summary;
}
