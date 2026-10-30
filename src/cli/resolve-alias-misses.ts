import { z } from 'zod';
import { nameSchema, positiveId } from '../core/models.ts';
import type { AliasMiss } from '../core/ports.ts';
import { MAX_SEARCH_CANDIDATES, type SubjectSearchResult } from '../core/subject-search.ts';
import type { createCliLogger } from './logger.ts';

export const aliasReviewOptionsSchema = z.object({
  limit: z.coerce.number().int().positive().safe().default(20),
  searchLimit: z.coerce.number().int().min(1).max(MAX_SEARCH_CANDIDATES).default(10),
  auto: z.boolean().default(false),
});
export interface AliasReviewTarget {
  aliasMisses(planned?: boolean, limit?: number): Promise<AliasMiss[]>;
  getAliasMiss(name: string): Promise<AliasMiss | null>;
  setAliasMissPlanned(name: string, planned: boolean): Promise<AliasMiss | null>;
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
  ui?: AliasReviewUI;
  logger: ReturnType<typeof createCliLogger>;
  limit?: number;
  searchLimit?: number;
  auto?: boolean;
  signal?: AbortSignal;
}) {
  const { limit, searchLimit, auto } = aliasReviewOptionsSchema.parse(options);
  const { target, ui, logger } = options;
  if (!auto && !ui) throw new Error('人工处理未命中别名需要交互界面');
  logger.update({ phase: 'alias_misses_loading', limit, searchLimit, auto });
  const misses = (await target.aliasMisses(true, limit)).slice(0, limit);
  const results: {
    name: string;
    status: 'resolved' | 'skipped' | 'no_candidates' | 'unplanned';
    subjectId?: number;
    reason?: 'no_candidates' | 'no_exact_match' | 'ambiguous_exact_match' | 'no_longer_pending';
  }[] = [];
  const synced = new Set<number>();
  let stopped = false;
  ui?.write(
    `本批处理 ${misses.length} 个有计划的未命中别名，每个最多 ${searchLimit} 个候选；选中作品后立即导入。`,
  );
  review: for (const [index, miss] of misses.entries()) {
    if (options.signal?.aborted) {
      stopped = true;
      break;
    }
    const name = nameSchema.parse(miss.name);
    const context = { index: index + 1, total: misses.length, name, completed: results.length };
    const skipNoLongerPending = () => {
      results.push({ name, status: 'skipped', reason: 'no_longer_pending' });
      logger.log('info', 'alias_auto_skipped', `自动跳过：${name}（已清理或已改为无计划）`, {
        ...context,
        reason: 'no_longer_pending',
      });
    };
    let selected: AliasReviewChoice | undefined;
    let skipReason: (typeof results)[number]['reason'];
    try {
      let keyword = name;
      let result: SubjectSearchResult;
      while (true) {
        // 精确查询当前记录，不用前 N 条列表判断，避免排名变化造成误跳过。
        const current = await target.getAliasMiss(name);
        if (options.signal?.aborted) {
          stopped = true;
          break review;
        }
        if (!current?.planned) {
          skipNoLongerPending();
          continue review;
        }
        const searchContext = { ...context, keyword };
        logger.update({ phase: 'alias_search', ...searchContext });
        logger.log('info', 'alias_search_started', '搜索未命中别名的候选条目', searchContext);
        result = await target.searchSubjects(keyword, searchLimit);
        if (options.signal?.aborted) {
          selected = 'quit';
          break;
        }
        if (auto) {
          // 精确比较原名和中文名，不使用检索归一化；多个不同条目同名时留给人工确认。
          const ids = [
            ...new Set(
              result.candidates
                .filter((candidate) => candidate.name === name || candidate.nameCn === name)
                .map((candidate) => candidate.id),
            ),
          ];
          if (ids.length === 1) {
            selected = ids[0]!;
            logger.log(
              'info',
              'alias_auto_selected',
              `自动选择：${name} → https://bgm.tv/subject/${selected}`,
              {
                ...context,
                subjectId: selected,
              },
            );
          } else {
            selected = 'skip';
            skipReason = !result.candidates.length
              ? 'no_candidates'
              : ids.length
                ? 'ambiguous_exact_match'
                : 'no_exact_match';
            const reason = !result.candidates.length
              ? '没有搜索结果'
              : ids.length
                ? '多个条目完全同名'
                : '没有完全同名的候选';
            logger.log('info', 'alias_auto_skipped', `自动跳过：${name}（${reason}）`, {
              ...context,
              reason: skipReason,
              candidateCount: result.candidates.length,
              exactSubjectIds: ids,
            });
          }
          break;
        }
        logger.update({ phase: 'alias_selection', ...searchContext });
        selected = await ui!.choose(miss, result, index + 1, misses.length);
        if (options.signal?.aborted) {
          selected = 'quit';
          break;
        }
        if (typeof selected !== 'object') break;
        keyword = nameSchema.parse(selected.search);
        ui!.write(`重新搜索：${keyword}（待处理别名：${name}）`);
      }
      if (selected === 'quit') {
        stopped = true;
        break;
      }
      if (selected === 'skip') {
        results.push({
          name,
          status: result.candidates.length ? 'skipped' : 'no_candidates',
          ...(skipReason ? { reason: skipReason } : {}),
        });
        continue;
      }
      // 用户选择期间也可能被其他操作清理；写入前再次核对。
      const current = await target.getAliasMiss(name);
      if (options.signal?.aborted) {
        stopped = true;
        break;
      }
      if (!current?.planned) {
        skipNoLongerPending();
        continue;
      }
      if (selected === 'unplanned') {
        logger.update({ phase: 'alias_plan_update', ...context });
        if (!(await target.setAliasMissPlanned(name, false))) {
          // 复核与 PATCH 之间记录被清理也是正常竞态，不中断整批。
          skipNoLongerPending();
          continue;
        }
        results.push({ name, status: 'unplanned' });
        ui!.write(`已标为无计划：${name}`);
        logger.log('info', 'alias_unplanned', '未命中别名已标为无计划', context);
        continue;
      }
      const id = positiveId.parse(selected);
      if (!result.candidates.some((candidate) => candidate.id === id))
        throw new Error('选择的条目不在当前候选列表中');
      logger.update({ phase: 'alias_import', ...context, subjectId: id });
      logger.log('info', 'alias_selected', '已选择候选，开始导入并关联别名', {
        ...context,
        subjectId: id,
      });
      if (!synced.has(id)) {
        const imported = await target.syncSubject(id);
        if (imported.imported !== id) throw new Error('导入结果条目 ID 与选择不一致');
        synced.add(id);
      }
      // 复用已有同名别名；尚未存在的名称才作为手动来源写入。
      await target.alias(id, name);
      results.push({ name, status: 'resolved', subjectId: id });
      ui?.write(`已导入：${name} → https://bgm.tv/subject/${id}`);
      logger.log('info', 'alias_resolved', '条目已导入，别名已关联', { ...context, subjectId: id });
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
