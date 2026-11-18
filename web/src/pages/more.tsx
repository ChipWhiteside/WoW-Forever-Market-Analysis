import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, post } from '../lib/api';
import { ago } from '../lib/format';
import { PageHeader, Card, Money, Chip, ItemIcon, ItemName, Empty } from '../components/ui';
import { PlayList } from './plays';
import { useNav } from '../nav';

const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted';
const td = 'px-3 py-2 align-top';

export function CraftingPage() {
  const { openItem } = useNav();
  const [prof, setProf] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const { data } = useQuery({ queryKey: ['crafting', prof], queryFn: () => api<any>(`/api/crafting${prof ? `?profession=${encodeURIComponent(prof)}` : ''}`) });
  const rows: any[] = data?.rows ?? [];
  return (
    <>
      <PageHeader title="Crafting" sub={<>Make or buy for every recipe: each ingredient at the cheapest of the auction house, an Alliance usable vendor, or crafting it yourself. Margin is after the cut, priced on {data?.house ?? 'your house'}. Your own gathered materials count at what you could sell them for.</>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setProf('')} className={`rounded-full px-3 py-1 text-xs ${!prof ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>All</button>
        {(data?.profs ?? []).map((p: any) => <button key={p.profession} onClick={() => setProf(p.profession)} className={`rounded-full px-3 py-1 text-xs ${prof === p.profession ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>{p.profession} <span className="text-muted">{p.n}</span></button>)}
      </div>
      {!data?.professions && <p className="mb-3 text-xs text-muted">Add your professions in Settings (for example {'{"Blacksmithing": 75, "Mining": 90}'}) to see skill up odds and cost per point.</p>}
      {rows.length === 0 ? <Empty title="No recipes loaded yet">Recipes load with the daily data refresh once the Blizzard connection works.</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line"><tr><th className={th}>Recipe</th><th className={th}>Cost</th><th className={th}>Sells for</th><th className={th}>Margin</th><th className={th}>Skill</th><th className={th}>Ingredients</th></tr></thead>
            <tbody>
              {rows.slice(0, 200).map(r => (
                <>
                  <tr key={r.recipeId} className="cursor-pointer border-b border-line/60 hover:bg-line/20" onClick={() => setOpen(open === r.recipeId ? null : r.recipeId)}>
                    <td className={td}><button className="font-semibold hover:underline" onClick={e => { e.stopPropagation(); openItem(r.productId); }}>{r.name}</button><div className="text-xs text-muted">{r.profession}{r.bop ? ' · binds on pickup, vendor value only' : ''}</div></td>
                    <td className={td}>{r.cost != null ? <Money c={r.cost} size="sm" /> : <Chip tone="bad">blocked</Chip>}</td>
                    <td className={td}><Money c={r.sale} size="sm" />{r.productFloor == null && <div className="text-[11px] text-muted">not listed, vendor price</div>}</td>
                    <td className={td}>{r.margin != null ? <span className={r.margin > 0 ? 'text-good' : 'text-bad'}><Money c={r.margin} size="sm" /></span> : '—'}{r.marginPct != null && <div className="text-[11px] text-muted">{Math.round(r.marginPct * 100)}%</div>}</td>
                    <td className={`${td} text-xs text-muted`}>{r.thresholds.yellow != null ? `${r.thresholds.learn ?? '?'} · ${r.thresholds.yellow} · ${r.thresholds.green} · ${r.thresholds.grey}` : 'no threshold row'}{r.skillUp != null && <div>{Math.round(r.skillUp * 100)}% skill up{r.costPerPoint ? <>, <Money c={r.costPerPoint} size="sm" /> a point</> : null}</div>}</td>
                    <td className={`${td} text-xs text-muted`}>{r.blocked ?? r.sources}</td>
                  </tr>
                  {open === r.recipeId && <tr key={`${r.recipeId}-t`}><td colSpan={6} className="bg-page px-6 py-3"><Tree id={r.recipeId} /></td></tr>}
                </>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Tree({ id }: { id: number }) {
  const { openItem } = useNav();
  const { data } = useQuery({ queryKey: ['craft', id], queryFn: () => api<any>(`/api/crafting/${id}`) });
  if (!data?.tree) return <p className="text-xs text-muted">Loading…</p>;
  const render = (nodes: any[], depth = 0): JSX.Element => (
    <div className={depth ? 'ml-5 border-l border-line pl-3' : ''}>
      {nodes.map((n: any) => (
        <div key={n.itemId} className="py-0.5 text-xs">
          <button className="font-semibold hover:underline" onClick={() => openItem(n.itemId)}>{n.quantity}× {n.name}</button>{' '}
          <Chip tone={n.source === 'none' ? 'bad' : n.source === 'craft' ? 'gold' : 'muted'}>{n.source === 'auction' ? 'buy on auction' : n.source === 'vendor' ? 'buy from vendor' : n.source === 'craft' ? 'craft it' : 'no source'}</Chip>{' '}
          {n.unitCost != null && <><Money c={n.unitCost} size="sm" /> each</>} <span className="text-muted">{n.detail}</span>
          {n.alternatives.filter((a: any) => a.source !== n.source).map((a: any) => <span key={a.source} className="ml-2 text-muted">· {a.source} <Money c={a.unitCost} size="sm" dim /></span>)}
          {n.children && render(n.children, depth + 1)}
        </div>
      ))}
    </div>
  );
  return render(data.tree);
}

export function DropsPage() {
  const { openItem } = useNav();
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [kind, setKind] = useState('');
  const [thin, setThin] = useState(false);
  const { data } = useQuery({ queryKey: ['drops', min, max, kind, thin], queryFn: () => api<any>(`/api/drops?min=${min}&max=${max}&kind=${kind}${thin ? '&thin=1' : ''}`) });
  const rows: any[] = data?.rows ?? [];
  return (
    <>
      <PageHeader title="World drops" sub="Where to spend an hour. Every source ranked by value per kill: each sellable drop times how many drop per kill times its value now. Rates come from players' recorded WoW Forever kills, and the kill count is always shown." />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <input value={min} onChange={e => setMin(e.target.value)} placeholder="min level" className="w-24 rounded-lg border border-line bg-card px-2 py-1" />
        <input value={max} onChange={e => setMax(e.target.value)} placeholder="max level" className="w-24 rounded-lg border border-line bg-card px-2 py-1" />
        {[['', 'All'], ['npc', 'Enemies'], ['fishing', 'Fishing'], ['item', 'Containers'], ['object', 'Nodes']].map(([k, l]) => <button key={k} onClick={() => setKind(k!)} className={`rounded-full px-3 py-1 text-xs ${kind === k ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>{l}</button>)}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={thin} onChange={e => setThin(e.target.checked)} /> include sources under 10 recorded kills</label>
      </div>
      {rows.length === 0 ? <Empty title="No loot data yet">Loot data loads with the daily EG Link refresh.</Empty> : (
        <div className="grid gap-3">
          {rows.slice(0, 80).map(r => (
            <Card key={`${r.kind}:${r.sourceId}`} className="p-4">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <Money c={r.goldPerHour ?? r.valuePerKill} size="lg" /><span className="text-xs text-muted">{r.goldPerHour ? 'an hour' : r.kind === 'item' ? 'per open' : 'per kill'}</span>
                <span className="font-semibold">{r.name}</span>
                <span className="text-xs text-muted">{[r.zone, r.minLevel ? `level ${r.minLevel}${r.maxLevel !== r.minLevel ? `-${r.maxLevel}` : ''}` : null, r.classification].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs">
                <span><Money c={r.valuePerKill} size="sm" /> {r.kind === 'item' ? 'per open' : r.kind === 'fishing' ? 'per catch' : r.kind === 'object' ? 'per node' : r.kind.includes('spell') ? 'per skin' : 'per kill'}</span>
                <Chip tone={r.rough ? 'warn' : 'good'}>{r.kills} {r.kind === 'npc' ? 'kills' : r.kind === 'object' ? 'nodes' : 'loots'} recorded{r.rough ? ', rough' : ''}</Chip>
                <Chip>{r.perHourBasis}</Chip>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {r.top.map((t: any) => <button key={t.itemId} onClick={() => openItem(t.itemId)} className="hover:underline">{t.name} <span className="text-muted">{t.perKill.toFixed(2)} each, {t.how}</span> <Money c={t.value} size="sm" dim /></button>)}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

export function FarmingPage() {
  const qc = useQueryClient();
  const [activity, setActivity] = useState('');
  const [ending, setEnding] = useState<number | null>(null);
  const [itemsText, setItemsText] = useState('');
  const { data } = useQuery({ queryKey: ['farming'], queryFn: () => api<any[]>('/api/farming'), refetchInterval: 30_000 });
  const start = useMutation({ mutationFn: () => post('/api/farming/start', { activity }), onSuccess: () => { setActivity(''); qc.invalidateQueries({ queryKey: ['farming'] }); } });
  const end = useMutation({
    mutationFn: (id: number) => post(`/api/farming/${id}/end`, { items: itemsText.split(/[\n,]/).map(s => s.trim()).filter(Boolean).map(s => { const [a, b] = s.split(/[x\s]+/); return { itemId: Number(a), count: Number(b) }; }).filter(x => x.itemId && x.count) }),
    onSuccess: () => { setEnding(null); setItemsText(''); qc.invalidateQueries({ queryKey: ['farming'] }); },
  });
  return (
    <>
      <PageHeader title="Farming" sub="Gold an hour you actually measured, at today's prices. Start a timer, play, end it with what you gathered. Measured rates replace estimates in World drops." />
      <Card className="mb-5 flex gap-2 p-3"><input value={activity} onChange={e => setActivity(e.target.value)} placeholder="What are you farming? e.g. Trunk fishing, Booty Bay docks" className="flex-1 rounded-lg border border-line bg-page px-3 py-2 text-sm" />
        <button disabled={!activity} onClick={() => start.mutate()} className="rounded-md bg-ink px-4 text-sm font-semibold text-page disabled:opacity-40">Start</button></Card>
      {(data ?? []).length === 0 ? <Empty title="No sessions yet" /> : (data ?? []).map(s => (
        <Card key={s.id} className="mb-3 p-4">
          <div className="flex flex-wrap items-baseline gap-3"><span className="font-semibold">{s.activity}</span><span className="text-xs text-muted">{new Date(s.started_at).toLocaleString()} · {s.hours.toFixed(2)} h</span>
            {s.goldPerHour != null ? <span className="ml-auto"><Money c={s.goldPerHour} size="lg" /> <span className="text-xs text-muted">an hour</span></span> : <Chip tone="gold">running</Chip>}</div>
          {s.items.length > 0 && <p className="mt-1 text-xs text-muted">{s.items.map((i: any) => `${i.count} ${i.name} (${i.perHour.toFixed(0)}/h)`).join(', ')}</p>}
          {!s.ended_at && (ending === s.id ? (
            <div className="mt-2 flex gap-2"><input value={itemsText} onChange={e => setItemsText(e.target.value)} placeholder="item id and count, e.g. 2770 x 20, 2835 x 14" className="flex-1 rounded-lg border border-line bg-page px-3 py-1.5 text-sm" /><button onClick={() => end.mutate(s.id)} className="rounded-md bg-ink px-3 text-xs font-semibold text-page">End</button></div>
          ) : <button onClick={() => setEnding(s.id)} className="mt-2 rounded-md border border-line px-3 py-1 text-xs">End session</button>)}
        </Card>
      ))}
    </>
  );
}

export function PositionsPage() {
  const { openItem } = useNav();
  const { data } = useQuery({ queryKey: ['positions'], queryFn: () => api<any>('/api/positions'), refetchInterval: 60_000 });
  return (
    <>
      <PageHeader title="Positions" sub="What you bought, what it cost, what it is worth now. Done on a play opens one here. The companion addon will fill this in by itself later." />
      {data && (
        <div className="mb-5 grid grid-cols-3 gap-3">
          <Card className="px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted">Available gold</p><Money c={data.available} size="lg" /></Card>
          <Card className="px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted">Tied up</p><Money c={data.tied} size="lg" /></Card>
          <Card className="px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted">Realized</p><Money c={data.realized} size="lg" /></Card>
        </div>
      )}
      {!data?.rows?.length ? <Empty title="No positions">Mark a play Done to open one. Set your starting gold in Settings.</Empty> : data.rows.map((p: any) => (
        <Card key={p.id} className={`mb-2 flex items-center gap-3 p-3 ${p.closed_at ? 'opacity-60' : ''}`}>
          <button onClick={() => openItem(p.item_id)}><ItemIcon url={p.icon_url} quality={p.quality} size={32} /></button>
          <div className="flex-1"><ItemName name={p.name} id={p.item_id} quality={p.quality} /><p className="text-xs text-muted">{p.held} held of {p.quantity} at <Money c={p.unit_cost} size="sm" /> · opened {ago(p.opened_at)}</p></div>
          <div className="text-right"><Money c={p.worthNow} /><p className="text-[11px] text-muted">worth now, {p.how}</p></div>
        </Card>
      ))}
    </>
  );
}

export function WatchlistPage() {
  const { openItem } = useNav();
  const qc = useQueryClient();
  const [id, setId] = useState(''); const [above, setAbove] = useState('');
  const { data } = useQuery({ queryKey: ['watchlist'], queryFn: () => api<any[]>('/api/watchlist'), refetchInterval: 60_000 });
  const add = useMutation({ mutationFn: () => post('/api/watchlist', { itemId: Number(id), alertAbove: above ? Number(above) : null }), onSuccess: () => { setId(''); setAbove(''); qc.invalidateQueries({ queryKey: ['watchlist'] }); } });
  return (
    <>
      <PageHeader title="Watchlist" sub="Pinned items. When one jumps 50 percent over its typical floor, or past a price you set, it shows as Sell now." />
      <Card className="mb-4 flex gap-2 p-3"><input value={id} onChange={e => setId(e.target.value)} placeholder="item id" className="w-32 rounded-lg border border-line bg-page px-3 py-2 text-sm" /><input value={above} onChange={e => setAbove(e.target.value)} placeholder="alert above, copper (optional)" className="flex-1 rounded-lg border border-line bg-page px-3 py-2 text-sm" /><button disabled={!id} onClick={() => add.mutate()} className="rounded-md bg-ink px-4 text-sm font-semibold text-page disabled:opacity-40">Add</button></Card>
      {(data ?? []).map(w => (
        <Card key={w.item_id} className="mb-2 flex items-center gap-3 p-3">
          <button onClick={() => openItem(w.item_id)}><ItemIcon url={w.icon_url} quality={w.quality} size={32} /></button>
          <div className="flex-1"><ItemName name={w.name} id={w.item_id} quality={w.quality} />{w.alert_above && <p className="text-xs text-muted">alert above <Money c={w.alert_above} size="sm" /></p>}</div>
          <div className="text-right"><Money c={w.floor} /><p className="text-[11px] text-muted">{w.units} listed</p></div>
        </Card>
      ))}
      <div className="mt-6"><PlayList detectors={['sell_now']} emptyTitle="Nothing to sell into right now" emptyText="Sell now plays need a typical floor, which takes 24 hourly readings, or a price you set." /></div>
    </>
  );
}

export function MarketPage() {
  const { openItem } = useNav();
  const { data } = useQuery({ queryKey: ['market'], queryFn: () => api<any>('/api/market'), refetchInterval: 5 * 60_000 });
  if (!data?.totals) return <><PageHeader title="Market" /><Empty title="No market data yet">The weekly read fills in as soon as the first snapshot lands.</Empty></>;
  const Row = ({ r, extra }: { r: any; extra?: React.ReactNode }) => (
    <button onClick={() => openItem(r.item_id)} className="flex w-full items-center gap-2 py-1 text-left text-sm hover:bg-line/20">
      <ItemIcon url={r.icon_url} quality={r.quality} size={22} /><span className="flex-1 truncate">{r.name ?? `Item ${r.item_id}`}</span>{extra}
    </button>
  );
  return (
    <>
      <PageHeader title="Market" sub={<>{data.house.name} {data.house.id}. Built from {data.historyDays} days of history. Listings only, never sales. Insight, never alerts.</>} />
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Card className="px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted">Listed value</p><Money c={data.totals.value} size="lg" /></Card>
        <Card className="px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted">Items listed</p><p className="num text-lg font-semibold">{data.totals.items.toLocaleString()}</p></Card>
        <Card className="px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted">Units</p><p className="num text-lg font-semibold">{data.totals.units.toLocaleString()}</p></Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4"><h3 className="mb-2 font-display text-sm font-bold text-gold">Category share</h3>
          {data.categories.slice(0, 10).map((c: any) => <div key={c.name} className="flex items-center gap-2 py-0.5 text-sm"><span className="w-32 truncate">{c.name}</span><span className="h-2 rounded-full bg-gold/60" style={{ width: `${Math.max(2, c.share * 220)}px` }} /><span className="num text-xs text-muted">{Math.round(c.share * 100)}%</span></div>)}
        </Card>
        <Card className="p-4"><h3 className="mb-2 font-display text-sm font-bold text-gold">Top by value</h3>{data.topByValue.slice(0, 12).map((r: any) => <Row key={r.item_id} r={r} extra={<Money c={r.value} size="sm" />} />)}</Card>
        <Card className="p-4"><h3 className="mb-2 font-display text-sm font-bold text-gold">Risers {data.historyDays < 7 ? `(since ${new Date(data.comparedFrom).toLocaleDateString()}, a week is not in yet)` : 'this week'}</h3>{data.risers.map((r: any) => <Row key={r.item_id} r={r} extra={<span className="num text-xs text-good">+{Math.round(r.change * 100)}%</span>} />)}</Card>
        <Card className="p-4"><h3 className="mb-2 font-display text-sm font-bold text-gold">Fallers</h3>{data.fallers.map((r: any) => <Row key={r.item_id} r={r} extra={<span className="num text-xs text-bad">{Math.round(r.change * 100)}%</span>} />)}</Card>
        <Card className="p-4"><h3 className="mb-2 font-display text-sm font-bold text-gold">Most units listed</h3>{data.topByUnits.slice(0, 12).map((r: any) => <Row key={r.item_id} r={r} extra={<span className="num text-xs text-muted">{r.total_units.toLocaleString()}</span>} />)}</Card>
      </div>
    </>
  );
}
