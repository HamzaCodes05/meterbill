import {
  bpsOfHalfUp, formatCents, formatMicros, microsToCentsHalfUp, MoneyError, parseUnitPriceToMicros, prorateHalfUp,
} from './money';

/** One band of graduated pricing. `upTo` is the cumulative ceiling; null means "and above". */
export type Tier = { upTo: number | null; unitPrice: string };
export type UsagePricing = { metric: string; label: string; tiers: Tier[] };
export type PlanSpec = { name: string; baseFeeCents: number; seatFeeCents: number; usagePricing: UsagePricing[] };

export type LineKind = 'base' | 'seats' | 'usage' | 'tax';
export type LineItem = { kind: LineKind; description: string; quantity: number; unitPrice: string; amountCents: number };
export type InvoiceCalc = { lines: LineItem[]; subtotalCents: number; taxCents: number; totalCents: number };

export class NotBillable extends Error {}

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtInt = (n: number) => n.toLocaleString('en-US');

export function parsePeriod(period: string) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) throw new MoneyError(`invalid period "${period}" (expected YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const startDay = Date.UTC(year, month - 1, 1) / DAY_MS;
  const nextDay = Date.UTC(year, month, 1) / DAY_MS;
  return {
    year, month, startDay, endDay: nextDay - 1, days: nextDay - startDay,
    start: new Date(startDay * DAY_MS), end: new Date(nextDay * DAY_MS), // [start, end)
    label: `${MONTHS[month - 1]} ${year}`,
  };
}

const dayNumber = (isoDate: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new MoneyError(`invalid date "${isoDate}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
};

/** Validates a plan's usage pricing. Called when plans are created so bad pricing can never reach an invoice. */
export function validateUsagePricing(pricing: UsagePricing[]): void {
  const seen = new Set<string>();
  for (const p of pricing) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(p.metric)) throw new MoneyError(`invalid metric name "${p.metric}"`);
    if (seen.has(p.metric)) throw new MoneyError(`duplicate metric "${p.metric}"`);
    seen.add(p.metric);
    if (!p.tiers.length) throw new MoneyError(`metric "${p.metric}" needs at least one tier`);
    let prev = 0;
    p.tiers.forEach((t, i) => {
      parseUnitPriceToMicros(t.unitPrice);
      const last = i === p.tiers.length - 1;
      if (last && t.upTo !== null) throw new MoneyError(`the last tier of "${p.metric}" must have upTo = null`);
      if (!last) {
        if (t.upTo === null || !Number.isInteger(t.upTo) || t.upTo <= prev) {
          throw new MoneyError(`tiers of "${p.metric}" must have strictly increasing integer upTo values`);
        }
        prev = t.upTo;
      }
    });
  }
}

/**
 * Computes one invoice. Pure function: same inputs, same output, no I/O.
 *
 *  - Base and seat fees are prorated by the days the subscription was active in the period.
 *  - Usage is graduated: each tier prices only the units that fall inside it. Usage is not prorated.
 *  - Each line is rounded half-up to whole cents; the subtotal is the sum of those lines;
 *    tax is computed on the subtotal.
 */
export function computeInvoice(input: {
  plan: PlanSpec;
  seats: number;
  startedOn: string; // YYYY-MM-DD
  endsOn: string | null;
  period: string; // YYYY-MM
  usage: Record<string, number>;
  taxBps: number;
}): InvoiceCalc {
  const { plan, seats, period, usage, taxBps } = input;
  const p = parsePeriod(period);

  const first = Math.max(dayNumber(input.startedOn), p.startDay);
  const last = Math.min(input.endsOn ? dayNumber(input.endsOn) : Infinity, p.endDay);
  const activeDays = last - first + 1;
  if (activeDays <= 0) throw new NotBillable(`subscription is not active during ${period}`);

  const partial = activeDays < p.days;
  const note = partial ? `, prorated ${activeDays}/${p.days} days` : '';
  const lines: LineItem[] = [];

  lines.push({
    kind: 'base',
    description: `${plan.name} base fee, ${p.label}${note}`,
    quantity: 1,
    unitPrice: formatCents(plan.baseFeeCents).slice(1),
    amountCents: prorateHalfUp(plan.baseFeeCents, activeDays, p.days),
  });

  if (plan.seatFeeCents > 0) {
    lines.push({
      kind: 'seats',
      description: `Seats (${seats} x ${formatCents(plan.seatFeeCents)}), ${p.label}${note}`,
      quantity: seats,
      unitPrice: formatCents(plan.seatFeeCents).slice(1),
      amountCents: prorateHalfUp(plan.seatFeeCents * seats, activeDays, p.days),
    });
  }

  for (const pricing of plan.usagePricing) {
    const total = Math.max(0, Math.trunc(usage[pricing.metric] ?? 0));
    let from = 0; // units already consumed by lower tiers
    for (const tier of pricing.tiers) {
      const ceiling = tier.upTo ?? Infinity;
      const inTier = Math.min(total, ceiling) - from;
      if (inTier > 0) {
        const micros = parseUnitPriceToMicros(tier.unitPrice);
        const range = tier.upTo === null ? `${fmtInt(from + 1)}+` : `${fmtInt(from + 1)}-${fmtInt(tier.upTo)}`;
        lines.push({
          kind: 'usage',
          description: `${pricing.label}: ${range} @ $${formatMicros(micros)}`,
          quantity: inTier,
          unitPrice: formatMicros(micros),
          amountCents: Number(microsToCentsHalfUp(BigInt(inTier) * micros)),
        });
      }
      from = ceiling;
      if (total <= ceiling) break;
    }
  }

  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = bpsOfHalfUp(subtotalCents, taxBps);
  if (taxCents > 0) {
    lines.push({
      kind: 'tax',
      description: `Tax (${(taxBps / 100).toFixed(2)}%)`,
      quantity: 1,
      unitPrice: formatCents(taxCents).slice(1),
      amountCents: taxCents,
    });
  }
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
