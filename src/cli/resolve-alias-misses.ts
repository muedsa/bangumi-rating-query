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
  aliasMisses(planned?: boolean): Promise<AliasMiss[]>;
  setAliasMissPlanned(name: string, planned: boolean): Promise<AliasMiss>;
  searchSubjects(keyword: string, limit: number): Promise<SubjectSearchResult>;
  syncSubject(id: number): Promise<{ imported: number }>;
  alias(id: number, name: string): Promise<unknown>;
}
export type AliasReviewChoice = number | 'skip' | 'quit' | 'unplanned' | { search: string };
export interface AliasReviewUI {
  choose(
    miss: AliasMiss,
    result: SubjectSearchResult,
    index: number,
    total: number,
  ): Promise<AliasReviewChoice>;
  write(message: string): void;
}

export async function resolveAliasMisses(options: {
  target: AliasReviewTarget;
  ui: AliasReviewUI;
  logger: ReturnType<typeof createCliLogger>;
  limit?: number;
  searchLimit?: number;
  signal?: AbortSignal;
}) {
  const { limit, searchLimit } = aliasReviewOptionsSchema.parse(options);
  const { target, ui, logger } = options;
  logger.update({ phase: 'alias_misses_loading', limit, searchLimit });
  const misses = (await target.aliasMisses(true)).slice(0, limit);
  const results: {
    name: string;
    status: 'resolved' | 'skipped' | 'no_candidates' | 'unplanned';
    subjectId?: number;
  }[] = [];
  const synced = new Set<number>();
  let stopped = false;
  ui.write(
    `本批处理 ${misses.length} 个有计划的未命中别名，每个最多 ${searchLimit} 个候选；选中作品后立即导入。`,
  );
  for (const [index, miss] of misses.entries()) {
    if (options.signal?.aborted) {
      stopped = true;
      break;
    }
    const name = nameSchema.parse(miss.name);
    const context = { index: index + 1, total: misses.length, name, completed: results.length };
    let selected: AliasReviewChoice | undefined;
    try {
      let keyword = name;
      let result: SubjectSearchResult;
      while (true) {
        const searchContext = { ...context, keyword };
        logger.update({ phase: 'alias_search', ...searchContext });
        logger.log('info', 'alias_search_started', '搜索未命中别名的候选条目', searchContext);
        result = await target.searchSubjects(keyword, searchLimit);
        if (options.signal?.aborted) {
          selected = 'quit';
          break;
        }
        logger.update({ phase: 'alias_selection', ...searchContext });
        selected = await ui.choose(miss, result, index + 1, misses.length);
        if (typeof selected !== 'object') break;
        keyword = nameSchema.parse(selected.search);
        ui.write(`重新搜索：${keyword}（待处理别名：${name}）`);
      }
      if (selected === 'quit') {
        stopped = true;
        break;
      }
      if (selected === 'skip') {
        results.push({ name, status: result.candidates.length ? 'skipped' : 'no_candidates' });
        continue;
      }
      if (selected === 'unplanned') {
        logger.update({ phase: 'alias_plan_update', ...context });
        await target.setAliasMissPlanned(name, false);
        results.push({ name, status: 'unplanned' });
        ui.write(`已标为无计划：${name}`);
        logger.log('info', 'alias_unplanned', '未命中别名已标为无计划', context);
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
    unplanned: results.filter((r) => r.status === 'unplanned').length,
    remaining: misses.length - results.length,
    importedSubjects: synced.size,
    results,
  };
  logger.update({ phase: 'alias_review_completed', ...summary, results: undefined });
  return summary;
}
