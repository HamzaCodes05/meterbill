'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Invoice, InvoiceRow, finalizeInvoice, generateInvoices, getInvoice, listInvoices, money, payInvoice, previousPeriod,
} from '@/lib/api';
import { Badge, Card, Th, button, ghost, input } from './ui';

export default function InvoicesPanel() {
  const [period, setPeriod] = useState(previousPeriod());
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [open, setOpen] = useState<Invoice | null>(null);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => { listInvoices(period).then(setRows).catch(() => undefined); }, [period]);
  useEffect(refresh, [refresh]);

  async function act(fn: () => Promise<unknown>, message?: (r: any) => string) {
    setError(''); setInfo('');
    try {
      const r = await fn();
      if (message) setInfo(message(r));
      refresh();
      if (open) setOpen(await getInvoice(open.id));
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
  }

  return (
    <div className="space-y-6">
      <Card className="no-print">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">Billing period<input className={`${input} mt-1 block`} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
          <button className={button} onClick={() => act(() => generateInvoices(period), (r) => `Drafts: ${r.created} created, ${r.updated} refreshed, ${r.skipped} already finalized`)}>Generate drafts</button>
          <p className="text-xs text-slate-500">Drafts refresh with late usage. Finalizing locks the invoice and closes the period for new usage.</p>
        </div>
        {info && <p className="mt-3 text-sm text-emerald-400">{info}</p>}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </Card>

      <div className="no-print overflow-x-auto rounded-xl bg-slate-900">
        <table className="w-full text-sm"><thead><tr><Th>Customer</Th><Th>Plan</Th><Th>Status</Th><Th right>Total</Th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td className="p-3 text-slate-500" colSpan={4}>No invoices for {period}. Generate drafts to create them.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} onClick={() => getInvoice(r.id).then(setOpen)} className="cursor-pointer border-t border-slate-800 hover:bg-slate-800/60">
                <td className="p-3">{r.customerName}</td><td>{r.planName}</td><td><Badge kind={r.status}>{r.status}</Badge></td>
                <td className="pr-3 text-right font-mono">{money(r.totalCents)}</td>
              </tr>
            ))}
          </tbody></table>
      </div>

      {open && (
        <div className="print-area rounded-xl bg-slate-900 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-semibold">Invoice {open.period}</h2>
              <p className="text-sm text-slate-400">{open.customerName} · {open.customerEmail}</p>
              <p className="text-sm text-slate-400">{open.planName}</p>
            </div>
            <Badge kind={open.status}>{open.status}</Badge>
          </div>
          <table className="mt-4 w-full text-sm">
            <thead><tr><Th>Description</Th><Th right>Qty</Th><Th right>Unit price</Th><Th right>Amount</Th></tr></thead>
            <tbody>
              {open.lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-800">
                  <td className="p-3">{l.description}</td><td className="text-right">{l.quantity.toLocaleString()}</td>
                  <td className="text-right font-mono">${l.unitPrice}</td><td className="text-right font-mono">{money(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="font-mono">
              <tr className="border-t border-slate-700"><td colSpan={3} className="p-3 text-right text-slate-400">Subtotal</td><td className="text-right">{money(open.subtotalCents)}</td></tr>
              <tr><td colSpan={3} className="px-3 pb-1 text-right text-slate-400">Tax</td><td className="text-right">{money(open.taxCents)}</td></tr>
              <tr className="text-base font-semibold"><td colSpan={3} className="p-3 text-right">Total due</td><td className="text-right">{money(open.totalCents)}</td></tr>
            </tfoot>
          </table>
          <div className="no-print mt-4 flex gap-2">
            {open.status === 'draft' && <button className={button} onClick={() => act(() => finalizeInvoice(open.id), () => 'Invoice finalized and locked')}>Finalize</button>}
            {open.status === 'finalized' && <button className={button} onClick={() => act(() => payInvoice(open.id), () => 'Marked as paid')}>Mark paid</button>}
            <button className={ghost} onClick={() => window.print()}>Print / save PDF</button>
            <button className={ghost} onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
