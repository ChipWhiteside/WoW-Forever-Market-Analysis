import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { mapHref, type Place } from '../lib/zones';
import { useNav } from '../nav';
import { Money, ItemIcon, ItemName, Chip, Card, PageHeader, Empty } from '../components/ui';

/** Mirrors src/flips/types.ts. Money in copper. */
interface Risk { atStake: number; badCaseLoss: number; daysToSell: number | null; level: 'low' | 'medium' | 'high'; drivers: string[] }
interface Option { label: 'small' | 'best' | 'most'; units: number; cost: number; expectedSold: number; expectedProfit: number; minutes: number; goldPerHour: number | null; risk: Risk }
interface Leg { kind: 'auction' | 'vendor' | 'any_vendor' | 'craft'; itemId: number; name: string; units: number; unitPrice: number; who: string; houseId?: number; places: Place[]; note?: string }
interface Quote { claimPrice: number; netEach: number; listed: number | null; basis: string; ahead: number; salesPerDayLow: number | null; salesPerDayMid: number | null; hoursWatched: number; newPerHour: number; sweepHigh: number | null; strength: number; strengthParts: Array<{ label: string; points: number; max: number }>; rising: boolean }
interface FlipDetail {
  key: string; kind: 'craft' | 'flip'; family: string; itemId: number; name: string; recipeId?: number; recipeName?: string; profession?: string; sellHouseId: number | null;
  buy: Leg[]; sell: Leg; perItem: number; best: Option; options: Option[]; sellQuote: Quote; repeatable: boolean; opening: 'new' | 'rising' | null; openHours72: number;
  setup?: { skill: string; rank: number | null; cost: number | null; where: string | null; places: Place[]; unknown?: boolean } | null; shares: string[]; afterShared?: { units: number; expectedProfit: number }; notes: string[]; dataAt: number;
}
interface Row { key: string; kind: 'craft' | 'flip'; family: string; house_id: number | null; item_id: number; state: string; rank: number | null; expected_profit: number; risk: string; detail: FlipDetail; icon_url: string | null; quality: string | null; house_name: string | null; faction: string | null; data_at: number }
interface Resp { flips: Row[]; run: { at: number; data_at: number; ms: number; complete: boolean; report: { items: number; recipesTried: number; flips: number; incompleteReason?: string; heldBackByReason: Record<string, number>; suspects: string[] } } | null; heldBack: Array<{ key: string; family: string; itemId: number; name: string; perItem: number | null; reason: string }> }

export const FAMILY_LABEL: Record<string, string> = {
  craft_auction: 'Craft, sell on the auction house', craft_vendor: 'Craft, sell to a vendor', conversion: 'Convert, sell', disenchant: 'Disenchant, sell',
  vendor_auction: 'Vendor to auction house', auction_vendor: 'Auction house to vendor', cross_house: 'Between your two houses', cheap_listing: 'Cheap listing, relist',
};
const RISK_TONE = { low: 'good', medium: 'gold', high: 'bad' } as const;
type Sort = 'rank' | 'each' | 'hour' | 'risk';

/**
 * Every flip on one list, crafting (green) and flipping (blue) side by side, best first.
 * Nothing is hidden by default: the filters only narrow the view.
 */
export function FlipsPage() {
  const { openItem } = useNav();
  const { data, isLoading } = useQuery({ queryKey: ['flips'], queryFn: () => api<Resp>('/api/flips'), refetchInterval: 60_000 });
  const [kind, setKind] = useState<'all' | 'craft' | 'flip'>('all');
  const [risk, setRisk] = useState<'all' | 'low' | 'medium'>('all');
  const [sort, setSort] = useState<Sort>('rank');
  const rows = useMemo(() => {
    let r = (data?.flips ?? []).filter(f => (kind === 'all' || f.kind === kind) && (risk === 'all' || (risk === 'low' ? f.risk === 'low' : f.risk !== 'high')));
    const order = { low: 0, medium: 1, high: 2 } as Record<string, number>;
    if (sort === 'each') r = [...r].sort((a, b) => b.detail.perItem - a.detail.perItem);
    if (sort === 'hour') r = [...r].sort((a, b) => (b.detail.best.goldPerHour ?? -1) - (a.detail.best.goldPerHour ?? -1));
    if (sort === 'risk') r = [...r].sort((a, b) => (order[a.risk] ?? 3) - (order[b.risk] ?? 3) || b.expected_profit - a.expected_profit);
    return r;
  }, [data, kind, risk, sort]);
  const n = (k: string) => (data?.flips ?? []).filter(f => f.kind === k).length;
  const run = data?.run;
  return (
    <div>
      <PageHeader title="Flips" sub="Every way to turn copper into more copper on your two houses this hour, crafting and flipping ranked together. Best first: what you can expect to make overnight if you act now." />
      <Card className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
        {run ? <>
          <span>Data from <b>{ago(run.data_at)}</b></span>
          <span className="text-muted">{run.report.items.toLocaleString()} items, {run.report.recipesTried.toLocaleString()} recipes checked in {(run.ms / 1000).toFixed(1)}s</span>
          {run.complete ? <Chip tone="good">complete</Chip> : <Chip tone="bad">incomplete: {run.report.incompleteReason ?? 'see Health'}</Chip>}
        </> : <span className="text-muted">No flip run yet. The first one happens at the next publish, about 25 past the hour.</span>}
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Toggle on={kind === 'all'} onClick={() => setKind('all')}>All {data ? `(${data.flips.length})` : ''}</Toggle>
        <Toggle on={kind === 'craft'} onClick={() => setKind('craft')} cls="text-craft">Crafting ({n('craft')})</Toggle>
        <Toggle on={kind === 'flip'} onClick={() => setKind('flip')} cls="text-flip">Flipping ({n('flip')})</Toggle>
        <span className="mx-1 text-line">|</span>
        <Toggle on={risk === 'all'} onClick={() => setRisk('all')}>Any risk</Toggle>
        <Toggle on={risk === 'medium'} onClick={() => setRisk('medium')}>Low and medium</Toggle>
        <Toggle on={risk === 'low'} onClick={() => setRisk('low')}>Low only</Toggle>
        <label className="ml-auto text-xs text-muted">Sort <select value={sort} onChange={e => setSort(e.target.value as Sort)} className="ml-1 rounded-md border border-line bg-card px-2 py-1 text-sm text-ink">
          <option value="rank">Expected profit</option><option value="each">Profit per item</option><option value="hour">Gold per hour</option><option value="risk">Lowest risk</option>
        </select></label>
      </div>

      {isLoading ? <p className="text-muted">Loading.</p> : rows.length === 0 ? (
        <Empty title="No flips right now">{run ? 'Nothing cleared the checks this hour. The held back list below says why.' : 'Waiting for the first run.'}</Empty>
      ) : (
        <div className="space-y-3">{rows.map((f, i) => <FlipCard key={f.key} f={f} place={sort === 'rank' && kind === 'all' && risk === 'all' ? (f.rank ?? i + 1) : i + 1} onOpenItem={openItem} />)}</div>
      )}

      {!!data?.heldBack.length && (
        <Card className="mt-6 p-4">
          <h2 className="font-display text-lg font-semibold">Held back this hour</h2>
          <p className="mb-2 text-xs text-muted">The closest calls that did not make the list, and why.</p>
          <ul className="space-y-1 text-sm">
            {data.heldBack.slice(0, 25).map(h => (
              <li key={h.key} className="flex flex-wrap gap-x-2">
                <button className="font-semibold hover:underline" onClick={() => openItem(h.itemId)}>{h.name}</button>
                <span className="text-xs text-muted">{FAMILY_LABEL[h.family] ?? h.family}</span>
                {h.perItem != null && <span><Money c={h.perItem} size="sm" /> each</span>}
                <span className="text-muted">{h.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Toggle({ on, onClick, children, cls = '' }: { on: boolean; onClick: () => void; children: React.ReactNode; cls?: string }) {
  return <button onClick={onClick} className={`rounded-full px-3 py-1 ${on ? 'bg-ink/10 font-semibold' : 'border border-line'} ${cls}`}>{children}</button>;
}

const units = (n: number) => `${n.toLocaleString()} unit${n === 1 ? '' : 's'}`;
const minutes = (m: number) => m < 1 ? 'under a minute' : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} hours`;

export function FlipCard({ f, place, onOpenItem }: { f: Row; place: number; onOpenItem: (id: number) => void }) {
  const d = f.detail;
  const craft = f.kind === 'craft';
  const q = d.sellQuote;
  const [open, setOpen] = useState(false);
  // Buy lines show only what is bought; craft steps go under Make, and the product is never its own input.
  const bought = d.buy.filter(l => l.kind !== 'craft');
  const steps = d.buy.filter(l => l.kind === 'craft' && l.itemId !== d.itemId);
  return (
    <Card className={`border-l-4 p-4 ${craft ? 'border-l-craft' : 'border-l-flip'} ${f.state === 'gone' ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="num w-6 shrink-0 pt-1 text-right text-sm font-bold text-muted">{place}</span>
        <button onClick={() => onOpenItem(f.item_id)}><ItemIcon url={f.icon_url} quality={f.quality} size={44} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white ${craft ? 'bg-craft' : 'bg-flip'}`}>{craft ? 'Crafting' : 'Flipping'}</span>
                <button onClick={() => onOpenItem(f.item_id)} className="min-w-0 break-words text-left text-base hover:underline"><ItemName name={d.name} id={f.item_id} quality={f.quality} /></button>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {FAMILY_LABEL[d.family] ?? d.family}
                {d.opening === 'new' ? ', new this hour' : d.opening === 'rising' ? ', price rising on real sales' : ''}
                {`, open ${d.openHours72} of the last 72 hours`}
                {d.repeatable ? ', repeatable' : ', one opening'}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <div className={d.best.expectedProfit >= 0 ? 'text-good' : 'text-bad'}>{d.best.expectedProfit >= 0 && <span className="text-lg font-bold">+</span>}<Money c={d.best.expectedProfit} size="xl" /></div>
              <p className="text-[11px] text-muted">expected overnight, {units(d.best.units)}</p>
              <p className="text-xs"><Money c={d.perItem} size="sm" /> <span className="text-muted">per item</span></p>
            </div>
          </div>

          <ul className="mt-3 space-y-1.5 text-sm">
            {bought.map((l, i) => <LegLine key={i} label={i ? '' : 'Buy'} leg={l} />)}
            {bought.length === 0 && <li className="flex gap-2"><Label>Buy</Label><span className="text-muted">Nothing to buy: every input is made.</span></li>}
            {craft && <li className="flex gap-2"><Label>Make</Label><span>{d.recipeName ?? 'craft'}{d.profession ? ` (${d.profession})` : ''}: <b>{d.best.units}</b> made, about {minutes(d.best.minutes)} of work.</span></li>}
            {steps.map((l, i) => <LegLine key={`m${i}`} label="" leg={l} first="Make first" />)}
            <LegLine label="Sell" leg={d.sell} />
            <li className="flex gap-2"><Label>Price</Label>
              <span>
                {q.listed != null && <>cheapest listed <Money c={q.listed} size="sm" />, </>}
                counting on <Money c={q.claimPrice} size="sm" /> <span className="text-muted">({q.basis === 'sold' ? 'what it actually sold for' : q.basis === 'sweep' ? 'what buyers paid this hour' : q.basis === 'vendor' ? 'vendor price' : 'trimmed market price'})</span>
                {q.sweepHigh != null && q.rising && <> , buyers paid up to <Money c={q.sweepHigh} size="sm" /> this hour</>}
              </span>
            </li>
            <li className="flex gap-2"><Label>Volume</Label>
              <span>
                {d.sell.kind === 'any_vendor' ? 'Vendors buy any amount.' : q.salesPerDayLow != null
                  ? <>At least <b>{Math.round(q.salesPerDayLow)}</b> sell a day{q.salesPerDayMid != null ? `, about ${Math.round(q.salesPerDayMid)}` : ''} <span className="text-xs text-muted">({Math.round(q.hoursWatched)} hours watched)</span>. {q.ahead.toLocaleString()} listed ahead of you. Expect about <b>{Math.round(d.best.expectedSold)}</b> of {d.best.units} to sell overnight.</>
                  : <span className="text-muted">No sales seen yet.</span>}
              </span>
            </li>
            <li className="flex gap-2"><Label>Risk</Label>
              <span className="flex flex-wrap items-baseline gap-x-2">
                <Chip tone={RISK_TONE[d.best.risk.level]}>{d.best.risk.level} risk</Chip>
                <span><Money c={d.best.risk.atStake} size="sm" /> at stake, bad case <span className="text-bad"><Money c={-d.best.risk.badCaseLoss} size="sm" /></span>{d.best.risk.daysToSell != null ? `, ${d.best.risk.daysToSell < 1 ? 'under a day' : `about ${d.best.risk.daysToSell.toFixed(1)} days`} to sell` : ''}.</span>
                {d.best.risk.drivers.length > 0 && <span className="text-xs text-muted">{d.best.risk.drivers.join(', ')}.</span>}
              </span>
            </li>
            {d.setup && <li className="flex gap-2"><Label>Setup</Label><span>Needs {d.setup.skill}{d.setup.rank != null ? ` ${d.setup.rank}` : ''}{d.setup.cost != null ? <>, learn for <Money c={d.setup.cost} size="sm" /></> : ''}{d.setup.where ? (d.setup.unknown ? `, ${d.setup.where}` : ` at ${d.setup.where}`) : ''}. One time cost.</span></li>}
            {d.shares.length > 0 && <li className="flex gap-2"><Label>Shares</Label><span className="text-muted">Uses the same reagents or buyers as {d.shares.length} flip{d.shares.length > 1 ? 's' : ''} above{d.afterShared ? <>; doing both leaves <b>{d.afterShared.units}</b> units worth <Money c={d.afterShared.expectedProfit} size="sm" /></> : ''}.</span></li>}
          </ul>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/70 pt-2.5">
            <span className="text-xs text-muted">data {ago(f.data_at)}{f.house_name ? `, ${f.faction === 'blackwater' ? 'Blackwater' : 'Alliance'} house` : ''}</span>
            <span title={q.strengthParts.map(x => `${x.label}: ${x.points} of ${x.max}`).join('\n')} className="cursor-help"><Chip tone={q.strength >= 75 ? 'good' : q.strength >= 60 ? 'gold' : 'warn'}>strength {q.strength}/100</Chip></span>
            {d.best.goldPerHour != null && <Chip>{<Money c={d.best.goldPerHour} size="sm" />} an hour of work</Chip>}
            <button className="ml-auto text-xs text-muted underline" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} amounts</button>
          </div>

          {open && (
            <div className="mt-2 overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted"><th className="py-1">Amount</th><th>Units</th><th>Cost</th><th>Sells overnight</th><th>Expected profit</th><th>Per hour</th><th>Risk</th><th>Bad case</th></tr></thead>
              <tbody>{d.options.map(o => (
                <tr key={o.label} className={`border-t border-line/60 ${o.label === 'best' ? 'font-semibold' : ''}`}>
                  <td className="py-1">{o.label === 'small' ? 'Small' : o.label === 'best' ? 'Best' : 'Most'}</td>
                  <td className="num">{o.units.toLocaleString()}</td><td><Money c={o.cost} size="sm" /></td><td className="num">{Math.round(o.expectedSold)}</td>
                  <td><Money c={o.expectedProfit} size="sm" /></td><td>{o.goldPerHour != null ? <Money c={o.goldPerHour} size="sm" /> : '?'}</td>
                  <td><Chip tone={RISK_TONE[o.risk.level]}>{o.risk.level}</Chip></td><td className="text-bad"><Money c={-o.risk.badCaseLoss} size="sm" /></td>
                </tr>
              ))}</tbody>
            </table>
            </div>
          )}
          {d.notes.length > 0 && <p className="mt-2 text-xs text-muted">{d.notes.join(' ')}</p>}
        </div>
      </div>
    </Card>
  );
}

function Label({ children }: { children?: React.ReactNode }) {
  return <span className="w-14 shrink-0 text-xs font-bold uppercase tracking-wide text-muted">{children}</span>;
}

function LegLine({ label, leg, first }: { label: string; leg: Leg; first?: string }) {
  const pl = leg.places[0];
  const href = pl ? mapHref(pl) : null;
  return (
    <li className="flex gap-2">
      <Label>{label}</Label>
      <span className="flex flex-wrap items-baseline gap-x-2">
        {first && <span className="text-muted">{first}</span>}
        <span><b>{leg.units.toLocaleString()}</b> {leg.name}</span>
        <span className="text-muted">at</span><Money c={leg.unitPrice} size="sm" /><span className="text-muted">{label === 'Sell' ? 'each after the cut' : 'each'}</span>
        <span className="font-semibold">{leg.kind === 'any_vendor' ? 'to any vendor' : leg.who}</span>
        {pl && (href ? <a href={href} className="text-alliance underline decoration-dotted underline-offset-2">{pl.zone ?? pl.label}{pl.x != null ? ` ${pl.x}, ${pl.y}` : ''}</a> : <span className="text-muted">{pl.zone ?? pl.label}</span>)}
        {leg.note && <span className="text-xs text-muted">({leg.note})</span>}
      </span>
    </li>
  );
}
