export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type Customer = { id: string; name: string; email: string; taxRateBps: number; createdAt: string };
export type Tier = { upTo: number | null; unitPrice: string };
export type UsagePricing = { metric: string; label: string; tiers: Tier[] };
export type Plan = { id: string; name: string; baseFeeCents: number; seatFeeCents: number; usagePricing: UsagePricing[] };
export type Subscription = {
  id: string; customerId: string; customerName: string; planId: string; planName: string;
  seats: number; startedOn: string; endsOn: string | null;
};
export type InvoiceStatus = 'draft' | 'finalized' | 'paid';
export type InvoiceRow = {
  id: string; period: string; status: InvoiceStatus; subtotalCents: number; taxCents: number; totalCents: number;
  finalizedAt: string | null; paidAt: string | null; customerId: string; customerName: string; planName: string;
};
export type InvoiceLine = { kind: string; description: string; quantity: number; unitPrice: string; amountCents: number };
export type Invoice = InvoiceRow & { customerEmail: string; createdAt: string; lines: InvoiceLine[] };
export type EventResult = { idempotencyKey: string; status: 'accepted' | 'duplicate' | 'rejected'; reason?: string };

const KEY = 'meterbill_token';
export const getToken = () => (typeof window === 'undefined' ? null : localStorage.getItem(KEY));
export const setToken = (t: string) => localStorage.setItem(KEY, t);
export const clearToken = () => localStorage.removeItem(KEY);
export class UnauthorizedError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') throw new UnauthorizedError();
  if (!res.ok) {
    const msg = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    throw new Error(msg ?? `Request failed (${res.status})`);
  }
  return body as T;
}
const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const login = (email: string, password: string) => post<{ accessToken: string }>('/auth/login', { email, password });
export const listCustomers = () => request<Customer[]>('/v1/customers');
export const createCustomer = (c: { name: string; email: string; taxRateBps: number }) => post<Customer>('/v1/customers', c);
export const listPlans = () => request<Plan[]>('/v1/plans');
export const createPlan = (p: { name: string; baseFeeCents: number; seatFeeCents: number; usagePricing: UsagePricing[] }) => post<Plan>('/v1/plans', p);
export const listSubscriptions = () => request<Subscription[]>('/v1/subscriptions');
export const createSubscription = (s: { customerId: string; planId: string; seats: number; startedOn: string }) => post<Subscription>('/v1/subscriptions', s);
export const cancelSubscription = (id: string) => post<Subscription>(`/v1/subscriptions/${id}/cancel`);
export const simulateEvents = (events: unknown[]) => post<{ results: EventResult[] }>('/v1/simulate-events', { events });
export const customerUsage = (id: string, period: string) => request<{ metric: string; quantity: number; events: number }[]>(`/v1/customers/${id}/usage?period=${period}`);
export const listInvoices = (period?: string) => request<InvoiceRow[]>(`/v1/invoices${period ? `?period=${period}` : ''}`);
export const getInvoice = (id: string) => request<Invoice>(`/v1/invoices/${id}`);
export const generateInvoices = (period: string) => post<{ period: string; created: number; updated: number; skipped: number }>('/v1/invoices/generate', { period });
export const finalizeInvoice = (id: string) => post<Invoice>(`/v1/invoices/${id}/finalize`);
export const payInvoice = (id: string) => post<Invoice>(`/v1/invoices/${id}/pay`);

export const money = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const previousPeriod = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
