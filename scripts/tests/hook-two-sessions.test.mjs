// Zweck: Zwei Sessions starten gleichzeitig (SessionStart) gegen einen fehlenden Snapshot; die Sperre des Hook-Moduls laesst nur eine Installation zu (#750).
// Nutzen: Der Test geht durch den echten Hook-Einstieg und zaehlt Downloads an einem lokalen Ziel; die Engine selbst testet provider.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { run as exec, temporary } from './fixtures.mjs';

const root = process.env.WORKFLOW_KIT_TARGET || fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const hookTimeout = Number(process.env.WORKFLOW_KIT_HOOK_TIMEOUT_MS) || 30_000;
const { impeccable: version } = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));

test('two SessionStart hooks at the same time install Impeccable once, and the next call finds it', async t => {
  const temp = temporary(t, 'hook-twice-');
  const checkout = path.join(temp, 'checkout'), home = path.join(temp, 'home');
  for (const from of ['.agents/hooks', '.agents/skills/ponytail'])
    cpSync(path.join(root, from), path.join(checkout, from), { recursive: true, dereference: true });
  cpSync(path.join(root, 'scripts'), path.join(checkout, 'scripts'), { recursive: true, filter: file => path.basename(file) !== 'tests' });
  mkdirSync(path.join(checkout, '.git'));
  mkdirSync(path.join(checkout, '.github'));
  writeFileSync(path.join(checkout, '.github/workflow-project.json'), '{"impeccable":true}');
  // The engine comes from a local server and is checked against a pin for exactly these bytes.
  const bytes = Buffer.from('engine bytes of the two-sessions test\n');
  const asset = `impeccable-${windows ? 'windows' : process.platform}-${windows ? 'x64' : process.arch}${windows ? '.exe' : ''}`;
  writeFileSync(path.join(checkout, 'scripts/impeccable/SHA256SUMS'), `${createHash('sha256').update(bytes).digest('hex')}  ${asset}\n`);
  let downloads = 0;
  const server = createServer((request, response) => { downloads++; setTimeout(() => response.end(bytes), 300); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, HOME: home, USERPROFILE: home, IMPECCABLE_DOWNLOAD_BASE: `http://127.0.0.1:${server.address().port}`, PONYTAIL_DEFAULT_MODE: 'full', CLAUDE_PROJECT_DIR: checkout };
  const call = () => exec(process.execPath, [path.join(checkout, 'scripts/kit-hook.mjs'), 'SessionStart', '--agent', 'claude'],
    { cwd: checkout, env, input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: checkout }), timeout: hookTimeout });
  const engineHome = path.join(home, '.impeccable/workflow-kit');
  const engine = path.join(engineHome, `engine-${version}`, windows ? 'impeccable.exe' : 'impeccable');
  const lock = path.join(home, '.ponytail/workflow-kit/.install.lock');
  await Promise.all([call(), call()]);
  for (let wait = 0; (!existsSync(engine) || existsSync(lock)) && wait < hookTimeout; wait += 100) await new Promise(resolve => setTimeout(resolve, 100));
  const log = path.join(home, '.ponytail/workflow-kit/.install.log');
  assert.ok(existsSync(engine), `one of the two hooks installed the engine${existsSync(log) ? `: ${readFileSync(log, 'utf8')}` : ''} downloads=${downloads}`);
  assert.equal(downloads, 1, 'exactly one download');
  assert.deepEqual(readdirSync(engineHome).filter(name => name.startsWith('engine-')), [`engine-${version}`], 'exactly one installation folder');
  assert.doesNotMatch((await call()).stdout, /Impeccable hooks are OFF/, 'the next call finds the installation');
  assert.equal(downloads, 1, 'finding it downloads nothing');
  // The last call started a verifying installer that still holds the folder; Windows cannot remove it before.
  for (let wait = 0; wait < 500 || (existsSync(lock) && wait < hookTimeout); wait += 100) await new Promise(resolve => setTimeout(resolve, 100));
});
