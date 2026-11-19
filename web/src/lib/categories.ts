import { useEffect, useState } from 'react';

/**
 * Item categories for filtering, straight from the game's own item class and subclass (Blizzard item data), so new
 * classes appear on their own. Chip's hidden categories are remembered in this browser.
 */
export interface Categorized { item_class?: string | null; item_subclass?: string | null }

const PLURAL: Record<string, string> = {
  Recipe: 'Recipes', 'Trade Goods': 'Crafting materials', Consumable: 'Consumables', Weapon: 'Weapons', Armor: 'Armor',
  Container: 'Bags', Reagent: 'Reagents', Projectile: 'Ammo', Quiver: 'Quivers', Quest: 'Quest items', Key: 'Keys',
  Miscellaneous: 'Miscellaneous', Gem: 'Gems', 'Item Enhancement': 'Enhancements',
};
export const categoryOf = (x: Categorized) => x.item_class ? PLURAL[x.item_class] ?? x.item_class : 'Other';
export const subcategoryOf = (x: Categorized) => x.item_subclass || 'Other';
/** A key for one subcategory inside its category. */
export const subKey = (x: Categorized) => `${categoryOf(x)} / ${subcategoryOf(x)}`;

const STORE = 'hidden-categories';
export function loadHidden(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STORE) ?? '[]') as string[]); } catch { return new Set(); }
}
export function saveHidden(h: Set<string>): void {
  try { localStorage.setItem(STORE, JSON.stringify([...h])); } catch { /* private window: fine for this visit */ }
}
/** Hidden when its whole category is hidden, or its own subcategory is. */
export const isHidden = (x: Categorized, hidden: Set<string>) => hidden.has(categoryOf(x)) || hidden.has(subKey(x));

// A tiny shared store so every list on the page hides the same things at once.
let current = loadHidden();
const listeners = new Set<(h: Set<string>) => void>();
export function setHidden(h: Set<string>) { current = new Set(h); saveHidden(current); listeners.forEach(l => l(current)); }
export function useHidden(): [Set<string>, (h: Set<string>) => void] {
  const [h, set] = useState(current);
  useEffect(() => { listeners.add(set); return () => { listeners.delete(set); }; }, []);
  return [h, setHidden];
}
