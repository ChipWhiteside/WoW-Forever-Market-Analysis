import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Play } from '../lib/api';
import { PlayCard } from '../components/PlayCard';
import { PageHeader, Empty } from '../components/ui';
import { PLAY_LABEL } from '../lib/format';
import { CategoryFilter } from '../components/CategoryFilter';
import { isHidden, useHidden } from '../lib/categories';
import { useNav } from '../nav';

export function PlayList({ detectors, filters = false, emptyTitle, emptyText }: { detectors?: string[]; filters?: boolean; emptyTitle: string; emptyText: React.ReactNode }) {
  const { openItem } = useNav();
  const [showGone, setShowGone] = useState(false);
  const [only, setOnly] = useState<string | null>(null);
  const [hidden] = useHidden();
  const { data, isLoading } = useQuery({
    queryKey: ['plays', detectors?.join(','), showGone],
    queryFn: () => api<Play[]>(`/api/plays?${detectors ? `detector=${detectors.join(',')}&` : ''}${showGone ? 'gone=1' : ''}`),
    refetchInterval: 30_000,
  });
  if (isLoading) return <p className="text-muted">Loading…</p>;
  const all = (data ?? []).filter(p => (p.detail as { buy?: unknown }).buy);
  const counts = new Map<string, number>();
  for (const p of all) if (p.state !== 'gone') counts.set(p.detector, (counts.get(p.detector) ?? 0) + 1);
  const byType = only ? all.filter(p => p.detector === only) : all;
  const plays = byType.filter(p => !isHidden(p, hidden));
  const hiddenCount = byType.length - plays.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {filters && counts.size > 1 && <>
          <button onClick={() => setOnly(null)} className={`rounded-full px-3 py-1 text-xs ${!only ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>All {all.filter(p => p.state !== 'gone').length}</button>
          {[...counts.entries()].map(([d, n]) => (
            <button key={d} onClick={() => setOnly(only === d ? null : d)} className={`rounded-full px-3 py-1 text-xs ${only === d ? 'bg-gold/20 font-semibold' : 'border border-line'}`}>{PLAY_LABEL[d]} {n}</button>
          ))}
        </>}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={showGone} onChange={e => setShowGone(e.target.checked)} /> show gone</label>
      </div>
      <CategoryFilter items={byType.filter(p => p.state !== 'gone')} />
      {hiddenCount > 0 && <p className="text-xs text-muted">{hiddenCount} play{hiddenCount === 1 ? '' : 's'} hidden by your category filter.</p>}
      {plays.length === 0 ? <Empty title={emptyTitle}>{emptyText}</Empty> : plays.map(p => <PlayCard key={p.key} p={p} onOpenItem={openItem} />)}
    </div>
  );
}

export function VendorPage() {
  return <>
    <PageHeader title="Vendor plays" sub="Buy on the auction house and sell to any vendor, or buy from a vendor and sell on the auction house. Horde only vendors never appear." />
    <PlayList filters detectors={['vendor_dump', 'vendor_supply']} emptyTitle="No vendor plays right now" emptyText="Checked against every listing on every refresh. When one opens, it shows here and on your phone." />
  </>;
}

export function ResalePage() {
  return <>
    <PageHeader title="Resale" sub="Listings far under their usual price on items that actually sell, and price gaps between your Alliance and Blackwater houses wider than the cut." />
    <PlayList filters detectors={['underpriced', 'cross_house']} emptyTitle="No resale plays right now" emptyText={<>Cheap listing plays need 24 hourly readings to learn an item's usual price. Between houses plays need your Blackwater house picked in Settings.</>} />
  </>;
}
