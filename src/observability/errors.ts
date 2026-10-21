export interface ErrorContext {
  requestId?: string;
  method?: string;
  path?: string;
  rayId?: string;
  status?: number;
  code?: string;
  trigger?: 'scheduled';
}

export type ServerErrorLogger = (event: string, error: unknown, context?: ErrorContext) => void;

export function requestErrorContext(
  request: Request,
  path: string,
  requestId: string = crypto.randomUUID(),
): ErrorContext {
  const ray = request.headers.get('cf-ray') ?? '';
  return {
    requestId,
    method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method)
      ? request.method
      : 'OTHER',
    path,
    ...(/^[a-f\d]{16,32}(?:-[A-Z]{3})?$/i.test(ray) ? { rayId: ray } : {}),
  };
}

export function createServerErrorLogger(
  options: {
    secrets?: string[];
    write?: (line: string) => void;
  } = {},
): ServerErrorLogger {
  const secrets = [
    ...new Set(
      (options.secrets ?? [])
        .flatMap((value) => [value, value.trim()])
        .filter(Boolean)
        .flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  const write = options.write ?? ((line: string) => console.error(line));
  function redact(input: string, limit = 2000) {
    let text = input;
    // 先脱敏再截断，避免仅输出半段凭证。只读取 message/stack/cause，不序列化异常的 query/params 等属性。
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
    text = text
      .replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [REDACTED]')
      .replace(
        /\b(?:https?|file|postgres(?:ql)?):\/\/[^\s)<>"']+/giu,
        (url) => '[URL_REDACTED]' + (url.match(/:\d+:\d+$/u)?.[0] ?? ''),
      )
      .replace(/\b(?:params|parameters|bindings|payload|body)\s*[:=][\s\S]*/giu, '[DATA_REDACTED]')
      .replace(/\b(?:failed query|query|sql)\s*[:=][\s\S]*/giu, '[SQL_REDACTED]')
      .replace(/'(?:''|\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`/gu, '[REDACTED]');
    return text.slice(0, limit);
  }
  return (event, error, context = {}) => {
    try {
      const causes: { name: string; message: string; stack?: string[] }[] = [];
      const seen = new Set<unknown>();
      let current = error;
      while (current !== undefined && !seen.has(current) && causes.length < 5) {
        seen.add(current);
        const value = current instanceof Error ? current : null;
        const stack = value?.stack
          ?.split('\n')
          .slice(1)
          .filter((line) => /^\s+at\s/.test(line))
          .slice(0, 8)
          .map((line) => redact(line, 400));
        causes.push({
          name: redact(value?.name ?? 'UnknownError', 100),
          message: redact(
            value?.message ?? (typeof current === 'string' ? current : '非 Error 异常'),
          ),
          ...(stack?.length ? { stack } : {}),
        });
        current = value?.cause;
      }
      write(
        JSON.stringify(
          {
            time: new Date().toISOString(),
            level: 'error',
            event,
            ...context,
            error: causes[0]?.name ?? 'UnknownError',
            causes,
          },
          (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value),
        ),
      );
    } catch {
      // 日志失败不能掩盖原始故障或改变 HTTP/定时任务行为。
    }
  };
}
