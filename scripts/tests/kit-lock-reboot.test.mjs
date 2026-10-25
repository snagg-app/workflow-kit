import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { locked } from '../lock.mjs';

// #1024: after a reboot a stranger can own the PID of the dead holder; the boot marker tells the old lock apart.
function lockWithPid(t, boot) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-lock-reboot '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'kit.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid)); // a live process, as a stranger would be
  if (boot !== undefined) writeFileSync(join(lock, 'boot'), String(boot));
  return lock;
}

test('a lock from before the last reboot is taken although its PID is alive', t => {
  const lock = lockWithPid(t, Date.now() - uptime() * 1000 - 3_600_000);
  assert.equal(locked(lock, 15 * 60_000, () => {}), true);
});

test('a lock from this boot with a live PID is never taken', t => {
  const lock = lockWithPid(t, Date.now() - uptime() * 1000);
  assert.equal(locked(lock, 15 * 60_000, () => {}), false);
});
