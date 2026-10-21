import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PostgresDriver } from '../../src/adapters/storage/postgres.ts';

/** CI 连接真实 PostgreSQL；本地通过 TCP 协议连接嵌入式 PostgreSQL 引擎。 */
export async function postgresTestDatabase(migrate = true) {
  let db: PGlite | undefined;
  let server: PGLiteSocketServer | undefined;
  let driver: PostgresDriver | undefined;
  const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`;
  let created = false;
  const close = async () => {
    try {
      if (created) await driver!.query({ sql: `DROP SCHEMA "${schema}" CASCADE`, params: [] });
    } finally {
      await driver?.close();
      await server?.stop();
      await db?.close();
    }
  };
  try {
    let address = process.env.TEST_POSTGRES_URL;
    if (!address) {
      db = await PGlite.create();
      server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 4 });
      await server.start();
      address = `postgres://postgres:postgres@${server.getServerConn()}/postgres?sslmode=disable`;
    }
    const url = new URL(address);
    url.searchParams.set('search_path', schema);
    driver = new PostgresDriver(url.toString(), process.env.TEST_POSTGRES_URL ? 4 : 1);
    await driver.query({ sql: `CREATE SCHEMA "${schema}"`, params: [] });
    created = true;
    if (migrate) await driver.migrate();
    return { driver, url: url.toString(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
