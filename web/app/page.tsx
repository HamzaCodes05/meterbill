'use client';
import { useEffect, useState } from 'react';
import { CustomersPanel, PlansPanel, SubscriptionsPanel } from '@/components/CatalogPanels';
import InvoicesPanel from '@/components/InvoicesPanel';
import LoginForm from '@/components/LoginForm';
import UsagePanel from '@/components/UsagePanel';
import { clearToken, getToken } from '@/lib/api';

const TABS = ['Invoices', 'Usage', 'Customers', 'Plans', 'Subscriptions'] as const;

export default function Home() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Invoices');

  useEffect(() => { setAuthed(!!getToken()); setReady(true); }, []);
  if (!ready) return null;
  if (!authed) return <LoginForm onDone={() => setAuthed(true)} />;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="no-print mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">MeterBill</h1>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-slate-800' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
          ))}
        </nav>
        <button onClick={() => { clearToken(); setAuthed(false); }} className="text-sm text-slate-400 hover:text-slate-200">Sign out</button>
      </header>
      {tab === 'Invoices' && <InvoicesPanel />}
      {tab === 'Usage' && <UsagePanel />}
      {tab === 'Customers' && <CustomersPanel />}
      {tab === 'Plans' && <PlansPanel />}
      {tab === 'Subscriptions' && <SubscriptionsPanel />}
    </div>
  );
}
