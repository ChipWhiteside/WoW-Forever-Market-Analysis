import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Agreed page content must never disappear or be pushed down silently (docs/page-contracts.md).
 * November 20: a new recipe table was put above the leveling steps and Chip lost the plan he relied on.
 * Each list is in display order. A failure here means a change removed or reordered agreed content:
 * restore it, or get Chip's explicit go ahead and update docs/page-contracts.md with this test.
 */
const src = (p: string) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');
function inOrder(text: string, marks: string[]) {
  let at = -1;
  for (const m of marks) {
    const i = text.indexOf(m, at + 1);
    expect(i, `"${m}" missing, or not after the item before it`).toBeGreaterThan(at);
    at = i;
  }
}
const section = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

describe('page contracts', () => {
  it('play card keeps Buy, Sell, Why, Price, Volume, List and Strength, in order', () => {
    inOrder(src('components/PlayCard.tsx'), ['label="Buy"', 'label="Sell"', '>Why<', '>Price<', '>Volume<', '>List<', 'strength ']);
  });
  it('leveling plan keeps the steps table first, then materials, then recipes to learn', () => {
    const lv = section(src('pages/crafting.tsx'), 'function Leveling()', '\nfunction ');
    inOrder(lv, ['from <input', 'to <input', 'Materials to buy', 'Sell these instead',
      '>Skill<', '>Make<', '>Crafts<', '>Each craft takes<', '>Learn<', '>Colors<',
      'Materials for this range', '>Material<', '>Need<', '>From your bags<', '>Made from your bags<', '>To buy<', '>Cheapest way<', '>Cost<',
      '<RecipesToLearn']);
  });
  it('recipes to learn keeps learn at, recipe, cost and where', () => {
    inOrder(section(src('pages/crafting.tsx'), 'function RecipesToLearn', '\nfunction '), ['>Learn at<', '>Recipe<', '>Cost<', '>Where<']);
  });
  it('profit board keeps its columns', () => {
    inOrder(section(src('pages/crafting.tsx'), 'function ProfitBoard', '\nfunction '), ['>Item<', '>Costs each<', '>Sells each<', '>Profit each<', '>Sell a day<', '>List for<']);
  });
  it('now page keeps the held back list', () => {
    expect(src('pages/now.tsx')).toContain('Held back this hour');
  });
  it('flips page keeps run status, filters, the list and held back', () => {
    inOrder(src('pages/flips.tsx'), ['Data from', '>Crafting (', '>Flipping (', 'Lowest risk', '<FlipCard', 'Held back this hour']);
  });
  it('flips page has the Refresh button beside the run status, before the filters (Chip, November 26)', () => {
    const page = section(src('pages/flips.tsx'), 'export function FlipsPage', '\nfunction ');
    inOrder(page, ['Data from', 'complete</Chip>', '<RefreshButton />', '>Crafting (']);
    const btn = section(src('pages/flips.tsx'), 'function RefreshButton', '\nfunction ');
    expect(btn).toContain("'/api/flips/refresh'");
    expect(btn).toContain("'Checking Blizzard...'");
    expect(btn).toContain('animate-spin');
    expect(src('pages/flips.tsx')).toContain('Blizzard publishes about ${minute} past each hour, next one about ${hhmm}');
  });
  it('flips page says which flips go to Discord, live bars from settings, after Refresh before the filters (Chip, November 27)', () => {
    const page = section(src('pages/flips.tsx'), 'export function FlipsPage', '\nfunction ');
    inOrder(page, ['<RefreshButton />', '<DiscordLine />', '>Crafting (']);
    const line = section(src('pages/flips.tsx'), 'function DiscordLine', '\n}\n');
    expect(line).toContain("'/api/settings'");
    inOrder(line, ['Discord gets Good (', "alert_good_gold", 'g or more) and Amazing (', "alert_amazing_gold", 'g or more) flips that are low or medium risk with solid evidence']);
  });
  it('settings keep every field, with the flip alert bars and the play alerts checkbox below (Chip, November 26)', () => {
    inOrder(section(src('pages/misc.tsx'), 'export function SettingsPage', '\nexport function '), ["'Gold on hand'", "'Alert bar, in silver'", "'Quiet from (hour)'", 'Your professions',
      "'Crafting session, in minutes'", 'Only craft sub steps in my professions', "'Good flip alert, in gold'", "'Amazing flip alert, in gold'", 'Also send the old play alerts', "'Saved' : 'Save'"]);
  });
  it('flip card keeps its lines in order, crafting green and flipping blue', () => {
    const card = section(src('pages/flips.tsx'), 'export function FlipCard', '\nfunction ');
    expect(card).toContain("craft ? 'bg-craft' : 'bg-flip'");
    inOrder(card, ["'Crafting' : 'Flipping'", 'open ${d.openHours72} of the last 72 hours', 'expected overnight', 'per item', "'Buy'", '<Label>Make</Label>', 'label="Sell"', '<Label>Price</Label>', '<Label>Volume</Label>', '<Label>Risk</Label>', '<Label>Setup</Label>', '<Label>Shares</Label>', 'strength {q.strength}', 'an hour of work', '>Amount<', '>Units<', '>Cost<', '>Sells overnight<', '>Expected profit<', '>Per hour<', '>Risk<', '>Bad case<']);
  });
  it('flip card: Make first steps come before Make, and long Buy or Make first lists fold behind "show N more", never cut', () => {
    const card = section(src('pages/flips.tsx'), 'export function FlipCard', '\nfunction ');
    inOrder(card, ["'Buy'", '<MoreLine', 'first="Make first"', '<MoreLine', '<Label>Make</Label>']);
    expect(src('pages/flips.tsx')).toContain('`show ${hidden} more`');
    expect(card).toContain('allBuy ? bought : bought.slice(0, LINES_SHOWN)');
    expect(card).toContain('allSteps ? steps : steps.slice(0, LINES_SHOWN)');
  });
  it('flip card ends with I did this and, for flips you did, Sold, after everything agreed before (phase 2, November 27)', () => {
    const page = src('pages/flips.tsx');
    const card = section(page, 'export function FlipCard', '\nfunction ');
    inOrder(card, ['>Bad case<', 'd.notes.length > 0', '<FlipActions f={f} />']);
    const actions = section(page, 'function FlipActions', '\nfunction ');
    inOrder(actions, ["'/api/ledger'", '/did`', '>I did this<', '<SoldLine']);
    const sold = section(page, 'function SoldLine', '\nfunction ');
    inOrder(sold, ['/sold`', 'You did', '>Sold<', 'units <input', 'gold received <input']);
  });
  it('Ledger page is in the menu under Mine after Watchlist, with per person totals then history (phase 2, November 27)', () => {
    inOrder(src('App.tsx'), ["id: 'positions'", "id: 'watchlist'", "id: 'ledger', label: 'Ledger', group: 'Mine', el: LedgerPage", "id: 'market'"]);
    inOrder(src('pages/ledger.tsx'), ["'/api/ledger'", '>Person<', '>Flips done<', '>Gold spent<', '>Gold received<', '>Realised minus spent<', '>Expected<', '>Realised against expected<', '>History<']);
  });
  it('Refresh online says it is running on GitHub with the same spinner, then the result, beside the run status (phase 2 on GitHub, November 27)', () => {
    const page = section(src('pages/flips.tsx'), 'export function FlipsPage', '\nfunction ');
    inOrder(page, ['Data from', '<RefreshButton />', '<DiscordLine />', '>Crafting (']);
    const btn = section(src('pages/flips.tsx'), 'function RefreshButton', '\nfunction ');
    inOrder(btn, ["'/api/flips/refresh'", 'res.status === 202', "'Running on GitHub, usually 1 to 2 minutes.'", '/api/flips/refresh/status', 'Updated on GitHub.', 'animate-spin', "'Running on GitHub...' : 'Checking Blizzard...'"]);
  });
  it('saved writes show as pending, below everything agreed, on the flip card and the Ledger (phase 2 on GitHub, November 27)', () => {
    const actions = section(src('pages/flips.tsx'), 'function FlipActions', '\nfunction ');
    inOrder(actions, ['>I did this<', '<SoldLine', 'pending.map', 'saved, counts at the next update.']);
    inOrder(src('pages/ledger.tsx'), ['>Person<', '>Realised against expected<', '>History<', 'data.history.map', 'Saved, counts at the next update', 'data.pending.map', 'saved, counts at the next update']);
  });
  it('flips page shows the health banner last in the run status card, online, when results are over 2 hours old (phase 2, round 1)', () => {
    const page = section(src('pages/flips.tsx'), 'export function FlipsPage', '\nfunction ');
    inOrder(page, ['Data from', '<RefreshButton />', '<DiscordLine />', '<StaleBanner online={!!data?.online}', '</Card>', '>Crafting (']);
    const banner = section(src('pages/flips.tsx'), 'export function StaleBanner', '\n}\n');
    inOrder(banner, ['!online', '2 * 3600_000', 'Hourly updates have not run since {when}. Check the Actions tab on GitHub.']);
    expect(section(src('pages/flips.tsx'), 'function RefreshButton', '\nfunction ')).toContain('usually 1 to 2 minutes, up to about 15 when it waits for Blizzard to publish.');
  });
  it('ledger lists saved writes that were not applied, with the reason, below the saved list (phase 2, round 1)', () => {
    inOrder(src('pages/ledger.tsx'), ['>History<', 'data.pending.map', 'Saved but not applied', 'data.refused', 'not applied: {p.reason}']);
  });
  it('login page asks for a name and the password, and the menu keeps its items above Signed in as (phase 2, November 27)', () => {
    inOrder(src('pages/login.tsx'), ["'/api/login'", 'Your name', 'Password', "'Sign in'"]);
    inOrder(src('App.tsx'), ['Search anywhere: Ctrl K', "'Dark'} mode", 'Signed in as', 'Sign out']);
  });
});
