import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Play } from '../lib/api';
import { post } from '../lib/api';
import { ago, PLAY_LABEL } from '../lib/format';
import { mapHref, type Place } from '../lib/zones';
import { Money, ItemIcon, ItemName, Chip, Card } from './ui';

interface Leg { kind: 'vendor' | 'auction' | 'any_vendor' | 'held'; price: number; who: string; places: Place[]; note?: string }
interface ListingOption { hours: number; depositEach: number; expectedSold: number | null; expectedProfit: number | null; sellsOut: boolean }

const KIND: Record<Leg['kind'], string> = { vendor: 'Vendor', auction: 'Auction house', any_vendor: 'Any vendor', held: 'Your bags' };

/**
 * One play, readable at a glance: the item, the profit per item, then where to buy and where to sell as bullets.
 * Every location is a link to the map.
 */
export function PlayCard({ p, onOpenItem }: { p: Play; onOpenItem: (id: number) => void }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState('');
  const [askDone, setAskDone] = useState(false);
  const mark = useMutation({
    mutationFn: (b: { status: string; quantity?: number; unitCost?: number }) => post(`/api/plays/${encodeURIComponent(p.key)}/status`, b),
    onSuccess: () => qc.invalidateQueries(),
  });
  const d = p.detail as { price?: { levels: Array<[number, number, number]>; thinTop: boolean; recentSoldPrice: number | null; recentSales: number; soldPrice: number | null; used: string; note: string };
    buy?: Leg; sell?: Leg; perItem?: number; salesPerDay?: number | null; salesHours?: number; available?: number | null; realisticUnits?: number; listing?: { best: number; options: ListingOption[]; quantity: number }; oneOff?: boolean };
  const gone = p.state === 'gone';
  if (!d.buy || !d.sell) return null; // a play from before the new layout; it refreshes on the next publish
  return (
    <Card className={`p-4 ${gone ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-3">
        <button onClick={() => onOpenItem(p.item_id)}><ItemIcon url={p.icon_url} quality={p.quality} size={44} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <button onClick={() => onOpenItem(p.item_id)} className="block truncate text-left text-base hover:underline"><ItemName name={p.item_name} id={p.item_id} quality={p.quality} /></button>
              <p className="text-xs text-muted">{PLAY_LABEL[p.detector]}{p.state === 'new' ? ' · new' : p.state === 'fading' ? ' · fading' : gone ? ' · gone' : ''}</p>
            </div>
            <div className="shrink-0 text-right">
              <div className={(d.perItem ?? 0) >= 0 ? 'text-good' : 'text-bad'}>{(d.perItem ?? 0) >= 0 && <span className="text-lg font-bold">+</span>}<Money c={d.perItem} size="xl" /></div>
              <p className="text-[11px] text-muted">profit per item</p>
            </div>
          </div>

          <ul className="mt-3 space-y-1.5 text-sm">
            <LegRow label="Buy" leg={d.buy} />
            <LegRow label="Sell" leg={d.sell} />
            {d.price && (
              <li className="flex gap-2">
                <span className="w-12 shrink-0 text-xs font-bold uppercase tracking-wide text-muted">Price</span>
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-xs text-muted">listed now</span>
                  {d.price.levels.slice(0, 4).map(([pr, u], i) => (
                    <span key={i} className={i === 0 ? 'font-semibold' : 'text-muted'}><Money c={pr} size="sm" dim={i > 0} /> ×{u.toLocaleString()}</span>
                  ))}
                  {d.price.recentSoldPrice != null && <span><span className="text-xs text-muted">sold last 24h ~</span><Money c={d.price.recentSoldPrice} size="sm" /> <span className="text-xs text-muted">({d.price.recentSales})</span></span>}
                  {d.price.note && <span className="w-full text-xs text-warn">{d.price.note}</span>}
                </span>
              </li>
            )}
            <li className="flex gap-2">
              <span className="w-12 shrink-0 text-xs font-bold uppercase tracking-wide text-muted">Volume</span>
              <span>
                {d.salesPerDay != null ? <><b>~{Math.round(d.salesPerDay).toLocaleString()}</b> sell a day <span className="text-xs text-muted">(from {d.salesHours != null && d.salesHours >= 48 ? `${Math.round(d.salesHours / 24)} days` : `${Math.round(d.salesHours ?? 0)} hours`} of watching)</span></> : p.detector === 'vendor_dump' ? 'Vendors buy any amount' : <span className="text-muted">No sales seen yet</span>}
                {d.available != null && Number.isFinite(d.available) && <span className="text-muted"> · {d.available.toLocaleString()} available at this price</span>}
                <span className="text-muted"> · worth doing <b className="text-ink">{d.realisticUnits}</b>, about </span><Money c={p.profit} size="sm" />
              </span>
            </li>
            {d.listing && (
              <li className="flex gap-2">
                <span className="w-12 shrink-0 text-xs font-bold uppercase tracking-wide text-muted">List</span>
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {d.listing.options.map(o => (
                    <span key={o.hours} className={o.hours === d.listing!.best ? 'font-bold' : 'text-muted'}>
                      {o.hours}h: deposit <Money c={o.depositEach} size="sm" dim={o.hours !== d.listing!.best} /> each{o.expectedSold != null ? `, sells ~${Math.round(o.expectedSold)}` : ''}{o.hours === d.listing!.best ? ' ✓' : ''}
                    </span>
                  ))}
                  {d.listing.options[0]?.expectedSold == null && <span className="text-xs text-muted">sales rate not known yet</span>}
                </span>
              </li>
            )}
          </ul>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/70 pt-2.5">
            <span className="text-xs text-muted">data {ago(p.data_at)}</span>
            <Chip tone={p.confidence === 'high' ? 'good' : p.confidence === 'medium' ? 'gold' : 'warn'}>{p.confidence === 'low' ? 'watch only' : `${p.confidence} confidence`}{typeof (p.detail as { score?: number }).score === 'number' ? ` · ${(p.detail as { score: number }).score}/100` : ''}</Chip>
            {d.oneOff && <Chip tone="warn">one cheap listing, may be a one off</Chip>}
            <span className="ml-auto flex gap-1">
              {!gone && !p.user_status && !askDone && <>
                <button className="rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-page" onClick={() => setAskDone(true)}>Done</button>
                <button className="rounded-md border border-line px-2.5 py-1 text-xs text-muted" onClick={() => mark.mutate({ status: 'skipped' })}>Skip</button>
                <button className="rounded-md border border-line px-2.5 py-1 text-xs text-muted" onClick={() => mark.mutate({ status: 'already_gone' })}>Gone</button>
              </>}
              {askDone && (
                <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); mark.mutate({ status: 'done', quantity: Number(qty) || undefined, unitCost: d.buy!.price }); setAskDone(false); }}>
                  <input autoFocus value={qty} onChange={e => setQty(e.target.value)} placeholder="units bought" className="w-24 rounded-md border border-line bg-page px-2 py-1 text-xs" />
                  <button className="rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-page">Save</button>
                </form>
              )}
              {p.user_status === 'done' && <Chip tone="good">done</Chip>}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function LegRow({ label, leg }: { label: string; leg: Leg }) {
  return (
    <li className="flex gap-2">
      <span className="w-12 shrink-0 text-xs font-bold uppercase tracking-wide text-muted">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{leg.kind === 'auction' ? leg.who : KIND[leg.kind]}</span>
        <Money c={leg.price} size="sm" />
        {leg.kind === 'vendor' && <span>{leg.who}</span>}
        {leg.places.slice(0, 1).map(pl => {
          const href = mapHref(pl);
          const text = `${pl.zone ?? pl.label}${pl.x != null ? ` ${pl.x}, ${pl.y}` : ''}`;
          return href ? <a key={pl.label} href={href} className="text-alliance underline decoration-dotted underline-offset-2 hover:decoration-solid">📍 {text}</a> : <span key={pl.label} className="text-muted">{text}</span>;
        })}
        {leg.places.length > 1 && <span className="text-xs text-muted">also {leg.places.slice(1).map((pl, i) => {
          const href = mapHref(pl);
          return <a key={pl.label} href={href ?? undefined} className="hover:underline">{i ? ', ' : ''}{pl.zone}</a>;
        })}</span>}
        {leg.note && <span className="text-xs text-muted">({leg.note})</span>}
      </span>
    </li>
  );
}
