/**
 * Prints the simulator table: npx tsx tests/sim/report.ts [number of seeds, default 12] [first seed, default 201]
 * Old rules: the counter as of commit 39a8dda (tests/sim/old-aggregate.ts). New rules: src/analysis/aggregate.ts.
 * Net: the new count less the pulls of the front listing expected to read as sales (src/analysis/history.ts).
 */
import { score, table, spread, type Score } from './evaluate.ts';

const n = Number(process.argv[2] ?? 12);
const first = Number(process.argv[3] ?? 201);
const seeds = Array.from({ length: n }, (_, i) => first + i);
const few = seeds.slice(0, Math.min(5, n));
const types = ['deep', 'thin', 'equipment'] as const;
const show = (title: string, ss: Score[]) => { console.log(`\n${title}`); console.log(table(ss)); };
console.log(`Sale counter against simulated truth: ${n} seeds from ${first}, 6 items each, 7 days, hourly snapshots.`);
console.log('"true sold" counts units bought from listings that were up at the previous snapshot; "unseen" were posted and bought inside one hour, invisible by design.');
console.log('Sellers pull every listing, the cheapest included, at the rates measured behind the cheapest on the real snapshots (B38).');
const main = types.map(t => score(t, seeds));
show('Headline, measured pull rates:', main);
console.log('\nSpread over seeds (mean and standard deviation of each seed\'s figure):');
for (const s of main) {
  const f = (k: 'oldDayError' | 'newDayError' | 'netDayError' | 'newBias' | 'netBias') => { const x = spread(s, p => p[k]); return `${(x.mean * 100).toFixed(1)} ± ${(x.sd * 100).toFixed(1)}%`; };
  console.log(`  ${s.type.padEnd(9)} daily error old ${f('oldDayError')}, new ${f('newDayError')}, net ${f('netDayError')}; bias new ${f('newBias')}, net ${f('netBias')}; age conflicts ${s.ageConflicts}`);
}
for (const h of [11, 15]) show(`LONG ends at ${h} hours instead of 12 (${few.length} seeds; the measured span is 11 to 15, B33):`, types.map(t => score(t, few, { longEndsAt: h * 60 })));
show(`No undercutting at all (${few.length} seeds):`, types.map(t => score(t, few, { undercutsPerHour: 0 })));
const twice = { deep: 2, thin: 0.16, equipment: 0.3 };
show(`Twice as much undercutting (${few.length} seeds):`, types.map(t => score(t, few, { undercutsPerHour: twice[t] })));
show(`No clock or bucket edge jitter (${few.length} seeds):`, types.map(t => score(t, few, { exactClock: true })));
const low = { deep: 0.003, thin: 0.004, equipment: 0.004 };
show(`Sellers pull almost nothing (the first simulator's 0.3 to 0.4% an hour, ${few.length} seeds):`, types.map(t => score(t, few, { cancelPerListingHour: low[t] })));
