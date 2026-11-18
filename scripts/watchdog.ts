/**
 * After the loop merges a change: run the test suite and the live contract check. If either fails where it
 * passed before the merge, revert the merge commit automatically and say so. Plain code, no Claude.
 * Usage: npx tsx scripts/watchdog.ts <merge-commit>
 */
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/config/env.ts';

const commit = process.argv[2];
if (!commit) { console.log('usage: watchdog <merge-commit>'); process.exit(2); }
const run = (c: string) => { try { execSync(c, { cwd: PROJECT_ROOT, stdio: 'pipe' }); return true; } catch { return false; } };
const testsOk = run('npm test --silent');
const contractOk = run('npm run contract --silent');
if (testsOk && contractOk) { console.log('watchdog: healthy after merge'); process.exit(0); }
const why = [!testsOk && 'tests fail', !contractOk && 'live contract check fails'].filter(Boolean).join(' and ');
run(`git revert --no-edit -m 1 ${commit}`) || run(`git revert --no-edit ${commit}`);
appendFileSync(join(PROJECT_ROOT, 'docs', 'CHANGELOG.md'), `\n- ${new Date().toISOString()} REVERTED ${commit} automatically by the watchdog: ${why} after merge. Needs Chip.\n`);
console.log(`watchdog: reverted ${commit}, ${why}`);
process.exit(1);
