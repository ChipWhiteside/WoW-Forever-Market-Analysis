import { useState } from 'react';
import { Card } from '../components/ui';

/** Phase 2 login: a name and the shared password. The site remembers you for 90 days. */
export function LoginPage({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState(() => { try { return localStorage.getItem('last_username') ?? ''; } catch { return ''; } });
  const [password, setPassword] = useState('');
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ busy: true, error: null });
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setState({ busy: false, error: body.error ?? `Sign in failed (${res.status}).` }); return; }
      try { localStorage.setItem('last_username', username.trim()); } catch { /* fine */ }
      onDone();
    } catch (err) {
      setState({ busy: false, error: `Sign in failed: ${(err as Error).message}` });
    }
  };
  const field = 'mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-base';
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm px-6 py-7">
        <div className="mb-5 flex items-center gap-2"><img src="/coin.svg" width={30} height={30} alt="" /><span className="font-display text-xl font-bold tracking-wide">Gold Finder</span></div>
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm font-semibold">Your name
            <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" maxLength={32} required className={field} />
            <span className="mt-1 block text-xs font-normal text-muted">Any name. It shows on the Ledger next to what you did.</span>
          </label>
          <label className="block text-sm font-semibold">Password
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" className={field} />
          </label>
          {state.error && <p className="text-sm text-bad">{state.error}</p>}
          <button type="submit" disabled={state.busy || !username.trim()} className="w-full rounded-md bg-ink px-4 py-2 text-sm font-semibold text-page disabled:opacity-50">{state.busy ? 'Signing in...' : 'Sign in'}</button>
          <p className="text-center text-xs text-muted">You stay signed in on this device for 90 days.</p>
        </form>
      </Card>
    </div>
  );
}
