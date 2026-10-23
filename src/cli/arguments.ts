import { Command, CommanderError, Option } from 'commander';

export const commands = [
  [
    'resolve-alias-misses',
    '处理未命中别名',
    ['limit', 'search-limit', 'auto', 'request-retries', 'request-delay-ms'],
  ],
  [
    'sync-archive',
    '导入 Archive / 继续下一批',
    [
      'file',
      'as-of',
      'limit',
      'checkpoint-interval',
      'skip-invalid',
      'dry-run',
      'request-retries',
      'request-delay-ms',
    ],
  ],
  ['sync-calendar', '同步放送日历', ['complete-platforms', 'request-delay-ms']],
  ['sync-subject', '同步单个条目', ['id', 'request-delay-ms']],
  ['alias-add', '添加手动别名', ['id', 'name', 'request-delay-ms']],
  ['alias-misses', '查看未命中统计', []],
  ['stats', '查看访问统计', []],
  ['retention-preview', '预览冷数据', ['days']],
  ['download-archive', '下载 Archive', ['out']],
  ['export', '导出备份', ['out', 'request-delay-ms']],
  ['import', '恢复备份 / 继续恢复', ['file', 'request-delay-ms']],
  ['stats-prune', '清理每日访问统计', ['days']],
  ['migrate', '迁移本地数据库', []],
] as const;
export type CommandName = (typeof commands)[number][0];
export interface CliValues {
  file?: string;
  asOf?: string;
  id?: string;
  name?: string;
  apiUrl?: string;
  limit?: string;
  searchLimit?: string;
  auto?: boolean;
  checkpointInterval?: string;
  days?: string;
  skipInvalid?: boolean;
  dryRun?: boolean;
  completePlatforms?: boolean;
  requestDelayMs?: string;
  requestRetries?: string;
  logLevel?: string;
  out?: string;
  json?: boolean;
  interactive?: boolean;
  logFile?: string;
}
const flags = [
  ['--file <路径>', '输入文件路径'],
  ['--as-of <ISO时间>', '数据快照时间；默认读取文件的 .meta.json'],
  ['--id <ID>', 'Bangumi 条目 ID'],
  ['--name <名称>', '手动别名'],
  ['--limit <数量>', '本批处理上限；Archive 默认 1000，别名默认 20'],
  ['--search-limit <数量>', '每个名称的候选上限，默认 10，范围 1～50'],
  ['--auto', '自动处理唯一的原名或中文名完全相同的候选，其余跳过，不等待输入'],
  ['--checkpoint-interval <行数>', '检查点保存间隔，默认 20 行'],
  ['--days <天数>', '统计天数，默认 90'],
  ['--skip-invalid', '跳过解析失败的 Archive 行'],
  ['--dry-run', '仅解析 Archive，不连接存储或保存检查点'],
  ['--complete-platforms', '连续补全日历条目的作品形式'],
  ['--request-delay-ms <毫秒>', '管理请求间隔，默认 0'],
  ['--request-retries <次数>', '失败后的重试次数，默认 3，0 关闭'],
  ['--out <路径>', '下载或备份输出文件'],
] as const;

export function parseCliArgs(
  args: string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
) {
  const program = new Command()
    .name('bun run cli')
    .description('Bangumi 动画评分管理工具；不带命令时进入交互菜单');
  program
    .option('--api-url <URL>', '远程管理服务地址；省略时使用本地数据库')
    .option('--json', 'stdout 输出 JSON 结果；交互提示仍写入 stderr')
    .option('--no-interactive', '禁用交互，缺少参数时直接报错')
    .option('--log-level <级别>', '日志级别：debug|info|warn|error|silent，默认 info')
    .option('--log-file <路径>', '追加保存脱敏后的完整 JSONL 调试日志')
    .helpOption('-h, --help', '查看帮助')
    .addHelpCommand('help [命令]', '查看命令帮助')
    .configureOutput({ writeOut: write, writeErr() {} })
    .exitOverride();
  // 保留旧参数在命令之前的写法；子命令帮助只展示相关参数。
  for (const [flag, description] of flags)
    program.addOption(new Option(flag, description).hideHelp());
  let command: CommandName | undefined;
  let values: CliValues = {};
  program.action(() => {
    values = program.opts<CliValues>();
  });
  for (const [name, description, visible] of commands) {
    const child = program
      .command(name)
      .description(description)
      .helpOption('-h, --help', '查看帮助')
      .configureHelp({ showGlobalOptions: true });
    for (const [flag, description] of flags) {
      const key = flag.split(' ')[0]!.slice(2);
      child.addOption(
        new Option(flag, description).hideHelp(!(visible as readonly string[]).includes(key)),
      );
    }
    child.action(() => {
      command = name;
      values = child.optsWithGlobals<CliValues>();
    });
  }
  try {
    program.parse(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0)
      return { help: true, values, command };
    throw error;
  }
  if (!command) values = program.opts<CliValues>();
  return { help: false, values, command, showHelp: () => program.outputHelp() };
}
