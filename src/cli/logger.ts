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
  writeFile?: (line: string) => void;
  onUpdate?: (details: LogDetails) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const write = options.write ?? ((line: string) => console.error(line));
  const secrets = [...(options.secrets ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  let context: LogDetails = { phase: 'initializing' };
  const serialize = (value: unknown) =>
    JSON.stringify(value, (_key, value: unknown) => {
      if (typeof value !== 'string') return value;
      let safe = value.replace(/Bearer\s+[^\s"'<>]+/giu, 'Bearer [REDACTED]');
      for (const secret of secrets) safe = safe.replaceAll(secret, '[REDACTED]');
      return safe.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[URL_REDACTED]');
    });
  const log: LogWriter = (level, event, message, details = {}) => {
    const visible = priorities[level] >= priorities[options.level];
    if (!visible && !options.writeFile) return;
    const time = now();
    const line = serialize({
      ...details,
      time: new Date(time).toISOString(),
      level,
      command: options.command,
      event,
      message,
      elapsedMs: time - startedAt,
    });
    options.writeFile?.(line);
    if (visible) write(line);
  };
  return {
    log,
    update(details: LogDetails) {
      context = details;
      if (options.onUpdate && priorities[options.level] <= priorities.info)
        options.onUpdate(JSON.parse(serialize(details)) as LogDetails);
    },
    progress() {
      log('info', 'cli_progress', '任务运行中', context);
    },
    fail(error: unknown) {
      log('error', 'cli_failed', '命令执行失败', { ...context, causes: errorDetails(error) });
    },
  };
}
