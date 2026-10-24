import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { commands, type CommandName, type CliValues } from './arguments.ts';
import type { Prompts } from './prompts.ts';

export const integerInput =
  (min: number, max = Number.MAX_SAFE_INTEGER) =>
  (value: string) => {
    const n = Number(value);
    return value.trim() && Number.isSafeInteger(n) && n >= min && n <= max
      ? undefined
      : `请输入 ${min}～${max} 的整数`;
  };
export const existingFile = (value: string) => {
  try {
    return statSync(value).isFile() ? undefined : '请选择一个文件';
  } catch {
    return '文件不存在或不可读取';
  }
};
export function apiUrlInput(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return '地址中不要包含凭证，请配置 ADMIN_TOKEN';
    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return;
  } catch {
    /* 使用统一错误信息，不回显地址中的潜在凭证。 */
  }
  return '请输入 HTTPS 服务地址（本机开发可使用 HTTP）';
}
export async function chooseTarget(
  prompts: Prompts,
  previous?: string,
  env: Record<string, unknown> = process.env,
) {
  const target = await prompts.select(
    '选择操作目标',
    [
      {
        value: 'local',
        label: '本地数据库',
        hint:
          env.DATABASE_DRIVER === 'postgres' ? '使用已配置的 PostgreSQL' : '使用已配置的 SQLite',
      },
      { value: 'remote', label: '远程 Worker / Node 服务' },
    ],
    previous ? 'remote' : 'local',
  );
  return target === 'remote'
    ? await prompts.text({ message: '管理服务地址', defaultValue: previous, validate: apiUrlInput })
    : undefined;
}
export async function chooseCommand(prompts: Prompts): Promise<CommandName | 'target' | 'quit'> {
  return prompts.select('选择操作', [
    ...commands.map(([value, label]) => ({ value, label })),
    { value: 'target', label: '切换操作目标' },
    { value: 'quit', label: '退出' },
  ]);
}
export async function fillParameters(
  command: CommandName,
  input: CliValues,
  prompts: Prompts,
  fromMenu = false,
): Promise<CliValues> {
  const v = { ...input };
  // 显式自动执行时，缺省参数直接使用默认值，不在终端中追加提问。
  if (command === 'resolve-alias-misses' && v.auto) return v;
  const needsFile = ['sync-archive', 'import'].includes(command);
  const guided = fromMenu || (needsFile && !v.file);
  if (needsFile && !v.file)
    v.file = await prompts.file({
      message: command === 'import' ? '选择备份文件' : '选择 subject.jsonlines',
      defaultValue:
        command === 'sync-archive' && existsSync('data/subject.jsonlines')
          ? 'data/subject.jsonlines'
          : undefined,
      validate: existingFile,
    });
  if (['download-archive', 'export'].includes(command) && !v.out)
    v.out = await prompts.text({
      message: '输出文件路径',
      defaultValue: command === 'export' ? 'data/backup.jsonl' : 'data/subject.jsonlines',
      validate: (s) => (s.trim() ? undefined : '请输入输出路径'),
    });
  if (['sync-subject', 'alias-add'].includes(command) && !v.id)
    v.id = await prompts.text({ message: 'Bangumi 条目 ID', validate: integerInput(1) });
  if (command === 'alias-add' && !v.name)
    v.name = await prompts.text({
      message: '手动别名',
      validate: (s) =>
        s.trim().length > 0 && s.trim().length <= 300 ? undefined : '请输入 1～300 个字符',
    });
  if (command === 'sync-archive') {
    if (guided && v.dryRun === undefined)
      v.dryRun = await prompts.confirm('仅解析和统计（不写入服务器）？');
    if (!v.dryRun && !v.asOf) {
      const metaPath = `${v.file}.meta.json`;
      const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf8')) : {};
      if (!meta.dataAsOf)
        v.asOf = await prompts.text({
          message: '数据快照时间（ISO 8601，例如 2026-10-20T08:18:54Z）',
          validate: (s) =>
            z.iso.datetime({ offset: true }).safeParse(s).success
              ? undefined
              : '请输入包含时区的 ISO 8601 时间',
        });
    }
    if (guided && v.limit === undefined) {
      const limit = await prompts.text({
        message: '本批处理上限',
        defaultValue: v.dryRun ? '全部' : '1000',
        validate: (s) => (v.dryRun && s === '全部' ? undefined : integerInput(1, 100000)(s)),
      });
      if (limit !== '全部') v.limit = limit;
    }
    if (guided && v.skipInvalid === undefined)
      v.skipInvalid = await prompts.confirm('跳过无法解析的行并保留错误记录？');
  }
  if (command === 'resolve-alias-misses') {
    if (fromMenu && v.auto === undefined)
      v.auto =
        (await prompts.select('选择别名处理方式', [
          { value: 'manual', label: '人工选择', hint: '逐个查看候选并确认' },
          { value: 'auto', label: '自动匹配', hint: '仅处理唯一的完全同名候选，其余跳过' },
        ])) === 'auto';
    if (v.limit === undefined)
      v.limit = await prompts.text({
        message: '本批最多处理多少个别名？',
        defaultValue: '20',
        validate: integerInput(1),
      });
    if (v.searchLimit === undefined)
      v.searchLimit = await prompts.text({
        message: '每个别名最多搜索多少个候选？',
        defaultValue: '10',
        validate: integerInput(1, 50),
      });
  }
  if (['stats-prune', 'retention-preview'].includes(command) && fromMenu && !v.days)
    v.days = await prompts.text({
      message: '统计天数',
      defaultValue: '90',
      validate: integerInput(command === 'stats-prune' ? 30 : 1, 3650),
    });
  if (command === 'sync-calendar' && fromMenu && v.completePlatforms === undefined)
    v.completePlatforms = await prompts.confirm('连续补全作品形式？');
  if (
    ['sync-archive', 'resolve-alias-misses'].includes(command) &&
    (guided || command === 'resolve-alias-misses')
  ) {
    const extra =
      (command === 'sync-archive' && !v.dryRun && v.checkpointInterval === undefined) ||
      (v.apiUrl && !v.dryRun && (v.requestDelayMs === undefined || v.requestRetries === undefined));
    if (extra && (await prompts.confirm('调整高级选项（否则使用默认值）？'))) {
      if (command === 'sync-archive' && !v.dryRun && v.checkpointInterval === undefined)
        v.checkpointInterval = await prompts.text({
          message: '检查点保存间隔（文件行数）',
          defaultValue: '20',
          validate: integerInput(1),
        });
      if (v.apiUrl && !v.dryRun) {
        if (v.requestDelayMs === undefined)
          v.requestDelayMs = await prompts.text({
            message: '请求间隔（毫秒）',
            defaultValue: '0',
            validate: integerInput(0, 2147483647),
          });
        if (v.requestRetries === undefined)
          v.requestRetries = await prompts.text({
            message: '请求失败后的重试次数',
            defaultValue: '3',
            validate: integerInput(0),
          });
      }
    }
  }
  return v;
}
