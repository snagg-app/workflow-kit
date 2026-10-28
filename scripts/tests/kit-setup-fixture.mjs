// What the kit setup tests share (kit-setup*.test.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { kitCheckout, temporary } from './fixtures.mjs';

/** Every file below `dir` (links by target, the .git folder skipped) with a hash of its content. */
export function snapshot(dir, base = dir, found = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), name = path.slice(base.length);
    if (entry.name === '.git') continue;
    if (entry.isSymbolicLink()) found[name] = readlinkSync(path);
    else if (entry.isDirectory()) snapshot(path, base, found);
    else found[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return found;
}

export function setup(t) {
  const kit = kitCheckout(t), project = temporary(t, 'kit setup project '), home = temporary(t, 'kit setup home ');
  execFileSync('git', ['init', '--quiet', project]);
  // No network: the Impeccable engine download fails fast and counts as an open step.
  const env = { ...process.env, HOME: home, USERPROFILE: home, IMPECCABLE_DOWNLOAD_BASE: 'http://127.0.0.1:9', KIT_NODE_SETUP: 'skip' };
  const run = (extra = {}) => spawnSync(process.execPath, [join(kit, 'scripts/kit.mjs'), '--cwd', project, 'setup'], { encoding: 'utf8', env: { ...env, ...extra } });
  return { project, home, run, env };
}
