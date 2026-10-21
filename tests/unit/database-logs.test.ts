import { test, expect } from 'bun:test';
import { createCliLogger } from '../../src/cli/logger.ts';
import { createServerErrorLogger } from '../../src/observability/errors.ts';

test('服务端和 CLI 错误日志过滤 PostgreSQL 连接串', () => {
  const output: string[] = [];
  const error = new Error(
    'connection failed postgres://user:private-password@localhost/db postgresql://user:encoded%40password@remote/db?sslmode=verify-full',
  );
  createServerErrorLogger({ write: (line) => output.push(line) })('database_failed', error);
  createCliLogger({ command: 'migrate', level: 'info', write: (line) => output.push(line) }).fail(
    error,
  );
  for (const line of output) {
    expect(line).toContain('connection failed');
    expect(line).not.toContain('private-password');
    expect(line).not.toContain('encoded%40password');
    expect(line).not.toContain('localhost');
  }
});
