import { useQuery } from '@tanstack/react-query';
import { api, type Health } from '../lib/api';
import { PageHeader, Card, Chip, Money } from '../components/ui';
import { PlayList } from './plays';
import { ago, DETECTOR_LABEL } from '../lib/format';
import { useNav } from '../nav';

export function HealthStrip() {
  const { data } = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/api/health'), refetchInterval: 30_000 });
  if (!data) return null;
  const tone = data.status === 'ok' ? 'border-good/30 bg-good/5' : data.status === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-bad/40 bg-bad/10';
  const newest = Math.max(0, ...data.houses.map(h => h.lastPublish ?? 0));
  return (
    <div className={`mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 text-sm ${tone}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${data.status === 'ok' ? 'bg-good' : data.status === 'warn' ? 'bg-warn' : 'bg-bad'}`} />
      <span className="font-semibold">{data.status === 'ok' ? 'All houses fresh' : data.status === 'warn' ? 'Attention' : 'Problem'}</span>
      <span className="text-muted">{data.message}</span>
      <span className="ml-auto text-xs text-muted">newest data {ago(newest || null)}</span>
    </div>
  );
}

export function NowPage() {
  const { go } = useNav();
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => api<any>('/api/overview'), refetchInterval: 30_000 });
  const counts: Array<{ detector: string; n: number; profit: number; fresh: number }> = data?.counts ?? [];
  return (
    <>
      <HealthStrip />
      <PageHeader title="Now" sub="Every live play on your houses, best first. Profit leads, the sentence says what to do." />
      {data && data.pinned.length < 2 && (
        <Card className="mb-5 flex items-center justify-between gap-4 border-gold/40 bg-gold/5 px-4 py-3">
          <p className="text-sm"><span className="font-semibold">Pick your two houses.</span> Until you do, plays show for every candidate house and no alerts go out.</p>
          <button onClick={() => go('settings')} className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-page">Open house finder</button>
        </Card>
      )}
      {counts.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          {counts.map(c => (
            <Card key={c.detector} className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{DETECTOR_LABEL[c.detector]}</p>
              <div className="mt-1 flex items-baseline justify-between"><Money c={c.profit} size="lg" /><span className="text-xs text-muted">{c.n} live{c.fresh ? <>, <Chip tone="gold">{c.fresh} new</Chip></> : null}</span></div>
            </Card>
          ))}
        </div>
      )}
      <PlayList emptyTitle="Nothing worth your time this hour" emptyText="The engine checks every listing within minutes of each publish. When something clears your profit bar, it lands here and on your phone." />
    </>
  );
}
