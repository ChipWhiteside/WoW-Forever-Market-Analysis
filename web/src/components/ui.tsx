import type { ReactNode } from 'react';
import { coins } from '../lib/format';

/** Gold, silver and copper with coin glyphs. The WoW layer on every price. */
export function Money({ c, size = 'md', dim = false }: { c: number | null | undefined; size?: 'sm' | 'md' | 'lg' | 'xl'; dim?: boolean }) {
  const v = coins(c);
  const text = { sm: 'text-xs', md: 'text-sm', lg: 'text-lg', xl: 'text-3xl' }[size];
  const dot = { sm: 'w-2 h-2', md: 'w-2.5 h-2.5', lg: 'w-3 h-3', xl: 'w-4 h-4' }[size];
  if (!v) return <span className={`${text} text-muted`}>?</span>;
  // Show only the units that matter: gold and silver once there is gold, otherwise silver and copper.
  const shown: Array<[number, string]> = [];
  if (v.g) shown.push([v.g, 'bg-[#E2B13C] ring-[#A7791F]']);
  if (v.s) shown.push([v.s, 'bg-[#C9CDD3] ring-[#8D939C]']);
  if (!v.g && (v.c || shown.length === 0)) shown.push([v.c, 'bg-[#C77B3F] ring-[#8E522A]']);
  return (
    <span className={`inline-flex items-baseline gap-1.5 num font-semibold ${text} ${dim ? 'text-muted' : ''}`}>
      {v.neg && <span>-</span>}
      {shown.map(([n, cls], i) => (
        <span key={i} className="inline-flex items-center gap-0.5">{n}<span className={`inline-block rounded-full ring-1 ${cls} ${dot} translate-y-[-1px]`} /></span>
      ))}
    </span>
  );
}

export function ItemIcon({ url, quality, size = 36 }: { url: string | null | undefined; quality: string | null | undefined; size?: number }) {
  return (
    <span className={`q-${quality ?? 'none'} qrim inline-block shrink-0 overflow-hidden rounded-md bg-line`} style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" width={size} height={size} loading="lazy" /> : <span className="flex h-full items-center justify-center text-[10px] text-muted">?</span>}
    </span>
  );
}

export function ItemName({ name, id, quality, className = '' }: { name: string | null | undefined; id: number; quality: string | null | undefined; className?: string }) {
  return <span className={`font-semibold ${className}`}>{name ?? `Item ${id}`}{quality && quality !== 'COMMON' && quality !== 'POOR' && <span className={`q-${quality} qtext ml-1.5 text-[10px] font-bold uppercase tracking-wide`}>{quality.toLowerCase()}</span>}</span>;
}

export function HouseBadge({ faction, name }: { faction: string; name?: string }) {
  const label = faction === 'alliance' ? 'Alliance' : faction === 'blackwater' ? 'Blackwater' : faction;
  const cls = faction === 'alliance' ? 'bg-alliance/10 text-alliance' : 'bg-blackwater/10 text-blackwater';
  return <span title={name} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'good' | 'warn' | 'bad' | 'gold' }) {
  const cls = { muted: 'bg-line/60 text-muted', good: 'bg-good/10 text-good', warn: 'bg-warn/15 text-warn', bad: 'bg-bad/10 text-bad', gold: 'bg-gold/15 text-gold' }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-card shadow-card ${className}`}>{children}</div>;
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-wide">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="px-6 py-10 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>}
    </Card>
  );
}

/** A small floor history line. Points are [time, value]. */
export function Sparkline({ points, width = 260, height = 56 }: { points: Array<[number, number]>; width?: number; height?: number }) {
  if (points.length < 2) return <div className="text-xs text-muted">Not enough history yet.</div>;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * (width - 4) + 2;
  const sy = (y: number) => height - 2 - ((y - y0) / Math.max(1, y1 - y0)) * (height - 4);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  return <svg width={width} height={height} className="overflow-visible"><path d={d} fill="none" stroke="rgb(var(--gold))" strokeWidth={2} strokeLinejoin="round" /></svg>;
}

export function Ladder({ ladder, max = 8 }: { ladder: Array<[number, number]>; max?: number }) {
  const rows = ladder.slice(0, max);
  const top = Math.max(1, ...rows.map(r => r[1]));
  return (
    <div className="space-y-1">
      {rows.map(([p, u], i) => (
        <div key={i} className="flex items-center gap-3 text-xs">
          <span className="w-24 text-right"><Money c={p} size="sm" /></span>
          <span className="h-2 rounded-full bg-gold/60" style={{ width: `${Math.max(4, (u / top) * 160)}px` }} />
          <span className="num text-muted">{u.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
