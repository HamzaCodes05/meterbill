'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Customer, Plan, Subscription, cancelSubscription, createCustomer, createPlan, createSubscription, listCustomers,
  listPlans, listSubscriptions, money,
} from '@/lib/api';
import { Badge, Card, Th, button, ghost, input } from './ui';

function useList<T>(load: () => Promise<T[]>) {
  const [rows, setRows] = useState<T[]>([]);
  const refresh = useCallback(() => { load().then(setRows).catch(() => undefined); }, [load]);
  useEffect(refresh, [refresh]);
  return [rows, refresh] as const;
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Failed');

export function CustomersPanel() {
  const [rows, refresh] = useList<Customer>(listCustomers);
  const [form, setForm] = useState({ name: '', email: '', taxPct: '0' });
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try { await createCustomer({ name: form.name, email: form.email, taxRateBps: Math.round(Number(form.taxPct) * 100) }); setForm({ name: '', email: '', taxPct: '0' }); refresh(); }
    catch (err) { setError(errMsg(err)); }
  }
  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">Name<input className={`${input} mt-1 block w-48`} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="text-xs text-slate-400">Email<input className={`${input} mt-1 block w-60`} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="text-xs text-slate-400">Tax %<input className={`${input} mt-1 block w-24`} type="number" step="0.01" min="0" max="100" value={form.taxPct} onChange={(e) => setForm({ ...form, taxPct: e.target.value })} /></label>
          <button className={button}>Add customer</button>
          {error && <p className="w-full text-sm text-red-400">{error}</p>}
        </form>
      </Card>
      <div className="overflow-x-auto rounded-xl bg-slate-900">
        <table className="w-full text-sm"><thead><tr><Th>Name</Th><Th>Email</Th><Th>Tax</Th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td className="p-3 text-slate-500" colSpan={3}>No customers yet.</td></tr>}
            {rows.map((c) => <tr key={c.id} className="border-t border-slate-800"><td className="p-3">{c.name}</td><td>{c.email}</td><td>{(c.taxRateBps / 100).toFixed(2)}%</td></tr>)}
          </tbody></table>
      </div>
    </div>
  );
}

const EXAMPLE_PRICING = JSON.stringify([
  { metric: 'api_calls', label: 'API calls', tiers: [{ upTo: 1000, unitPrice: '0' }, { upTo: 10000, unitPrice: '0.002' }, { upTo: null, unitPrice: '0.001' }] },
  { metric: 'storage_gb', label: 'Storage (GB)', tiers: [{ upTo: null, unitPrice: '0.10' }] },
], null, 2);

export function PlansPanel() {
  const [rows, refresh] = useList<Plan>(listPlans);
  const [form, setForm] = useState({ name: '', base: '99.00', seat: '15.00', pricing: EXAMPLE_PRICING });
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      await createPlan({ name: form.name, baseFeeCents: Math.round(Number(form.base) * 100), seatFeeCents: Math.round(Number(form.seat) * 100), usagePricing: JSON.parse(form.pricing) });
      setForm({ ...form, name: '' }); refresh();
    } catch (err) { setError(err instanceof SyntaxError ? 'Usage pricing is not valid JSON' : errMsg(err)); }
  }
  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm">New plan <span className="text-slate-500">(plans are immutable: to change a price, create a new plan)</span></p>
          <div className="flex flex-wrap gap-3">
            <input className={`${input} w-48`} required placeholder="Plan name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <label className="text-xs text-slate-400">Base fee $/mo<input className={`${input} ml-2 w-24`} type="number" step="0.01" min="0" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} /></label>
            <label className="text-xs text-slate-400">Per seat $/mo<input className={`${input} ml-2 w-24`} type="number" step="0.01" min="0" value={form.seat} onChange={(e) => setForm({ ...form, seat: e.target.value })} /></label>
          </div>
          <textarea className={`${input} w-full font-mono text-xs`} rows={9} value={form.pricing} onChange={(e) => setForm({ ...form, pricing: e.target.value })} />
          <p className="text-xs text-slate-500">Graduated tiers: each tier prices only the units that fall inside it. Prices are decimal strings (up to 6 places); the last tier has <code>upTo: null</code>.</p>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button className={button}>Create plan</button>
        </form>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((p) => (
          <Card key={p.id}>
            <p className="font-medium">{p.name}</p>
            <p className="text-sm text-slate-400">{money(p.baseFeeCents)}/mo base · {money(p.seatFeeCents)}/seat</p>
            {p.usagePricing.map((u) => (
              <div key={u.metric} className="mt-2 text-xs text-slate-300">
                <span className="font-mono text-emerald-300">{u.metric}</span>: {u.tiers.map((t, i) => `${t.upTo === null ? 'then' : `first ${t.upTo.toLocaleString()}`} @ $${t.unitPrice}${i < u.tiers.length - 1 ? ', ' : ''}`)}
              </div>
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}

export function SubscriptionsPanel() {
  const [rows, refresh] = useList<Subscription>(listSubscriptions);
  const [customers] = useList<Customer>(listCustomers);
  const [plans] = useList<Plan>(listPlans);
  const [form, setForm] = useState({ customerId: '', planId: '', seats: '1', startedOn: new Date().toISOString().slice(0, 10) });
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try { await createSubscription({ customerId: form.customerId || customers[0]?.id, planId: form.planId || plans[0]?.id, seats: Number(form.seats), startedOn: form.startedOn }); refresh(); }
    catch (err) { setError(errMsg(err)); }
  }
  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">Customer<select className={`${input} mt-1 block`} value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="text-xs text-slate-400">Plan<select className={`${input} mt-1 block`} value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="text-xs text-slate-400">Seats<input className={`${input} mt-1 block w-20`} type="number" min="1" value={form.seats} onChange={(e) => setForm({ ...form, seats: e.target.value })} /></label>
          <label className="text-xs text-slate-400">Start date<input className={`${input} mt-1 block`} type="date" value={form.startedOn} onChange={(e) => setForm({ ...form, startedOn: e.target.value })} /></label>
          <button className={button}>Subscribe</button>
          {error && <p className="w-full text-sm text-red-400">{error}</p>}
        </form>
      </Card>
      <div className="overflow-x-auto rounded-xl bg-slate-900">
        <table className="w-full text-sm"><thead><tr><Th>Customer</Th><Th>Plan</Th><Th>Seats</Th><Th>Started</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td className="p-3 text-slate-500" colSpan={6}>No subscriptions yet.</td></tr>}
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-slate-800">
                <td className="p-3">{s.customerName}</td><td>{s.planName}</td><td>{s.seats}</td><td>{s.startedOn}</td>
                <td>{s.endsOn ? <Badge kind="ending">ends {s.endsOn}</Badge> : <Badge kind="active">active</Badge>}</td>
                <td className="pr-3 text-right">{!s.endsOn && <button className={ghost} onClick={() => confirm('Cancel at the end of this month?') && cancelSubscription(s.id).then(refresh)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody></table>
      </div>
    </div>
  );
}
