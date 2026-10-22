import * as clack from '@clack/prompts';
import { Chalk, supportsColorStderr } from 'chalk';
import ora from 'ora';
import type { Writable } from 'node:stream';
import type { CommandName } from './arguments.ts';
import type { LogDetails } from './logger.ts';
import { display, terminalOutput } from './display.ts';

const phases: Record<string, string> = {
  opening_storage: '连接存储',
  archive_hash: '计算文件 SHA-256',
  checkpoint_read: '读取检查点',
  archive_scan: '扫描 Archive',
  archive_parse: '解析条目',
  archive_import: '导入条目',
  checkpoint_write: '保存检查点',
  alias_misses_loading: '读取有计划的未命中别名',
  alias_search: '搜索候选',
  alias_import: '导入作品和手动别名',
  alias_plan_update: '更新处理计划',
  calendar_sync: '同步放送日历',
  subject_sync: '同步条目',
  backup_export: '导出备份',
  backup_validation: '校验备份',
  backup_restore: '恢复备份',
  backup_hash: '校验备份文件',
  backup_check_empty: '检查目标数据库',
  archive_manifest: '读取下载清单',
  archive_download: '下载 Archive',
  archive_extract: '解压 Archive',
  downloading_archive: '准备下载',
};
export function formatProgress(data: LogDetails) {
  const parts = [phases[String(data.phase)] ?? '处理中'];
  if (data.line !== undefined) parts.push(`第 ${data.line} 行`);
  if (data.dryRun && data.parsed !== undefined) parts.push(`已解析 ${data.parsed}`);
  else if (data.imported !== undefined) parts.push(`已导入 ${data.imported}`);
  else if (data.parsed !== undefined) parts.push(`已解析 ${data.parsed}`);
  if (data.skipped !== undefined) parts.push(`跳过 ${data.skipped}`);
  if (data.recordsPerSecond !== undefined) parts.push(`${data.recordsPerSecond} 条/秒`);
  if (data.checkpointLine !== undefined && data.checkpointLine !== null)
    parts.push(`检查点 ${data.checkpointLine}`);
  if (data.index !== undefined) parts.push(`${data.index}/${data.total}`);
  if (data.keyword) parts.push(`关键词：${display(data.keyword)}`);
  if (data.restored !== undefined) parts.push(`${data.restored}/${data.total}`);
  if (data.exported !== undefined) parts.push(`已导出 ${data.exported}`);
  if (data.validated !== undefined) parts.push(`已校验 ${data.validated}`);
  if (typeof data.downloadedBytes === 'number')
    parts.push(`${(data.downloadedBytes / 1048576).toFixed(1)} MiB`);
  return display(parts.join(' · '));
}

export function resultLines(command: CommandName, result: unknown): string[] {
  const r = result as Record<string, any>;
  if (command === 'sync-archive')
    return [
      r.status === 'stopped'
        ? r.dryRun
          ? '已停止解析'
          : '已停止，完成的进度已保存'
        : r.complete
          ? '文件扫描完成'
          : r.dryRun
            ? '本次解析达到处理上限'
            : '本批已完成，可继续下一批',
      `${r.dryRun ? `解析 ${r.parsed}` : `导入 ${r.imported}`} · 本批跳过 ${r.skipped} · 累计跳过 ${r.skippedTotal}`,
      `当前文件行：${r.line}${r.dryRun ? '（仅解析，不保存检查点）' : '（检查点已保存）'}`,
      ...(r.errorLog ? [`错误记录：${r.errorLog}`] : []),
    ];
  if (command === 'resolve-alias-misses')
    return [
      `${r.status === 'stopped' ? '已停止' : '本批完成'} · 已处理 ${r.processed}/${r.total}`,
      `成功绑定 ${r.resolved} · 无计划 ${r.unplanned} · 跳过 ${r.skipped + r.noCandidates} · 未处理 ${r.remaining}`,
      `导入作品 ${r.importedSubjects} 个`,
    ];
  if (command === 'alias-misses')
    return (result as any[]).length
      ? (result as any[]).map(
          (item) =>
            `${item.name}  |  未命中 ${item.missCount} 次  |  ${item.planned ? '有计划' : '无计划'}`,
        )
      : ['暂无未命中记录'];
  if (command === 'stats') {
    const items = Array.isArray(result) ? result : r.subjects;
    return items?.length
      ? items.map(
          (item: any) =>
            `${item.name}  |  累计 ${item.totalHits}  |  近 7 天 ${item.hits7d}  |  近 30 天 ${item.hits30d}`,
        )
      : ['暂无访问统计'];
  }
  if (command === 'sync-subject') return [`条目 ${r.imported} 同步完成`];
  if (command === 'alias-add') {
    const a = r.alias ?? r;
    return [
      `已添加：${a.name} → https://bgm.tv/subject/${a.subjectId}`,
      ...(r.conflictingSubjectIds?.length
        ? [`同名冲突条目：${r.conflictingSubjectIds.join('、')}`]
        : []),
    ];
  }
  if (command === 'migrate') return ['数据库迁移完成'];
  const labels: Record<string, string> = {
    imported: '导入条目',
    restored: '恢复条目',
    exported: '导出条目',
    platformsUpdated: '补全作品形式',
    platformsRemaining: '待补全',
    rounds: '执行轮数',
    dataAsOf: '数据时间',
    deleted: '删除记录',
    hasMore: '还有待清理记录',
    sha256: 'SHA-256',
    reason: '说明',
    actionable: '可自动执行',
    candidates: '候选记录',
    platformFailures: '补全失败',
    status: '状态',
    output: '输出文件',
  };
  return Object.entries(r)
    .filter(([, v]) => v !== undefined)
    .map(
      ([key, value]) =>
        `${labels[key] ?? key}：${typeof value === 'object' ? JSON.stringify(value) : value}`,
    );
}

export function createPresentation(options: { human: boolean; output?: Writable }) {
  const output = terminalOutput(options.output ?? process.stderr);
  const opts = { output };
  const color = new Chalk({
    level:
      options.human && process.env.NO_COLOR === undefined && supportsColorStderr
        ? supportsColorStderr.level
        : 0,
  });
  let busy = false;
  let waiting = false;
  // 不读取 stdin；Ctrl+C 由入口统一处理，等待当前写入与检查点保存。
  const spinner = ora({
    stream: output as NodeJS.WriteStream,
    isEnabled: options.human,
    discardStdin: false,
    color: 'cyan',
  });
  const stop = () => {
    if (busy) {
      spinner.stop();
      busy = false;
    }
  };
  const note = (message: string, title: string) => {
    stop();
    clack.note(message.split('\n').map(display).join('\n'), color.cyan(title), opts);
  };
  const message = (message: string) => {
    stop();
    clack.log.info(display(message), opts);
  };
  return {
    output,
    selectionHint(value: string) {
      // 覆盖 Clack 在选中项 hint 外层施加的 dim，避免详情与未选中项同样暗淡。
      return color.reset.cyanBright(display(value));
    },
    get waiting() {
      return waiting;
    },
    setWaiting(value: boolean) {
      stop();
      waiting = value;
    },
    intro() {
      clack.intro(color.bold.cyan('Bangumi · 动画评分管理'), opts);
    },
    outro(message = '操作完成') {
      stop();
      clack.outro(message, opts);
    },
    note,
    message,
    stop,
    result(command: CommandName, result: unknown) {
      note(resultLines(command, result).join('\n'), '执行结果');
    },
    update(data: LogDetails) {
      if (
        !options.human ||
        waiting ||
        ['alias_selection', 'alias_review_completed', 'finished'].includes(String(data.phase))
      )
        return;
      const text = formatProgress(data);
      if (!busy) {
        spinner.start(text);
        busy = true;
      } else spinner.text = text;
    },
    log(line: string) {
      if (!options.human) {
        output.write(line + '\n');
        return;
      }
      const entry = JSON.parse(line);
      if (entry.event === 'cli_failed') {
        stop();
        clack.log.error(
          (entry.causes ?? []).map((cause: any) => display(cause.message)).join('\n'),
          opts,
        );
        if (entry.phase) clack.log.info(formatProgress(entry), opts);
      } else if (entry.event === 'archive_resumed') {
        note(
          `文件：${entry.file}\n检查点：第 ${entry.checkpointLine} 行\n从第 ${entry.checkpointLine + 1} 行继续`,
          '导入进度',
        );
      } else if (entry.event === 'api_request_retry') {
        stop();
        clack.log.warn(
          `请求失败${entry.status ? `（HTTP ${entry.status}）` : ''}，${entry.waitMs / 1000} 秒后重试 ${entry.retry}/${entry.requestRetries}`,
          opts,
        );
      } else if (entry.level === 'warn' || entry.level === 'error') {
        stop();
        clack.log[entry.level === 'warn' ? 'warn' : 'error'](
          display(`${entry.message}${entry.line ? `（第 ${entry.line} 行）` : ''}`),
          opts,
        );
      } else if (entry.level === 'debug') {
        stop();
        clack.log.message(color.dim(display(`${entry.message} · ${entry.event}`)), opts);
      }
    },
  };
}
export type Presentation = ReturnType<typeof createPresentation>;
