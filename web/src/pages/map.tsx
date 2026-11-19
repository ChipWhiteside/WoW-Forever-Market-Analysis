import { useEffect, useState } from 'react';
import { PageHeader, Card } from '../components/ui';
import { ZONES, mapImage } from '../lib/zones';

const AUCTION_HOUSES = [
  { label: 'Stormwind auction house', uiMap: 1453, x: 61.1, y: 71.2, kind: 'alliance' },
  { label: 'Ironforge auction house', uiMap: 1455, x: 25.7, y: 75.3, kind: 'alliance' },
  { label: 'Booty Bay auction house (Blackwater)', uiMap: 1434, x: 26.6, y: 76.4, kind: 'blackwater' },
  { label: 'Gadgetzan auction house (Blackwater)', uiMap: 1446, x: 52.0, y: 29.6, kind: 'blackwater' },
  { label: 'Everlook auction house (Blackwater)', uiMap: 1452, x: 61.4, y: 37.2, kind: 'blackwater' },
];

/** Read #map/<uiMap>/<x>/<y>/<label> */
function parse(): { uiMap: number; x: number | null; y: number | null; label: string | null } {
  const [, m, x, y, label] = location.hash.slice(1).split('/');
  return { uiMap: Number(m) || 1453, x: x ? Number(x) : null, y: y ? Number(y) : null, label: label ? decodeURIComponent(label) : null };
}

export function MapPage() {
  const [pin, setPin] = useState(parse);
  useEffect(() => { const f = () => setPin(parse()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const img = mapImage(pin.uiMap);
  const zone = ZONES[pin.uiMap]?.name ?? `New zone, map ${pin.uiMap}`;
  const others = AUCTION_HOUSES.filter(a => a.uiMap === pin.uiMap && !(a.x === pin.x && a.y === pin.y));
  return (
    <>
      <PageHeader title="Map" sub="Click any location on a play to jump here. The red pin is where to go; gold pins are auction houses." right={
        <select value={pin.uiMap} onChange={e => { location.hash = `map/${e.target.value}`; }} className="rounded-lg border border-line bg-card px-3 py-2 text-sm">
          {Object.entries(ZONES).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, z]) => <option key={id} value={id}>{z.name}</option>)}
        </select>} />
      {pin.label && <Card className="mb-3 px-4 py-2 text-sm"><span className="font-semibold">{pin.label}</span> <span className="text-muted">· {zone}{pin.x != null ? `, ${pin.x}, ${pin.y}` : ''}</span></Card>}
      {img ? (
        <div className="relative w-full overflow-hidden rounded-xl border border-line shadow-card" style={{ aspectRatio: '1022 / 668' }}>
          <img src={img} alt={zone} className="absolute inset-0 h-full w-full" />
          {others.map(a => <Pin key={a.label} x={a.x} y={a.y} label={a.label} tone="gold" />)}
          {pin.x != null && pin.y != null && <Pin x={pin.x} y={pin.y} label={pin.label ?? ''} tone="red" />}
        </div>
      ) : <Card className="p-6 text-sm text-muted">No map image for {zone} yet. Go to {pin.x}, {pin.y} on the in game map.</Card>}
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {AUCTION_HOUSES.map(a => <a key={a.label} href={`#map/${a.uiMap}/${a.x}/${a.y}/${encodeURIComponent(a.label)}`} className="rounded-full border border-line px-3 py-1 hover:bg-line/40">{a.label}</a>)}
      </div>
    </>
  );
}

function Pin({ x, y, label, tone }: { x: number; y: number; label: string; tone: 'red' | 'gold' }) {
  return (
    <div className={`group absolute ${tone === 'red' ? 'z-10' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} title={label}>
      <div className={`-ml-2 -mt-2 h-4 w-4 rounded-full border-2 border-white shadow ${tone === 'red' ? 'animate-pulse bg-bad' : 'bg-gold'}`} />
      {label && <div className={`ml-3 -mt-5 whitespace-nowrap rounded bg-ink/85 px-1.5 py-0.5 text-[11px] font-semibold text-white ${tone === 'red' ? '' : 'hidden group-hover:block'}`}>{label}</div>}
    </div>
  );
}
