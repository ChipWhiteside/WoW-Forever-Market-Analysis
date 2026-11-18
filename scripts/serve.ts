/** Serve the app over an existing database without polling Blizzard. For UI work and demos. */
import { loadConfig } from '../src/config/env.ts';
import { openDb } from '../src/store/db.ts';
import { startServer } from '../src/server/server.ts';
const cfg = loadConfig();
await startServer({ db: openDb(cfg.dataDir), engine: null, client: null, port: cfg.port, dataDir: cfg.dataDir, log: console.log });
