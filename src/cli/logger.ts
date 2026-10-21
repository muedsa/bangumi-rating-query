export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogVerbosity = LogLevel | 'silent';
export type LogDetails = Record<string, unknown>;
export type LogWriter = (
  level: LogLevel,
  event: string,
  message: string,
  details?: LogDetails,
) => void;

const priorities = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };

export function errorDetails(error: unknown) {
  const causes: { name: string; message: string }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current) && causes.length < 5) {
    seen.add(current);
    causes.push({
      name: current instanceof Error ? current.name : 'UnknownError',
      message: (current instanceof Error ? current.message : String(current)).slice(0, 2000),
    });
    current = current instanceof Error ? current.cause : undefined;
  }
  return causes;
}

export function createCliLogger(options: {
  command: string;
  level: LogVerbosity;
  secrets?: string[];
  write?: (line: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const write = options.write ?? ((line: string) => console.error(line));
  const secrets = [...(options.secrets ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  let context: LogDetails = { phase: 'initializing' };
  const log: LogWriter = (level, event, message, details = {}) => {
    if (priorities[level] < priorities[options.level]) return;
    const time = now();
    write(
      JSON.stringify(
        {
          ...details,
          time: new Date(time).toISOString(),
          level,
          command: options.command,
          event,
          message,
          elapsedMs: time - startedAt,
        },
        (_key, value: unknown) => {
          if (typeof value !== 'string') return value;
          let safe = value.replace(/Bearer\s+[^\s"'<>]+/giu, 'Bearer [REDACTED]');
          for (const secret of secrets) safe = safe.replaceAll(secret, '[REDACTED]');
          safe = safe.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[URL_REDACTED]');
          return safe;
        },
      ),
    );
  };
  return {
    log,
    update(details: LogDetails) {
      context = details;
    },
    progress() {
      log('info', 'cli_progress', '任务运行中', context);
    },
    fail(error: unknown) {
      log('error', 'cli_failed', '命令执行失败', { ...context, causes: errorDetails(error) });
    },
  };
}
