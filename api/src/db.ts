import { Global, Injectable, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
import { SCHEMA } from './schema';

// bigint (int8) comes back as a string by default. Our amounts stay far below 2^53, so use numbers.
types.setTypeParser(20, (v) => Number(v));
// keep `date` columns as 'YYYY-MM-DD' strings instead of timezone-shifted JS Dates
types.setTypeParser(1082, (v) => v);

@Injectable()
export class Db implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(Db.name);
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://meterbill:meterbill@localhost:5432/meterbill',
    max: 10,
  });

  async onModuleInit() {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query(SCHEMA);
        return;
      } catch (err) {
        if (attempt >= 10) throw err;
        this.log.warn(`database not ready (attempt ${attempt}), retrying...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params as any[])).rows as T[];
  }

  /** Runs fn inside one transaction; rolls back on any error. */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}

/**
 * Serialises everything that touches one customer's usage/invoices (event ingestion, invoice
 * generation, finalization). Always taken BEFORE any row lock, so lock order is consistent
 * and deadlocks are impossible.
 */
export const lockCustomer = (c: PoolClient, customerId: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`customer:${customerId}`]);

export const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

@Global()
@Module({ providers: [Db], exports: [Db] })
export class DbModule {}
