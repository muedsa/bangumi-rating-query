import type { AliasReviewUI, AliasReviewChoice } from './resolve-alias-misses.ts';
import type { Prompts, Choice } from './prompts.ts';
import type { Presentation } from './presentation.ts';
import { CliCancelled } from './cancellation.ts';
import { nameSchema } from '../core/models.ts';

export function createClackAliasReview(
  prompts: Prompts,
  presentation: Presentation,
): AliasReviewUI {
  return {
    write: presentation.message,
    async choose(miss, result, index, total): Promise<AliasReviewChoice> {
      presentation.note(
        `名称：${miss.name}\n未命中 ${miss.missCount} 次 · 搜索结果 ${result.total} 条\n方向键选择，回车导入；也可换词搜索、跳过或结束`,
        `处理别名 ${index}/${total}`,
      );
      const choices: Choice<number | string>[] = result.candidates.map((item) => ({
        value: item.id,
        label: `${item.nameCn || item.name}${item.nameCn ? ` / ${item.name}` : ''} · ${item.airDate ?? '日期未知'} · ${item.platform || '形式未知'} · ${item.score ?? '暂无'} 分`,
        hint: `https://bgm.tv/subject/${item.id} · ${item.votes} 人评分${item.summary ? ` · ${item.summary.slice(0, 160)}` : ''}`,
      }));
      choices.push(
        { value: 'search', label: '换个名称搜索' },
        { value: 'skip', label: '暂时跳过' },
        { value: 'unplanned', label: '标为无计划', hint: '后续处理不再查询，统计仍保留' },
        { value: 'quit', label: '结束本批' },
      );
      try {
        const selected = await prompts.select(
          result.candidates.length ? '选择匹配作品或操作' : '没有找到候选，请选择下一步',
          choices,
        );
        if (selected === 'search')
          return {
            search: await prompts.text({
              message: '新的搜索名称（仍为原别名绑定作品）',
              validate: (s) =>
                nameSchema.safeParse(s).success ? undefined : '请输入 1～300 个字符',
            }),
          };
        return selected as AliasReviewChoice;
      } catch (error) {
        if (error instanceof CliCancelled) return 'quit';
        throw error;
      }
    },
  };
}
