// Zweck: Pruefen, dass der Impeccable-Installer eine vorhandene, verifizierte Engine ausfuehrbar macht.
// Nutzen: Unter Unix meldet der Sessionstart sonst bei jedem Start fehlende Hooks, obwohl die Engine nur ihr Ausfuehrungsrecht verloren hat.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const kit = fileURLToPath(new URL('../../', import.meta.url));

test('an installed engine without its executable bit is made executable again', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'impeccable install '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A copy of the installer next to a pin file for fake engine bytes: the real pins name real release binaries.
  const bytes = Buffer.from('engine bytes of this test\n');
  const asset = `impeccable-${process.platform}-${process.arch}`;
  mkdirSync(join(root, 'kit/scripts/impeccable'), { recursive: true });
  copyFileSync(join(kit, 'scripts/install-impeccable-hooks.mjs'), join(root, 'kit/scripts/install-impeccable-hooks.mjs'));
  writeFileSync(join(root, 'kit/scripts/versions.json'), JSON.stringify({ impeccable: '0.0.1' }));
  writeFileSync(join(root, 'kit/scripts/impeccable/SHA256SUMS'), `${createHash('sha256').update(bytes).digest('hex')}  ${asset}\n`);
  const directory = join(root, 'home/.impeccable/workflow-kit/engine-0.0.1');
  mkdirSync(directory, { recursive: true });
  const engine = join(directory, 'impeccable');
  writeFileSync(engine, bytes, { mode: 0o644 });
  assert.equal(statSync(engine).mode & 0o111, 0, 'The precondition is an engine without any executable bit');
  const result = spawnSync(process.execPath, [join(root, 'kit/scripts/install-impeccable-hooks.mjs')],
    { env: { ...process.env, HOME: join(root, 'home') }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(engine).mode & 0o111, 0o111, 'The verified engine is executable for every user');
});
