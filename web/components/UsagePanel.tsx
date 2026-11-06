'use client';
import { useEffect, useState } from 'react';
import { Customer, Plan, customerUsage, listCustomers, listPlans, simulateEvents } from '@/lib/api';
import { Card, button, ghost, input } from './ui';

export default function UsagePanel() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [metric, setMetric] = useState('');
  const [quantity, setQuantity] = useState('100');
  const [when, setWhen] = useState(new Date().toISOString().slice(0, 16));
  const [log, setLog] = useState<string[]>([]);
  const [usage, setUsage] = useState<{ metric: string; quantity: number; events: number }[]>([]);

  useEffect(() => { listCustomers().then(setCustomers).catch(() => undefined); listPlans().then(setPlans).catch(() => undefined); }, []);
  const metrics = Array.from(new Set(plans.flatMap((p) => p.usagePricing.map((u) => u.metric))));
  const cid = customerId || customers[0]?.id || '';
  const period = new Date(when).toISOString().slice(0, 7);

  const loadUsage = () => cid && customerUsage(cid, period).then(setUsage).catch(() => undefined);
  useEffect(() => { loadUsage(); }, [cid, period]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(events: unknown[], label: string) {
    try {
      const r = await simulateEvents(events);
      const c = (s: string) => r.results.filter((x) => x.status === s).length;
      const reasons = Array.from(new Set(r.results.filter((x) => x.reason).map((x) => x.reason)));
      setLog((l) => [`${label}: ${c('accepted')} accepted, ${c('duplicate')} duplicate, ${c('rejected')} rejected${reasons.length ? ` (${reasons.join(', ')})` : ''}`, ...l].slice(0, 8));
      loadUsage();
    } catch (err) { setLog((l) => [`${label}: ${err instanceof Error ? err.message : 'failed'}`, ...l]); }
  }
  const one = () => send([{ customerId: cid, metric: metric || metrics[0], quantity: Number(quantity), timestamp: new Date(when).toISOString(), idempotencyKey: crypto.randomUUID() }], 'Single event');
  const burst = () => {
    const now = Date.now();
    send(Array.from({ length: 40 }, (_, i) => ({
      customerId: cid, metric: metrics[i % metrics.length], quantity: 50 + ((i * 37) % 400),
      timestamp: new Date(now - ((i * 36) % 1000) * 3_600_000).toISOString(), idempotencyKey: crypto.randomUUID(),
    })), 'Sample burst (40 events over ~6 weeks)');
  };

  return (
    <div className="space-y-6">
      <Card>
        <p className="mb-3 text-sm text-slate-400">In production your services call <code>POST /v1/events</code> with an ingest key. This simulator uses your admin login.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">Customer<select className={`${input} mt-1 block`} value={cid} onChange={(e) => setCustomerId(e.target.value)}>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="text-xs text-slate-400">Metric<select className={`${input} mt-1 block`} value={metric || metrics[0] || ''} onChange={(e) => setMetric(e.target.value)}>{metrics.map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="text-xs text-slate-400">Quantity<input className={`${input} mt-1 block w-28`} type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
          <label className="text-xs text-slate-400">When<input className={`${input} mt-1 block`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <button className={button} onClick={one} disabled={!cid}>Send event</button>
          <button className={ghost} onClick={burst} disabled={!cid}>Send sample burst</button>
        </div>
        <ul className="mt-4 space-y-1 text-xs text-slate-300">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </Card>
      <Card>
        <p className="mb-2 text-sm font-medium">Usage in {period}</p>
        {usage.length === 0 ? <p className="text-sm text-slate-500">No usage recorded for this customer and month.</p> : (
          <ul className="text-sm">{usage.map((u) => <li key={u.metric} className="flex justify-between border-t border-slate-800 py-1"><span className="font-mono text-emerald-300">{u.metric}</span><span>{u.quantity.toLocaleString()} units · {u.events} events</span></li>)}</ul>
        )}
      </Card>
    </div>
  );
}
