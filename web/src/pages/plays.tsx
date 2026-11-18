import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Play } from '../lib/api';
import { PlayCard } from '../components/PlayCard';
import { PageHeader, Empty, Money } from '../components/ui';
import { useNav } from '../nav';

export function PlayList({ detectors, emptyTitle, emptyText }: { detectors?: string[]; emptyTitle: string; emptyText: React.ReactNode }) {
  const { openItem } = useNav();
  const [showGone, setShowGone] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['plays', detectors?.join(','), showGone],
    queryFn: () => api<Play[]>(`/api/plays?${detectors ? `detector=${detectors.join(',')}&` : ''}${showGone ? 'gone=1' : ''}`),
    refetchInterval: 30_000,
  });
  if (isLoading) return <p className="text-muted">Loading…</p>;
  const plays = data ?? [];
  const live = plays.filter(p => p.state !== 'gone');
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-muted">
        <span>{live.length} live play{live.length === 1 ? '' : 's'}{live.length ? <> worth up to <Money c={live.reduce((s, p) => s + p.profit, 0)} size="sm" /> combined</> : null}</span>
        <label className="flex items-center gap-2"><input type="checkbox" checked={showGone} onChange={e => setShowGone(e.target.checked)} /> show gone</label>
      </div>
      {plays.length === 0 ? <Empty title={emptyTitle}>{emptyText}</Empty> : plays.map(p => <PlayCard key={p.key} p={p} onOpenItem={openItem} />)}
    </div>
  );
}

export function VendorPage() {
  return <>
    <PageHeader title="Vendor plays" sub="Listings under what any vendor pays (vendor dump), and vendor items selling well above what an Alliance usable vendor charges (vendor supply). Horde only vendors never appear." />
    <PlayList detectors={['vendor_dump', 'vendor_supply']} emptyTitle="No vendor plays right now" emptyText="This is checked against every listing on every publish. When one opens, it shows here and on your phone." />
  </>;
}

export function ResalePage() {
  return <>
    <PageHeader title="Resale" sub="Listings far under their typical floor on items that actually sell, and gaps between your Alliance and Blackwater houses wider than the cut." />
    <PlayList detectors={['underpriced', 'cross_house']} emptyTitle="No resale plays right now" emptyText={<>Underpriced plays need 24 hourly readings to learn a typical floor. Cross house plays need both your houses picked in Settings.</>} />
  </>;
}
