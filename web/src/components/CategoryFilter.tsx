import { categoryOf, subcategoryOf, useHidden, type Categorized } from '../lib/categories';

/**
 * Filter buttons by item category. Click a category to hide it, click again to show it. The second row splits the
 * visible categories into their subcategories (Blacksmithing recipes, Cloth, Metal & Stone...).
 */
export function CategoryFilter({ items }: { items: Categorized[] }) {
  const [hidden, setHidden] = useHidden();
  if (!items.length) return null;
  const cats = new Map<string, Map<string, number>>();
  for (const it of items) {
    const c = categoryOf(it), s = subcategoryOf(it);
    const m = cats.get(c) ?? new Map<string, number>();
    m.set(s, (m.get(s) ?? 0) + 1);
    cats.set(c, m);
  }
  const sorted = [...cats.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
  const toggle = (k: string) => { const n = new Set(hidden); n.has(k) ? n.delete(k) : n.add(k); setHidden(n); };
  const chip = (k: string, label: string, n: number, small = false) => {
    const off = hidden.has(k);
    return (
      <button key={k} onClick={() => toggle(k)} title={off ? 'Hidden. Click to show' : 'Click to hide'}
        className={`rounded-full ${small ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'} ${off ? 'border border-dashed border-line text-muted line-through' : 'border border-line bg-card font-semibold'}`}>
        {label} <span className="font-normal text-muted">{n}</span>
      </button>
    );
  };
  const splits = sorted.filter(([c, subs]) => !hidden.has(c) && subs.size > 1);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted">Show</span>
        {sorted.map(([c, subs]) => chip(c, c, sum(subs)))}
        {hidden.size > 0 && <button onClick={() => setHidden(new Set())} className="ml-1 text-xs text-alliance underline">show all</button>}
      </div>
      {splits.map(([c, subs]) => (
        <div key={c} className="flex flex-wrap items-center gap-1 pl-10">
          <span className="mr-1 text-[11px] text-muted">{c}:</span>
          {[...subs.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => chip(`${c} / ${s}`, s, n, true))}
        </div>
      ))}
    </div>
  );
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
