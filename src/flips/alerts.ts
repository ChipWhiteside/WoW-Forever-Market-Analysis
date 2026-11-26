import type { DB } from '../store/db.ts';
import { getKv, setKv, tx } from '../store/db.ts';
import { money } from '../format/money.ts';
import { FLIP_ALERTS } from '../rules/flips.ts';
import { alertSettings, isQuiet, sendDiscord } from '../alerts/discord.ts';
import type { Flip, FlipRunReport } from './types.ts';

/**
 * Discord alerts for the best flips only (Chip, November 26, docs/flip-plan.md section 0).
 * Every flip that clears every gate in one run is sent, Amazing first, in as few posts as Discord's 2,000 characters allow.
 * Each alert is logged in flip_alerts so the bars can be tuned (scripts/alert-review.ts). A row is claimed (pending)
 * before its post goes out, in the same transaction as the repeat check, then marked sent or failed: two overlapping
 * runs never send one flip twice, and a failed post is retried by the next run (refresh round 1 finding A).
 */
export type Tier = 'good' | 'amazing';

export interface FlipAlertSettings { good: number; amazing: number }

/** The bars in copper. Settings hold gold (alert_good_gold 10, alert_amazing_gold 20). */
export function flipAlertSettings(db: DB): FlipAlertSettings {
  const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const gold = (k: string, d: number) => { const n = Number(get(k)); return Math.round((get(k) != null && get(k) !== '' && Number.isFinite(n) && n >= 0 ? n : d) * 10000); };
  return { good: gold(FLIP_ALERTS.goodSetting, FLIP_ALERTS.goodGold), amazing: gold(FLIP_ALERTS.amazingSetting, FLIP_ALERTS.amazingGold) };
}

/** The expected profit an alert is judged on: the lower of the standalone and the shared pass numbers. */
export const alertProfit = (f: Flip) => Math.min(f.best.expectedProfit, f.afterShared?.expectedProfit ?? f.best.expectedProfit);

/** Why a flip does not alert, or its tier. Pure. */
export function judgeFlip(f: Flip, s: FlipAlertSettings, held: Set<string> = new Set()): { tier: Tier } | { tier: null; reason: string } {
  const ep = alertProfit(f);
  if (ep < s.good) return { tier: null, reason: `expected ${money(ep)}, under the Good bar of ${money(s.good)}` };
  if (f.best.risk.level === 'high') return { tier: null, reason: 'high risk' };
  if (!(f.sellQuote.strength >= FLIP_ALERTS.minStrength)) return { tier: null, reason: `strength ${f.sellQuote.strength}, under ${FLIP_ALERTS.minStrength}` };
  if (f.sellHouseId != null && (f.sellQuote.hoursWatched < FLIP_ALERTS.minHoursWatched || f.sellQuote.lowPending))
    return { tier: null, reason: `learning: ${Math.round(f.sellQuote.hoursWatched * 10) / 10} of ${FLIP_ALERTS.minHoursWatched} hours of sales seen` };
  if (f.setup?.unknown) return { tier: null, reason: 'learn source unknown' };
  if (held.has(f.key)) return { tier: null, reason: 'held back' };
  return { tier: ep >= s.amazing ? 'amazing' : 'good' };
}

export interface Chosen { flip: Flip; tier: Tier; profit: number }

/** One block per flip: tier and item, numbers, buy line, sell line, link. */
export function formatFlipBlock(c: Chosen, appUrl: string | null): string {
  const f = c.flip;
  const buy = f.buy.filter(l => l.kind !== 'craft').map(l => `${l.units} ${l.name} at ${money(l.unitPrice)} (${l.who})`).join('; ') || 'nothing to buy';
  const sell = `${f.sell.units} at ${money(f.sellQuote.claimPrice)} (${f.sell.who})`;
  const lines = [
    `**${c.tier === 'amazing' ? 'AMAZING' : 'Good'}** · ${f.kind === 'craft' ? 'Crafting' : 'Flipping'}: **${f.name}**`,
    `Expected overnight **${money(c.profit)}** · ${money(f.perItem)} per item · best amount ${f.best.units} · risk ${f.best.risk.level} · strength ${f.sellQuote.strength}`,
    `Buy: ${buy}`,
    `Sell: ${sell}`,
  ];
  if (appUrl) lines.push(`${appUrl.replace(/\/$/, '')}/#flips`);
  // One block never fills a post on its own: a very long buy line is cut, the app has the rest.
  const room = FLIP_ALERTS.maxChars - 100;
  let text = lines.join('\n');
  if (text.length > room) { lines[2] = lines[2]!.slice(0, Math.max(40, lines[2]!.length - (text.length - room) - 30)) + '… (rest in the app)'; text = lines.join('\n'); }
  return text;
}

/** Posts under 2,000 characters each, every block whole, Amazing first. */
export function formatFlipAlerts(chosen: Chosen[], appUrl: string | null): Array<{ body: string; keys: string[] }> {
  const sorted = [...chosen].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'amazing' ? -1 : 1) || b.profit - a.profit);
  const head = (n: number) => `**${n} flip${n === 1 ? '' : 's'} worth doing now**`;
  const posts: Array<{ blocks: string[]; keys: string[] }> = [];
  let cur: { blocks: string[]; keys: string[] } = { blocks: [], keys: [] };
  const len = (p: typeof cur) => head(sorted.length).length + p.blocks.reduce((s, b) => s + b.length + 2, 0);
  for (const c of sorted) {
    const block = formatFlipBlock(c, appUrl);
    if (cur.blocks.length && len(cur) + block.length + 2 > FLIP_ALERTS.maxChars - 20) { posts.push(cur); cur = { blocks: [], keys: [] }; }
    cur.blocks.push(block); cur.keys.push(c.flip.key);
  }
  if (cur.blocks.length) posts.push(cur);
  return posts.map((p, i) => ({
    body: [posts.length > 1 ? `${head(sorted.length)} (${i + 1} of ${posts.length})` : head(sorted.length), ...p.blocks].join('\n\n'),
    keys: p.keys,
  }));
}

const PENDING = 'flip_alerts_pending';
/** A claim not marked sent or failed within this long belongs to a run that died while sending. */
const PENDING_STALE_MS = 10 * 60_000;

export interface FlipAlertResult { sent: number; posts: number; skipped: string | null; held: number }

/**
 * Send every flip of one run that clears the gates. A key sent in the last 24 hours waits unless its expected profit
 * grew by 25 percent. In quiet hours the alerts are held and sent once the quiet period ends, if still live.
 */
export async function flipAlertCycle(db: DB, webhookUrl: string | null, flips: Flip[], report: Pick<FlipRunReport, 'complete' | 'dataAt'>,
  opts: { now?: number; fetchFn?: typeof fetch; appUrl?: string | null; held?: Set<string> } = {}): Promise<FlipAlertResult> {
  const now = opts.now ?? Date.now();
  const none = (skipped: string, held = 0): FlipAlertResult => ({ sent: 0, posts: 0, skipped, held });
  if (!report.complete) return none('run incomplete');
  if (now - report.dataAt > FLIP_ALERTS.freshMinutes * 60_000) return none('data not fresh');
  const s = flipAlertSettings(db);
  const quiet = isQuiet(now, alertSettings(db));
  // A failed post never counts as sent: only sent rows, and pending rows a run is still sending, block a repeat.
  // A pending row older than PENDING_STALE_MS was left by a run that died mid send and is retried.
  const last = db.prepare(`SELECT at, expected_profit FROM flip_alerts WHERE key = ? AND (status = 'sent' OR (status = 'pending' AND at >= ?)) ORDER BY at DESC LIMIT 1`);
  const claim = db.prepare(`INSERT OR REPLACE INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, item_id, house_id, claim_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
  const pick = (): Chosen[] => {
    const chosen: Chosen[] = [];
    for (const f of flips) {
      const j = judgeFlip(f, s, opts.held);
      if (!j.tier) continue;
      const profit = alertProfit(f);
      const prev = last.get(f.key, now - PENDING_STALE_MS) as { at: number; expected_profit: number } | undefined;
      if (prev && now - prev.at < FLIP_ALERTS.repeatHours * 3600_000 && profit < prev.expected_profit * (1 + FLIP_ALERTS.regrowth)) continue;
      chosen.push({ flip: f, tier: j.tier, profit });
    }
    return chosen;
  };
  // The repeat check and the claim are one transaction with no await inside, so no other run can slip between them.
  const chosen = quiet || !webhookUrl ? pick() : tx(db, () => {
    const c = pick();
    for (const x of c) claim.run(x.flip.key, now, x.tier, x.profit, x.flip.perItem, x.flip.best.units, x.flip.dataAt, x.flip.itemId, x.flip.sellHouseId, x.flip.sellQuote.claimPrice);
    return c;
  });
  if (!chosen.length) { if (!quiet) setKv(db, PENDING, '[]'); return none('nothing new'); }
  if (quiet) {
    const pending = new Set<string>(JSON.parse(getKv(db, PENDING) ?? '[]') as string[]);
    for (const c of chosen) pending.add(c.flip.key);
    setKv(db, PENDING, JSON.stringify([...pending]));
    return none('quiet hours', chosen.length);
  }
  if (!webhookUrl) return none('no webhook set');
  let sent = 0, posts = 0;
  const mark = db.prepare('UPDATE flip_alerts SET status = ? WHERE key = ? AND at = ?');
  const failed: string[] = [];
  for (const p of formatFlipAlerts(chosen, opts.appUrl ?? null)) {
    const ok = await sendDiscord(webhookUrl, p.body, opts.fetchFn);
    db.prepare('INSERT INTO alerts_sent (at, channel, plays, body, ok) VALUES (?, ?, ?, ?, ?)').run(now, 'discord_flips', p.keys.length, p.body, ok ? 1 : 0);
    for (const k of p.keys) mark.run(ok ? 'sent' : 'failed', k, now);
    if (!ok) { failed.push(...p.keys); continue; }
    posts++;
    sent += p.keys.length;
  }
  // Held alerts whose post failed stay held, so the flush after quiet hours retries them instead of dropping them.
  setKv(db, PENDING, JSON.stringify(failed));
  return { sent, posts, skipped: sent ? null : 'discord failed', held: 0 };
}

/**
 * Called every engine round: once quiet hours end, alerts held during them go out if their flips are still on the
 * latest complete, fresh list and still clear every gate.
 */
export async function flushHeldFlipAlerts(db: DB, webhookUrl: string | null, opts: { now?: number; fetchFn?: typeof fetch; appUrl?: string | null } = {}): Promise<FlipAlertResult | null> {
  const now = opts.now ?? Date.now();
  const pending = JSON.parse(getKv(db, PENDING) ?? '[]') as string[];
  if (!pending.length || isQuiet(now, alertSettings(db))) return null;
  const run = db.prepare('SELECT data_at, complete FROM flip_runs ORDER BY at DESC LIMIT 1').get() as { data_at: number; complete: number } | undefined;
  const want = new Set(pending);
  const flips = (db.prepare(`SELECT key, detail FROM flips WHERE state != 'gone'`).all() as Array<{ key: string; detail: string }>)
    .filter(r => want.has(r.key)).map(r => JSON.parse(r.detail) as Flip);
  if (!run || !flips.length) { setKv(db, PENDING, '[]'); return { sent: 0, posts: 0, skipped: 'held alerts no longer live', held: 0 }; }
  return flipAlertCycle(db, webhookUrl, flips, { complete: !!run.complete, dataAt: run.data_at }, opts);
}
