import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One engine sends alerts per data folder. The lock file holds the pid of the engine that owns it. A second engine
 * (npm run once, a second --no-server run) may still collect, but it must not send alerts. A lock whose pid is dead is taken over.
 */
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function takeInstanceLock(dataDir: string, pid = process.pid): { held: true; release: () => void } | { held: false; ownerPid: number } {
  const file = join(dataDir, 'engine.lock');
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx' });
      return { held: true, release: () => { try { if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file); } catch { /* already gone */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let other = NaN;
      try { other = Number(readFileSync(file, 'utf8').trim()); } catch { continue; }
      if (Number.isInteger(other) && other > 0 && other !== pid && alive(other)) return { held: false, ownerPid: other };
      try { unlinkSync(file); } catch { /* another process took it over first; the next pass sees it */ }
    }
  }
  return { held: false, ownerPid: 0 };
}
