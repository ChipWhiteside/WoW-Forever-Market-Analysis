// node:sqlite is built into Node 22.13+. Silence its experimental warning once, before load.
const origEmit = process.emitWarning;
process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
  if (String((w as Error)?.message ?? w).includes('SQLite')) return;
  return (origEmit as (...a: unknown[]) => void).call(process, w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
import { join } from 'node:path';

export type DB = InstanceType<typeof DatabaseSync>;

const MIGRATIONS: string[] = [
  // 1. Core market history
  `
  CREATE TABLE houses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    faction TEXT NOT NULL,            -- alliance | horde | blackwater
    cut REAL NOT NULL,                -- 0.05 or 0.15, see src/rules
    tracked INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0 -- Chip's own house for this faction
  );
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id INTEGER NOT NULL,
    kind TEXT NOT NULL,               -- auctions | commodities
    last_modified TEXT NOT NULL,      -- Blizzard header, the publish identity
    published_at INTEGER NOT NULL,    -- epoch ms parsed from last_modified
    fetched_at INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    distinct_items INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    raw_path TEXT,
    UNIQUE (house_id, kind, last_modified)
  );
  CREATE INDEX snapshots_house_time ON snapshots (house_id, published_at);
  -- One row per item per snapshot. Prices in copper per unit.
  CREATE TABLE item_stats (
    snapshot_id INTEGER NOT NULL,
    house_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    published_at INTEGER NOT NULL,
    floor INTEGER,                    -- lowest buyout per unit, null if bid only
    units_at_floor INTEGER NOT NULL,
    units_within5 INTEGER NOT NULL,   -- units priced at or under floor * 1.05
    total_units INTEGER NOT NULL,
    listings INTEGER NOT NULL,
    ladder TEXT NOT NULL,             -- JSON [[unitPrice, units], ...] cheapest 12 price points
    gone_listings INTEGER,            -- listings present last snapshot, absent now (null on first snapshot)
    gone_units INTEGER,
    gone_units_expiring INTEGER,      -- of gone_units, ones that were SHORT last time (likely expired)
    gone_units_near_floor INTEGER,    -- gone units priced within 10% of the previous floor
    new_units INTEGER,
    PRIMARY KEY (snapshot_id, item_id)
  );
  CREATE INDEX item_stats_lookup ON item_stats (house_id, item_id, published_at);
  CREATE TABLE poll_log (
    at INTEGER NOT NULL, house_id INTEGER NOT NULL, kind TEXT NOT NULL,
    status INTEGER NOT NULL, ms INTEGER NOT NULL, note TEXT
  );
  CREATE INDEX poll_log_at ON poll_log (at);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 2. Catalog and plays
  `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    name TEXT,
    name_source TEXT,                 -- blizzard | eglink | wago | none
    quality TEXT,
    item_class TEXT, item_subclass TEXT,
    item_level INTEGER, required_level INTEGER,
    binding TEXT,
    sell_price INTEGER, purchase_price INTEGER, purchase_quantity INTEGER,
    max_count INTEGER, stackable INTEGER,
    media_id INTEGER, icon_url TEXT,
    status INTEGER NOT NULL,          -- last HTTP status from Blizzard
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE plays (
    key TEXT PRIMARY KEY,             -- detector:house:item[:extra], stable across snapshots
    detector TEXT NOT NULL,
    house_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    state TEXT NOT NULL,              -- new | live | fading | gone
    profit INTEGER NOT NULL,          -- profit available, copper
    peak_profit INTEGER NOT NULL,
    confidence TEXT NOT NULL,         -- high | medium | low
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,             -- JSON, detector specific
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    data_at INTEGER NOT NULL,         -- publish time of the snapshot it came from
    snapshots_seen INTEGER NOT NULL,
    gone_at INTEGER,
    alerted_profit INTEGER,           -- profit at last alert, for the 25% growth rule
    user_status TEXT                  -- done | skipped | already_gone
  );
  CREATE INDEX plays_state ON plays (state, profit);
  CREATE TABLE alerts_sent (at INTEGER NOT NULL, channel TEXT NOT NULL, plays INTEGER NOT NULL, body TEXT NOT NULL, ok INTEGER NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 3. Reference datasets (vendors, recipes, loot), refreshed daily
  `
  CREATE TABLE vendor_items (
    npc_id INTEGER NOT NULL, npc_name TEXT, faction TEXT, zone TEXT, x REAL, y REAL, map_id INTEGER,
    item_id INTEGER NOT NULL, price INTEGER, price_by_standing TEXT, units_per_purchase INTEGER,
    limited INTEGER, standing_required TEXT,
    PRIMARY KEY (npc_id, item_id)
  );
  CREATE INDEX vendor_items_item ON vendor_items (item_id);
  CREATE TABLE recipes (
    id INTEGER PRIMARY KEY, name TEXT, profession_id INTEGER, profession TEXT, category TEXT,
    crafted_item_id INTEGER, qty_min REAL, qty_max REAL,
    learn_skill INTEGER, yellow INTEGER, green INTEGER, grey INTEGER, threshold_source TEXT
  );
  CREATE INDEX recipes_product ON recipes (crafted_item_id);
  CREATE TABLE recipe_reagents (recipe_id INTEGER NOT NULL, item_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (recipe_id, item_id));
  CREATE INDEX recipe_reagents_item ON recipe_reagents (item_id);
  CREATE TABLE loot (
    source_kind TEXT NOT NULL, source_id INTEGER NOT NULL, source_name TEXT, zone TEXT,
    min_level INTEGER, max_level INTEGER, classification TEXT,
    item_id INTEGER NOT NULL, chance REAL NOT NULL, avg_count REAL, kills INTEGER, origin TEXT NOT NULL,
    PRIMARY KEY (source_kind, source_id, item_id)
  );
  CREATE INDEX loot_item ON loot (item_id);
  CREATE TABLE datasets (name TEXT PRIMARY KEY, version TEXT, fetched_at INTEGER, records INTEGER, note TEXT);
  `,
  // 4. Chip's own state
  `
  CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, play_key TEXT, item_id INTEGER NOT NULL, house_id INTEGER,
    quantity INTEGER NOT NULL, unit_cost INTEGER NOT NULL, opened_at INTEGER NOT NULL,
    closed_at INTEGER, sold_qty INTEGER, unit_sale INTEGER, note TEXT
  );
  CREATE TABLE watchlist (item_id INTEGER PRIMARY KEY, alert_above INTEGER, alert_below INTEGER, added_at INTEGER NOT NULL);
  CREATE TABLE farm_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, activity TEXT NOT NULL, source_id INTEGER,
    started_at INTEGER NOT NULL, ended_at INTEGER, kills INTEGER, items TEXT, note TEXT
  );
  `,
  // 5. Long term history and calibration
  `
  CREATE TABLE item_daily (
    house_id INTEGER NOT NULL, item_id INTEGER NOT NULL, day TEXT NOT NULL,
    floor_min INTEGER, floor_median INTEGER, floor_max INTEGER, units_avg REAL, sold_est INTEGER, readings INTEGER NOT NULL,
    PRIMARY KEY (house_id, item_id, day)
  );
  CREATE TABLE play_history (
    key TEXT NOT NULL, detector TEXT NOT NULL, house_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
    first_seen INTEGER NOT NULL, gone_at INTEGER, peak_profit INTEGER NOT NULL, snapshots_seen INTEGER NOT NULL, user_status TEXT
  );
  CREATE INDEX play_history_detector ON play_history (detector, first_seen);
  `,
  // 6. Sell through precision (review findings 1 and 2), vendor standing gate (finding 4)
  `
  ALTER TABLE item_stats ADD COLUMN gone_units_expiring_near_floor INTEGER;
  ALTER TABLE snapshots ADD COLUMN diff_hours REAL;
  `,
  // 7. Chip's own materials, for the leveling planner
  `
  CREATE TABLE inventory (item_id INTEGER PRIMARY KEY, count INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `,
  // 8. The price sales happened at, so demand and price describe the same market level
  `
  ALTER TABLE item_stats ADD COLUMN sold_value INTEGER;
  `,
  // 9. Why people buy things: quests that require an item (EG Link quest descriptions)
  `
  CREATE TABLE quest_items (
    quest_id INTEGER NOT NULL, item_id INTEGER NOT NULL, amount INTEGER NOT NULL, title TEXT, level INTEGER, min_level INTEGER, zone_area INTEGER,
    PRIMARY KEY (quest_id, item_id)
  );
  CREATE INDEX quest_items_item ON quest_items (item_id);
  `,
  // 10. Where recipes are learned: every profession trainer's list (EG Link trainers)
  `
  CREATE TABLE trainer_spells (
    npc_id INTEGER NOT NULL, npc_name TEXT, faction TEXT, zone TEXT, x REAL, y REAL, map_id INTEGER,
    spell_id INTEGER NOT NULL, name TEXT NOT NULL, skill TEXT, skill_rank INTEGER, cost INTEGER,
    PRIMARY KEY (npc_id, spell_id)
  );
  CREATE INDEX trainer_spells_name ON trainer_spells (name);
  `,
  // 11. The flip engine (docs/flip-plan.md, approved by Chip November 24)
  `
  ALTER TABLE items ADD COLUMN bonding INTEGER;          -- game table ItemSparse.Bonding: 0 none, 1 pickup, 2 equip, 3 use, 4 quest
  ALTER TABLE items ADD COLUMN stack_size INTEGER;       -- ItemSparse.Stackable
  ALTER TABLE items ADD COLUMN vendor_stack INTEGER;     -- units per vendor purchase (vials come 5 at a time)
  ALTER TABLE items ADD COLUMN data_source TEXT;         -- forever | classic1x | wago: where name, prices and binding came from
  ALTER TABLE recipes ADD COLUMN spell_id INTEGER;
  ALTER TABLE recipes ADD COLUMN cast_ms INTEGER;
  ALTER TABLE recipes ADD COLUMN cooldown_ms INTEGER;
  ALTER TABLE recipes ADD COLUMN cooldown_category INTEGER; -- shared cooldown (transmutes share one)
  ALTER TABLE recipes ADD COLUMN random_yield INTEGER NOT NULL DEFAULT 0; -- yield not proven: kept out of the ranking
  ALTER TABLE recipes ADD COLUMN live INTEGER NOT NULL DEFAULT 1;          -- product and every reagent exist in Forever
  ALTER TABLE recipes ADD COLUMN kind TEXT NOT NULL DEFAULT 'profession';   -- profession | conversion
  ALTER TABLE recipes ADD COLUMN source TEXT;            -- wago | blizzard | both
  ALTER TABLE recipes ADD COLUMN disagreement TEXT;      -- what the two sources disagree on, null when they agree
  ALTER TABLE item_stats ADD COLUMN sweep_high INTEGER;  -- highest unit price judged bought since the last publish
  ALTER TABLE item_stats ADD COLUMN sold_units INTEGER;  -- units judged sold since the last publish, current rules
  ALTER TABLE item_stats ADD COLUMN new_near_floor INTEGER; -- new units posted at or under 1.1 times the floor
  CREATE TABLE listing_seen (
    house_id INTEGER NOT NULL, kind TEXT NOT NULL, listing_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL, first_seen INTEGER NOT NULL, first_time_left TEXT NOT NULL,
    PRIMARY KEY (house_id, kind, listing_id)
  );
  CREATE TABLE flips (
    key TEXT PRIMARY KEY,             -- family:sellHouse:item[:recipe], stable across publishes
    kind TEXT NOT NULL,               -- craft | flip (green or blue card)
    family TEXT NOT NULL,
    house_id INTEGER,                 -- the house it sells on, null when it sells to a vendor
    item_id INTEGER NOT NULL,
    recipe_id INTEGER,
    state TEXT NOT NULL,              -- new | live | fading | gone
    rank INTEGER,
    expected_profit INTEGER NOT NULL,
    risk TEXT NOT NULL,               -- low | medium | high
    detail TEXT NOT NULL,             -- JSON Flip
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, data_at INTEGER NOT NULL, gone_at INTEGER
  );
  CREATE INDEX flips_state ON flips (state, rank);
  CREATE TABLE flip_history (at INTEGER NOT NULL, key TEXT NOT NULL, expected_profit INTEGER NOT NULL, per_item INTEGER NOT NULL, units INTEGER NOT NULL, PRIMARY KEY (at, key));
  CREATE TABLE flip_runs (at INTEGER PRIMARY KEY, data_at INTEGER NOT NULL, ms INTEGER NOT NULL, complete INTEGER NOT NULL, report TEXT NOT NULL);
  `,
  // 12. Where a recipe is learned from an item: linked by id through the game's ItemEffect table, never by name
  `
  ALTER TABLE recipes ADD COLUMN teach_item_id INTEGER;     -- the plans, pattern or recipe item that teaches it
  ALTER TABLE recipes ADD COLUMN teach_skill INTEGER;       -- ItemSparse.RequiredSkillRank of that item
  ALTER TABLE recipes ADD COLUMN learn_source TEXT;         -- trainer_alliance | trainer_horde_only | item | auto | yellow
  `,
  // 13. Sales counted as events (listings bought), so the cautious estimate never mistakes one big stack for many buyers
  `
  ALTER TABLE item_stats ADD COLUMN sold_events INTEGER;
  `,
];

export function openDb(dataDir: string, file = 'wowf.db'): DB {
  const db = new DatabaseSync(file === ':memory:' ? ':memory:' : join(dataDir, file));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let v = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      v++;
      db.prepare('UPDATE schema_version SET version = ?').run(v);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getKv(db: DB, key: string): string | null {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setKv(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
