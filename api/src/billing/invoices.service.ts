import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { computeInvoice, NotBillable, parsePeriod, PlanSpec } from './calculator';
import { Db, lockCustomer } from '../db';

type SubRow = {
  id: string; customerId: string; seats: number; startedOn: string; endsOn: string | null; taxBps: number;
  plan: PlanSpec;
};

const SUB_SELECT = `
  SELECT s.id, s.customer_id AS "customerId", s.seats, s.started_on AS "startedOn", s.ends_on AS "endsOn",
         c.tax_rate_bps AS "taxBps",
         jsonb_build_object('name', p.name, 'baseFeeCents', p.base_fee_cents, 'seatFeeCents', p.seat_fee_cents,
                            'usagePricing', p.usage_pricing) AS plan
  FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN customers c ON c.id = s.customer_id`;

const dayToIso = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class InvoicesService {
  constructor(private readonly db: Db) {}

  /** Creates or refreshes DRAFT invoices for every subscription active in `period`. Idempotent. */
  async generate(period: string) {
    const p = this.checkPeriod(period);
    if (p.start.getTime() > Date.now()) throw new BadRequestException('Cannot invoice a period that has not started');

    const subs = await this.db.query<SubRow>(
      `${SUB_SELECT} WHERE s.started_on <= $2::date AND (s.ends_on IS NULL OR s.ends_on >= $1::date)`,
      [dayToIso(p.startDay), dayToIso(p.endDay)],
    );
    const tally = { created: 0, updated: 0, skipped: 0 };
    for (const sub of subs) {
      const outcome = await this.db.tx(async (c) => {
        await lockCustomer(c, sub.customerId);
        return this.build(c, sub, period);
      });
      if (outcome !== 'not_billable') tally[outcome]++;
    }
    return { period, ...tally };
  }

  /**
   * Locks the invoice. Recomputes from the usage that exists right now, inside the customer lock,
   * so the finalized numbers include every event that was accepted and exclude every event that
   * will be rejected afterwards. After this the invoice never changes.
   */
  async finalize(id: string) {
    const head = await this.header(id);
    const p = this.checkPeriod(head.period);
    if (head.status !== 'draft') return this.get(id); // idempotent
    if (p.end.getTime() > Date.now()) throw new ConflictException(`Period ${head.period} has not ended yet`);

    await this.db.tx(async (c) => {
      await lockCustomer(c, head.customerId);
      const cur = (await c.query('SELECT status FROM invoices WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (cur.status !== 'draft') return;
      const sub = (await c.query(`${SUB_SELECT} WHERE s.id = $1`, [head.subscriptionId])).rows[0] as SubRow;
      await this.build(c, sub, head.period);
      await c.query(`UPDATE invoices SET status='finalized', finalized_at=now(), updated_at=now() WHERE id=$1`, [id]);
    });
    return this.get(id);
  }

  async pay(id: string) {
    const head = await this.header(id);
    if (head.status === 'draft') throw new ConflictException('Finalize the invoice before it can be paid');
    if (head.status === 'finalized') {
      await this.db.query(`UPDATE invoices SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 AND status='finalized'`, [id]);
    }
    return this.get(id);
  }

  list(filter: { period?: string; status?: string; customerId?: string }) {
    return this.db.query(
      `SELECT i.id, i.period, i.status, i.subtotal_cents AS "subtotalCents", i.tax_cents AS "taxCents",
              i.total_cents AS "totalCents", i.finalized_at AS "finalizedAt", i.paid_at AS "paidAt",
              c.id AS "customerId", c.name AS "customerName", p.name AS "planName"
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
       WHERE ($1::text IS NULL OR i.period = $1) AND ($2::text IS NULL OR i.status = $2) AND ($3::uuid IS NULL OR i.customer_id = $3)
       ORDER BY i.period DESC, c.name LIMIT 200`,
      [filter.period ?? null, filter.status ?? null, filter.customerId ?? null],
    );
  }

  async get(id: string) {
    const [inv] = await this.db.query(
      `SELECT i.id, i.period, i.status, i.subtotal_cents AS "subtotalCents", i.tax_cents AS "taxCents",
              i.total_cents AS "totalCents", i.finalized_at AS "finalizedAt", i.paid_at AS "paidAt", i.created_at AS "createdAt",
              c.id AS "customerId", c.name AS "customerName", c.email AS "customerEmail", p.name AS "planName"
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id WHERE i.id = $1`,
      [id],
    );
    if (!inv) throw new NotFoundException('Invoice not found');
    const lines = await this.db.query(
      `SELECT kind, description, quantity, unit_price AS "unitPrice", amount_cents AS "amountCents"
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY position`,
      [id],
    );
    return { ...inv, lines };
  }

  // ----------------------------------------------------------------- internals
  private checkPeriod(period: string) {
    try {
      return parsePeriod(period);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private async header(id: string) {
    const [row] = await this.db.query(
      `SELECT id, period, status, customer_id AS "customerId", subscription_id AS "subscriptionId" FROM invoices WHERE id=$1`,
      [id],
    );
    if (!row) throw new NotFoundException('Invoice not found');
    return row as { id: string; period: string; status: string; customerId: string; subscriptionId: string };
  }

  /** Must be called with the customer lock held. Never touches a non-draft invoice. */
  private async build(c: PoolClient, sub: SubRow, period: string): Promise<'created' | 'updated' | 'skipped' | 'not_billable'> {
    const p = parsePeriod(period);
    const existing = (await c.query('SELECT id, status FROM invoices WHERE subscription_id=$1 AND period=$2 FOR UPDATE', [sub.id, period])).rows[0];
    if (existing && existing.status !== 'draft') return 'skipped';

    const usage: Record<string, number> = {};
    const rows = (await c.query(
      `SELECT metric, SUM(quantity)::bigint AS quantity FROM usage_events
       WHERE customer_id=$1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY metric`,
      [sub.customerId, p.start, p.end],
    )).rows;
    for (const r of rows) usage[r.metric] = Number(r.quantity);

    let calc;
    try {
      calc = computeInvoice({ plan: sub.plan, seats: sub.seats, startedOn: sub.startedOn, endsOn: sub.endsOn, period, usage, taxBps: sub.taxBps });
    } catch (err) {
      if (err instanceof NotBillable) return 'not_billable';
      throw err;
    }

    let invoiceId: string;
    if (existing) {
      invoiceId = existing.id;
      await c.query(
        `UPDATE invoices SET subtotal_cents=$2, tax_cents=$3, total_cents=$4, updated_at=now() WHERE id=$1`,
        [invoiceId, calc.subtotalCents, calc.taxCents, calc.totalCents],
      );
      await c.query('DELETE FROM invoice_lines WHERE invoice_id=$1', [invoiceId]);
    } else {
      invoiceId = (await c.query(
        `INSERT INTO invoices (subscription_id, customer_id, period, subtotal_cents, tax_cents, total_cents)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [sub.id, sub.customerId, period, calc.subtotalCents, calc.taxCents, calc.totalCents],
      )).rows[0].id;
    }
    for (const [i, l] of calc.lines.entries()) {
      await c.query(
        `INSERT INTO invoice_lines (invoice_id, position, kind, description, quantity, unit_price, amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoiceId, i, l.kind, l.description, l.quantity, l.unitPrice, l.amountCents],
      );
    }
    return existing ? 'updated' : 'created';
  }
}
