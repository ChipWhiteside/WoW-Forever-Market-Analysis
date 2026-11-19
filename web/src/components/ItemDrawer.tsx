import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Money, ItemIcon, ItemName, HouseBadge, Chip, Sparkline, Ladder } from './ui';
import { mapHref } from '../lib/zones';

/** Everything known about one item. Opens from any screen. */
export function ItemDrawer({ id, onClose, onOpenItem }: { id: number; onClose: () => void; onOpenItem: (id: number) => void }) {
  const { data } = useQuery({ queryKey: ['item', id], queryFn: () => api<any>(`/api/items/${id}`) });
  const it = data?.item;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-line bg-page p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="float-right text-sm text-muted hover:text-ink">Close</button>
        {!data ? <p className="text-muted">Loading…</p> : (
          <>
            <div className="flex items-center gap-3">
              <ItemIcon url={it.icon_url} quality={it.quality} size={52} />
              <div>
                <h2 className="text-lg"><ItemName name={it.name} id={id} quality={it.quality} /></h2>
                <p className="text-xs text-muted">{[it.item_class, it.item_subclass, it.required_level ? `requires level ${it.required_level}` : null, it.binding?.toLowerCase().replace('_', ' ')].filter(Boolean).join(' · ')} · id {id}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Stat label="Vendor pays"><Money c={it.sell_price} /></Stat>
              <Stat label="Blizzard list price" hint="Populated on every item, never proof a vendor sells it"><Money c={it.purchase_price} dim /></Stat>
            </div>

            <Section title="On the auction houses">
              {data.houses.length === 0 && <p className="text-sm text-muted">Not listed on any tracked house right now.</p>}
              {data.houses.map((h: any) => (
                <div key={h.id} className="mb-4">
                  <div className="mb-1.5 flex items-center gap-2 text-sm"><HouseBadge faction={h.faction} name={h.name} /><span className="text-muted">house {h.id}{h.pinned ? ', yours' : ''} · {ago(h.published_at)}</span></div>
                  <div className="mb-2 flex gap-6 text-sm"><span>floor <Money c={h.floor} /></span><span className="text-muted">{h.units_at_floor} at floor · {h.total_units} total · {h.listings} listings</span></div>
                  <Ladder ladder={h.ladder} />
                </div>
              ))}
              {data.history.length > 1 && (
                <div className="mt-2"><p className="mb-1 text-xs font-semibold text-muted">Floor, last 7 days{data.houses[0] ? `, ${data.houses[0].name} ${data.houses[0].id}` : ''}</p>
                  <Sparkline points={data.history.filter((r: any) => !data.houses[0] || r.house_id === data.houses[0].id).map((r: any) => [r.t, r.floor])} width={480} />
                </div>
              )}
            </Section>

            <Section title="Vendors that sell it">
              {data.vendors.length === 0 ? <p className="text-sm text-muted">No vendor recorded selling it in WoW Forever.</p> : data.vendors.slice(0, 12).map((v: any) => (
                <div key={v.npc_id} className={`flex items-center justify-between py-1 text-sm ${v.faction === 'horde' ? 'opacity-40' : ''}`}>
                  <span>{v.npc_name} {(() => { const h = mapHref({ label: v.npc_name, zone: v.zone, uiMap: v.map_id, x: v.x, y: v.y }); const t = `${v.zone ?? '?'}${v.x != null ? ` ${v.x}, ${v.y}` : ''}`; return h ? <a href={h} onClick={onClose} className="text-alliance underline decoration-dotted">📍 {t}</a> : <span className="text-muted">· {t}</span>; })()} {v.faction === 'horde' ? <Chip tone="bad">Horde only</Chip> : v.faction === 'unknown' ? <Chip tone="warn">faction unknown</Chip> : null}{v.limited ? <Chip tone="warn">limited</Chip> : null}</span>
                  <Money c={v.price} size="sm" />
                </div>
              ))}
            </Section>

            {data.madeBy.length > 0 && <Section title="Made by">{data.madeBy.map((r: any) => (
              <div key={r.id} className="py-1 text-sm"><span className="font-semibold">{r.name}</span> <span className="text-muted">· {r.profession}{r.yellow ? ` · yellow ${r.yellow}, green ${r.green}, grey ${r.grey}` : ''}</span>
                <div className="text-xs text-muted">{JSON.parse(r.reagents).map((g: any) => <button key={g.item_id} className="mr-2 hover:underline" onClick={() => onOpenItem(g.item_id)}>{g.quantity}× {g.name ?? `Item ${g.item_id}`}</button>)}</div>
              </div>))}</Section>}
            {data.usedIn.length > 0 && <Section title="Used in">{data.usedIn.map((r: any) => (
              <button key={r.id} onClick={() => r.crafted_item_id && onOpenItem(r.crafted_item_id)} className="mr-2 mb-1 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-line/40">{r.name} <span className="text-muted">{r.profession}</span></button>))}</Section>}
            {data.drops.length > 0 && <Section title="Drops from">{data.drops.slice(0, 15).map((d: any, i: number) => (
              <div key={i} className="flex justify-between py-0.5 text-sm"><span>{d.source_name ?? `${d.source_kind} ${d.source_id}`} <span className="text-muted">· {d.zone ?? ''} {d.min_level ? `level ${d.min_level}${d.max_level !== d.min_level ? `-${d.max_level}` : ''}` : ''}</span></span>
                <span className="num">{(d.chance * 100).toFixed(1)}% <span className={`text-xs ${d.kills < 50 ? 'text-warn' : 'text-muted'}`}>({d.kills} {d.source_kind === 'npc' ? 'kills' : 'opens'}{d.kills < 50 ? ', rough' : ''})</span></span></div>))}</Section>}
          </>
        )}
      </aside>
    </div>
  );
}
const Stat = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="rounded-lg border border-line bg-card px-3 py-2" title={hint}><p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>{children}</div>
);
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-6"><h3 className="mb-2 font-display text-sm font-bold tracking-wide text-gold">{title}</h3>{children}</section>
);
