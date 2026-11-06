export const input = 'rounded-lg bg-slate-800 px-3 py-2 text-sm outline-none focus:ring-2 ring-emerald-500';
export const button = 'rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50';
export const ghost = 'rounded-lg bg-slate-700 px-3 py-1.5 text-xs hover:bg-slate-600 disabled:opacity-50';

const BADGE: Record<string, string> = {
  draft: 'bg-amber-500/20 text-amber-300', finalized: 'bg-sky-500/20 text-sky-300', paid: 'bg-emerald-500/20 text-emerald-300',
  active: 'bg-emerald-500/20 text-emerald-300', ending: 'bg-slate-600/50 text-slate-300',
};
export const Badge = ({ kind, children }: { kind: string; children: React.ReactNode }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs ${BADGE[kind] ?? BADGE.ending}`}>{children}</span>
);
export const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`rounded-xl bg-slate-900 p-4 ${className}`}>{children}</div>
);
export const Th = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => (
  <th className={`p-3 text-xs font-normal uppercase text-slate-500 ${right ? 'text-right' : 'text-left'}`}>{children}</th>
);
