import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vendorFaction, steamwheedleTown, vendorUnitPrice, UNUSABLE_GATE, vendorBasePrice, vendorGate, mergeVendors, mergeTrainers, mergeLoot, parseLootKey, npcNames, isHangul, applyGameToEgLink, STANDING_DISCOUNT,
  type EgVendor, type EgNpc, type EgCreature, type EgTrainer } from '../../src/datasets/eglink.ts';
import { loadGameDataFromDir } from '../../src/datasets/gamedata.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDir } from '../helpers.ts';

const game = loadGameDataFromDir(fileURLToPath(new URL('../fixtures/wago', import.meta.url)), '1.60.1.71037');

const S = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe('vendor faction (test T4)', () => {
  it('Horde NPC seen Friendly by Horde is Horde (Nerrist)', () => expect(vendorFaction(S({ Horde: [5, 6] }), new Set(['Horde']))).toBe('horde'));
  it('Alliance NPC is Alliance (Edna Mullby)', () => expect(vendorFaction(S({ Alliance: [5, 6] }), new Set(['Alliance']))).toBe('alliance'));
  it('Old Man Heming (2626) is usable: Chip bought Bright Baubles from him in game (B3, V22)', () => {
    expect(vendorFaction(S({ Horde: [4] }), new Set(), 2626)).toBe('neutral');
    expect(vendorFaction(S({ Horde: [4, 5] }), new Set(), 2626)).toBe('neutral');
  });
  // Round 2 fix 7: seen only by Horde at Neutral, outside a Steamwheedle town and not a named case: unconfirmed.
  it('seen only by Horde at Neutral elsewhere is unconfirmed, not neutral', () => expect(vendorFaction(S({ Horde: [4] }), new Set())).toBe('unconfirmed'));
  it('a Steamwheedle town NPC is neutral, even if only Horde saw it, unless Alliance saw it hostile', () => {
    expect(steamwheedleTown(1434, 28.1, 78)).toBe('Booty Bay');    // Glyx Brewright
    expect(steamwheedleTown(1413, 62.7, 36.3)).toBe('Ratchet');    // Gagsprocket
    expect(steamwheedleTown(1446, 51.5, 28.7)).toBe('Gadgetzan');  // Krinkle Goodsteel
    expect(steamwheedleTown(1452, 61.2, 37.1)).toBe('Everlook');   // Qia
    expect(steamwheedleTown(1413, 41.8, 38.6)).toBeNull();          // Kiknikle, not in Ratchet
    expect(steamwheedleTown(1434, 32.7, 29.2)).toBeNull();          // Nerrist, Grom'gol
    expect(vendorFaction(S({ Horde: [4, 5] }), new Set(), 1, 'Ratchet')).toBe('neutral');
    expect(vendorFaction(S({ Horde: [4] }), new Set(['Horde']), 1, 'Ratchet')).toBe('horde');
    expect(vendorFaction(S({ Horde: [5], Alliance: [2] }), new Set(), 1, 'Ratchet')).toBe('horde');
  });
  it('seen by Alliance at Neutral is neutral', () => expect(vendorFaction(S({ Alliance: [4] }), new Set())).toBe('neutral'));
  it('seen usable by both is neutral', () => expect(vendorFaction(S({ Alliance: [4], Horde: [4] }), new Set())).toBe('neutral'));
  it('no observations is unknown', () => expect(vendorFaction({}, new Set())).toBe('unknown'));
});

describe('vendor price', () => {
  it('backs the Friendly base price out of an Honored only record', () => expect(vendorUnitPrice({ '6': 225 }, 1)).toBe(250));
  it('uses the exact price at a known standing', () => expect(vendorUnitPrice({ '5': 250, '6': 225 }, 1, 6)).toBe(225));
  it('divides by the purchase stack', () => expect(vendorUnitPrice({ '5': 250 }, 10)).toBe(25));
});

/** Real EG Link records cut to a few NPCs (tests/fixtures/eglink/npcs-cut.json), every build they appear in. */
type CutBuild = { build: string; vendors: Record<string, EgVendor>; npcs: Record<string, EgNpc>; creatures: Record<string, EgCreature>; trainers: Record<string, EgTrainer> };
const cut = (JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/eglink/npcs-cut.json', import.meta.url)), 'utf8')) as { builds: CutBuild[] }).builds;
const vendors = mergeVendors(cut);
const V = (npc: number, item?: number) => vendors.filter(v => v.npcId === npc && (item == null || v.itemId === item));

describe('round 2 fixes on real EG Link records', () => {
  it('fix 5: Revered is 0.90 in Forever, so Salazar Bloch\'s Engineer\'s Ink {"7":1800} backs out to 2000, as Fradd Swiftgear sells it', () => {
    expect(V(4581, 10647)[0]!.costs).toEqual({ '7': 1800 });
    expect(vendorUnitPrice(V(4581, 10647)[0]!.costs, 1)).toBe(2000);
    expect(vendorUnitPrice(V(2682, 10647)[0]!.costs, 1)).toBe(2000);
    expect(STANDING_DISCOUNT['7']).toBe(0.9);
  });
  it('fix 5: a recorded Friendly price is used as is, never rounded up from Honored: Tharynn Bouden\'s Bleach {"5":25,"6":23} is 25, not 26', () => {
    expect(V(66, 2324)[0]!.costs).toEqual({ '5': 25, '6': 23 });
    expect(vendorBasePrice({ '5': 25, '6': 23 })).toBe(25);
    expect(vendorUnitPrice({ '5': 25, '6': 23 }, 1)).toBe(25);
    expect(vendorBasePrice({ '4': 2000 })).toBe(2000);
  });
  it('fix 3: Cylania (4164) keeps her English name though the newest build recorded her in Korean', () => {
    expect(cut.find(b => b.build === '1.60.1.71037')!.vendors['4164']!.name).toBe('키라니아');
    expect(new Set(V(4164).map(v => v.npcName))).toEqual(new Set(['Cylania']));
    expect(npcNames(cut).get('4164')).toBe('Cylania');
  });
  it('fix 3: Korean trainer skills become English profession names; the spell name too once the game tables are applied', () => {
    const t = mergeTrainers(cut);
    const r = t.find(x => x.npcId === 3603 && x.spellId === 2329)!;
    expect(r).toMatchObject({ skill: 'Alchemy', skillRank: 15 });
    expect(t.find(x => x.npcId === 4210 && x.spellId === 2539)).toMatchObject({ skill: 'Cooking' });
    // No build recorded these trainers in English, so their own names stay as recorded until one does.
    expect(isHangul(r.npcName)).toBe(true);
    const db = openDb(tempDir(), ':memory:');
    const it = db.prepare(`INSERT INTO trainer_spells (npc_id, npc_name, faction, zone, x, y, map_id, spell_id, name, skill, skill_rank, cost) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL)`);
    for (const x of t) it.run(x.npcId, x.npcName, x.faction, x.spellId, x.name, x.skill, x.skillRank);
    db.prepare(`UPDATE trainer_spells SET skill = '연금술' WHERE spell_id = 1249630`).run();
    const fixes = applyGameToEgLink(db, game);
    expect(fixes).toMatchObject({ trainerNames: 3, trainerSkills: 1 });
    expect(db.prepare('SELECT name, skill FROM trainer_spells WHERE npc_id = 3603 ORDER BY spell_id').all()).toEqual([
      { name: 'Elixir of Minor Strength', skill: 'Alchemy' }, { name: 'Cerulean Dye', skill: 'Alchemy' }]);
    expect(db.prepare('SELECT name, skill FROM trainer_spells WHERE npc_id = 4210').get()).toEqual({ name: 'Spiced Wolf Meat', skill: 'Cooking' });
  });
  it('round 3 D1: Creeg Bothunk (263570) stands inside the Ratchet box but EG Link records his side as Horde, so he stays Horde', () => {
    const v = V(263570);
    expect(v.length).toBeGreaterThan(0);
    expect(steamwheedleTown(v[0]!.uiMap, v[0]!.x, v[0]!.y)).toBe('Ratchet');
    expect(v.every(x => x.faction === 'horde')).toBe(true);
  });
  it('Old Man Heming (2626) from his real records is neutral: Bright Baubles usable', () => {
    expect(V(2626, 6532).map(x => x.faction)).toEqual(['neutral']);
  });
  it('fix 7: Kixxle (8305), seen only by Horde at Neutral, is unconfirmed; Kzixx (3134) stays neutral as a known neutral', () => {
    expect(V(8305).every(v => v.faction === 'unconfirmed')).toBe(true);
    expect(V(3134).every(v => v.faction === 'neutral')).toBe(true);
    expect(V(4164).every(v => v.faction === 'alliance')).toBe(true);
  });
  it('fix 4: the gate is the item\'s own reputation need, not the lowest standing someone recorded', () => {
    expect(vendorGate(game.items.get(2324))).toBe('4');          // Bleach: no faction
    expect(vendorGate(game.items.get(20072))).toBe('5');         // Defiler's Talisman: MinReputation 4, Friendly
    // Round 3 D4: The Defilers are closed to Alliance in the real Faction rows, so the talisman is never usable.
    expect(vendorGate(game.items.get(20072), game.factions)).toBe(UNUSABLE_GATE);
    expect([510, 2798, 2787, 76].map(f => game.factions.get(f)?.closedToAlliance)).toEqual([true, true, true, true]);
    expect([21, 369, 470, 577, 2827, 72, 69].map(f => game.factions.get(f)?.closedToAlliance)).toEqual([false, false, false, false, false, false, false]);
    expect(vendorGate(game.items.get(20068))).toBe('8');         // Deathguard's Cloak: MinReputation 7, Exalted
    expect(vendorGate(undefined)).toBeNull();
    const db = openDb(tempDir(), ':memory:');
    const ins = db.prepare(`INSERT INTO vendor_items (npc_id, npc_name, faction, item_id, price, price_by_standing, units_per_purchase, limited, standing_required) VALUES (?, 'x', 'alliance', ?, 1, ?, 1, 0, ?)`);
    ins.run(66, 2324, '{"6":23}', '6');      // only an Honored player recorded it: the item needs nothing
    ins.run(1, 20072, '{"4":100}', '4');     // recorded at Neutral, but the item needs Friendly with a Horde only faction
    ins.run(2, 999999, '{"6":90}', '4');     // not in the game table: the recorded standing stays
    const f = applyGameToEgLink(db, game);
    expect(db.prepare('SELECT item_id, standing_required FROM vendor_items ORDER BY npc_id').all()).toEqual([
      { item_id: 20072, standing_required: '9' }, { item_id: 999999, standing_required: '6' }, { item_id: 2324, standing_required: '4' }]);
    expect(f).toMatchObject({ vendorGated: 1, vendorGateChanged: 2, vendorNoItem: 1, vendorHordeOnly: 1 });
  });
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
