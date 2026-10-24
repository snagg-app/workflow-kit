import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TABLE, affectedTests, projectCommands, readProjectMap } from '../affected-tests.mjs';
import { run, temporary } from './fixtures.mjs';

const names = result => result.tests.map(path => path.replace('scripts/tests/', ''));

test('a Markdown change selects only the static file checks', () => {
  assert.deepEqual(names(affectedTests(['docs/parallel-drivers.md', 'README.md'])), ['text-files.test.mjs']);
});

test('a board.mjs change selects the board tests, not the Git hook tests', () => {
  const selected = names(affectedTests(['scripts/board.mjs']));
  assert.ok(selected.includes('board-check.test.mjs') && selected.includes('board-wait.test.mjs'));
  assert.ok(selected.every(name => name.startsWith('board-') || name === 'text-files.test.mjs'), selected.join());
});

test('the GitHub adapter and every board command module select the board tests', () => {
  for (const file of ['scripts/github.mjs', 'scripts/board-reviews.mjs', 'scripts/board-merge.mjs']) {
    assert.ok(names(affectedTests([file])).includes('board-wait.test.mjs'), file);
  }
});

test('a hook change selects the hook tests and nothing slower than needed', () => {
  assert.deepEqual(names(affectedTests(['scripts/install-git-hooks.mjs'])), ['git-hooks.test.mjs', 'kit-init-hook.test.mjs', 'text-files.test.mjs']);
});

test('the Git tool, is-main and the Git hooks select the tests that import them', () => {
  assert.ok(names(affectedTests(['scripts/git-tool.mjs'])).includes('board-checkout.test.mjs'));
  assert.ok(names(affectedTests(['scripts/is-main.mjs'])).includes('board-modules.test.mjs'));
  assert.ok(names(affectedTests(['.githooks/pre-push'])).includes('git-hooks.test.mjs'));
});

test('a changed test runs itself; an unmapped script is reported instead of skipped', () => {
  const result = affectedTests(['scripts/tests/setup.test.mjs', 'scripts/not-yet-mapped.mjs']);
  assert.ok(names(result).includes('setup.test.mjs'));
  assert.deepEqual(result.unmapped, ['scripts/not-yet-mapped.mjs']);
});

test('every kit script outside scripts/tests has a row in the table', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = execFileSync('git', ['ls-files', '--', ':(glob)scripts/**/*.mjs'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter(file => file && !file.startsWith('scripts/tests/'));
  assert.deepEqual(files.filter(file => !TABLE.some(([pattern]) => pattern.test(file))), []);
});

test('a project map names the commands of the changed paths, each once', () => {
  const map = { 'backend/domain/**': './gradlew :domain:test', 'frontend/web/**': ['npm test', './gradlew :domain:test'], '*.md': [] };
  assert.deepEqual(projectCommands(['backend/domain/src/A.java', 'frontend/web/a.ts'], map), ['./gradlew :domain:test', 'npm test']);
  assert.deepEqual(projectCommands(['backend/api/A.java', 'x/frontend/web/a.ts', 'README.md'], map), []);
});

test('with a project file the command lists its entries; without one nothing changes', async t => {
  const project = temporary(t, 'affected-tests-');
  mkdirSync(join(project, '.git'));
  const ask = () => run(process.execPath, [fileURLToPath(new URL('../affected-tests.mjs', import.meta.url)), 'backend/domain/A.java', 'scripts/board.mjs'], { cwd: project });
  const without = await ask();
  assert.deepEqual([without.status, without.stdout], [0, '']); // the project's scripts/board.mjs is no kit file
  mkdirSync(join(project, '.github'));
  writeFileSync(join(project, '.github/affected-tests.json'), JSON.stringify({ 'backend/domain/**': './gradlew :domain:test' }));
  assert.equal((await ask()).stdout, './gradlew :domain:test\n');
  // --cwd names the project from another directory; the map and the file arguments are the project's
  const elsewhere = temporary(t, 'affected-tests-');
  mkdirSync(join(elsewhere, '.git'));
  const script = fileURLToPath(new URL('../affected-tests.mjs', import.meta.url));
  const named = await run(process.execPath, [script, '--cwd', project, 'backend/domain/A.java'], { cwd: elsewhere });
  assert.deepEqual([named.status, named.stdout], [0, './gradlew :domain:test\n'], named.stderr);
  assert.equal((await run(process.execPath, [script, '--cwd'], { cwd: elsewhere })).status, 2);
});

test('--run prints no line per test or command when green, and the output of the failure when red', async t => {
  const script = fileURLToPath(new URL('../affected-tests.mjs', import.meta.url));
  const { NODE_TEST_CONTEXT, ...outside } = process.env; // inside `node --test`, a nested one would report to its parent
  const green = await run(process.execPath, [script, '--run', 'README.md'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: outside });
  assert.equal(green.status, 0);
  assert.match(green.stdout, /^run: node --test \(\d+ files\)\nℹ tests \d+\nℹ pass \d+\nℹ fail 0\ntook [\d.]+ s\n$/);
  const project = temporary(t, 'affected-tests-');
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.github'));
  const map = JSON.stringify({ 'a/**': 'node -e "console.log(process.env.OUT); process.exit(Number(process.env.FAIL || 0))"' });
  writeFileSync(join(project, '.github/affected-tests.json'), map);
  const ask = env => run(process.execPath, [script, '--run', 'a/B.java'], { cwd: project, env: { ...outside, ...env } });
  const ok = await ask({ OUT: 'chatter' });
  assert.deepEqual([ok.status, ok.stdout.split('\n')[1].startsWith('ok: ')], [0, true], ok.stdout);
  assert.ok(!ok.stdout.includes('chatter'));
  const red = await ask({ OUT: 'broken output', FAIL: '1' });
  assert.deepEqual([red.status, red.stdout.split('\n').slice(1, -2).join('\n')], [1, 'broken output']);
});

test('--run names a command before it starts, with the duration after it', async t => {
  const script = fileURLToPath(new URL('../affected-tests.mjs', import.meta.url));
  const { NODE_TEST_CONTEXT, ...outside } = process.env;
  const project = temporary(t, 'affected-tests-');
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.github'));
  // The command waits for a file that the test creates only after it has read the `run:` line, so a line printed after the run times out.
  const wait = 'node -e "const fs=require(\'fs\');while(!fs.existsSync(process.env.GATE))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)"';
  writeFileSync(join(project, '.github/affected-tests.json'), JSON.stringify({ 'a/**': wait }));
  const gate = join(project, 'gate');
  const child = spawn(process.execPath, [script, '--run', 'a/B.java'], { cwd: project, env: { ...outside, GATE: gate }, stdio: ['ignore', 'pipe', 'inherit'] });
  const timer = setTimeout(() => child.kill(), 10000);
  t.after(() => clearTimeout(timer));
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; if (out.includes(`run: ${wait}\n`)) writeFileSync(gate, ''); });
  await new Promise(resolve => child.on('close', resolve));
  assert.match(out, /^run: node -e .*\nok: .*\ntook [\d.]+ s\n$/s);
});

test('--resume skips the green steps of the same head after a red one', async t => {
  const script = fileURLToPath(new URL('../affected-tests.mjs', import.meta.url));
  const { NODE_TEST_CONTEXT, ...outside } = process.env;
  const project = temporary(t, 'affected-tests-');
  await run('git', ['init', '-q'], { cwd: project });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: project });
  mkdirSync(join(project, '.github'));
  const ok = 'node -e "process.exit(0)"', bad = 'node -e "process.exit(Number(process.env.FAIL || 0))"';
  writeFileSync(join(project, '.github/affected-tests.json'), JSON.stringify({ 'a/**': [ok, bad] }));
  const steps = join(project, 'steps');
  const ask = env => run(process.execPath, [script, '--run', '--resume', steps, 'a/B.java'], { cwd: project, env: { ...outside, ...env } });
  const red = await ask({ FAIL: '1' });
  assert.equal(red.status, 1);
  const again = await ask({});
  assert.equal(again.status, 0);
  assert.ok(again.stdout.includes(`skip (green for this head): ${ok}`) && again.stdout.includes(`run: ${bad}`), again.stdout);
});

test('--resume does not skip another selection of the same size at the same head', async t => {
  const script = fileURLToPath(new URL('../affected-tests.mjs', import.meta.url));
  const { NODE_TEST_CONTEXT, ...outside } = process.env;
  const cwd = fileURLToPath(new URL('../..', import.meta.url)), steps = join(temporary(t, 'affected-tests-'), 'steps');
  const ask = file => run(process.execPath, [script, '--run', '--resume', steps, file], { cwd, env: outside });
  assert.equal((await ask('scripts/quota-sample.mjs')).status, 0);
  const other = await ask('scripts/check-submodule-sources.mjs');
  assert.ok(other.stdout.includes('run: node --test (2 files)') && !other.stdout.includes('skip'), other.stdout);
});

test('a project entry without a command is refused', t => {
  const project = temporary(t, 'affected-tests-');
  mkdirSync(join(project, '.github'));
  writeFileSync(join(project, '.github/affected-tests.json'), JSON.stringify({ 'backend/**': 3 }));
  assert.throws(() => readProjectMap(project), /"backend\/\*\*" needs a command/);
});

test('every table row points at tests that exist', () => {
  const available = readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.test.mjs'));
  for (const [, targets] of TABLE) for (const target of targets)
    assert.ok(available.some(name => (target instanceof RegExp ? target.test(name) : name === target)), String(target));
});

test('an unknown option is refused with exit 2 and a usage text, --help exits 0', async () => {
  const script = fileURLToPath(new URL('../affected-tests.mjs', import.meta.url));
  const unknown = await run(process.execPath, [script, '--nope']), help = await run(process.execPath, [script, '--help']);
  assert.equal(unknown.status, 2);
  assert.doesNotMatch(unknown.stderr, /ERR_PARSE_ARGS/, 'no Node error code');
  assert.equal(help.status, 0);
});
