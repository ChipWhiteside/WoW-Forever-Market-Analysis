import { useQuery } from '@tanstack/react-query';
import { api, type Health } from '../lib/api';
import { PageHeader, Card, Money, ItemIcon, ItemName } from '../components/ui';
import { PLAY_LABEL } from '../lib/format';
import { PlayList } from './plays';
import { ago } from '../lib/format';
import { useNav } from '../nav';

/** Blizzard publishes every house together at about 25 past the hour (verified). */
export function nextRefresh(lastPublish: number): number {
  const next = lastPublish + 3600_000;
  return next > Date.now() ? next : Date.now() + (3600_000 - ((Date.now() - lastPublish) % 3600_000));
}

/** The only thing the top bar needs: how fresh the data is and when the next refresh lands. */
export function HealthStrip() {
  const { data } = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/api/health'), refetchInterval: 30_000 });
  if (!data) return null;
  const newest = Math.max(0, ...data.houses.map(h => h.lastPublish ?? 0));
  if (!newest) return <div className="mb-6 rounded-xl border border-line bg-card px-4 py-2.5 text-sm text-muted">Waiting for the first snapshot. It lands within a few minutes of the engine starting.</div>;
  const stale = Date.now() - newest > 75 * 60_000;
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className={`mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2.5 text-sm ${stale ? 'border-warn/50 bg-warn/10' : 'border-line bg-card'}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${stale ? 'bg-warn' : 'bg-good'}`} />
      <span>Data from <b>{time(newest)}</b>, {ago(newest)}.</span>
      {stale ? <span className="text-warn">No new data for over an hour. Is the engine running? See Health.</span>
        : <span className="text-muted">Next refresh about {time(nextRefresh(newest))}.</span>}
    </div>
  );
}

/** Only when a house is still unpicked, and it says exactly which. */
export function HouseStatus() {
  const { go } = useNav();
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => api<any>('/api/overview') });
  if (!data) return null;
  const pinned: Array<{ id: number; faction: string }> = data.pinned ?? [];
  const a = pinned.find(h => h.faction === 'alliance');
  const b = pinned.find(h => h.faction === 'blackwater');
  if (a && b) return null;
  return (
    <Card className="mb-5 flex flex-wrap items-center justify-between gap-3 border-gold/40 bg-gold/5 px-4 py-3 text-sm">
      <p>
        <b>Your houses:</b> Alliance {a ? <b className="text-good">{a.id} ✓</b> : <span className="text-warn">not picked</span>} · Blackwater {b ? <b className="text-good">{b.id} ✓</b> : <span className="text-warn">not picked yet</span>}.
        <span className="text-muted"> {!a ? 'Alerts start once your Alliance house is picked.' : 'Plays between your two houses start once Blackwater is picked.'}</span>
      </p>
      <button onClick={() => go('settings')} className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold hover:bg-line/40">Pick in Settings</button>
    </Card>
  );
}

export function NowPage() {
  return (
    <>
      <HealthStrip />
      <HouseStatus />
      <PageHeader title="Now" sub="Every live play on your houses, best first. Ranked by profit per item times what you can realistically sell today." />
      <PlayList filters emptyTitle="Nothing worth your time this hour" emptyText="Every listing is checked within minutes of each refresh. When something clears your bar it lands here and on your phone." />
      <ClosestCalls />
    </>
  );
}

/** The best candidates held back this round, and exactly why. An empty board explains itself. */
function ClosestCalls() {
  const { openItem } = useNav();
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => api<any>('/api/overview'), refetchInterval: 60_000 });
  const cc = data?.closest;
  if (!cc?.calls?.length) return null;
  return (
    <div className="mt-8">
      <h2 className="font-display text-lg font-bold">Held back this hour</h2>
      <p className="mb-3 text-sm text-muted">The best candidates the engine found that did not make the cut, and why. If something here looks real to you, say so: it is how the rules get tuned.</p>
      <Card className="divide-y divide-line/70">
        {cc.calls.map((c: any, i: number) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <ItemIcon url={c.icon_url} quality={c.quality} size={28} />
            <button onClick={() => openItem(c.itemId)} className="w-48 shrink-0 truncate text-left hover:underline"><ItemName name={c.name} id={c.itemId} quality={c.quality} /></button>
            <span className="w-28 shrink-0 text-good"><Money c={c.perItem} size="sm" /> each</span>
            <span className="w-44 shrink-0 text-xs text-muted">{PLAY_LABEL[c.detector]}</span>
            <span className="text-xs">{c.reason}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
