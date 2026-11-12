import { z } from 'zod';
import { positiveId } from '../../core/models.ts';
import { TRENDS_PAGE_SIZE } from '../../core/trends.ts';

const trendsSearchSchema = z.object({
  total: z.number().int().nonnegative(),
  data: z.array(z.object({ id: positiveId, type: z.literal(2) })).max(TRENDS_PAGE_SIZE),
});

/** 按 UTC 日期回溯六个日历月，包含起止日；月底截短到目标月份最后一天。 */
export function trendsSearchBody(now = Date.now()) {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setUTCDate(1);
  from.setUTCMonth(from.getUTCMonth() - 6);
  const monthEnd = new Date(from);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  from.setUTCDate(Math.min(today.getUTCDate(), monthEnd.getUTCDate()));
  const until = new Date(today);
  until.setUTCDate(until.getUTCDate() + 1);
  return {
    keyword: '',
    sort: 'heat',
    filter: {
      type: [2],
      air_date: [`>=${from.toISOString().slice(0, 10)}`, `<${until.toISOString().slice(0, 10)}`],
    },
  };
}

/** 只从搜索结果读取动画 ID；名称、别名和评分统一从详情接口获取。 */
export function fromTrendsSearchPage(input: unknown) {
  return trendsSearchSchema.parse(input);
}
