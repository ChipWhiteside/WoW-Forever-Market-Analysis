import { describe, it, expect } from 'vitest';
import { categoryOf, subKey, isHidden } from '../../web/src/lib/categories.ts';

describe('item categories', () => {
  const recipe = { item_class: 'Recipe', item_subclass: 'Blacksmithing' };
  const cloth = { item_class: 'Trade Goods', item_subclass: 'Cloth' };
  it('uses plain names and falls back to the game name or Other', () => {
    expect(categoryOf(recipe)).toBe('Recipes');
    expect(categoryOf(cloth)).toBe('Crafting materials');
    expect(categoryOf({ item_class: 'Something New' })).toBe('Something New');
    expect(categoryOf({})).toBe('Other');
  });
  it('hides a whole category, or just one subcategory', () => {
    expect(isHidden(recipe, new Set(['Recipes']))).toBe(true);
    expect(isHidden(cloth, new Set(['Recipes']))).toBe(false);
    expect(isHidden(recipe, new Set([subKey(recipe)]))).toBe(true);
    expect(isHidden({ item_class: 'Recipe', item_subclass: 'Tailoring' }, new Set([subKey(recipe)]))).toBe(false);
  });
});
