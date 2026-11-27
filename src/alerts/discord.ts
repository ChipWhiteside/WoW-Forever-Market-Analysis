import { money } from '../format/money.ts';
import type { DB } from '../store/db.ts';
import { ALERTS } from '../rules/thresholds.ts';
import { PLAY_ALERTS_SETTING } from '../rules/flips.ts';
import type { Play } from '../detectors/types.ts';

const ALERTING = new Set(['vendor_dump', 'vendor_supply', 'underpriced', 'cross_house', 'sell_now']);
export const LABEL: Record<string, string> = {
  vendor_dump: 'Auction house to vendor', vendor_supply: 'Vendor to auction house', underpriced: 'Cheap listing, relist', cross_house: 'Between houses',
  craft: 'Craft', sell_now: 'Sell what you hold', world_drop: 'World drop',
};

export interface AlertSettings { profitBar: number; quietStart: number; quietEnd: number; timeZone: string; enabled: Set<string>; playAlerts: boolean }

export function alertSettings(db: DB): AlertSettings {
  const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  return {
    profitBar: Number(get('profit_bar') ?? ALERTS.profitBar),
    quietStart: Number(get('quiet_start') ?? ALERTS.quietStartHour),
    quietEnd: Number(get('quiet_end') ?? ALERTS.quietEndHour),
    timeZone: get('time_zone') ?? 'America/Denver',
    enabled: new Set(JSON.parse(get('alert_detectors') ?? JSON.stringify([...ALERTING])) as string[]),
    // Off by default since November 26: Discord carries only the best flips (src/flips/alerts.ts) unless Chip turns these on.
    playAlerts: get(PLAY_ALERTS_SETTING) === '1',
  };
}

export function isQuiet(now: number, s: Pick<AlertSettings, 'quietStart' | 'quietEnd' | 'timeZone'>): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: s.timeZone }).format(now));
  return s.quietStart > s.quietEnd ? hour >= s.quietStart || hour < s.quietEnd : hour >= s.quietStart && hour < s.quietEnd;
}

/**
 * Pick the plays worth a message: alerting detector, on a pinned house, over the profit bar, from fresh data,
 * and either never alerted or grown by 25 percent since the last alert. Never "nothing here".
 */
export function selectForAlert(db: DB, candidates: Play[], pinned: Set<number>, s: AlertSettings, now = Date.now()): Play[] {
  const prev = db.prepare('SELECT alerted_profit FROM plays WHERE key = ?');
  return candidates
    // Cross house needs two houses fresh at once; one late house should not silence it (review finding 8).
    .filter(p => p.confidence !== 'low') // watch plays stay in the app, never on the phone
    .filter(p => s.enabled.has(p.detector) && pinned.has(p.houseId) && p.profit >= s.profitBar && now - p.dataAt < (p.detector === 'cross_house' ? 150 : 90) * 60_000)
    .filter(p => {
      const r = prev.get(p.key) as { alerted_profit: number | null } | undefined;
      return r?.alerted_profit == null || p.profit >= r.alerted_profit * (1 + ALERTS.regrowth);
    })
    .sort((a, b) => b.profit - a.profit);
}

export function formatAlert(plays: Play[], appUrl: string | null): string {
  const lines = [`**${plays.length} new play${plays.length === 1 ? '' : 's'}**`];
  for (const p of plays.slice(0, 12)) {
    const d = p.detail as { score?: number; costToDo?: number; realisticUnits: number };
    const strengthText = typeof d.score === 'number' ? ` Strength ${d.score}/100.` : '';
    lines.push(`• **${LABEL[p.detector]}**: ${p.summary} Worth doing ${d.realisticUnits}, costs ${money(d.costToDo ?? 0)}, makes about **${money(p.profit)}**.${strengthText}`);
  }
  if (plays.length > 12) lines.push(`…and ${plays.length - 12} more in the app.`);
  if (appUrl) lines.push(appUrl);
  return lines.join('\n').slice(0, 1990);
}

/** A hung webhook must not hold the engine lock: after this long the post counts as failed and is retried next run. */
export const DISCORD_TIMEOUT_MS = 15_000;

export async function sendDiscord(webhookUrl: string, content: string, fetchFn: typeof fetch = fetch, timeoutMs = DISCORD_TIMEOUT_MS): Promise<boolean> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => { ctl.abort(); resolve(false); }, timeoutMs); });
  try {
    const post = fetchFn(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: ctl.signal })
      .then(res => res.ok, () => false);
    // Raced, so a fetch that ignores the abort signal still ends at the timeout.
    return await Promise.race([post, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Send one message for this cycle if anything qualifies. Records what was sent so repeats stay quiet. */
export async function alertCycle(db: DB, webhookUrl: string | null, candidates: Play[], pinned: Set<number>, opts: { now?: number; fetchFn?: typeof fetch; appUrl?: string | null } = {}): Promise<{ sent: number; skipped: string | null }> {
  const now = opts.now ?? Date.now();
  const s = alertSettings(db);
  if (!s.playAlerts) return { sent: 0, skipped: 'play alerts off' };
  const chosen = selectForAlert(db, candidates, pinned, s, now);
  if (chosen.length === 0) return { sent: 0, skipped: 'nothing new' };
  if (isQuiet(now, s)) return { sent: 0, skipped: 'quiet hours' };
  if (!webhookUrl) return { sent: 0, skipped: 'no webhook set' };
  const body = formatAlert(chosen, opts.appUrl ?? null);
  const ok = await sendDiscord(webhookUrl, body, opts.fetchFn);
  db.prepare('INSERT INTO alerts_sent (at, channel, plays, body, ok) VALUES (?, ?, ?, ?, ?)').run(now, 'discord', chosen.length, body, ok ? 1 : 0);
  if (ok) {
    const mark = db.prepare('UPDATE plays SET alerted_profit = ? WHERE key = ?');
    for (const p of chosen) mark.run(p.profit, p.key);
  }
  return { sent: ok ? chosen.length : 0, skipped: ok ? null : 'discord failed' };
}
