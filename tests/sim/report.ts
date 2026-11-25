/**
 * Prints the simulator table: npx tsx tests/sim/report.ts [number of seeds, default 5]
 * Old rules: the counter as of commit 39a8dda (tests/sim/old-aggregate.ts). New rules: src/analysis/aggregate.ts.
 */
import { score, table, MEASURED_CANCELS } from './evaluate.ts';

const n = Number(process.argv[2] ?? 5);
const seeds = Array.from({ length: n }, (_, i) => 101 + i);
const types = ['deep', 'thin', 'equipment'] as const;
console.log(`Sale counter against simulated truth: ${n} seeds, 6 items each, 7 days, hourly snapshots.`);
console.log('"true sold" counts units bought from listings that were up at the previous snapshot; "unseen" were posted and bought inside one hour, invisible by design.\n');
console.log(table(types.map(t => score(t, seeds))));
for (const h of [11, 15]) {
  console.log(`\nLONG ends at ${h} hours instead of 12 (the measured span is 11 to 15, B33):`);
  console.log(table(types.map(t => score(t, seeds, { longEndsAt: h * 60 }))));
}
console.log('\nNo undercutting at all:');
console.log(table(types.map(t => score(t, seeds, { undercutsPerHour: 0 }))));
const twice = { deep: 2, thin: 0.16, equipment: 0.3 };
console.log('\nTwice as much undercutting:');
console.log(table(types.map(t => score(t, seeds, { undercutsPerHour: twice[t] }))));
console.log(`\nSellers pull every listing, the cheapest included, as often as the real snapshots show for listings no buyer could reach`);
console.log(`(${types.map(t => `${t} ${(MEASURED_CANCELS[t] * 100).toFixed(1)}%`).join(', ')} of listings an hour, B38). A cautious case: the cheapest listing is rarely pulled by a cancel scan.`);
console.log(table(types.map(t => score(t, seeds, { cancelPerListingHour: MEASURED_CANCELS[t] }))));
