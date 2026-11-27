import { useQuery } from '@tanstack/react-query';
import { api, type Ledger } from '../lib/api';
import { ago } from '../lib/format';
import { useNav } from '../nav';
import { Money, Card, PageHeader, Empty, Chip } from '../components/ui';

/**
 * Who did what (phase 2). Per person: flips done, gold spent, gold received, realised minus spent, and that against
 * what the flips expected. Then every "I did this" and "Sold", newest first.
 */
export function LedgerPage() {
  const { openItem } = useNav();
  const { data, isLoading } = useQuery({ queryKey: ['ledger'], queryFn: () => api<Ledger>('/api/ledger'), refetchInterval: 60_000 });
  const pct = (v: number | null) => v == null ? '?' : `${Math.round(v * 100)}%`;
  return (
    <div>
      <PageHeader title="Ledger" sub="Who did which flips, what they spent, and what came back. Spent is the cost the flip expected when you pressed I did this. Units not sold yet count as spent." />
      {isLoading ? <p className="text-muted">Loading.</p> : !data?.people.length ? (
        <Empty title="Nothing done yet">Press I did this on a flip card when you do one. Press Sold when it sells.</Empty>
      ) : <>
        <Card className="mb-6 overflow-x-auto p-4">
          <table className="w-full whitespace-nowrap text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="py-1 pr-3">Person</th><th className="pr-3">Flips done</th><th className="pr-3">Gold spent</th><th className="pr-3">Gold received</th><th className="pr-3">Realised minus spent</th><th className="pr-3">Expected</th><th>Realised against expected</th>
            </tr></thead>
            <tbody>{data.people.map(p => (
              <tr key={p.username} className={`border-t border-line/60 ${p.username === data.me ? 'font-semibold' : ''}`}>
                <td className="py-1.5 pr-3">{p.username}{p.username === data.me && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}</td>
                <td className="num pr-3">{p.flipsDone} <span className="text-xs text-muted">({p.unitsSold} of {p.unitsDone} units sold)</span></td>
                <td className="pr-3"><Money c={p.spent} size="sm" /></td>
                <td className="pr-3"><Money c={p.received} size="sm" /></td>
                <td className={`pr-3 ${p.realised >= 0 ? 'text-good' : 'text-bad'}`}><Money c={p.realised} size="sm" /></td>
                <td className="pr-3"><Money c={p.expected} size="sm" /></td>
                <td><Chip tone={p.realisedVsExpected == null ? 'muted' : p.realisedVsExpected >= 0.9 ? 'good' : p.realisedVsExpected >= 0.5 ? 'gold' : 'bad'}>{pct(p.realisedVsExpected)}</Chip></td>
              </tr>
            ))}</tbody>
          </table>
        </Card>

        <Card className="p-4">
          <h2 className="font-display text-lg font-semibold">History</h2>
          <ul className="mt-2 divide-y divide-line/60 text-sm">
            {data.history.map(h => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="w-24 shrink-0 text-xs text-muted">{ago(h.at)}</span>
                <span className="font-semibold">{h.username}</span>
                <span className="text-muted">{h.action === 'did' ? 'did' : 'sold'}</span>
                <span><b>{h.units}</b> {h.item_id != null ? <button className="hover:underline" onClick={() => openItem(h.item_id!)}>{h.name ?? `Item ${h.item_id}`}</button> : h.name ?? h.flip_key}</span>
                {h.action === 'did'
                  ? <span className="text-muted">cost <Money c={h.expected_cost} size="sm" />, expected <Money c={h.expected_profit} size="sm" />{h.soldUnits ? <>, {h.soldUnits} sold for <Money c={h.soldReceived} size="sm" /></> : ', none sold yet'}</span>
                  : <span className="text-muted">for <Money c={h.received} size="sm" /></span>}
              </li>
            ))}
          </ul>
        </Card>
      </>}
    </div>
  );
}
