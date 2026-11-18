/**
 * After the loop merges a change: run the tests and the live contract check on the merged code AND on the code
 * just before the merge. Revert only what the change broke: a check that passes before and fails after.
 * A Blizzard outage fails both sides and reverts nothing. Plain code, no Claude.
 * Usage: npx tsx scripts/watchdog.ts <merge-commit>
 */
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync, symlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROJECT_ROOT } from '../src/config/env.ts';

const commit = process.argv[2];
if (!commit) { console.log('usage: watchdog <merge-commit>'); process.exit(2); }
const run = (c: string, cwd: string) => { try { execSync(c, { cwd, stdio: 'pipe' }); return true; } catch { return false; } };
const checks = (cwd: string) => ({ tests: run('npx vitest run', cwd), contract: run('npx tsx scripts/contract.ts', cwd) });

const after = checks(PROJECT_ROOT);
if (after.tests && after.contract) { console.log('watchdog: healthy after merge'); process.exit(0); }

// Baseline: the same checks on the code before the merge, in a throwaway worktree sharing node_modules and .env.
const dir = mkdtempSync(join(tmpdir(), 'wowf-before-'));
rmSync(dir, { recursive: true });
execSync(`git worktree add --detach "${dir}" ${commit}^1`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
try {
  symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  if (existsSync(join(PROJECT_ROOT, '.env'))) symlinkSync(join(PROJECT_ROOT, '.env'), join(dir, '.env'));
  const before = checks(dir);
  const broke = (Object.keys(after) as Array<keyof typeof after>).filter(k => before[k] && !after[k]);
  if (broke.length === 0) {
    console.log(`watchdog: failures also present before the merge (${JSON.stringify(before)}), not caused by this change. Kept.`);
    process.exit(0);
  }
  run(`git revert --no-edit -m 1 ${commit}`, PROJECT_ROOT) || run(`git revert --no-edit ${commit}`, PROJECT_ROOT);
  appendFileSync(join(PROJECT_ROOT, 'docs', 'CHANGELOG.md'), `\n- ${new Date().toISOString()} REVERTED ${commit} automatically by the watchdog: ${broke.join(' and ')} passed before the merge and failed after. Needs Chip.\n`);
  console.log(`watchdog: reverted ${commit}, broke ${broke.join(' and ')}`);
  process.exit(1);
} finally {
  execSync(`git worktree remove --force "${dir}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
}
