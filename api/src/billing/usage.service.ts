import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Db, lockCustomer } from '../db';
import { EventDto } from '../admin/dto';

export type EventResult = {
  idempotencyKey: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
};

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const periodOf = (d: Date) => d.toISOString().slice(0, 7);

@Injectable()
export class UsageService {
  constructor(private readonly db: Db) {}

  /**
   * Ingests usage events. Safe to retry: an event is identified by (customer, idempotencyKey), so
   * re-sending the same event never double counts. Events for an already-invoiced period are
   * rejected rather than silently dropped or silently re-opened, so a finalized invoice stays true.
   */
  async ingest(events: EventDto[]): Promise<EventResult[]> {
    const known = new Set(
      (await this.db.query<{ metric: string }>(
        `SELECT DISTINCT jsonb_array_elements(usage_pricing)->>'metric' AS metric FROM plans`,
      )).map((r) => r.metric),
    );

    const byCustomer = new Map<string, number[]>();
    events.forEach((e, i) => byCustomer.set(e.customerId, [...(byCustomer.get(e.customerId) ?? []), i]));

    const results: EventResult[] = new Array(events.length);
    for (const [customerId, indexes] of byCustomer) {
      await this.db.tx(async (c) => {
        await lockCustomer(c, customerId); // serialises against invoice generation/finalization
        const exists = (await c.query('SELECT 1 FROM customers WHERE id=$1', [customerId])).rowCount;
        const closed = new Set<string>(
          (await c.query(`SELECT DISTINCT period FROM invoices WHERE customer_id=$1 AND status <> 'draft'`, [customerId]))
            .rows.map((r) => r.period),
        );
        for (const i of indexes) {
          results[i] = await this.ingestOne(c, events[i], { exists: !!exists, known, closed });
        }
      });
    }
    return results;
  }

  private async ingestOne(
    c: PoolClient,
    e: EventDto,
    ctx: { exists: boolean; known: Set<string>; closed: Set<string> },
  ): Promise<EventResult> {
    const reject = (reason: string): EventResult => ({ idempotencyKey: e.idempotencyKey, status: 'rejected', reason });
    const when = new Date(e.timestamp);

    if (!ctx.exists) return reject('unknown_customer');
    if (!ctx.known.has(e.metric)) return reject('unknown_metric');
    if (when.getTime() > Date.now() + FUTURE_TOLERANCE_MS) return reject('timestamp_in_future');
    if (ctx.closed.has(periodOf(when))) return reject('period_closed');

    const inserted = await c.query(
      `INSERT INTO usage_events (customer_id, metric, quantity, occurred_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (customer_id, idempotency_key) DO NOTHING RETURNING id`,
      [e.customerId, e.metric, e.quantity, when, e.idempotencyKey],
    );
    if (inserted.rowCount) return { idempotencyKey: e.idempotencyKey, status: 'accepted' };

    // Key already used: a true retry carries the identical payload; anything else is a client bug.
    const prev = (await c.query(
      'SELECT metric, quantity, occurred_at FROM usage_events WHERE customer_id=$1 AND idempotency_key=$2',
      [e.customerId, e.idempotencyKey],
    )).rows[0];
    const same = prev.metric === e.metric && Number(prev.quantity) === e.quantity && prev.occurred_at.getTime() === when.getTime();
    return same ? { idempotencyKey: e.idempotencyKey, status: 'duplicate' } : reject('idempotency_key_reused_with_different_payload');
  }

  summary(customerId: string, period: string) {
    return this.db.query(
      `SELECT metric, SUM(quantity)::bigint AS quantity, COUNT(*)::int AS events FROM usage_events
       WHERE customer_id = $1 AND to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM') = $2
       GROUP BY metric ORDER BY metric`,
      [customerId, period],
    );
  }
}
