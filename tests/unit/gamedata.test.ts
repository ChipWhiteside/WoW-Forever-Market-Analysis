import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseTable, loadGameDataFromDir, fetchGameData, TABLE_NAMES } from '../../src/datasets/gamedata.ts';
import { tempDir } from '../helpers.ts';

/** Real rows of the wago `wowf` tables, build 1.60.1.71037, cut to the recipes the tests check. */
export const FIXTURES = fileURLToPath(new URL('../fixtures/wago', import.meta.url));
const BUILD = '1.60.1.71037';

describe('wago CSV parsing', () => {
  it('handles commas and doubled quotes inside quotes, and line breaks inside quoted fields', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",3\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
  });
  it('a renamed column throws and names the column (ledger rule 1)', () => {
    expect(() => parseTable('SpellCastTimes', 'ID,BaseTime,Minimum\n14,3000,3000')).toThrow(/SpellCastTimes has no Base column/);
  });
  it('the real Spell fixture keeps multi line descriptions in one row', () => {
    const g = loadGameDataFromDir(FIXTURES, BUILD);
    expect(g.spellDescriptions.get(13361)).toBe('Turn three lesser magic essences into a greater one.');
  });
});

describe('game data from the real tables', () => {
  const g = loadGameDataFromDir(FIXTURES, BUILD);
  it('White Wedding Dress keeps Bleach from slot 3 after an empty slot 2', () => {
    expect(g.reagents.get(12091)).toEqual([{ itemId: 4339, quantity: 5 }, { itemId: 8343, quantity: 3 }, { itemId: 2324, quantity: 1 }]);
  });
  it('Coarse Dynamite creates 4365 with base 2 and variance 1', () => {
    expect(g.creates.get(3931)).toEqual([{ itemId: 4365, base: 2, variance: 1 }]);
  });
  it('cast time is SpellCastTimes.Base: Smelt Copper 3000 ms (index 14), Mooncloth 60000 ms (index 39, Minimum 30000)', () => {
    expect(g.castMs.get(2657)).toBe(3000);
    expect(g.castMs.get(18560)).toBe(60000);
  });
  it('cooldowns: Iron to Gold 1 hour on its own; Arcanite and Air to Fire share category 310', () => {
    expect(g.cooldowns.get(11479)).toEqual({ recoveryMs: 3_600_000, categoryRecoveryMs: 0, category: null });
    expect(g.cooldowns.get(17187)).toEqual({ recoveryMs: 0, categoryRecoveryMs: 169_200_000, category: 310 });
    expect(g.cooldowns.get(17559)?.category).toBe(310);
  });
  it('ItemSparse gives bonding, stack size and vendor bundle (Empty Vial comes 5 at a time)', () => {
    expect(g.items.get(3371)).toMatchObject({ name: 'Empty Vial', bonding: 0, stackable: 20, vendorStack: 5, buyPrice: 20, sellPrice: 1 });
    expect(g.items.get(249409)).toMatchObject({ name: 'Cerulean Dye', bonding: 0, stackable: 20 });
  });
});

describe('fetchGameData', () => {
  const serve = (calls: string[]) => (async (input: string | URL) => {
    const url = String(input); calls.push(url);
    if (url === 'https://wago.tools/api/builds') return new Response(JSON.stringify({ wowf: [{ version: BUILD }] }));
    const m = url.match(/db2\/(\w+)\/csv\?build=(.+)$/);
    if (!m || m[2] !== BUILD) return new Response('', { status: 404 });
    return new Response(readFileSync(join(FIXTURES, `${m[1]}.csv`), 'utf8'));
  }) as typeof fetch;

  it('downloads every table once into DATA_DIR/datasets/wago/<build>/, then reads from disk', async () => {
    const dir = tempDir();
    const calls: string[] = [];
    const g = await fetchGameData(dir, { fetchFn: serve(calls) });
    expect(g.build).toBe(BUILD);
    expect(calls.filter(c => c.includes('/db2/')).length).toBe(TABLE_NAMES.length);
    for (const t of TABLE_NAMES) expect(existsSync(join(dir, 'datasets', 'wago', BUILD, `${t}.csv`))).toBe(true);
    const again: string[] = [];
    await fetchGameData(dir, { fetchFn: serve(again) });
    expect(again).toEqual(['https://wago.tools/api/builds']);
  });

  it('uses the newest complete cached build when wago.tools is down, and says so', async () => {
    const dir = tempDir();
    await fetchGameData(dir, { fetchFn: serve([]) });
    const logs: string[] = [];
    const down = (async () => { throw new Error('offline'); }) as typeof fetch;
    const g = await fetchGameData(dir, { fetchFn: down, log: m => logs.push(m) });
    expect(g.build).toBe(BUILD);
    expect(logs[0]).toMatch(/using cached build 1\.60\.1\.71037/);
  });

  it('a downloaded table with a changed shape is not cached and throws naming the column', async () => {
    const dir = tempDir();
    const bad = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/builds')) return new Response(JSON.stringify({ wowf: [{ version: BUILD }] }));
      if (url.includes('/SkillLineAbility/')) return new Response('ID,SkillLine,SpellID\n1,2,3');
      return new Response(readFileSync(join(FIXTURES, `${url.match(/db2\/(\w+)\//)![1]}.csv`), 'utf8'));
    }) as typeof fetch;
    await expect(fetchGameData(dir, { fetchFn: bad })).rejects.toThrow(/SkillLineAbility has no Spell column/);
    expect(existsSync(join(dir, 'datasets', 'wago', BUILD, 'SkillLineAbility.csv'))).toBe(false);
  });

  // Round 2 fix 6: a new build that fails must not make the daily refresh throw every 30 minutes.
  const NEW = '1.60.1.99999';
  const newBuild = (table: (name: string) => Response | null) => (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/api/builds')) return new Response(JSON.stringify({ wowf: [{ version: NEW }] }));
    const name = url.match(/db2\/(\w+)\//)![1]!;
    return table(name) ?? new Response(readFileSync(join(FIXTURES, `${name}.csv`), 'utf8'));
  }) as typeof fetch;

  it('a new build whose table fails its shape check falls back to the newest complete cached build, warns, and is marked stale', async () => {
    const dir = tempDir();
    await fetchGameData(dir, { fetchFn: serve([]) });
    const logs: string[] = [];
    const g = await fetchGameData(dir, { fetchFn: newBuild(n => (n === 'ItemSparse' ? new Response('ID,Display_lang,Bonding\n1,x,0') : null)), log: m => logs.push(m) });
    expect(g.build).toBe(BUILD);
    expect(g.stale).toMatchObject({ wanted: NEW });
    expect(g.stale!.reason).toMatch(/ItemSparse has no Stackable column/);
    expect(logs.some(l => /WARNING: build 1\.60\.1\.99999 unusable .* using cached build 1\.60\.1\.71037, marked stale/.test(l))).toBe(true);
    expect(existsSync(join(dir, 'datasets', 'wago', NEW, 'ItemSparse.csv'))).toBe(false);
  });

  it('a new build whose download fails falls back the same way', async () => {
    const dir = tempDir();
    await fetchGameData(dir, { fetchFn: serve([]) });
    const g = await fetchGameData(dir, { fetchFn: newBuild(n => (n === 'SpellEffect' ? new Response('busy', { status: 503 }) : null)) });
    expect(g.build).toBe(BUILD);
    expect(g.stale).toEqual({ wanted: NEW, reason: 'wago SpellEffect returned 503' });
  });

  it('with no cached build to fall back on, a failing new build still throws', async () => {
    await expect(fetchGameData(tempDir(), { fetchFn: newBuild(n => (n === 'Spell' ? new Response('x', { status: 500 }) : null)) })).rejects.toThrow(/wago Spell returned 500/);
  });
});

describe('ItemSparse skill and reputation columns (round 2 fixes 1 and 4)', () => {
  const sparse = readFileSync(join(FIXTURES, 'ItemSparse.csv'), 'utf8');
  it('a missing RequiredSkillRank or MinFactionID column throws naming it', () => {
    expect(() => parseTable('ItemSparse', sparse.replace('RequiredSkillRank', 'ReqSkillRank'))).toThrow(/ItemSparse has no RequiredSkillRank column/);
    expect(() => parseTable('ItemSparse', sparse.replace('MinFactionID', 'MinFaction'))).toThrow(/ItemSparse has no MinFactionID column/);
  });
  it('real rows: Recipe: Swiftness Potion needs Alchemy (171) 60; Empty Vial needs no reputation', () => {
    const g = loadGameDataFromDir(FIXTURES, BUILD);
    expect(g.items.get(2555)).toMatchObject({ requiredSkill: 171, requiredSkillRank: 60, minFactionId: 0, minReputation: 0 });
    expect(g.items.get(3371)).toMatchObject({ requiredSkillRank: 0, minFactionId: 0 });
  });
});
