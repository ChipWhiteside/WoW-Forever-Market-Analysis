import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Play } from '../lib/api';
import { post } from '../lib/api';
import { ago, DETECTOR_LABEL, DETECTOR_VERB } from '../lib/format';
import { Money, ItemIcon, ItemName, HouseBadge, Chip, Card } from './ui';

const STATE: Record<Play['state'], { label: string; tone: 'gold' | 'good' | 'warn' | 'muted' }> = {
  new: { label: 'New', tone: 'gold' }, live: { label: 'Live', tone: 'good' }, fading: { label: 'Fading', tone: 'warn' }, gone: { label: 'Gone', tone: 'muted' },
};
const CONF = { high: 'good', medium: 'gold', low: 'warn' } as const;

/** A play reads in three seconds: profit first, one sentence, then age, confidence, house and state. */
export function PlayCard({ p, onOpenItem }: { p: Play; onOpenItem: (id: number) => void }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<string>('');
  const [askDone, setAskDone] = useState(false);
  const mark = useMutation({
    mutationFn: (b: { status: string; quantity?: number; unitCost?: number }) => post(`/api/plays/${encodeURIComponent(p.key)}/status`, b),
    onSuccess: () => qc.invalidateQueries(),
  });
  const s = STATE[p.state];
  const unitCost = (p.detail.vendorPrice ?? p.detail.buyFloor ?? p.detail.cheapest ?? p.detail.floor) as number | undefined;
  const gone = p.state === 'gone';
  return (
    <Card className={`p-4 transition ${gone ? 'opacity-55' : 'hover:border-gold/40'}`}>
      <div className="flex items-start gap-4">
        <button onClick={() => onOpenItem(p.item_id)} className="mt-0.5"><ItemIcon url={p.icon_url} quality={p.quality} size={44} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Money c={p.profit} size="lg" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">{DETECTOR_LABEL[p.detector]}</span>
            <button onClick={() => onOpenItem(p.item_id)} className="truncate hover:underline"><ItemName name={p.item_name} id={p.item_id} quality={p.quality} /></button>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed">{p.summary}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Chip tone={s.tone}>{s.label}{p.state !== 'new' && !gone ? `, ${p.snapshots_seen} publishes` : ''}</Chip>
            <Chip tone={CONF[p.confidence]}>{p.confidence} confidence</Chip>
            {p.detector === 'cross_house'
              ? <span className="flex items-center gap-1"><HouseBadge faction={p.faction} /><span className="text-xs text-muted">to</span><HouseBadge faction={p.faction === 'alliance' ? 'blackwater' : 'alliance'} /></span>
              : <HouseBadge faction={p.faction} name={p.house_name} />}
            <span className="text-xs text-muted">data {ago(p.data_at)}</span>
            {p.detail.oneOff && <Chip tone="warn">single cheap listing, may be a one off</Chip>}
            {p.detail.where && <span className="text-xs text-muted">· {String(p.detail.where)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gold">{DETECTOR_VERB[p.detector]}</span>
          {!gone && !p.user_status && !askDone && (
            <div className="flex gap-1">
              <button className="rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-page hover:opacity-90" onClick={() => setAskDone(true)}>Done</button>
              <button className="rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-line/40" onClick={() => mark.mutate({ status: 'skipped' })}>Skip</button>
              <button className="rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-line/40" onClick={() => mark.mutate({ status: 'already_gone' })}>Gone</button>
            </div>
          )}
          {askDone && (
            <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); mark.mutate({ status: 'done', quantity: Number(qty) || undefined, unitCost }); setAskDone(false); }}>
              <input autoFocus value={qty} onChange={e => setQty(e.target.value)} placeholder="units bought" className="w-24 rounded-md border border-line bg-page px-2 py-1 text-xs" />
              <button className="rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-page">Save</button>
            </form>
          )}
          {p.user_status === 'done' && <Chip tone="good">done</Chip>}
        </div>
      </div>
    </Card>
  );
}
