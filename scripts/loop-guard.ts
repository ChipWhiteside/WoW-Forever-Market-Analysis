/**
 * Plain code guardrails for the overnight loop. The agents call these; they never decide them.
 *   window             exit 0 inside the night window (default 1am to 5am local), exit 3 outside it
 *   protected <base>   list changed files between <base> and HEAD that touch protected paths, exit 4 if any
 */
import { execSync } from 'node:child_process';

const PROTECTED = [/^src\/rules\//, /^src\/store\/db\.ts$/, /^src\/alerts\//, /^\.env/, /^scripts\/loop-guard\.ts$/, /^scripts\/watchdog\.ts$/, /^\.claude\//, /^src\/datasets\/.*SOURCES/, /^docs\/page-contracts\.md$/, /^tests\/unit\/page-contracts\.test\.ts$/];

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'window') {
  const start = Number(process.env.LOOP_START_HOUR ?? 1), end = Number(process.env.LOOP_END_HOUR ?? 5);
  const h = new Date().getHours();
  const inside = start < end ? h >= start && h < end : h >= start || h < end;
  console.log(inside ? `inside window ${start}:00 to ${end}:00, hour ${h}` : `outside window ${start}:00 to ${end}:00, hour ${h}. Exiting without doing anything.`);
  process.exit(inside ? 0 : 3);
} else if (cmd === 'protected') {
  const files = execSync(`git diff --name-only ${arg ?? 'HEAD~1'} HEAD`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const hits = files.filter(f => PROTECTED.some(p => p.test(f)));
  if (hits.length) { console.log(`protected paths touched, proposal only:\n${hits.join('\n')}`); process.exit(4); }
  console.log(`no protected paths in ${files.length} changed files`);
} else {
  console.log('usage: loop-guard window | protected <base>');
  process.exit(2);
}
