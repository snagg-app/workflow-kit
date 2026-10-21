import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { rename } from '../provider-links.mjs';
import { isolatedGit, run as spawn, temporary } from './fixtures.mjs';

const hook = fileURLToPath(new URL('../kit-hook.mjs', import.meta.url));
const templates = fileURLToPath(new URL('../../templates/', import.meta.url));

/** The process entry of the hooks: hook JSON in, output out. SubagentStart does the kit check and installs nothing;
 * a personal home without snapshots keeps Ponytail and Impeccable silent. */
const call = (event, cwd, env, input = {}) => spawn(process.execPath, [hook, event, '--agent', 'claude'],
  { cwd, env: { ...env, USERPROFILE: env.HOME }, input: JSON.stringify({ hook_event_name: event, ...input }) });
const home = temp => { const dir = join(temp, 'home'); mkdirSync(dir, { recursive: true }); return dir; };

// Every test runs in its own temporary directory with its own repositories, so they run side by side.
describe('kit hook', { concurrency: true }, () => {
test('initializes a missing kit once and leaves an initialized one alone', async t => {
  const temp = temporary(t, 'kit-init ');
  // The test submodule is a local path; Git blocks that transport for submodules unless allowed.
  const local = { ...isolatedGit(temp), HOME: home(temp), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const git = async (cwd, ...a) => {
    const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env: local });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const fixture = async (name, ...files) => { const dir = join(temp, name); mkdirSync(dir); await git(dir, 'init', '--quiet'); for (const file of files) writeFileSync(join(dir, file), 'x'); return dir; };

  const kit = await fixture('kit', 'AGENT_RULES.md');
  // Checkout code the hook must not run: a team-wide relative core.hooksPath reaches the kit's own .githooks.
  mkdirSync(join(kit, '.githooks'));
  writeFileSync(join(kit, '.githooks/post-checkout'), '#!/bin/sh\necho ran > "$HOOK_MARKER"\n');
  await git(kit, 'add', '.'); await git(kit, 'update-index', '--chmod=+x', '.githooks/post-checkout'); await git(kit, 'commit', '--quiet', '-m', 'kit');
  const origin = await fixture('origin', 'README.md');
  await git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
  await git(origin, 'add', '.'); await git(origin, 'commit', '--quiet', '-m', 'consumer');
  const plain = await fixture('plain', 'README.md');
  await git(plain, 'add', '.'); await git(plain, 'commit', '--quiet', '-m', 'plain');
  let count = 0;
  const clone = async () => { const dir = join(temp, 'clone' + count++); await git(temp, 'clone', '--quiet', origin, dir); return dir; };
  const marker = join(temp, 'hook-ran').replaceAll('\\', '/');
  const nested = { ...local, HOOK_MARKER: marker, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '.githooks' };
  // Precondition: without the hook's protection that git hook does run during the init.
  const bare = await clone();
  const initialized = await spawn('git', ['submodule', '--quiet', 'update', '--init', '--checkout', '.vendor/workflow-kit'], { cwd: bare, env: nested });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.ok(existsSync(marker), 'the fixture hook runs when nothing disables hooks');
  rmSync(marker);

  const trial = (cwd, env) => call('SubagentStart', cwd, { ...nested, ...env });
  const [first, second] = [await clone(), await clone()];
  assert.ok(!existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), 'fresh clone starts without the kit');

  let result = await trial(first);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'a successful init prints nothing');
  assert.ok(existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), 'the hook initializes the kit');
  assert.ok(!existsSync(marker), 'the hook runs no git hook from the checkout');

  const rules = join(first, '.vendor/workflow-kit/AGENT_RULES.md');
  rmSync(rules);
  result = await trial(first);
  assert.notEqual(result.stdout.trim(), '', 'a kit whose rules file is missing despite the update is reported');
  await git(join(first, '.vendor/workflow-kit'), 'checkout', '--', 'AGENT_RULES.md');

  rename(kit, `${kit}-gone`);
  result = await trial(first);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], 'an initialized kit is not touched, not even to reach the source');

  result = await trial(second);
  assert.equal(result.status, 0, 'a failed init must not abort the session');
  assert.notEqual(result.stdout.trim(), '', 'a failed init prints the manual command');
  assert.ok(!existsSync(join(second, '.vendor/workflow-kit/AGENT_RULES.md')));
  rename(`${kit}-gone`, kit);

  // An initialized kit whose gitlink moved on (a base merge) lags behind the pin; the pin commit is not fetched yet.
  const head = async inner => (await git(inner, 'rev-parse', 'HEAD')).trim();
  // Initializing a submodule is the slowest Git call here, so it happens once; every case starts from a copy.
  let template;
  const stale = async () => {
    template ??= (async () => {
      const dir = await clone();
      await git(dir, 'submodule', '--quiet', 'update', '--init', '.vendor/workflow-kit');
      return dir;
    })();
    const dir = join(temp, 'clone' + count++), inner = join(dir, '.vendor/workflow-kit');
    cpSync(await template, dir, { recursive: true });
    const old = await head(inner);
    await git(kit, 'commit', '--quiet', '--allow-empty', '-m', 'newer');
    const pin = await head(kit);
    await git(dir, 'update-index', '--cacheinfo', `160000,${pin},.vendor/workflow-kit`);
    assert.notEqual(old, pin, 'the kit lags behind its pin');
    return { dir, inner, old, pin };
  };
  let lag = await stale();
  result = await trial(lag.dir);
  assert.deepEqual([result.status, result.stdout, await head(lag.inner)], [0, '', lag.pin], 'the hook moves a lagging kit to the pin');
  assert.ok(!existsSync(marker), 'the update runs no git hook from the checkout');

  // Work that a checkout would lose stays: local changes, unpublished commits. Both are reported.
  lag = await stale();
  writeFileSync(join(lag.inner, 'notes.txt'), 'mine');
  result = await trial(lag.dir);
  assert.notEqual(result.stdout.trim(), '', 'a lagging kit with local changes is reported');
  assert.deepEqual([await head(lag.inner), existsSync(join(lag.inner, 'notes.txt'))], [lag.old, true]);
  lag = await stale();
  await git(lag.inner, 'commit', '--quiet', '--allow-empty', '-m', 'mine');
  const mine = await head(lag.inner);
  result = await trial(lag.dir);
  assert.notEqual(result.stdout.trim(), '', 'a lagging kit with unpublished commits is reported');
  assert.equal(await head(lag.inner), mine);

  lag = await stale();
  rename(kit, `${kit}-gone`);
  result = await trial(lag.dir);
  assert.notEqual(result.stdout.trim(), '', 'a lagging kit that cannot be updated is reported');
  assert.equal(await head(lag.inner), lag.old);
  rename(`${kit}-gone`, kit);

  // A .git file that points nowhere (aborted first clone): with other files in the folder the hook only reports,
  // with nothing but the .git file it clears it, and an empty modules remnant, and loads the pin again.
  lag = await stale();
  rmSync(join(lag.dir, '.git/modules'), { recursive: true });
  result = await trial(lag.dir);
  assert.notEqual(result.stdout.trim(), '', 'a kit with a dangling .git and other files is reported');
  assert.ok(existsSync(join(lag.inner, 'AGENT_RULES.md')));
  for (const name of ['AGENT_RULES.md', '.githooks']) rmSync(join(lag.inner, name), { recursive: true });
  mkdirSync(join(lag.dir, '.git/modules'));
  result = await trial(lag.dir);
  assert.deepEqual([result.status, result.stdout, await head(lag.inner)], [0, '', lag.pin], 'the hook repairs a dangling .git');

  // The agent's project directory wins over the hook's working directory.
  const away = await clone();
  result = await trial(temp, { CLAUDE_PROJECT_DIR: away });
  assert.ok(existsSync(join(away, '.vendor/workflow-kit/AGENT_RULES.md')), 'the hook initializes the project directory, not the working directory');

  const noGit = mkdtempSync(join(temp, 'no-git '));
  result = await trial(await clone(), { PATH: noGit });
  assert.deepEqual([result.status, result.stdout.trim() !== ''], [0, true], 'a missing git is reported, not skipped silently');

  result = await trial(plain);
  assert.deepEqual([result.status, result.stdout], [0, ''], 'a project without a kit gitlink is left alone');
  assert.ok(!existsSync(join(plain, '.vendor')));
});

test('a clean checkout is fast-forwarded to its fetched base, a changed one is warned, and the network is never needed', async t => {
  const temp = temporary(t, 'kit-behind ');
  const env = { ...isolatedGit(temp), HOME: home(temp), CLAUDE_PROJECT_DIR: '' };
  const git = async (cwd, ...a) => {
    const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // The message names the repository: equal commits made in the same second would have equal ids.
  const commit = dir => git(dir, 'commit', '--quiet', '--allow-empty', '-m', `c ${count} ${dir}`);
  let count = 0;
  /** A clone of an upstream that moved on `behind` commits since the last fetch, plus `own` commits made in the clone. */
  const scenario = async (behind, own) => {
    const up = join(temp, `up${count}`), dir = join(temp, `work${count++}`);
    mkdirSync(up); await git(up, 'init', '--quiet'); await commit(up);
    await git(temp, 'clone', '--quiet', up, dir);
    for (let i = 0; i < behind; i++) await commit(up);
    if (behind) await git(dir, 'fetch', '--quiet');
    for (let i = 0; i < own; i++) await commit(dir);
    return { up, dir };
  };
  const state = async dir => [await git(dir, 'rev-parse', 'HEAD'), await git(dir, 'rev-parse', 'origin/HEAD'), await git(dir, 'status', '--porcelain')];
  const dirty = dir => writeFileSync(join(dir, 'notes.txt'), 'mine');
  const trial = (cwd, extra) => call('SubagentStart', cwd, { ...env, ...extra });
  const silent = async (cwd, why) => { const r = await trial(cwd); assert.deepEqual([r.status, r.stdout], [0, ''], why); };

  await silent((await scenario(0, 0)).dir, 'an up-to-date checkout is not reported');
  await silent((await scenario(0, 1)).dir, 'a checkout ahead of its base is not reported');
  await silent((await scenario(2, 1)).dir, 'a checkout with commits of its own is not reported');
  await silent((await scenario(2, 0)).dir, 'a clean checkout is not reported: it is fast-forwarded');

  const { up, dir } = await scenario(2, 0);
  await dirty(dir);
  const before = await state(dir);
  let result = await trial(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\b2\b/, 'the hook reports how many commits the checkout is behind');
  assert.doesNotThrow(() => JSON.parse(result.stdout), 'host JSON');
  assert.deepEqual(await state(dir), before, 'the warning changes nothing');

  // A branch without upstream is still compared with the remote's default branch; no remote is contacted.
  await git(dir, 'switch', '--quiet', '-c', 'solo', '--no-track');
  rename(up, `${up}-gone`);
  result = await trial(dir);
  assert.match(result.stdout, /\b2\b/, 'the check uses the last fetched state, not the network');

  const outside = join(temp, `plain${count++}`);
  mkdirSync(outside); await git(outside, 'init', '--quiet'); await commit(outside);
  await silent(outside, 'a checkout without remote is left alone');
  await silent(temp, 'a directory outside any repository is left alone');

  const kept = async ({ dir }, why) => {
    const before = await state(dir);
    const result = await trial(dir);
    assert.deepEqual([result.status, await state(dir)], [0, before], why);
  };
  await kept(await scenario(2, 1), 'a checkout with commits of its own is not moved');
  const changed = await scenario(2, 0);
  await dirty(changed.dir);
  await kept(changed, 'a checkout with local changes is not moved');

  // No network and no upstream branch: the last fetched origin/HEAD is enough.
  const fetched = await scenario(2, 0);
  await git(fetched.dir, 'switch', '--quiet', '-c', 'solo', '--no-track');
  rename(fetched.up, `${fetched.up}-gone`);
  result = await trial(fetched.dir);
  assert.equal(result.status, 0, result.stderr);
  const [head, base, status] = await state(fetched.dir);
  assert.deepEqual([head, status], [base, ''], 'the hook fast-forwards a clean checkout to the last fetched base');

  // No git hook of the checkout runs: a team-wide relative core.hooksPath reaches a post-merge hook that arrives with the merge.
  const marker = join(temp, 'hook-ran').replaceAll('\\', '/');
  const nested = { HOOK_MARKER: marker, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.githooks' };
  const hooked = async () => {
    const { up, dir } = await scenario(0, 0);
    mkdirSync(join(up, '.githooks'));
    writeFileSync(join(up, '.githooks/post-merge'), '#!/bin/sh\necho ran > "$HOOK_MARKER"\n');
    await git(up, 'add', '.'); await git(up, 'update-index', '--chmod=+x', '.githooks/post-merge'); await commit(up);
    await git(dir, 'fetch', '--quiet');
    return dir;
  };
  const plainMerge = await spawn('git', ['merge', '--quiet', '--ff-only', 'origin/HEAD'], { cwd: await hooked(), env: { ...env, ...nested } });
  assert.equal(plainMerge.status, 0, plainMerge.stderr);
  assert.ok(existsSync(marker), 'the fixture hook runs when nothing disables hooks');
  rmSync(marker);
  const guarded = await hooked();
  await trial(guarded, nested);
  assert.equal((await state(guarded))[0], await git(guarded, 'rev-parse', 'origin/HEAD'), 'the checkout was fast-forwarded');
  assert.ok(!existsSync(marker), 'the hook runs no git hook from the checkout');
});

test('the kit moves to the pin of the fast-forwarded checkout', async t => {
  const temp = temporary(t, 'kit-follow ');
  // submodule.recurse=true is the documented setup: a project fast-forward then also checks out the new pin in the kit.
  const env = { ...isolatedGit(temp), HOME: home(temp), CLAUDE_PROJECT_DIR: '', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always', GIT_CONFIG_KEY_1: 'submodule.recurse', GIT_CONFIG_VALUE_1: 'true' };
  const git = async (cwd, ...a) => {
    const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const fixture = async (name, file) => { const dir = join(temp, name); mkdirSync(dir); await git(dir, 'init', '--quiet'); writeFileSync(join(dir, file), 'x'); await git(dir, 'add', '.'); await git(dir, 'commit', '--quiet', '-m', name); return dir; };
  const kit = await fixture('kit', 'AGENT_RULES.md'), origin = await fixture('origin', 'README.md');
  await git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
  await git(origin, 'commit', '--quiet', '-m', 'consumer');
  // A second clone works on a clean, published kit branch (#484).
  const [work, branched] = [join(temp, 'work'), join(temp, 'branched')];
  for (const dir of [work, branched]) await git(temp, 'clone', '--quiet', '--recurse-submodules', origin, dir);
  const [inner, branch] = [join(work, '.vendor/workflow-kit'), join(branched, '.vendor/workflow-kit')];
  await git(branch, 'switch', '--quiet', '-c', 'mine');
  const old = await git(branch, 'rev-parse', 'HEAD');
  // The consumer moves its pin to a newer kit commit; the clones only fetch that.
  await git(kit, 'commit', '--quiet', '--allow-empty', '-m', 'newer');
  const pin = await git(kit, 'rev-parse', 'HEAD');
  await git(join(origin, '.vendor/workflow-kit'), 'pull', '--quiet');
  await git(origin, 'commit', '--quiet', '-am', 'bump the kit');
  for (const dir of [work, branched]) await git(dir, 'fetch', '--quiet');
  assert.notEqual(await git(inner, 'rev-parse', 'HEAD'), pin, 'the kit lags behind the fetched pin');

  const result = await call('SubagentStart', work, env);
  assert.deepEqual([result.status, result.stdout], [0, ''], result.stderr);
  assert.deepEqual([await git(work, 'rev-parse', 'HEAD'), await git(inner, 'rev-parse', 'HEAD')], [await git(origin, 'rev-parse', 'HEAD'), pin]);

  // The project still moves, but the kit keeps its branch and commit.
  await call('SubagentStart', branched, env);
  assert.equal(await git(branched, 'rev-parse', 'HEAD'), await git(origin, 'rev-parse', 'HEAD'), 'the project fast-forwards');
  assert.deepEqual([await git(branch, 'symbolic-ref', '--short', 'HEAD'), await git(branch, 'rev-parse', 'HEAD')], ['mine', old], 'a kit branch is left alone');
});

test('a missing node_modules is reported with the project setup and nothing is installed', async t => {
  const temp = temporary(t, 'kit-modules ');
  const env = { ...isolatedGit(temp), HOME: home(temp), CLAUDE_PROJECT_DIR: '' };
  let count = 0;
  const project = async (manifest, setup) => {
    const dir = join(temp, `p${count++}`);
    mkdirSync(join(dir, '.github'), { recursive: true });
    assert.equal((await spawn('git', ['init', '--quiet'], { cwd: dir, env })).status, 0);
    if (manifest) writeFileSync(join(dir, 'package.json'), manifest);
    if (setup) writeFileSync(join(dir, '.github/workflow-project.json'), JSON.stringify({ setup }, null, 2));
    return dir;
  };
  // `resume` starts no installer; the personal home has no snapshots, so the output also carries the Ponytail hint.
  const trial = async dir => {
    const result = await call('SessionStart', dir, env, { source: 'resume' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const reported = async (dir, why) => {
    const out = await trial(dir);
    assert.match(out, /node_modules is missing/, why);
    assert.doesNotThrow(() => JSON.parse(out), 'host JSON');
    assert.ok(!existsSync(join(dir, 'node_modules')), 'nothing is installed');
    return out;
  };
  const silent = async (dir, why) => assert.doesNotMatch(await trial(dir), /node_modules/, why);

  const manifest = JSON.stringify({ name: 'x', devDependencies: { a: '1' } }, null, 2);
  await reported(await project(manifest), 'a worktree without node_modules is reported');
  assert.match(await reported(await project(manifest, 'pnpm run setup:all'), 'the setup field is honored'), /pnpm run setup:all/);

  const installed = await project(manifest);
  mkdirSync(join(installed, 'node_modules'));
  await silent(installed, 'a worktree with node_modules is left alone');
  await silent(await project(JSON.stringify({ name: 'x', dependencies: {} })), 'a manifest without dependencies is left alone');
  await silent(await project(JSON.stringify({ peerDependencies: { a: '1' } })), 'only the dependencies npm installs by default count');
  await silent(await project('{ not json'), 'a broken package.json is not reported');
  await silent(await project(), 'a project without package.json is left alone');
  await silent(temp, 'a directory outside any repository is left alone');
});

// Claude Code creates an agent worktree without checkout and resets it, so post-checkout never runs (#479). The hook
// then gets CLAUDE_PROJECT_DIR of the session that started the agent; the directory of the agent itself is on stdin.
test('the kit of the worktree named on stdin is filled, not only that of the project directory', async t => {
  const temp = temporary(t, 'kit-worktree ');
  const env = { ...isolatedGit(temp), HOME: home(temp), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const git = async (cwd, ...a) => {
    const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
  };
  const fixture = async (name, file) => { const dir = join(temp, name); mkdirSync(dir); await git(dir, 'init', '--quiet'); writeFileSync(join(dir, file), 'x'); await git(dir, 'add', '.'); await git(dir, 'commit', '--quiet', '-m', name); return dir; };
  const kit = await fixture('kit', 'AGENT_RULES.md'), origin = await fixture('origin', 'README.md');
  await git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
  await git(origin, 'commit', '--quiet', '-m', 'consumer');
  const project = join(temp, 'project'), worktree = join(temp, 'worktree');
  await git(temp, 'clone', '--quiet', '--recurse-submodules', origin, project);
  await git(project, 'worktree', 'add', '--quiet', '--no-checkout', '--detach', worktree, 'HEAD');
  await git(worktree, 'reset', '--quiet', '--hard');
  const rules = join(worktree, '.vendor/workflow-kit/AGENT_RULES.md');
  assert.ok(!existsSync(rules), 'a worktree created like Claude Code does starts without the kit');

  const result = await call('SubagentStart', project, { ...env, CLAUDE_PROJECT_DIR: project }, { cwd: worktree });
  assert.deepEqual([result.status, result.stdout], [0, ''], result.stderr);
  assert.ok(existsSync(rules), 'the kit of the agent worktree is initialized');
});

// Claude Code reads hooks once per session (#513): SessionStart keeps a fingerprint, SubagentStart compares it with the last fetched base.
test('a subagent is warned when the base changed the hook settings since the session started', async t => {
  const temp = temporary(t, 'kit-fingerprint ');
  const env = { ...isolatedGit(temp), HOME: home(temp), CLAUDE_CONFIG_DIR: join(temp, 'claude') };
  const git = async (cwd, ...a) => {
    const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
  };
  const origin = join(temp, 'origin'), project = join(temp, 'project');
  mkdirSync(join(origin, '.claude'), { recursive: true });
  await git(origin, 'init', '--quiet');
  const settings = text => writeFileSync(join(origin, '.claude/settings.json'), text);
  settings('{}');
  await git(origin, 'add', '.');
  await git(origin, 'commit', '--quiet', '-m', 'one');
  await git(temp, 'clone', '--quiet', origin, project);
  // `resume` keeps the fingerprint like `startup` but starts no installer.
  const session = (event, session_id, source) => call(event, project, { ...env, CLAUDE_PROJECT_DIR: project }, { session_id, source, cwd: project });
  const warns = async id => (await session('SubagentStart', id)).stdout.includes('Hooks seit Session-Start geändert: Session neu starten');

  await session('SessionStart', 'old', 'resume');
  assert.equal(await warns('old'), false, 'unchanged settings stay silent');
  settings('{"changed":true}');
  await git(origin, 'commit', '--quiet', '-am', 'two');
  await git(project, 'fetch', '--quiet');
  assert.equal(await warns('old'), true, 'a session that started before the change is warned');
  assert.equal(await warns('unknown'), false, 'a session without fingerprint is not');
  await session('SessionStart', 'old', 'compact');
  assert.equal(await warns('old'), true, 'a compaction does not reload hooks, so it keeps the fingerprint');
  await session('SessionStart', 'new', 'resume');
  assert.equal(await warns('new'), false, 'a session that started after the change is not');
});

// The one-line entries of the agent settings: they only find Node and the kit, then hand over to kit-hook.mjs.
const sh = process.platform === 'win32' ? spawnSync('where', ['sh']).stdout?.toString().split(/\r?\n/)[0] : '/bin/sh';
// Absolute: the Node-missing trial runs the shell with an empty PATH.
const powershell = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : spawnSync('which', ['pwsh']).stdout?.toString().trim();
const entries = [
  ['.claude/settings.json', 'command', sh, ['-c']],
  ['.codex/hooks.json', 'command', sh, ['-c']],
  ['.codex/hooks.json', 'commandWindows', powershell, ['-NoProfile', '-NonInteractive', '-Command']],
];
for (const [file, key, shell, args] of entries) {
  const available = Boolean(shell) && spawnSync(shell, args.at(-1) === '-c' ? ['-c', 'exit 0'] : ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`${file} ${key}: Node missing is a clear message, a missing kit is initialized, then kit-hook.mjs gets event and agent`, { skip: !available && `${shell} unavailable` }, async t => {
    const temp = temporary(t, 'kit-entry ');
    const handler = event => Object.values(JSON.parse(readFileSync(join(templates, file), 'utf8')).hooks[event]).flatMap(group => group.hooks)[0][key];
    const env = { ...isolatedGit(temp), HOME: home(temp), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always', HOOK_MARKER: join(temp, 'marker') };
    const git = async (cwd, ...a) => {
      const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
      assert.equal(result.status, 0, result.stderr);
    };
    // A kit whose hook module only records how it was called.
    const kit = join(temp, 'kit'), origin = join(temp, 'origin'), project = join(temp, 'project');
    mkdirSync(join(kit, 'scripts'), { recursive: true });
    writeFileSync(join(kit, 'AGENT_RULES.md'), 'x');
    writeFileSync(join(kit, 'scripts/kit-hook.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HOOK_MARKER, process.argv.slice(2).join(' '));\n");
    await git(kit, 'init', '--quiet'); await git(kit, 'add', '.'); await git(kit, 'commit', '--quiet', '-m', 'kit');
    mkdirSync(origin); await git(origin, 'init', '--quiet'); writeFileSync(join(origin, 'README.md'), 'x');
    await git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
    await git(origin, 'add', '.'); await git(origin, 'commit', '--quiet', '-m', 'consumer');
    await git(temp, 'clone', '--quiet', origin, project);
    const run = (command, extra) => spawn(shell, [...args, command], { cwd: project, env: { ...env, CLAUDE_PROJECT_DIR: project, ...extra }, input: '{}' });

    const noNode = await run(handler('SessionStart'), { PATH: mkdtempSync(join(temp, 'empty ')) });
    assert.equal(noNode.status, 0, noNode.stderr);
    assert.match(JSON.parse(noNode.stdout).systemMessage, /Node is missing/);
    assert.ok(!existsSync(env.HOOK_MARKER));

    assert.ok(!existsSync(join(project, '.vendor/workflow-kit/scripts/kit-hook.mjs')), 'the project starts without the kit');
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      rmSync(env.HOOK_MARKER, { force: true });
      const result = await run(handler(event));
      assert.equal(result.status, 0, result.stderr);
      if (event === 'SessionStart') assert.ok(existsSync(join(project, '.vendor/workflow-kit/scripts/kit-hook.mjs')), 'the entry initializes the missing kit');
      assert.equal(readFileSync(env.HOOK_MARKER, 'utf8'), `${event} --agent ${file.startsWith('.claude') ? 'claude' : 'codex'}`);
    }

    // An aborted first clone leaves a .git file that points nowhere and an empty modules folder: the entry still reaches the kit.
    const second = join(temp, 'second');
    await git(temp, 'clone', '--quiet', '--recurse-submodules', origin, second);
    rmSync(join(second, '.git/modules'), { recursive: true });
    for (const name of ['AGENT_RULES.md', 'scripts']) rmSync(join(second, '.vendor/workflow-kit', name), { recursive: true });
    mkdirSync(join(second, '.git/modules'));
    const repaired = await spawn(shell, [...args, handler('SessionStart')], { cwd: second, env: { ...env, CLAUDE_PROJECT_DIR: second }, input: '{}' });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.ok(existsSync(join(second, '.vendor/workflow-kit/scripts/kit-hook.mjs')), 'the entry repairs a dangling .git');
  });
}
});
