import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavContext } from './nav';
import { ItemDrawer } from './components/ItemDrawer';
import { NowPage } from './pages/now';
import { VendorPage, ResalePage } from './pages/plays';
import { LookupPage, SettingsPage, HealthPage, ChangelogPage } from './pages/misc';
import { CraftingPage } from './pages/crafting';
import { DropsPage, FarmingPage, PositionsPage, WatchlistPage, MarketPage } from './pages/more';
import { api, type Me } from './lib/api';
import { MapPage } from './pages/map';
import { FlipsPage } from './pages/flips';
import { LedgerPage } from './pages/ledger';
import { LoginPage } from './pages/login';

const SECTIONS: Array<{ id: string; label: string; group: string; el: () => JSX.Element | null; count?: string[] }> = [
  { id: 'flips', label: 'Flips', group: 'Plays', el: FlipsPage },
  { id: 'now', label: 'Now', group: 'Plays', el: NowPage },
  { id: 'vendor', label: 'Vendor plays', group: 'Plays', el: VendorPage, count: ['vendor_dump', 'vendor_supply'] },
  { id: 'resale', label: 'Resale', group: 'Plays', el: ResalePage, count: ['underpriced', 'cross_house'] },
  { id: 'crafting', label: 'Crafting', group: 'Plays', el: CraftingPage },
  { id: 'drops', label: 'World drops', group: 'Plays', el: DropsPage },
  { id: 'farming', label: 'Farming', group: 'Plays', el: FarmingPage },
  { id: 'map', label: 'Map', group: 'Plays', el: MapPage },
  { id: 'positions', label: 'Positions', group: 'Mine', el: PositionsPage },
  { id: 'watchlist', label: 'Watchlist', group: 'Mine', el: WatchlistPage },
  // Phase 2: who did what, added after the existing Mine pages.
  { id: 'ledger', label: 'Ledger', group: 'Mine', el: LedgerPage },
  { id: 'market', label: 'Market', group: 'Insight', el: MarketPage },
  { id: 'lookup', label: 'Item lookup', group: 'Insight', el: LookupPage },
  { id: 'changelog', label: 'Changelog', group: 'System', el: ChangelogPage },
  { id: 'health', label: 'Health', group: 'System', el: HealthPage },
  { id: 'settings', label: 'Settings', group: 'System', el: SettingsPage },
];

export default function App() {
  const pageOf = () => location.hash.slice(1).split('/')[0] || 'flips';
  const [page, setPage] = useState(pageOf);
  const [item, setItem] = useState<number | null>(null);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('theme') === 'dark'; } catch { return false; } });
  useEffect(() => { const f = () => setPage(pageOf()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* fine */ } }, [dark]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); location.hash = 'lookup'; } if (e.key === 'Escape') setItem(null); };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  // Phase 2 login: off locally unless SITE_PASSWORD is set; a 401 anywhere brings the login page back.
  const qc = useQueryClient();
  const { data: me, isError: meFailed, refetch: refetchMe } = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  useEffect(() => { const f = () => { void refetchMe(); }; addEventListener('wowf-signed-out', f); return () => removeEventListener('wowf-signed-out', f); }, [refetchMe]);
  const signedOut = !!me?.authRequired && !me.username;
  const { data: ov } = useQuery({ queryKey: ['overview'], queryFn: () => api<any>('/api/overview'), refetchInterval: 30_000, enabled: (!!me || meFailed) && !signedOut });
  const counts = new Map<string, number>((ov?.counts ?? []).map((c: any) => [c.detector, c.n]));
  const Page = (SECTIONS.find(s => s.id === page) ?? SECTIONS[0]!).el;
  const groups = [...new Set(SECTIONS.map(s => s.group))];
  if (!me && !meFailed) return null;
  if (signedOut) return <LoginPage onDone={() => { void qc.invalidateQueries(); }} />;
  const signOut = async () => { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); await qc.invalidateQueries(); };
  return (
    <NavContext.Provider value={{ go: p => { location.hash = p; }, openItem: setItem }}>
      <div className="flex min-h-full">
        <nav className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-card/60 px-3 py-5 md:flex">
          <div className="mb-6 flex items-center gap-2 px-2"><img src="/coin.svg" width={26} height={26} alt="" /><span className="font-display text-lg font-bold tracking-wide">Gold Finder</span></div>
          {groups.map(g => (
            <div key={g} className="mb-4">
              <p className="mb-1 px-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{g}</p>
              {SECTIONS.filter(s => s.group === g).map(s => {
                const n = s.count?.reduce((a, d) => a + (counts.get(d) ?? 0), 0);
                return (
                  <a key={s.id} href={`#${s.id}`} className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-sm ${page === s.id ? 'bg-gold/15 font-semibold text-ink' : 'text-muted hover:bg-line/40 hover:text-ink'}`}>
                    {s.label}{n ? <span className="num rounded-full bg-gold/20 px-1.5 text-[11px] font-bold text-gold">{n}</span> : null}
                  </a>
                );
              })}
            </div>
          ))}
          <div className="mt-auto space-y-2 px-2 text-xs text-muted">
            <p>Search anywhere: Ctrl K</p>
            <button onClick={() => setDark(!dark)} className="underline">{dark ? 'Light' : 'Dark'} mode</button>
            {me?.username && <p>Signed in as <b className="text-ink">{me.username}</b>{me.authRequired && <> · <button onClick={signOut} className="underline">Sign out</button></>}</p>}
          </div>
        </nav>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">
          <div className="mb-4 flex gap-2 overflow-x-auto md:hidden">{SECTIONS.map(s => <a key={s.id} href={`#${s.id}`} className={`whitespace-nowrap rounded-full px-3 py-1 text-xs ${page === s.id ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>{s.label}</a>)}</div>
          <div className="mx-auto max-w-5xl"><Page /></div>
          {me?.username && <p className="mt-8 text-center text-xs text-muted md:hidden">Signed in as <b className="text-ink">{me.username}</b>{me.authRequired && <> · <button onClick={signOut} className="underline">Sign out</button></>}</p>}
        </main>
      </div>
      {item != null && <ItemDrawer id={item} onClose={() => setItem(null)} onOpenItem={setItem} />}
    </NavContext.Provider>
  );
}
