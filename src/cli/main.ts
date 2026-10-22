import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { parseCliArgs, type CliValues } from './arguments.ts';
import { createPresentation } from './presentation.ts';
import { createPrompts } from './prompts.ts';
import { chooseCommand, chooseTarget, fillParameters } from './wizard.ts';
import { executeCommand, validateCommandOptions } from './execute.ts';
import { createCliLogger } from './logger.ts';
import { createClackAliasReview } from './alias-review-clack.ts';
import { createAliasReviewTerminal } from './alias-review-terminal.ts';
import { CliCancelled, checkCancelled } from './cancellation.ts';

export function cliModes(
  values: CliValues,
  streams = {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
    stderr: Boolean(process.stderr.isTTY),
    ci: Boolean(process.env.CI && process.env.CI !== 'false'),
  },
) {
  return {
    interactive: streams.stdin && streams.stderr && !streams.ci && values.interactive !== false,
    human: streams.stdin && streams.stderr && !streams.ci,
    json: Boolean(
      values.json || !streams.stdout || !streams.stdin || !streams.stderr || streams.ci,
    ),
  };
}
export async function runCli(args: string[]) {
  const controller = new AbortController();
  let values: CliValues = {};
  let modes = cliModes(values);
  const originalRawMode = process.stdin.isRaw;
  const presentation = createPresentation({ human: modes.human });
  const prompts = createPrompts(presentation, controller);
  let logFd: number | undefined;
  let logFileFailed = false;
  const secrets = [
    process.env.ADMIN_TOKEN ?? '',
    process.env.ADMIN_TOKEN?.trim() ?? '',
    process.env.BANGUMI_ACCESS_TOKEN ?? '',
    process.env.BANGUMI_ACCESS_TOKEN?.trim() ?? '',
    process.env.DATABASE_URL ?? '',
  ];
  const makeLogger = (command: string) =>
    createCliLogger({
      command,
      level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).parse(values.logLevel ?? 'info'),
      secrets,
      write: presentation.log,
      onUpdate: presentation.update,
      writeFile:
        logFd === undefined
          ? undefined
          : (line) => {
              if (logFileFailed) return;
              try {
                appendFileSync(logFd!, line + '\n', 'utf8');
              } catch (error) {
                logFileFailed = true;
                throw error;
              }
            },
    });
  let logger = makeLogger('cli');
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lineReview: ReturnType<typeof createAliasReviewTerminal> | undefined;
  const onInterrupt = () => {
    if (!controller.signal.aborted) {
      controller.abort();
      presentation.stop();
      if (modes.human && !presentation.waiting)
        presentation.message('正在停止，等待当前操作完成；已完成的写入会保留。');
    }
  };
  process.on('SIGINT', onInterrupt);
  try {
    const parsed = parseCliArgs(args);
    if (parsed.help) return;
    values = parsed.values;
    modes = cliModes(values);
    if (!parsed.command && !modes.interactive) {
      parsed.showHelp?.();
      return;
    }
    if (values.logFile) {
      mkdirSync(dirname(values.logFile), { recursive: true });
      logFd = openSync(values.logFile, 'a', 0o600);
    }
    logger = makeLogger(parsed.command ?? 'menu');
    const fromMenu = !parsed.command;
    if (modes.human) presentation.intro();
    if (fromMenu && !values.apiUrl) values.apiUrl = await chooseTarget(prompts);
    let command = parsed.command;
    while (true) {
      checkCancelled(controller.signal);
      if (fromMenu) {
        presentation.note(
          values.apiUrl
            ? `远程服务：${new URL(values.apiUrl).origin}`
            : process.env.DATABASE_DRIVER === 'postgres'
              ? '本地连接：PostgreSQL（使用环境配置）'
              : `本地 SQLite：${process.env.DATABASE_PATH ?? './data/bangumi.sqlite'}`,
          '当前目标',
        );
        const selected = await chooseCommand(prompts);
        if (selected === 'quit') break;
        if (selected === 'target') {
          values.apiUrl = await chooseTarget(prompts, values.apiUrl);
          continue;
        }
        command = selected;
      }
      if (!command) break;
      validateCommandOptions(command, values);
      if (modes.interactive) values = await fillParameters(command, values, prompts, fromMenu);
      let again = true;
      while (again) {
        again = false;
        logger = makeLogger(command);
        logger.log('info', 'cli_started', '开始执行命令', {
          mode: values.dryRun ? 'dry-run' : values.apiUrl ? 'remote' : 'local',
        });
        heartbeat = setInterval(() => {
          if (!presentation.waiting && !lineReview?.waiting) logger.progress();
        }, 5000);
        heartbeat.unref();
        let result: unknown;
        try {
          result = await executeCommand(command, values, {
            logger,
            signal: controller.signal,
            createReview: () => {
              if (modes.interactive) return createClackAliasReview(prompts, presentation);
              lineReview = createAliasReviewTerminal(
                process.stdin,
                process.stderr,
                controller.signal,
              );
              return lineReview;
            },
          });
        } finally {
          clearInterval(heartbeat);
          heartbeat = undefined;
          lineReview = undefined;
          presentation.stop();
        }
        const stopped = controller.signal.aborted;
        logger.log(
          'info',
          stopped ? 'cli_cancelled' : 'cli_completed',
          stopped ? '操作已取消，已完成结果保留' : '命令执行完成',
        );
        if (modes.json) {
          if (command === 'migrate' && !values.json) console.log('数据库迁移完成');
          else console.log(JSON.stringify(result));
        } else presentation.result(command, result);
        if (stopped) {
          process.exitCode = 130;
          return;
        }
        if (
          modes.interactive &&
          command === 'sync-archive' &&
          !values.dryRun &&
          (result as { complete: boolean }).complete === false
        )
          again = await prompts.confirm('继续导入下一批？（复用当前参数和检查点）');
      }
      if (!fromMenu) break;
      // 菜单只复用连接和输出配置，避免上一个命令的选项泄漏到下一个命令。
      values = {
        apiUrl: values.apiUrl,
        logLevel: values.logLevel,
        logFile: values.logFile,
        json: values.json,
        interactive: values.interactive,
      };
    }
    if (modes.human) presentation.outro('已完成，可随时重新运行 bun run cli');
  } catch (error) {
    presentation.stop();
    if (
      error instanceof CliCancelled ||
      (controller.signal.aborted && error instanceof Error && error.name === 'AbortError')
    ) {
      logger.log('info', 'cli_cancelled', '操作已取消；此前完成的写入已保留，未完成部分可重新运行');
      if (modes.human) presentation.outro('已取消；此前完成的写入已保留');
      process.exitCode = 130;
    } else {
      logger.fail(error);
      process.exitCode = 1;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    presentation.stop();
    process.removeListener('SIGINT', onInterrupt);
    if (modes.interactive) {
      if (process.stdin.isTTY) process.stdin.setRawMode?.(Boolean(originalRawMode));
      process.stdin.pause();
      // Windows 上暂停读取仍可能保留管道句柄；CLI 已结束，不再等待输入。
      process.stdin.unref?.();
    }
    if (logFd !== undefined) closeSync(logFd);
  }
}
