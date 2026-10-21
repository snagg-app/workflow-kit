// Zweck: Ponytail- und Impeccable-Hooks beim Sessionstart selbst installieren und aktuell halten.
// Nutzen: Der SessionStart-Hook kehrt sofort zurueck; ein abgeloester Kindprozess fuehrt die idempotenten Installer aus.
// Aufruf: Vom SessionStart-Hook im Projektverzeichnis; Hook-Vertrauen und Agent-Einstellungen bleiben unberuehrt.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));

if (process.argv[2] !== '--run') {
  spawn(process.execPath, [fileURLToPath(import.meta.url), '--run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  process.exit(0);
}

// One installer run per machine: the lock directory is atomic; a crashed run is taken over after 15 minutes.
const home = path.join(homedir(), '.ponytail', 'workflow-kit');
const lock = path.join(home, '.install.lock');
mkdirSync(home, { recursive: true });
for (let attempt = 0;; attempt++) {
  try { mkdirSync(lock); break; } catch (error) {
    if (error.code !== 'EEXIST' || attempt || Date.now() - statSync(lock).mtimeMs < 15 * 60_000) process.exit(0);
    rmSync(lock, { recursive: true, force: true });
  }
}
const log = openSync(path.join(home, '.install.log'), 'w');
try {
  // The installers are idempotent: a current installation is verified and left alone, a missing or stale one is replaced.
  for (const name of ['ponytail', 'impeccable'])
    spawnSync(process.execPath, [path.join(scripts, `install-${name}-hooks.mjs`)], { stdio: ['ignore', log, log], timeout: 300_000 });
} finally {
  closeSync(log);
  rmSync(lock, { recursive: true, force: true });
}
