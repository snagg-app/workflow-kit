// Zweck: Die eine Sperre des Kits (Hook, Kit-Pruefung, Installations-Engine): ein Sperrordner mit der Prozess-ID des Halters.
// Nutzen: Ein abgestuerzter (Prozess weg) oder haengender (aelter als `stale` ms) Halter wird abgeloest, ein lebender nie.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = ms => new Promise(done => setTimeout(done, ms));

const abandoned = (lock, stale) => {
  try { process.kill(Number(readFileSync(join(lock, 'pid'), 'utf8')), 0); } catch (error) { if (error.code === 'ESRCH') return true; }
  try { return Date.now() - statSync(lock).mtimeMs > stale; } catch { return true; }
};

/** Who holds the lock, for a message: the PID in it ('unknown' without one) and its age in seconds. */
export function holder(lock) {
  let pid = 'unknown', age = 0;
  try { pid = readFileSync(join(lock, 'pid'), 'utf8').trim() || pid; } catch { /* no pid written (yet) */ }
  try { age = Math.round((Date.now() - statSync(lock).mtimeMs) / 1000); } catch { /* released meanwhile */ }
  return { pid, age };
}

/** Takes the lock directory if it is free or its holder is gone; false while a live holder has it. */
function acquire(lock, stale) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock); } catch (error) {
      if (error.code !== 'EEXIST' || !abandoned(lock, stale)) return false;
      // shortcut: two takers that find the same dead lock race on the rename; a third run that locks in between is not told apart, upgrade to an owner token if that ever shows.
      try { renameSync(lock, `${lock}.dead-${process.pid}`); rmSync(`${lock}.dead-${process.pid}`, { recursive: true, force: true }); } catch { /* another run took it first */ }
      continue;
    }
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return true;
  }
  return false;
}

/** Runs `work` while it holds the lock; a live holder makes it skip (nothing runs, returns false). For hooks, which must not wait. */
export function locked(lock, stale, work) {
  if (!acquire(lock, stale)) return false;
  try { work(); } finally { rmSync(lock, { recursive: true, force: true }); }
  return true;
}

/** Like `locked`, but a live holder is waited for up to `wait` ms (longer than one 120 s download, so a second run does not give up on the first). */
export async function withLock(lock, work, { stale = 15 * 60_000, wait = 300_000 } = {}) {
  for (const give = Date.now() + wait; !acquire(lock, stale);) {
    assert.ok(Date.now() < give, `Another run holds ${lock}; run again when it is done.`);
    await sleep(100);
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
