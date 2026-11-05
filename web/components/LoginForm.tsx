'use client';
import { useState } from 'react';
import { login, setToken } from '@/lib/api';
import { button, input } from './ui';

export default function LoginForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('admin@meterbill.dev');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      setToken((await login(email, password)).accessToken);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-slate-900 p-6 shadow-xl">
        <div>
          <h1 className="text-2xl font-semibold">MeterBill</h1>
          <p className="text-sm text-slate-400">Usage-based billing, to the cent.</p>
        </div>
        <input className={`${input} w-full`} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className={`${input} w-full`} type="password" required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className={`${button} w-full`}>Sign in</button>
      </form>
    </main>
  );
}
