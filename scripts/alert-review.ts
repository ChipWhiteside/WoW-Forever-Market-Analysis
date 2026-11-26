/**
 * Were the flip alerts right? Lists recent Discord flip alerts and, for each, whether the flip was still live at the
 * next publishes and whether the product sold near the claimed price that night. Use it to tune the Good and Amazing
 * bars in Settings. Usage: npx tsx scripts/alert-review.ts [days, default 7]
 */
import { loadConfig } from '../src/config/env.ts';
import { openDb } from '../src/store/db.ts';
import { money } from '../src/format/money.ts';
import { reviewAlerts } from '../src/flips/alertReview.ts';

const days = Number(process.argv[2] ?? 7) || 7;
const db = openDb(loadConfig().dataDir);
const rows = reviewAlerts(db, { since: Date.now() - days * 24 * 3600_000 });
console.log(`\n${rows.length} flip alert${rows.length === 1 ? '' : 's'} in the last ${days} days.`);
for (const r of rows) {
  console.log(`\n${new Date(r.at).toLocaleString()}  ${r.tier.toUpperCase()}  ${r.key}`);
  console.log(`  claimed ${money(r.expectedProfit)} overnight, ${money(r.perItem)} each on ${r.units}`);
  console.log(`  ${r.verdict}${r.soldAll != null ? `; ${r.soldAll} sold in all over ${r.snapshots} publishes, floor ${money(r.floorMin)} to ${money(r.floorMax)}` : ''}`);
}
const live = rows.filter(r => r.runsAfter && r.liveNext === r.runsAfter).length;
const covered = rows.filter(r => r.soldNearClaim != null && r.soldNearClaim >= r.units).length;
if (rows.length) console.log(`\nStill live at every next run: ${live} of ${rows.length}. Sold near the claim for the full amount: ${covered} of ${rows.filter(r => r.soldNearClaim != null).length} sold on a house.`);
db.close();
