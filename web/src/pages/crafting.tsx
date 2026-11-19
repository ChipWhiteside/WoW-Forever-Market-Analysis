import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, Fragment } from 'react';
import { api, post, put } from '../lib/api';
import { PageHeader, Card, Money, Chip, Empty, ItemIcon, ItemName } from '../components/ui';
import { useNav } from '../nav';

const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted';
const td = 'px-3 py-2 align-top';

export function CraftingPage() {
  const [tab, setTab] = useState<'level' | 'profit' | 'mats'>('level');
  return (
    <>
      <PageHeader title="Crafting" sub="Your leveling plan, what is profitable to make right now, and the materials you already own." />
      <div className="mb-5 flex gap-2">
        {([['level', 'Leveling plan'], ['profit', 'Profit board'], ['mats', 'My materials']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-full px-4 py-1.5 text-sm ${tab === k ? 'bg-ink font-semibold text-page' : 'border border-line'}`}>{l}</button>
        ))}
      </div>
      {tab === 'level' ? <Leveling /> : tab === 'profit' ? <ProfitBoard /> : <Materials />}
    </>
  );
}

function Leveling() {
  const { openItem } = useNav();
  const [to, setTo] = useState('150');
  const [from, setFrom] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['leveling', from, to], queryFn: () => api<any>(`/api/leveling?profession=Blacksmithing&to=${to}${from ? `&from=${from}` : ''}`), placeholderData: prev => prev });
  if (!data) return <p className="text-muted">Loading…</p>;
  const buying = data.needs.filter((n: any) => n.buy > 0);
  return (
    <>
      <Card className="mb-4 flex flex-wrap items-center gap-3 p-4 text-sm">
        <span className="font-semibold">Blacksmithing</span>
        <label className="flex items-center gap-2">from <input value={from ?? String(data.current)} onChange={e => setFrom(e.target.value)} className="w-16 rounded border border-line bg-page px-2 py-1" /></label>
        <label className="flex items-center gap-2">to <input value={to} onChange={e => setTo(e.target.value)} className="w-16 rounded border border-line bg-page px-2 py-1" /></label>
        <span className="text-muted">Your skill comes from Settings. Owned materials are free.</span>
        <span className="ml-auto">Still to buy: {data.partial ? 'at least ' : ''}<Money c={data.totalBuyCost} /></span>
      </Card>
      {data.partial && <Card className="mb-4 border-warn/40 bg-warn/5 p-3 text-sm">
        <p className="font-semibold">Some prices are not available yet, so the total leaves them out.</p>
        <p className="text-xs text-muted">{[...new Set(data.partialWhy as string[])].length} items: {[...new Set((data.partialWhy as string[]).map(w => w.replace(/^no price or source for \d+ /, '').replace(/ is not loaded yet$/, '').replace(/ \(.*$/, '')))].join(', ')}. They fill in once they are listed or the recipes load.</p>
      </Card>}
      {data.sellInstead.length > 0 && (
        <Card className="mb-4 border-good/40 bg-good/5 p-4 text-sm">
          <p className="mb-1 font-semibold">Sell these instead of using them</p>
          {data.sellInstead.map((s: any) => <p key={s.itemId}>Your {s.units} {s.name} sell for <Money c={s.saleValue} size="sm" />; buying {s.replacement} costs <Money c={s.replacementCost} size="sm" />. Saves <Money c={s.saves} size="sm" />.</p>)}
        </Card>
      )}
      <Card className="mb-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line"><tr><th className={th}>Skill</th><th className={th}>Make</th><th className={th}>Crafts</th><th className={th}>Each craft takes</th><th className={th}>Colors</th></tr></thead>
          <tbody>{data.steps.map((s: any, i: number) => (
            <tr key={i} className="border-b border-line/60">
              <td className={`${td} num whitespace-nowrap font-semibold`}>{s.from} to {s.to}</td>
              <td className={td}><span className="font-semibold">{s.recipe}</span>{!s.found && <Chip tone="warn">not loaded</Chip>}
                {s.alt && <div className="text-xs text-muted">{s.alt.cheaper ? `Cheaper than the guide's ${s.alt.recipe} at today's prices` : `Or ${s.alt.recipe}${s.alt.crafts ? `, ${s.alt.crafts} crafts` : ''}`}</div>}
                {s.note && <div className="text-xs text-muted">{s.note}</div>}</td>
              <td className={`${td} num`}>{s.crafts ?? '?'}</td>
              <td className={`${td} text-xs`}>{s.reagents.map((r: any) => <button key={r.itemId} onClick={() => openItem(r.itemId)} className="mr-2 hover:underline">{r.perCraft} {r.name}</button>)}</td>
              <td className={`${td} num text-xs text-muted`}>{s.colors.yellow != null ? `yellow ${s.colors.yellow}, green ${s.colors.green}, grey ${s.colors.grey}` : ''}</td>
            </tr>))}</tbody>
        </table>
      </Card>
      <h3 className="mb-2 font-display text-sm font-bold text-gold">Materials for this range</h3>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line"><tr><th className={th}>Material</th><th className={th}>Need</th><th className={th}>From your bags</th><th className={th}>Made from your bags</th><th className={th}>To buy</th><th className={th}>Cheapest way</th><th className={th}>Cost</th></tr></thead>
          <tbody>{data.needs.map((n: any) => (
            <tr key={n.itemId} className="border-b border-line/60">
              <td className={td}><button onClick={() => openItem(n.itemId)} className="font-semibold hover:underline">{n.name}</button></td>
              <td className={`${td} num`}>{n.need}</td><td className={`${td} num text-good`}>{n.fromBags || ''}</td><td className={`${td} num text-good`}>{n.craftedFromBags || ''}</td>
              <td className={`${td} num font-semibold`}>{n.buy || ''}</td><td className={`${td} text-xs text-muted`}>{n.buy ? n.source : ''}</td>
              <td className={td}>{n.buy ? <Money c={n.buyCost} size="sm" /> : <span className="text-xs text-good">covered</span>}</td>
            </tr>))}</tbody>
        </table>
      </Card>
      {buying.length === 0 && <p className="mt-3 text-sm text-good">Everything for this range is covered by what you own.</p>}
      <p className="mt-4 text-xs text-muted">Full written plan with every correction to the guide: docs/blacksmithing-plan.md.</p>
    </>
  );
}

function ProfitBoard() {
  const { openItem } = useNav();
  const [prof, setProf] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const { data } = useQuery({ queryKey: ['crafting', prof], queryFn: () => api<any>(`/api/crafting${prof ? `?profession=${encodeURIComponent(prof)}` : ''}`) });
  const rows: any[] = data?.rows ?? [];
  return (
    <>
      <p className="mb-3 text-sm text-muted">Every number is per single item. Ingredients at the cheapest of the auction house, a vendor, or making them yourself, priced on {data?.house ?? 'your house'}.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setProf('')} className={`rounded-full px-3 py-1 text-xs ${!prof ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>All</button>
        {(data?.profs ?? []).map((p: any) => <button key={p.profession} onClick={() => setProf(p.profession)} className={`rounded-full px-3 py-1 text-xs ${prof === p.profession ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>{p.profession}</button>)}
      </div>
      {rows.length === 0 ? <Empty title="No recipes loaded yet">Recipes load with the daily data refresh.</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line"><tr><th className={th}>Item</th><th className={th}>Costs each</th><th className={th}>Sells each</th><th className={th}>Profit each</th><th className={th}>Sell a day</th><th className={th}>List for</th></tr></thead>
            <tbody>{rows.slice(0, 200).map(r => (
              <Fragment key={r.recipeId}>
                <tr className="cursor-pointer border-b border-line/60 hover:bg-line/20" onClick={() => setOpen(open === r.recipeId ? null : r.recipeId)}>
                  <td className={td}><button className="font-semibold hover:underline" onClick={e => { e.stopPropagation(); openItem(r.productId); }}>{r.productName}</button><div className="text-xs text-muted">{r.profession}{r.bop ? ' · binds on pickup' : ''}</div></td>
                  <td className={td}>{r.each.cost != null ? <Money c={r.each.cost} size="sm" /> : <span className="text-xs text-warn">{r.blocked ?? 'an ingredient has no price yet'}</span>}</td>
                  <td className={td}><Money c={r.each.sale} size="sm" /><div className="text-[11px] text-muted">{r.productFloor == null ? 'what a vendor pays, not listed' : 'trusted auction price'}</div></td>
                  <td className={td}>{r.each.profit != null ? <span className={`font-bold ${r.each.profit > 0 ? 'text-good' : 'text-bad'}`}><Money c={r.each.profit} size="sm" /></span> : <span className="text-xs text-muted">unknown until every ingredient has a price</span>}</td>
                  <td className={`${td} num`}>{r.salesPerDay != null ? Math.round(r.salesPerDay) : <span className="text-xs text-muted">learning</span>}</td>
                  <td className={`${td} text-xs`}>{r.listing ? r.listing.options.map((o: any) => <span key={o.hours} className={`mr-2 ${o.hours === r.listing.best ? 'font-bold' : 'text-muted'}`}>{o.hours}h <Money c={o.depositEach} size="sm" dim={o.hours !== r.listing.best} /></span>) : ''}</td>
                </tr>
                {open === r.recipeId && <tr><td colSpan={6} className="bg-page px-6 py-3 text-xs text-muted">{r.sources}{r.listing ? <p className="mt-1">{r.listing.why}</p> : null}</td></tr>}
              </Fragment>
            ))}</tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Materials() {
  const qc = useQueryClient();
  const { openItem } = useNav();
  const [text, setText] = useState('');
  const { data } = useQuery({ queryKey: ['inventory'], queryFn: () => api<any[]>('/api/inventory') });
  const paste = useMutation({ mutationFn: () => post<{ added: string[]; unknown: string[] }>('/api/inventory/paste', { text }), onSuccess: () => { qc.invalidateQueries(); } });
  const set = useMutation({ mutationFn: (b: { itemId: number; count: number }) => put('/api/inventory', b), onSuccess: () => qc.invalidateQueries() });
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="p-4">
        <p className="mb-2 text-sm font-semibold">Paste what you have</p>
        <p className="mb-2 text-xs text-muted">One per line, any of: Copper Ore 400 · 400 Copper Ore · Rough Stone: 1,200</p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={10} className="w-full rounded-lg border border-line bg-page p-2 font-mono text-xs" placeholder={'Copper Ore 400\nTin Ore 120\nRough Stone 600\nCoarse Stone 300'} />
        <button onClick={() => paste.mutate()} disabled={!text.trim()} className="mt-2 rounded-md bg-ink px-4 py-1.5 text-sm font-semibold text-page disabled:opacity-40">Save</button>
        {paste.data && <p className="mt-2 text-xs">{paste.data.added.length ? <span className="text-good">Saved {paste.data.added.length}. </span> : null}{paste.data.unknown.length ? <span className="text-warn">Not recognized: {paste.data.unknown.join(', ')}. Use the exact in game name.</span> : null}</p>}
      </Card>
      <Card className="p-4">
        <p className="mb-2 text-sm font-semibold">Your materials</p>
        {(data ?? []).length === 0 ? <p className="text-sm text-muted">Nothing saved yet.</p> : (data ?? []).map((m: any) => (
          <div key={m.item_id} className="flex items-center gap-2 py-1 text-sm">
            <ItemIcon url={m.icon_url} quality={m.quality} size={22} />
            <button onClick={() => openItem(m.item_id)} className="flex-1 text-left hover:underline"><ItemName name={m.name} id={m.item_id} quality={m.quality} /></button>
            <input defaultValue={m.count} onBlur={e => { const v = Number(e.target.value.replace(/,/g, '')); if (Number.isFinite(v) && v !== m.count) set.mutate({ itemId: m.item_id, count: v }); else e.target.value = String(m.count); }} className="w-20 rounded border border-line bg-page px-2 py-0.5 text-right text-xs" />
          </div>
        ))}
      </Card>
    </div>
  );
}
