import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { api, post, put, type Health } from '../lib/api';
import { ago } from '../lib/format';
import { PageHeader, Card, Money, HouseBadge, Chip, ItemIcon, ItemName, Empty } from '../components/ui';
import { useNav } from '../nav';

export function LookupPage() {
  const { openItem } = useNav();
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['search', q], queryFn: () => api<any[]>(`/api/items/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  return (
    <>
      <PageHeader title="Item lookup" sub="Search anything. Floor and ladder on both houses, history, vendors with faction, recipes, and every source that drops it." />
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Copper Ore, Bright Baubles, 2589…" className="mb-4 w-full rounded-xl border border-line bg-card px-4 py-3 text-base shadow-card outline-none focus:border-gold" />
      <div className="grid gap-2">
        {(data ?? []).map((it: any) => (
          <button key={it.id} onClick={() => openItem(it.id)} className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-left hover:border-gold/50">
            <ItemIcon url={it.icon_url} quality={it.quality} size={28} /><ItemName name={it.name} id={it.id} quality={it.quality} /><span className="ml-auto text-xs text-muted">{it.id}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: houses } = useQuery({ queryKey: ['houses'], queryFn: () => api<any[]>('/api/houses'), refetchInterval: 60_000 });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api<Record<string, string>>('/api/settings') });
  const pin = useMutation({ mutationFn: (b: { alliance?: number | null; blackwater?: number | null }) => post('/api/houses/pin', b), onSuccess: () => qc.invalidateQueries() });
  const save = useMutation({ mutationFn: (b: Record<string, string | number>) => put('/api/settings', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => { if (settings) setForm({ profit_bar: '2500', quiet_start: '23', quiet_end: '7', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, character: '', home_city: 'Stormwind', ...settings }); }, [settings]);
  const field = (k: string, label: string, hint?: string) => (
    <label className="block text-sm"><span className="font-semibold">{label}</span>{hint && <span className="ml-2 text-xs text-muted">{hint}</span>}
      <input value={form[k] ?? ''} onChange={e => setForm({ ...form, [k]: e.target.value })} className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2" /></label>
  );
  return (
    <>
      <PageHeader title="Settings" />
      <h2 className="mb-2 font-display text-lg font-bold">House finder</h2>
      <p className="mb-3 max-w-2xl text-sm text-muted">In game, search Copper Ore and Linen Cloth at a capital auction house and note the lowest price per unit. Do the same at Booty Bay. Pick the house whose numbers match. Every candidate has been recording since the engine started, so no history is lost whichever you pick.</p>
      {(['alliance', 'blackwater'] as const).map(f => (
        <div key={f} className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(houses ?? []).filter(h => h.faction === f).map(h => (
            <Card key={h.id} className={`p-4 ${h.pinned ? 'ring-2 ring-gold' : ''}`}>
              <div className="mb-2 flex items-center justify-between"><HouseBadge faction={f} /><span className="text-xs text-muted">house {h.id} · {h.rows ? `${h.rows.toLocaleString()} listings` : 'no data yet'}</span></div>
              {h.markers.map((m: any) => (
                <div key={m.id} className="flex justify-between py-0.5 text-sm"><span>{m.name}</span><span>{m.floor != null ? <Money c={m.floor} size="sm" /> : <span className="text-muted">not listed</span>}</span></div>
              ))}
              <button onClick={() => pin.mutate({ [f]: h.pinned ? null : h.id })} className={`mt-3 w-full rounded-md px-3 py-1.5 text-xs font-semibold ${h.pinned ? 'bg-gold text-page' : 'border border-line hover:bg-line/40'}`}>{h.pinned ? 'This is mine' : 'This one is mine'}</button>
            </Card>
          ))}
        </div>
      ))}
      <h2 className="mb-2 mt-8 font-display text-lg font-bold">Alerts and you</h2>
      <Card className="grid max-w-2xl gap-4 p-5 md:grid-cols-2">
        {field('profit_bar', 'Profit bar, copper', '2500 = 25 silver')}
        {field('time_zone', 'Time zone')}
        {field('quiet_start', 'Quiet from (hour)')}
        {field('quiet_end', 'Quiet until (hour)')}
        {field('character', 'Character name', 'for professions and reputation')}
        {field('home_city', 'Home city', 'trip times start here')}
        <button onClick={() => save.mutate(form)} className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-page md:col-span-2">{save.isSuccess ? 'Saved' : 'Save'}</button>
      </Card>
      <p className="mt-8 text-xs text-muted">Vendor, loot and item name data from <a className="underline" href="https://efficient.games">Efficient Games</a>, licensed under CC BY 4.0, merged across builds. Recipe skill thresholds from the game's SkillLineAbility table via wago.tools. Auction and item data from the Blizzard API.</p>
    </>
  );
}

export function HealthPage() {
  const { data } = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/api/health'), refetchInterval: 30_000 });
  const { data: ov } = useQuery({ queryKey: ['overview'], queryFn: () => api<any>('/api/overview') });
  if (!data) return null;
  return (
    <>
      <PageHeader title="Health" sub="Blizzard publishes each house about once an hour. Any hour the engine misses is gone from history for good, so gaps show here." />
      <Card className="mb-5 p-4 text-sm">{data.message}</Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {data.houses.map(h => (
          <Card key={h.id} className="p-4">
            <div className="flex items-center justify-between"><span className="font-semibold">{h.name.replace(' Auction House', '')} {h.id}</span><Chip tone={h.status === 'ok' ? 'good' : h.status === 'late' ? 'warn' : 'bad'}>{h.status}</Chip></div>
            <p className="mt-1 text-sm text-muted">last publish {ago(h.lastPublish)}</p>
            {h.lastError && <p className="mt-1 text-xs text-bad">{h.lastError}</p>}
          </Card>
        ))}
      </div>
      {ov && (
        <Card className="mt-5 p-4 text-sm">
          <p><span className="font-semibold">{ov.totals?.snapshots ?? 0}</span> snapshots since {ov.totals?.first ? new Date(ov.totals.first).toLocaleString() : 'never'}.</p>
          <p className="mt-1">{ov.items?.named ?? 0} of {ov.items?.n ?? 0} items named, {ov.items?.blizzard ?? 0} from Blizzard.</p>
          {(ov.datasets ?? []).map((d: any) => <p key={d.name} className="mt-1 text-muted">{d.name}: {d.version}, {d.records} records, refreshed {ago(d.fetched_at)}. {d.note}</p>)}
          {ov.learning?.map((l: any) => <p key={l.house} className="mt-1">House {l.house}: {Math.min(l.readings, 24)} of 24 hourly readings for typical floors{l.readings >= 24 ? ', learned' : ''}.</p>)}
        </Card>
      )}
    </>
  );
}

export function ChangelogPage() {
  const { data } = useQuery({ queryKey: ['changelog'], queryFn: () => api<{ markdown: string }>('/api/changelog') });
  return (
    <>
      <PageHeader title="Changelog" sub="What the overnight loop changed, reverted or wants you to look at." />
      {!data?.markdown ? <Empty title="No changes yet" /> : <Card className="whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed">{data.markdown}</Card>}
    </>
  );
}
