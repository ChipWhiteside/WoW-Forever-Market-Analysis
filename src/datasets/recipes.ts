import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { BlizzardClient } from '../blizzard/client.ts';
import { ProfessionIndex, Profession, SkillTier, Recipe } from '../blizzard/contracts.ts';
import { type DB, tx } from '../store/db.ts';
import { pool } from '../catalog/items.ts';

/**
 * Recipes come from Blizzard (V8, V9). Skill thresholds come from the game's own SkillLineAbility table
 * for the live `wowf` build on wago.tools. Blizzard's recipe id IS the SkillLineAbility row id
 * (checked November 18: recipe 1631 Rough Sharpening Stone is SLA row 1631, yellow 15, grey 55).
 * Green is the midpoint of yellow and grey, the Classic rule, which gives 35 for that recipe.
 */
export interface Thresholds { yellow: number; green: number; grey: number; minRank: number }

export function parseSkillLineAbility(csv: string): Map<number, Thresholds> {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = splitCsv(lines[0]!);
  const ix = (n: string) => { const i = head.indexOf(n); if (i < 0) throw new Error(`SkillLineAbility CSV has no ${n} column, shape changed`); return i; };
  const iId = ix('ID'), iMin = ix('MinSkillLineRank'), iHi = ix('TrivialSkillLineRankHigh'), iLo = ix('TrivialSkillLineRankLow');
  const out = new Map<number, Thresholds>();
  for (const line of lines.slice(1)) {
    const c = splitCsv(line);
    const hi = Number(c[iHi]), lo = Number(c[iLo]);
    if (!hi && !lo) continue;
    out.set(Number(c[iId]), { yellow: lo, green: Math.round((lo + hi) / 2), grey: hi, minRank: Number(c[iMin]) });
  }
  return out;
}

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export async function fetchThresholds(dataDir: string, fetchFn: typeof fetch = fetch): Promise<{ build: string; map: Map<number, Thresholds> }> {
  const builds = await (await fetchFn('https://wago.tools/api/builds')).json() as Record<string, Array<{ version: string }>>;
  const build = builds['wowf']?.[0]?.version;
  if (!build) throw new Error('wago.tools lists no wowf build, suspected bug');
  const dir = join(dataDir, 'datasets', 'wago');
  const file = join(dir, `SkillLineAbility-${build}.csv`);
  let csv: string;
  if (existsSync(file)) csv = readFileSync(file, 'utf8');
  else {
    const res = await fetchFn(`https://wago.tools/db2/SkillLineAbility/csv?build=${build}`);
    if (!res.ok) throw new Error(`wago SkillLineAbility returned ${res.status}`);
    csv = await res.text();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, csv);
  }
  return { build, map: parseSkillLineAbility(csv) };
}

/** Walk every profession to its recipes, then attach thresholds. Unmatched recipes are kept, never dropped (T3). */
export async function syncRecipes(client: BlizzardClient, db: DB, dataDir: string, log: (m: string) => void = () => {}): Promise<{ recipes: number; withThresholds: number; unmatched: number }> {
  const { build, map } = await fetchThresholds(dataDir);
  const idx = await client.get(client.url('/data/wow/profession/index', 'static'), ProfessionIndex);
  if (!idx.body?.professions.length) throw new Error('profession index empty, suspected bug');
  const refs: Array<{ id: number; profId: number; prof: string; category: string }> = [];
  for (const p of idx.body.professions) {
    const prof = await client.get(client.url(`/data/wow/profession/${p.id}`, 'static'), Profession);
    for (const t of prof.body?.skill_tiers ?? []) {
      const tier = await client.get(client.url(`/data/wow/profession/${p.id}/skill-tier/${t.id}`, 'static'), SkillTier);
      for (const c of tier.body?.categories ?? []) for (const r of c.recipes ?? []) refs.push({ id: r.id, profId: p.id, prof: p.name, category: c.name });
    }
  }
  log(`recipes: walking ${refs.length} recipes`);
  const recipes: Array<{ ref: typeof refs[number]; body: NonNullable<Awaited<ReturnType<typeof getRecipe>>> }> = [];
  const getRecipe = async (id: number) => (await client.get(client.url(`/data/wow/recipe/${id}`, 'static'), Recipe)).body;
  await pool(refs, 16, async ref => {
    try { const b = await getRecipe(ref.id); if (b) recipes.push({ ref, body: b }); } catch { /* counted below */ }
  });
  let withThresholds = 0;
  tx(db, () => {
    db.exec('DELETE FROM recipes; DELETE FROM recipe_reagents;');
    const ir = db.prepare(`INSERT OR REPLACE INTO recipes (id, name, profession_id, profession, category, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey, threshold_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ig = db.prepare('INSERT OR REPLACE INTO recipe_reagents (recipe_id, item_id, quantity) VALUES (?, ?, ?)');
    for (const { ref, body } of recipes) {
      const th = map.get(body.id);
      if (th) withThresholds++;
      const item = body.crafted_item ?? body.alliance_crafted_item;
      const q = body.crafted_quantity;
      ir.run(body.id, body.name, ref.profId, ref.prof, ref.category, item?.id ?? null, q?.minimum ?? q?.value ?? 1, q?.maximum ?? q?.value ?? 1,
        th ? Math.max(1, th.minRank) : null, th?.yellow ?? null, th?.green ?? null, th?.grey ?? null, th ? `wago wowf ${build}` : null);
      for (const r of body.reagents ?? []) ig.run(body.id, r.reagent.id, r.quantity);
    }
    db.prepare(`INSERT OR REPLACE INTO datasets (name, version, fetched_at, records, note) VALUES ('recipes', ?, ?, ?, ?)`)
      .run(`blizzard + wago ${build}`, Date.now(), recipes.length, `${recipes.length - withThresholds} recipes without a threshold row`);
  });
  return { recipes: recipes.length, withThresholds, unmatched: refs.length - recipes.length };
}
