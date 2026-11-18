import { describe, it, expect } from 'vitest';
import { vendorFaction, vendorUnitPrice, mergeVendors, mergeLoot, parseLootKey } from '../../src/datasets/eglink.ts';

const S = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe('vendor faction (test T4)', () => {
  it('Horde NPC seen Friendly by Horde is Horde (Nerrist)', () => expect(vendorFaction(S({ Horde: [5, 6] }), new Set(['Horde']))).toBe('horde'));
  it('Alliance NPC is Alliance (Edna Mullby)', () => expect(vendorFaction(S({ Alliance: [5, 6] }), new Set(['Alliance']))).toBe('alliance'));
  it('goblin seen only at Neutral is neutral (Old Man Heming)', () => expect(vendorFaction(S({ Horde: [4] }), new Set())).toBe('neutral'));
  it('seen usable by both is neutral', () => expect(vendorFaction(S({ Alliance: [4], Horde: [4] }), new Set())).toBe('neutral'));
  it('no observations is unknown', () => expect(vendorFaction({}, new Set())).toBe('unknown'));
});

describe('vendor price', () => {
  it('backs the Friendly base price out of an Honored only record', () => expect(vendorUnitPrice({ '6': 225 }, 1)).toBe(250));
  it('uses the exact price at a known standing', () => expect(vendorUnitPrice({ '5': 250, '6': 225 }, 1, 6)).toBe(225));
  it('divides by the purchase stack', () => expect(vendorUnitPrice({ '5': 250 }, 10)).toBe(25));
});

describe('mergeVendors', () => {
  it('newest build wins and skips entries without a plain gold price', () => {
    const v = mergeVendors([
      { build: '1.60.1.70900', vendors: { '1': { name: 'A', entries: { 'item:6532': { itemId: 6532, costs: { '5': 300 } } } } }, npcs: {}, creatures: { '1': { reactions: { Alliance: [5] } } } },
      { build: '1.60.1.70950', vendors: { '1': { name: 'A', entries: { 'item:6532': { itemId: 6532, costs: { '5': 250 } }, 'item:9': { itemId: 9, costs: { '5': 1 }, costItems: [{ itemId: 1 }] } } }, '2': { name: 'NoEntries' } }, npcs: {}, creatures: {} },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.costs).toEqual({ '5': 250 });
    expect(v[0]!.minStanding).toBe(5);
    expect(v[0]!.faction).toBe('alliance');
  });
});

describe('mergeLoot', () => {
  it('parses keys and drops group windows', () => {
    expect(parseLootKey('npc:3258|quest|group')).toMatchObject({ base: 'npc:3258', group: true, quest: true });
    expect(parseLootKey('object:1731|spell:2575')).toMatchObject({ base: 'object:1731' });
    expect(parseLootKey('npc:3|spell:8613')).toMatchObject({ base: 'npc:3|spell:8613', spell: 8613 });
  });
  it('adds counts across builds and weights by the share of corpses with loot', () => {
    const l = mergeLoot([
      { sources: { 'npc:1': { windows: 8, items: { '100': { drops: 4, quantity: 8 } } } }, kills: { 'npc:1': { deaths: 10, empty: 2, unknown: 0 } } },
      { sources: { 'npc:1|quest': { windows: 8, items: { '100': { drops: 4, quantity: 8 }, '200': { drops: 1, quest: 55 } } }, 'npc:1|group': { windows: 100, items: { '100': { drops: 100 } } } }, kills: { 'npc:1|quest': { deaths: 10, empty: 2, unknown: 0 } } },
    ]);
    expect(l).toHaveLength(1); // quest item 200 left out, group ignored
    // share 16/20 = 0.8, drops/windows 8/16 = 0.5, chance 0.4, 2 per drop
    expect(l[0]!.chance).toBe(0.4);
    expect(l[0]!.perKill).toBeCloseTo(0.8);
    expect(l[0]!.kills).toBe(20);
  });
});

describe('mergeVendors drops items the newest build no longer lists', () => {
  it('a hotfixed away item does not linger', () => {
    const v = mergeVendors([
      { build: '1.0.0.1', vendors: { '1': { entries: { a: { itemId: 10, costs: { '5': 100 } }, b: { itemId: 11, costs: { '5': 100 } } } } }, npcs: {}, creatures: {} },
      { build: '1.0.0.2', vendors: { '1': { entries: { a: { itemId: 10, costs: { '5': 120 } } } } }, npcs: {}, creatures: {} },
    ]);
    expect(v.map(x => x.itemId)).toEqual([10]);
    expect(v[0]!.costs['5']).toBe(120);
  });
});
