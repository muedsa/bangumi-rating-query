import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AliasReviewUI } from './resolve-alias-misses.ts';
import { nameSchema } from '../core/models.ts';
import { display } from './display.ts';

export function createAliasReviewTerminal(
  input: Readable = process.stdin,
  output: Writable = process.stderr,
  signal?: AbortSignal,
) {
  const lines = createInterface({
    input,
    output,
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    crlfDelay: Infinity,
  });
  // 立即订阅，避免管道提前输入的多行答案在网络等待期间丢失。
  const answers = lines[Symbol.asyncIterator]();
  let cancelled = false;
  let waiting = false;
  const cancel = () => {
    cancelled = true;
    lines.close();
  };
  lines.on('SIGINT', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const write = (message: string) => {
    output.write(display(message) + '\n');
  };
  const ui: AliasReviewUI = {
    write,
    async choose(miss, result, index, total) {
      write(`[${index}/${total}] 别名：${miss.name}（未命中 ${miss.missCount} 次）`);
      write(`搜索共 ${result.total} 条，展示 ${result.candidates.length} 个动画候选：`);
      if (!result.candidates.length)
        write('没有搜索到动画候选，可以输入自定义名称重新搜索，或标为无计划、跳过。');
      for (const [i, item] of result.candidates.entries()) {
        write(
          `${i + 1}. ${item.nameCn || item.name}${item.nameCn ? ` / ${item.name}` : ''} | ${item.airDate ?? '日期未知'} | ${item.platform || '类型未知'} | 评分 ${item.score ?? '暂无'}（${item.votes} 人） | https://bgm.tv/subject/${item.id}`,
        );
        if (item.summary) write(`   ${item.summary.slice(0, 160)}`);
      }
      waiting = true;
      try {
        while (!cancelled) {
          output.write(
            result.candidates.length
              ? '选择序号（-1 标为无计划，0/回车跳过，q 退出）：'
              : '输入搜索名称（-1 标为无计划，0/回车跳过，q 退出）：',
          );
          const answer = await answers.next();
          if (answer.done || cancelled) {
            write('输入结束，停止处理。');
            return 'quit';
          }
          const value = answer.value.trim().toLowerCase();
          if (value === 'q') return 'quit';
          if (value === '-1') return 'unplanned';
          if (value === '' || value === '0' || value === 's') return 'skip';
          if (!result.candidates.length) {
            const parsed = nameSchema.safeParse(answer.value);
            if (parsed.success) return { search: parsed.data };
            write('搜索名称需要 1～300 个字符；也可输入 -1、0 或 q。');
            continue;
          }
          if (/^[1-9]\d*$/u.test(value)) {
            const candidate = result.candidates[Number(value) - 1];
            if (candidate) return candidate.id;
          }
          write(`请输入 1～${result.candidates.length} 的序号、-1、0 或 q。`);
        }
        return 'quit';
      } finally {
        waiting = false;
      }
    },
  };
  return {
    ...ui,
    get waiting() {
      return waiting;
    },
    close() {
      signal?.removeEventListener('abort', cancel);
      lines.close();
    },
  };
}
