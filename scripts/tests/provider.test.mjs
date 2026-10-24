// Zweck: Die gemeinsame Anbieter-Engine (provider.mjs) haelt ihre Sicherheitsregeln fuer jeden Anbieter ein.
// Nutzen: Absturz mitten im Veroeffentlichen, zwei gleichzeitige Laeufe und falsche Pruefsummen werden einmal hier geprueft; je Anbieter genuegt ein Rauchtest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { context, guarded, install, outsideCheckouts, publish, withLock } from '../provider.mjs';
import impeccable from '../provider-impeccable.mjs';
import ponytail from '../provider-ponytail.mjs';
import { temporary } from './fixtures.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const data = text => `data:application/octet-stream;base64,${Buffer.from(text).toString('base64')}`;
const sleep = ms => new Promise(done => setTimeout(done, ms));
/** A provider that installs the given files below <home>/.fake/kit/1.0.0. */
const fake = files => ({ name: 'fake', label: 'Fake', install: { home: ['.fake', 'kit'], directory: version => version, launcher: 'run', files: () => files } });
function installFixture(t) {
  const home = join(temporary(t, 'provider install '), 'home');
  return { home, parent: join(home, '.fake/kit'), c: { home, outside: outsideCheckouts, versions: { fake: '1.0.0' } } };
}
const names = directory => readdirSync(directory).sort();

test('a download with a wrong checksum installs nothing and leaves nothing behind but the error log', async t => {
  const { parent, c } = installFixture(t);
  const p = fake({ engine: { url: data('tampered'), sha256: sha('engine'), mode: 0o555 } });
  await assert.rejects(install(p, c));
  assert.deepEqual(names(parent), ['.fake.log'], 'no folder, no staging, no lock');
  assert.ok(readFileSync(join(parent, '.fake.log'), 'utf8').length > 0, 'the failure is in the log');
});

test('a crash while staging leaves no partial installation, and the next run completes it', async t => {
  const { parent, c } = installFixture(t);
  const second = Buffer.from('second');
  const broken = fake({ first: { bytes: Buffer.from('first') }, second: { url: data('other'), sha256: sha(second) } });
  await assert.rejects(install(broken, c));
  assert.deepEqual(names(parent), ['.fake.log']);
  await install(fake({ first: { bytes: Buffer.from('first') }, second: { url: data('second'), sha256: sha(second) } }), c);
  assert.deepEqual(names(parent), ['1.0.0'], 'the log of the failed run is gone');
  assert.equal(readFileSync(join(parent, '1.0.0/second'), 'utf8'), 'second');
});

test('an installed version is verified, never replaced; the empty folder of an old failed download is filled', async t => {
  const { parent, c } = installFixture(t);
  const file = join(parent, '1.0.0/engine');
  mkdirSync(join(parent, '1.0.0'), { recursive: true });
  await install(fake({ engine: { bytes: Buffer.from('reviewed') } }), c);
  assert.equal(readFileSync(file, 'utf8'), 'reviewed');
  await install(fake({ engine: { bytes: Buffer.from('reviewed') } }), c);
  writeFileSync(file, 'tampered');
  await assert.rejects(install(fake({ engine: { bytes: Buffer.from('reviewed') } }), c));
  assert.equal(readFileSync(file, 'utf8'), 'tampered', 'the existing installation stays');
});

test('a verified file that lost its executable bit gets it back', { skip: process.platform === 'win32' }, async t => {
  const { parent, c } = installFixture(t);
  const file = join(parent, '1.0.0/engine');
  mkdirSync(join(parent, '1.0.0'), { recursive: true });
  writeFileSync(file, 'engine', { mode: 0o644 });
  await install(fake({ engine: { bytes: Buffer.from('engine'), mode: 0o555 } }), c);
  assert.equal(statSync(file).mode & 0o111, 0o111);
});

test('an old installation that cannot be removed is skipped and the installation still succeeds', async t => {
  const { parent, c } = installFixture(t);
  const old = join(parent, '0.9.0');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'engine'), 'old');
  // Windows cannot delete a program that is running from the folder; POSIX cannot remove entries from a read-only folder.
  let running = null;
  if (process.platform === 'win32') {
    cpSync(process.execPath, join(old, 'busy.exe'));
    running = spawn(join(old, 'busy.exe'), ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await once(running, 'spawn');
  } else {
    chmodSync(old, 0o555);
  }
  // Last: adding files renews the folder's modification time, and an unused folder is what gets pruned.
  const past = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(old, past, past);
  try {
    await install(fake({ engine: { bytes: Buffer.from('new') } }), c);
    assert.equal(readFileSync(join(parent, '1.0.0/engine'), 'utf8'), 'new');
    assert.equal(existsSync(join(old, 'engine')), true, 'the old installation is kept for the next run');
  } finally {
    if (running) running.kill(); else chmodSync(old, 0o755);
  }
});

test('the Ponytail start files are written only when their content changes', async t => {
  const dir = join(temporary(t, 'ponytail launcher '), 'install');
  mkdirSync(dir, { recursive: true });
  const names = ['launch.sh', 'launch.cmd'];
  ponytail.install.after(dir, {});
  const first = Object.fromEntries(names.map(name => [name, readFileSync(join(dir, name), 'utf8')]));
  const past = new Date(Date.now() - 86_400_000);
  for (const name of names) utimesSync(join(dir, name), past, past);
  ponytail.install.after(dir, {});
  for (const name of names) assert.equal(statSync(join(dir, name)).mtimeMs, past.getTime(), `${name} was rewritten although it is unchanged`);
  writeFileSync(join(dir, 'launch.sh'), 'stale');
  ponytail.install.after(dir, {});
  assert.equal(readFileSync(join(dir, 'launch.sh'), 'utf8'), first['launch.sh'], 'a changed start file is replaced');
});

test('a home inside a checkout is refused before anything is written', async t => {
  const { home, c } = installFixture(t);
  mkdirSync(join(home, '.git'), { recursive: true });
  await assert.rejects(install(fake({ engine: { bytes: Buffer.from('engine') } }), c));
  assert.equal(existsSync(join(home, '.fake')), false);
});

test('two simultaneous installations run one after the other and both succeed', async t => {
  const { parent, c } = installFixture(t);
  let active = 0, peak = 0;
  const p = fake({ engine: { bytes: Buffer.from('engine') } });
  p.install.after = async () => { peak = Math.max(peak, ++active); await sleep(150); active--; };
  await Promise.all([install(p, c), install(p, c)]);
  assert.equal(peak, 1, 'the second run waited for the first');
  assert.deepEqual(names(parent), ['1.0.0']);
});

test('a lock of a dead or hung run is taken over, the lock of a live one is waited for and kept', async t => {
  const lock = join(temporary(t, 'provider lock '), 'x.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(spawnSync(process.execPath, ['-e', '']).pid)); // a process that has ended
  assert.equal(await withLock(lock, () => 'dead holder replaced'), 'dead holder replaced');
  assert.equal(existsSync(lock), false, 'released after the work');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  await assert.rejects(withLock(lock, () => assert.fail('must not run'), { wait: 300 }));
  assert.ok(existsSync(lock), 'the live holder keeps its lock');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  await assert.rejects(withLock(lock, () => assert.fail('must not run'), { wait: 300, stale: 1000 }), 'an old lock of a live process is not taken over');
  assert.ok(existsSync(lock));
  rmSync(join(lock, 'pid'));
  utimesSync(lock, old, old);
  assert.equal(await withLock(lock, () => 'pid-less old lock replaced', { stale: 1000 }), 'pid-less old lock replaced');
});

test('a run whose lock was taken over by another does not delete that lock when it finishes', async t => {
  const lock = join(temporary(t, 'provider lock '), 'x.lock');
  await withLock(lock, () => { writeFileSync(join(lock, 'pid'), String(process.pid + 1)); });
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid + 1));
});

test('a failed run is logged, a later success removes the log, and the lock is free either way', async t => {
  const dir = temporary(t, 'provider log ');
  await assert.rejects(guarded(dir, 'x', () => { throw new Error('boom'); }), /boom/);
  assert.match(readFileSync(join(dir, '.x.log'), 'utf8'), /boom/);
  assert.equal(existsSync(join(dir, '.x.lock')), false);
  await guarded(dir, 'x', () => {});
  assert.deepEqual(names(dir), []);
});

test('a crash in the middle of publishing keeps finished outputs whole, removes the staging and is repaired by the next run', async t => {
  const root = temporary(t, 'provider publish ');
  mkdirSync(join(root, '.git'));
  const outputs = ['a', 'b', 'c'].map(name => [`.agents/skills/${name}`, name]);
  const build = (missing = '') => (c, next) => {
    for (const name of ['a', 'b', 'c'].filter(name => name !== missing)) {
      mkdirSync(join(next, name), { recursive: true });
      writeFileSync(join(next, name, 'SKILL.md'), `skill ${name}\n`);
    }
    return { outputs, message: 'published' };
  };
  const state = join(root, '.workflow-kit');
  await assert.rejects(publish({ name: 'fake', build: build('c') }, { root }));
  assert.deepEqual(names(state), ['.fake.log'], 'no staging folder, no lock');
  assert.equal(readFileSync(join(root, '.agents/skills/b/SKILL.md'), 'utf8'), 'skill b\n');
  assert.equal(existsSync(join(root, '.agents/skills/c')), false);
  await publish({ name: 'fake', build: build() }, { root });
  assert.equal(readFileSync(join(root, '.agents/skills/c/SKILL.md'), 'utf8'), 'skill c\n');
  assert.deepEqual(names(state), [], 'the log of the failed run is gone');
});

test('Impeccable smoke: the engine is downloaded, checked against its reviewed pin and made executable', async t => {
  const base = temporary(t, 'provider impeccable ');
  const bytes = Buffer.from('engine bytes of this test\n');
  const asset = `impeccable-${process.platform === 'win32' ? 'windows' : process.platform}-${process.platform === 'win32' ? 'x64' : process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
  mkdirSync(join(base, 'kit/scripts/impeccable'), { recursive: true });
  writeFileSync(join(base, 'kit/scripts/versions.json'), JSON.stringify({ impeccable: '0.0.1' }));
  writeFileSync(join(base, 'kit/scripts/impeccable/SHA256SUMS'), `${sha(bytes)}  ${asset}\n`);
  const served = { bytes };
  const server = createServer((request, response) => response.end(served.bytes));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const previous = process.env.IMPECCABLE_DOWNLOAD_BASE;
  process.env.IMPECCABLE_DOWNLOAD_BASE = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { if (previous === undefined) delete process.env.IMPECCABLE_DOWNLOAD_BASE; else process.env.IMPECCABLE_DOWNLOAD_BASE = previous; });
  const c = context({ kit: join(base, 'kit'), home: join(base, 'home') });
  const directory = join(base, 'home/.impeccable/workflow-kit/engine-0.0.1');
  served.bytes = Buffer.from('tampered');
  await assert.rejects(install(impeccable, c));
  assert.equal(existsSync(directory), false);
  served.bytes = bytes;
  await install(impeccable, c);
  const engine = join(directory, process.platform === 'win32' ? 'impeccable.exe' : 'impeccable');
  assert.deepEqual(readFileSync(engine), bytes);
  if (process.platform !== 'win32') {
    chmodSync(engine, 0o644);
    await install(impeccable, c);
    assert.equal(statSync(engine).mode & 0o111, 0o111);
  }
});

test('provider.mjs runs when started through a link to the kit, as .vendor/workflow-kit is one', t => {
  const link = join(temporary(t, 'provider link '), 'kit-scripts');
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link, process.platform === 'win32' ? 'junction' : 'dir');
  const run = spawnSync(process.execPath, [join(link, 'provider.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 2, 'the usage error proves the entry point ran, not a silent exit 0');
  assert.match(run.stderr, /Usage: node/);
});
