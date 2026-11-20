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
});
