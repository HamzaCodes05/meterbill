import { computeInvoice, NotBillable, parsePeriod, PlanSpec, Tier, validateUsagePricing } from '../src/billing/calculator';
import {
  bpsOfHalfUp, formatCents, formatMicros, microsToCentsHalfUp, MoneyError, parseUnitPriceToMicros, prorateHalfUp,
} from '../src/billing/money';

describe('money', () => {
  it('parses unit prices exactly, with no floating point', () => {
    expect(parseUnitPriceToMicros('0.0025')).toBe(2500n);
    expect(parseUnitPriceToMicros('1')).toBe(1_000_000n);
    expect(parseUnitPriceToMicros('0.000001')).toBe(1n);
    expect(parseUnitPriceToMicros('0.1')).toBe(100_000n); // the classic 0.1 + 0.2 trap is simply absent
    expect(parseUnitPriceToMicros('0.1') + parseUnitPriceToMicros('0.2')).toBe(parseUnitPriceToMicros('0.3'));
  });

  it.each(['-1', '1.0000001', 'abc', '', '1e3', '0x10', '1,5', ' '])('rejects bad price %p', (bad) => {
    expect(() => parseUnitPriceToMicros(bad)).toThrow(MoneyError);
  });

  it('formats micros', () => {
    expect(formatMicros(2500n)).toBe('0.0025');
    expect(formatMicros(1_000_000n)).toBe('1.00');
    expect(formatMicros(0n)).toBe('0.00');
  });

  it('rounds half up, exactly on the boundary', () => {
    expect(microsToCentsHalfUp(4999n)).toBe(0n);
    expect(microsToCentsHalfUp(5000n)).toBe(1n); // exactly half a cent rounds up
    expect(microsToCentsHalfUp(14_999n)).toBe(1n);
    expect(microsToCentsHalfUp(15_000n)).toBe(2n);
  });

  it('prorates in integers', () => {
    expect(prorateHalfUp(9900, 15, 31)).toBe(4790); // 4790.32
    expect(prorateHalfUp(9900, 31, 31)).toBe(9900);
    expect(prorateHalfUp(1, 1, 2)).toBe(1); // 0.5 rounds up
    expect(prorateHalfUp(0, 5, 31)).toBe(0);
  });

  it('computes tax in basis points', () => {
    expect(bpsOfHalfUp(10_000, 825)).toBe(825);
    expect(bpsOfHalfUp(1, 5000)).toBe(1); // 0.5 -> 1
    expect(bpsOfHalfUp(10_000, 0)).toBe(0);
  });

  it('formats cents', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(-250)).toBe('-$2.50');
  });
});

describe('periods', () => {
  it('knows month lengths, including leap years', () => {
    expect(parsePeriod('2026-10').days).toBe(31);
    expect(parsePeriod('2026-02').days).toBe(28);
    expect(parsePeriod('2028-02').days).toBe(29);
    expect(parsePeriod('2026-09').days).toBe(30);
  });
  it.each(['2026-13', '2026-00', '26-10', '2026-1', 'nope'])('rejects %p', (bad) => {
    expect(() => parsePeriod(bad)).toThrow();
  });
});

const TIERS: Tier[] = [
  { upTo: 1000, unitPrice: '0' }, // first 1,000 free
  { upTo: 10_000, unitPrice: '0.002' },
  { upTo: null, unitPrice: '0.001' },
];
const PLAN: PlanSpec = {
  name: 'Growth',
  baseFeeCents: 9900,
  seatFeeCents: 1500,
  usagePricing: [{ metric: 'api_calls', label: 'API calls', tiers: TIERS }],
};
const calc = (over: Partial<Parameters<typeof computeInvoice>[0]> = {}) =>
  computeInvoice({ plan: PLAN, seats: 1, startedOn: '2026-01-01', endsOn: null, period: '2026-10', usage: {}, taxBps: 0, ...over });
const usageLines = (c: ReturnType<typeof calc>) => c.lines.filter((l) => l.kind === 'usage');

describe('graduated usage tiers', () => {
  it.each([
    // usage, expected usage cents, expected number of usage lines
    [0, 0, 0],
    [1000, 0, 1], // exactly the free tier boundary
    [1001, 0, 2], // 1 unit in tier 2 = $0.002 = 0.2 cents -> 0
    [1500, 100, 2], // 500 * $0.002 = $1.00
    [10_000, 1800, 2], // 9,000 * $0.002 = $18.00
    [10_001, 1800, 3], // +1 unit at $0.001 = 0.1 cents -> 0
    [110_000, 1800 + 10_000, 3], // 100,000 * $0.001 = $100.00
  ])('usage %p', (units, expectedCents, nLines) => {
    const c = calc({ usage: { api_calls: units } });
    expect(usageLines(c).reduce((s, l) => s + l.amountCents, 0)).toBe(expectedCents);
    expect(usageLines(c)).toHaveLength(nLines);
  });

  it('prices only the units inside each tier, and quantities sum to total usage', () => {
    const c = calc({ usage: { api_calls: 25_000 } });
    expect(usageLines(c).map((l) => l.quantity)).toEqual([1000, 9000, 15_000]);
    expect(usageLines(c).reduce((s, l) => s + l.quantity, 0)).toBe(25_000);
  });

  it('matches a naive unit-by-unit reference implementation for many random plans and volumes', () => {
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let trial = 0; trial < 300; trial++) {
      const t1 = 1 + rand(50);
      const t2 = t1 + 1 + rand(50);
      const tiers: Tier[] = [
        { upTo: t1, unitPrice: `0.${String(rand(1000)).padStart(6, '0')}` },
        { upTo: t2, unitPrice: `0.${String(rand(1000)).padStart(6, '0')}` },
        { upTo: null, unitPrice: `0.${String(rand(1000)).padStart(6, '0')}` },
      ];
      const units = rand(200);
      const plan: PlanSpec = { name: 'P', baseFeeCents: 0, seatFeeCents: 0, usagePricing: [{ metric: 'm', label: 'M', tiers }] };
      const c = computeInvoice({ plan, seats: 1, startedOn: '2026-01-01', endsOn: null, period: '2026-10', usage: { m: units }, taxBps: 0 });

      // reference: walk every unit, add its price to its tier's bucket, round each bucket once
      const buckets = [0n, 0n, 0n];
      for (let u = 1; u <= units; u++) buckets[u <= t1 ? 0 : u <= t2 ? 1 : 2] += parseUnitPriceToMicros(tiers[u <= t1 ? 0 : u <= t2 ? 1 : 2].unitPrice);
      const expected = buckets.reduce((s, b) => s + Number(microsToCentsHalfUp(b)), 0);
      expect(usageLines(c).reduce((s, l) => s + l.amountCents, 0)).toBe(expected);
    }
  });

  it('rounds each line half-up once (sub-cent prices)', () => {
    const plan: PlanSpec = { ...PLAN, baseFeeCents: 0, seatFeeCents: 0, usagePricing: [{ metric: 'm', label: 'M', tiers: [{ upTo: null, unitPrice: '0.005' }] }] };
    const one = (u: number) => computeInvoice({ plan, seats: 1, startedOn: '2026-01-01', endsOn: null, period: '2026-10', usage: { m: u }, taxBps: 0 });
    expect(one(1).totalCents).toBe(1); // 0.5 cent -> 1
    expect(one(2).totalCents).toBe(1); // 1.0
    expect(one(3).totalCents).toBe(2); // 1.5 -> 2
  });
});

describe('fees, proration, tax', () => {
  it('bills a full month with no proration note', () => {
    const c = calc({ seats: 3 });
    expect(c.lines[0]).toMatchObject({ kind: 'base', amountCents: 9900 });
    expect(c.lines[0].description).not.toContain('prorated');
    expect(c.lines[1]).toMatchObject({ kind: 'seats', quantity: 3, amountCents: 4500 });
    expect(c.totalCents).toBe(14_400);
  });

  it('prorates base and seat fees for a mid-month start', () => {
    const c = calc({ startedOn: '2026-10-17', seats: 2 }); // 15 of 31 days
    expect(c.lines[0].amountCents).toBe(4790);
    expect(c.lines[0].description).toContain('prorated 15/31 days');
    expect(c.lines[1].amountCents).toBe(prorateHalfUp(3000, 15, 31)); // 1452
    expect(c.totalCents).toBe(4790 + 1452);
  });

  it('does not prorate usage', () => {
    const full = calc({ usage: { api_calls: 5000 } });
    const partial = calc({ startedOn: '2026-10-17', usage: { api_calls: 5000 } });
    expect(usageLines(partial)).toEqual(usageLines(full));
  });

  it('bills the first and last day inclusively, and handles leap February', () => {
    expect(calc({ startedOn: '2026-10-31' }).lines[0].description).toContain('1/31');
    expect(calc({ startedOn: '2028-02-01', period: '2028-02' }).lines[0].amountCents).toBe(9900);
    expect(calc({ startedOn: '2028-02-15', period: '2028-02' }).lines[0].description).toContain('15/29');
  });

  it('prorates the end of a subscription', () => {
    const c = calc({ endsOn: '2026-10-10' }); // days 1..10
    expect(c.lines[0].description).toContain('10/31');
    expect(c.lines[0].amountCents).toBe(prorateHalfUp(9900, 10, 31));
  });

  it('is not billable outside the subscription window', () => {
    expect(() => calc({ startedOn: '2026-11-01' })).toThrow(NotBillable);
    expect(() => calc({ endsOn: '2026-09-30' })).toThrow(NotBillable);
    expect(() => calc({ endsOn: '2026-10-01' })).not.toThrow();
  });

  it('adds tax on the subtotal, and the total is exactly the sum of the lines', () => {
    const c = calc({ seats: 2, usage: { api_calls: 12_345 }, taxBps: 825 });
    const tax = c.lines.find((l) => l.kind === 'tax')!;
    expect(tax.amountCents).toBe(bpsOfHalfUp(c.subtotalCents, 825));
    expect(c.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(c.totalCents);
    expect(c.totalCents).toBe(c.subtotalCents + c.taxCents);
  });

  it('omits the tax line when there is no tax', () => {
    expect(calc({ taxBps: 0 }).lines.some((l) => l.kind === 'tax')).toBe(false);
  });

  it('ignores usage for metrics the plan does not price, and negative usage', () => {
    expect(calc({ usage: { something_else: 999_999 } }).totalCents).toBe(calc().totalCents);
    expect(calc({ usage: { api_calls: -50 } }).totalCents).toBe(calc().totalCents);
  });

  it('skips the seat line for plans without a seat fee', () => {
    const c = computeInvoice({ plan: { ...PLAN, seatFeeCents: 0 }, seats: 5, startedOn: '2026-01-01', endsOn: null, period: '2026-10', usage: {}, taxBps: 0 });
    expect(c.lines.map((l) => l.kind)).toEqual(['base']);
  });
});

describe('README worked example (keeps the docs honest)', () => {
  it('Growth plan, 3 seats, joined on the 17th of a 31-day month, 12,445 calls, 8.25% tax', () => {
    const c = calc({ seats: 3, startedOn: '2026-10-17', usage: { api_calls: 12_445 }, taxBps: 825 });
    expect(c.lines.map((l) => [l.kind, l.amountCents])).toEqual([
      ['base', 4790], // 9900 x 15/31 = 4790.3
      ['seats', 2177], // 4500 x 15/31 = 2177.4
      ['usage', 0], //    1,000 x $0.000
      ['usage', 1800], // 9,000 x $0.002
      ['usage', 245], //  2,445 x $0.001 = 244.5 cents -> rounds up
      ['tax', 743], //    9012 x 8.25% = 743.49
    ]);
    expect(c.subtotalCents).toBe(9012);
    expect(c.totalCents).toBe(9755);
  });
});

describe('plan validation', () => {
  const ok = [{ metric: 'api_calls', label: 'API', tiers: TIERS }];
  it('accepts a valid plan', () => expect(() => validateUsagePricing(ok)).not.toThrow());
  it.each([
    ['unsorted tiers', [{ metric: 'a', label: 'A', tiers: [{ upTo: 100, unitPrice: '1' }, { upTo: 50, unitPrice: '1' }, { upTo: null, unitPrice: '1' }] }]],
    ['last tier capped', [{ metric: 'a', label: 'A', tiers: [{ upTo: 100, unitPrice: '1' }] }]],
    ['null mid-tier', [{ metric: 'a', label: 'A', tiers: [{ upTo: null, unitPrice: '1' }, { upTo: null, unitPrice: '1' }] }]],
    ['bad price', [{ metric: 'a', label: 'A', tiers: [{ upTo: null, unitPrice: '-1' }] }]],
    ['no tiers', [{ metric: 'a', label: 'A', tiers: [] }]],
    ['bad metric', [{ metric: 'Bad Name', label: 'A', tiers: [{ upTo: null, unitPrice: '1' }] }]],
    ['duplicate metric', [ok[0], ok[0]]],
    ['fractional boundary', [{ metric: 'a', label: 'A', tiers: [{ upTo: 1.5, unitPrice: '1' }, { upTo: null, unitPrice: '1' }] }]],
  ])('rejects %s', (_name, pricing) => {
    expect(() => validateUsagePricing(pricing as never)).toThrow(MoneyError);
  });
});
