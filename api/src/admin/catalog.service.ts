import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MoneyError } from '../billing/money';
import { validateUsagePricing } from '../billing/calculator';
import { Db, isUniqueViolation } from '../db';
import { CreateCustomerDto, CreatePlanDto, CreateSubscriptionDto } from './dto';

const isRealDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s;
};

@Injectable()
export class CatalogService {
  constructor(private readonly db: Db) {}

  async createCustomer(dto: CreateCustomerDto) {
    try {
      const [row] = await this.db.query(
        `INSERT INTO customers (name, email, tax_rate_bps) VALUES ($1, lower($2), $3)
         RETURNING id, name, email, tax_rate_bps AS "taxRateBps", created_at AS "createdAt"`,
        [dto.name, dto.email, dto.taxRateBps ?? 0],
      );
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('A customer with this email already exists');
      throw err;
    }
  }

  listCustomers() {
    return this.db.query(
      `SELECT id, name, email, tax_rate_bps AS "taxRateBps", created_at AS "createdAt" FROM customers ORDER BY created_at DESC`,
    );
  }

  async createPlan(dto: CreatePlanDto) {
    const usagePricing = dto.usagePricing ?? [];
    try {
      validateUsagePricing(usagePricing);
    } catch (err) {
      if (err instanceof MoneyError) throw new BadRequestException(err.message);
      throw err;
    }
    try {
      const [row] = await this.db.query(
        `INSERT INTO plans (name, base_fee_cents, seat_fee_cents, usage_pricing) VALUES ($1, $2, $3, $4)
         RETURNING id, name, base_fee_cents AS "baseFeeCents", seat_fee_cents AS "seatFeeCents",
                   usage_pricing AS "usagePricing", created_at AS "createdAt"`,
        [dto.name, dto.baseFeeCents, dto.seatFeeCents ?? 0, JSON.stringify(usagePricing)],
      );
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('A plan with this name already exists');
      throw err;
    }
  }

  listPlans() {
    return this.db.query(
      `SELECT id, name, base_fee_cents AS "baseFeeCents", seat_fee_cents AS "seatFeeCents",
              usage_pricing AS "usagePricing", created_at AS "createdAt" FROM plans ORDER BY created_at DESC`,
    );
  }

  async createSubscription(dto: CreateSubscriptionDto) {
    if (!isRealDate(dto.startedOn)) throw new BadRequestException('startedOn is not a real calendar date');
    return this.db.tx(async (c) => {
      const customer = (await c.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [dto.customerId])).rows[0];
      if (!customer) throw new NotFoundException('Customer not found');
      if (!(await c.query('SELECT 1 FROM plans WHERE id=$1', [dto.planId])).rowCount) throw new NotFoundException('Plan not found');

      // One subscription at a time per customer: otherwise the same usage would be billed twice.
      const prior = (await c.query(
        `SELECT bool_or(ends_on IS NULL) AS "hasOpen", max(ends_on) AS "latestEnd" FROM subscriptions WHERE customer_id=$1`,
        [dto.customerId],
      )).rows[0];
      if (prior.hasOpen) throw new ConflictException('Customer already has an active subscription; cancel it first');
      if (prior.latestEnd && dto.startedOn <= prior.latestEnd) {
        throw new ConflictException(`New subscription must start after the previous one ends (${prior.latestEnd})`);
      }
      const [row] = (await c.query(
        `INSERT INTO subscriptions (customer_id, plan_id, seats, started_on) VALUES ($1,$2,$3,$4)
         RETURNING id, customer_id AS "customerId", plan_id AS "planId", seats, started_on AS "startedOn", ends_on AS "endsOn"`,
        [dto.customerId, dto.planId, dto.seats ?? 1, dto.startedOn],
      )).rows;
      return row;
    });
  }

  listSubscriptions() {
    return this.db.query(
      `SELECT s.id, s.customer_id AS "customerId", c.name AS "customerName", s.plan_id AS "planId", p.name AS "planName",
              s.seats, s.started_on AS "startedOn", s.ends_on AS "endsOn"
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id
       ORDER BY s.created_at DESC`,
    );
  }

  /** Cancels at the end of the current month (UTC). No refunds or credits; the last period bills in full. */
  async cancelSubscription(id: string) {
    const now = new Date();
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const [row] = await this.db.query(
      `UPDATE subscriptions SET ends_on = GREATEST($2::date, started_on) WHERE id = $1 AND ends_on IS NULL
       RETURNING id, ends_on AS "endsOn"`,
      [id, lastDay],
    );
    if (row) return row;
    const [existing] = await this.db.query(`SELECT id, ends_on AS "endsOn" FROM subscriptions WHERE id=$1`, [id]);
    if (!existing) throw new NotFoundException('Subscription not found');
    return existing; // already cancelled: idempotent
  }
}
