import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Row, SqlDriver, Statement } from './sql.ts';
import { pendingMigrations, readSchemaVersion } from './schema.ts';

export class SqliteDriver implements SqlDriver {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  }
  private execute(s: Statement): Row[] {
    return this.db.prepare(s.sql).all(...s.params) as Row[];
  }
  async query(s: Statement) {
    return this.execute(s);
  }
  async batch(statements: Statement[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s) => this.execute(s));
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  migrate(directory = 'migrations') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
        .get();
      const version = exists
        ? readSchemaVersion(
            this.db.prepare('SELECT version FROM schema_version').all() as { version: number }[],
          )
        : 0;
      for (const { file } of pendingMigrations(version))
        this.db.exec(readFileSync(resolve(directory, file), 'utf8'));
      readSchemaVersion(
        this.db.prepare('SELECT version FROM schema_version').all() as { version: number }[],
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
