import { z } from 'zod';
import { PostgresDriver } from './postgres.ts';
import { SqliteDriver } from './sqlite.ts';

export function readStorageConfig(env: Record<string, unknown>) {
  const driver = z.enum(['sqlite', 'postgres']).default('sqlite').parse(env.DATABASE_DRIVER);
  if (driver === 'sqlite')
    return {
      driver,
      path: z.string().min(1).default('./data/bangumi.sqlite').parse(env.DATABASE_PATH),
    } as const;
  // 自定义错误不包含原始 URL，避免连接密码进入配置错误输出。
  const url = typeof env.DATABASE_URL === 'string' ? env.DATABASE_URL.trim() : '';
  try {
    const parsed = new URL(url);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length < 2
    )
      throw new Error();
  } catch {
    throw new Error(
      'DATABASE_DRIVER=postgres 时需要有效的 DATABASE_URL（postgres:// 或 postgresql://，包含数据库名）',
    );
  }
  const poolSize = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .parse(env.DATABASE_POOL_SIZE);
  return { driver, url, poolSize } as const;
}

/** Node 服务和 CLI 共用存储选择、初始化与失败清理。 */
export async function openStorage(env: Record<string, unknown>) {
  const config = readStorageConfig(env);
  const driver =
    config.driver === 'postgres'
      ? new PostgresDriver(config.url, config.poolSize)
      : new SqliteDriver(config.path);
  try {
    await driver.migrate();
    return driver;
  } catch (error) {
    await driver.close();
    throw error;
  }
}
