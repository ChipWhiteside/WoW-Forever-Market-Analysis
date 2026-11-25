/**
 * Prints the simulator table: npx tsx tests/sim/report.ts [number of seeds, default 5]
 * Old rules: the counter as of commit 39a8dda (tests/sim/old-aggregate.ts). New rules: src/analysis/aggregate.ts.
 */
import { score, table } from './evaluate.ts';

const n = Number(process.argv[2] ?? 5);
const seeds = Array.from({ length: n }, (_, i) => 101 + i);
const types = ['deep', 'thin', 'equipment'] as const;
console.log(`Sale counter against simulated truth: ${n} seeds, 6 items each, 7 days, hourly snapshots.`);
console.log('"true sold" counts units bought from listings that were up at the previous snapshot; "unseen" were posted and bought inside one hour, invisible by design.\n');
console.log(table(types.map(t => score(t, seeds))));
console.log('\nLONG ends at 8 hours instead of 12 (the bucket edge not yet measured on Forever):');
console.log(table(types.map(t => score(t, seeds, { longEndsAt: 480 }))));
console.log('\nNo undercutting at all:');
console.log(table(types.map(t => score(t, seeds, { undercutsPerHour: 0 }))));
const twice = { deep: 2, thin: 0.16, equipment: 0.3 };
console.log('\nTwice as much undercutting:');
console.log(table(types.map(t => score(t, seeds, { undercutsPerHour: twice[t] }))));
