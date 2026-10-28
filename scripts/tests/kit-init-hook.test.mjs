import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { entryFile } from '../agents.mjs';
import { hookSettings } from '../hooks.mjs';
import { rename } from '../write-guard.mjs';
import { isolatedGit, run as spawn, temporary } from './fixtures.mjs';

const hook = fileURLToPath(new URL('../kit-hook.mjs', import.meta.url));

/** The process entry of the hooks: hook JSON in, output out. SubagentStart does the kit check and installs nothing;
 * a personal home without snapshots keeps Ponytail and Impeccable silent. */
const call = (event, cwd, env, input = {}) => spawn(process.execPath, [hook, event, '--agent', 'claude'],
  { cwd, env: { ...env, USERPROFILE: env.HOME }, input: JSON.stringify({ hook_event_name: event, ...input }) });
const home = temp => { const dir = join(temp, 'home'); mkdirSync(dir, { recursive: true }); return dir; };

// Every test runs in its own temporary directory with its own repositories, so they run side by side.
describe('kit hook', { concurrency: true }, () => {
/** A project whose hooks name the kit, a shared kit checkout (a clone of `upstream` on main) and the env that points the hook at it. */
async function shared(t, label, { link = false, kitDir = true } = {}) {
  const temp = temporary(t, label);
  const env = { ...isolatedGit(temp), HOME: home(temp), CLAUDE_PROJECT_DIR: '', WORKFLOW_KIT_DIR: join(temp, 'kit'), KIT_HOOK_FRESH_SECONDS: '0' };
  const git = async (cwd, ...a) => {
    const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const [upstream, kit, project] = ['upstream', 'kit', 'project'].map(name => join(temp, name));
  mkdirSync(upstream); await git(upstream, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(upstream, 'AGENT_RULES.md'), 'x');
  await git(upstream, 'add', '.'); await git(upstream, 'commit', '--quiet', '-m', 'kit');
  if (kitDir) await git(temp, 'clone', '--quiet', upstream, kit);
  mkdirSync(join(project, '.claude'), { recursive: true }); await git(project, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ id: 'workflow-kit' }] }] } }));
  writeFileSync(join(project, '.gitignore'), '/.vendor/workflow-kit\n');
  await git(project, 'add', '.'); await git(project, 'commit', '--quiet', '-m', 'project');
  // `resume` starts no installer; the personal home has no snapshots, so the output also carries the Ponytail hint.
  const trial = (extra = {}, source = 'resume', cwd = project) => call('SessionStart', cwd, { ...env, CLAUDE_PROJECT_DIR: cwd, ...extra }, { source });
  const newer = async () => { await git(upstream, 'commit', '--quiet', '--allow-empty', '-m', `newer ${Math.random()}`); return git(upstream, 'rev-parse', 'HEAD'); };
  const head = () => git(kit, 'rev-parse', 'HEAD');
  const linked = () => existsSync(join(project, '.vendor/workflow-kit')) && realpathSync.native(join(project, '.vendor/workflow-kit')) === realpathSync.native(kit);
  return { temp, env, git, upstream, kit, project, trial, newer, head, linked };
}
const notice = /Workflow Kit/;

test('a fresh project gets the link to the shared kit and a clean git status; the kit follows main', async t => {
  const f = await shared(t, 'kit-shared ');
  assert.ok(!f.linked());
  let result = await f.trial();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, notice);
  assert.ok(f.linked(), 'the hook links .vendor/workflow-kit to the shared checkout');
  assert.equal(await f.git(f.project, 'status', '--porcelain'), '', 'the link is ignored');

  const tip = await f.newer();
  result = await f.trial();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.head(), tip, 'the next session start has the new kit commit, without a merge in the project');
});

test('the hook never runs a git from the project folder (#758)', async t => {
  const f = await shared(t, 'kit-planted-git ');
  const planted = join(f.project, process.platform === 'win32' ? 'git.exe' : 'git'), marker = join(f.temp, 'planted-git-ran');
  copyFileSync(process.execPath, planted);
  chmodSync(planted, 0o755);
  // The planted "git" is a copy of node; this preload (loaded by every node child) records that the copy, and only the copy, started.
  const probe = join(f.temp, 'probe.cjs');
  writeFileSync(probe, `if (/^git(\\.exe)?$/i.test(require('node:path').basename(process.execPath))) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const key = Object.keys(f.env).find(name => name.toLowerCase() === 'path');
  const result = await f.trial({ [key]: [f.project, '.', f.env[key]].join(delimiter), NODE_OPTIONS: `--require "${probe.replaceAll('\\', '/')}"` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false, 'the git of the project folder was started');
  assert.ok(f.linked(), 'the real git still did the check');
});

test('a valid stamp skips the check and the pull; a changed project commit runs the full check again', async t => {
  const f = await shared(t, 'kit-stamp ');
  const young = { KIT_HOOK_FRESH_SECONDS: '600' };
  assert.equal((await f.trial(young)).status, 0);
  assert.ok(existsSync(join(f.project, '.git/kit-ok')), 'a clean check leaves the stamp in the git dir');

  const before = await f.head(), tip = await f.newer();
  assert.equal((await f.trial(young)).status, 0);
  assert.equal(await f.head(), before, 'the stamp matches: no pull');

  await f.git(f.project, 'commit', '--quiet', '--allow-empty', '-m', 'moved');
  assert.equal((await f.trial(young)).status, 0);
  assert.equal(await f.head(), tip, 'the project moved: full check, the kit is pulled');
});

test('the shared kit is found next to the main checkout, also from a worktree', async t => {
  const f = await shared(t, 'kit-worktree ');
  const { WORKFLOW_KIT_DIR, ...env } = f.env;
  const wanted = join(f.temp, 'workflow-kit');
  await f.git(f.temp, 'clone', '--quiet', f.upstream, wanted);
  const worktree = join(f.temp, 'wt');
  await f.git(f.project, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
  const result = await call('SessionStart', worktree, { ...env, CLAUDE_PROJECT_DIR: worktree }, { source: 'resume' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync.native(join(worktree, '.vendor/workflow-kit')), realpathSync.native(wanted));
});

// #863: Claude's SubagentStart carries the cwd of the parent, so the subagent's own fresh worktree is found through the worktree list.
test('a subagent start links the fresh worktrees of the project, and changes nothing else in them', async t => {
  const f = await shared(t, 'kit-subagent-worktree ');
  const worktree = join(f.temp, 'agent-1');
  await f.git(f.project, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
  const result = await call('SubagentStart', f.project, { ...f.env, CLAUDE_PROJECT_DIR: f.project }, { cwd: f.project });
  assert.equal(result.status, 0, result.stderr);
  for (const dir of [f.project, worktree]) assert.equal(realpathSync.native(join(dir, '.vendor/workflow-kit')), realpathSync.native(f.kit), dir);
  assert.equal(await f.git(worktree, 'status', '--porcelain'), '', 'the link is ignored');
});

test('work in the shared kit is never touched, only reported', async t => {
  const f = await shared(t, 'kit-guard ');
  await f.trial();
  const stays = async (why, pattern) => {
    const before = await f.head(), tip = await f.newer();
    const result = await f.trial();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, pattern, why);
    assert.doesNotThrow(() => JSON.parse(result.stdout), 'host JSON');
    assert.equal(await f.head(), before, why);
    return tip;
  };
  writeFileSync(join(f.kit, 'notes.txt'), 'mine');
  await stays('local changes', /local changes/);
  rmSync(join(f.kit, 'notes.txt'));
  await f.git(f.kit, 'commit', '--quiet', '--allow-empty', '-m', 'mine');
  await stays('an unpublished commit', /unpublished/);
  await f.git(f.kit, 'reset', '--quiet', '--hard', 'origin/main');
  await f.git(f.kit, 'switch', '--quiet', '-c', 'work');
  await stays('another branch', /branch work/);
  await f.git(f.kit, 'switch', '--quiet', '--detach');
  await stays('a fixed revision', /fixed revision/);
  await f.git(f.kit, 'switch', '--quiet', 'main');
  await f.trial();
  assert.equal(await f.head(), await f.git(f.upstream, 'rev-parse', 'HEAD'), 'back on a clean main the kit follows again');
});

test('a running update is skipped, a compaction does not update, an unreachable source is reported', async t => {
  const f = await shared(t, 'kit-lock ');
  await f.trial();
  const lock = join(f.kit, '.git/kit-update.lock'), before = await f.head();
  await f.newer();
  mkdirSync(lock);
  assert.equal((await f.trial()).status, 0);
  assert.equal(await f.head(), before, 'another session holds the lock: no pull, no waiting');
  rmSync(lock, { recursive: true });
  assert.equal((await f.trial({}, 'compact')).status, 0);
  assert.equal(await f.head(), before, 'a compaction is no session start');
  rename(f.upstream, `${f.upstream}-gone`);
  const result = await f.trial();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /could not be updated/);
  assert.ok(!existsSync(lock), 'the lock is released');
});

test('a wrong link is replaced, a leftover submodule folder only reported, a project without kit hooks left alone', async t => {
  const f = await shared(t, 'kit-link ');
  const link = join(f.project, '.vendor/workflow-kit'), other = join(f.temp, 'other');
  mkdirSync(other); mkdirSync(join(f.project, '.vendor'));
  symlinkSync(other, link, 'junction');
  assert.equal((await f.trial()).status, 0);
  assert.ok(f.linked(), 'a link to another folder points at the shared kit afterwards');
  assert.ok(existsSync(other), 'the old target is not touched');

  rmSync(link); mkdirSync(link); writeFileSync(join(link, 'mine.txt'), 'x');
  const result = await f.trial();
  assert.match(result.stdout, /a folder or submodule, not a link/);
  assert.ok(existsSync(join(link, 'mine.txt')), 'a real folder stays');

  const plain = join(f.temp, 'plain');
  mkdirSync(plain); await f.git(plain, 'init', '--quiet');
  assert.equal((await f.trial({}, 'resume', plain)).status, 0);
  assert.ok(!existsSync(join(plain, '.vendor')), 'no kit hooks, no link');
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
  assert.match(await reported(await project(manifest, 'pnpm run setup:all'), 'the setup field is honored'), /run `pnpm run setup:all`/);
  assert.match(await reported(await project(manifest), 'without a setup field the message still names a command'), /run `npm ci`/);

  const installed = await project(manifest);
  mkdirSync(join(installed, 'node_modules'));
  await silent(installed, 'a worktree with node_modules is left alone');
  await silent(await project(JSON.stringify({ name: 'x', dependencies: {} })), 'a manifest without dependencies is left alone');
  await silent(await project(JSON.stringify({ peerDependencies: { a: '1' } })), 'only the dependencies npm installs by default count');
  await silent(await project('{ not json'), 'a broken package.json is not reported');
  await silent(await project(), 'a project without package.json is left alone');
  await silent(temp, 'a directory outside any repository is left alone');
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
  const warns = async (id, hint = 'Hooks changed since session start: restart the session') => (await session('SubagentStart', id)).stdout.includes(hint);

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
  // The hint follows the profile language (#759).
  mkdirSync(join(project, '.github'), { recursive: true });
  writeFileSync(join(project, '.github/workflow-project.json'), '{"language": "de"}');
  assert.equal(await warns('old', 'Hooks seit Session-Start geändert: Session neu starten'), true);
});

// The one-line entries of the agent settings: they only find Node and the kit (cloning the shared checkout if it is missing), then hand over to kit-hook.mjs.
const sh = process.platform === 'win32' ? spawnSync('where', ['sh']).stdout?.toString().split(/\r?\n/)[0] : '/bin/sh';
// Absolute: the Node-missing trial runs the shell with an empty PATH.
const powershell = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : spawnSync('which', ['pwsh']).stdout?.toString().trim();
const entries = [
  ['claude', 'command', sh, ['-c']],
  ['codex', 'command', sh, ['-c']],
  ['codex', 'commandWindows', powershell, ['-NoProfile', '-NonInteractive', '-Command']],
];
for (const [agent, key, shell, args] of entries) {
  const available = Boolean(shell) && spawnSync(shell, args.at(-1) === '-c' ? ['-c', 'exit 0'] : ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`${agent} ${key}: Node missing is a clear message, a missing kit is cloned, then kit-hook.mjs gets event and agent`, { skip: !available && `${shell} unavailable` }, async t => {
    const temp = temporary(t, 'kit-entry ');
    const handler = event => hookSettings(agent).hooks[event].flatMap(group => group.hooks)[0][key];
    const origin = join(temp, 'origin'), project = join(temp, 'project');
    // The kit's address is rewritten to a local repository, so the trial needs no network.
    const rewrite = to => ({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: `url.${to.replaceAll('\\', '/')}.insteadOf`, GIT_CONFIG_VALUE_1: 'https://github.com/snagg-app/workflow-kit.git' });
    const env = { ...isolatedGit(temp), HOME: home(temp), FNM_DIR: '', HOOK_MARKER: join(temp, 'marker'), ...rewrite(origin) };
    delete env.WORKFLOW_KIT_DIR;
    const git = async (cwd, ...a) => {
      const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
      assert.equal(result.status, 0, result.stderr);
    };
    // A kit whose hook module only records how it was called.
    mkdirSync(join(origin, 'scripts'), { recursive: true });
    writeFileSync(join(origin, 'AGENT_RULES.md'), 'x');
    writeFileSync(join(origin, 'scripts/kit-hook.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HOOK_MARKER, process.argv.slice(2).join(' '));\n");
    await git(origin, 'init', '--quiet'); await git(origin, 'add', '.'); await git(origin, 'commit', '--quiet', '-m', 'kit');
    mkdirSync(join(project, '.agents'), { recursive: true }); await git(project, 'init', '--quiet');
    copyFileSync(new URL('../kit-entry.mjs', import.meta.url), join(project, entryFile)); // what `kit setup` puts there
    const run = (command, extra) => spawn(shell, [...args, command], { cwd: project, env: { ...env, CLAUDE_PROJECT_DIR: project, ...extra }, input: '{}' });

    const noNode = await run(handler('SessionStart'), { PATH: mkdtempSync(join(temp, 'empty ')) });
    assert.equal(noNode.status, 0, noNode.stderr);
    assert.match(JSON.parse(noNode.stdout).systemMessage, /Node is missing/);
    assert.ok(!existsSync(env.HOOK_MARKER));

    // Without the shared checkout nothing can run; the clone is the only job of the entry, and it lands next to the project.
    const kit = join(temp, 'workflow-kit');
    const broken = await run(handler('SessionStart'), rewrite(join(temp, 'nowhere')));
    assert.equal(broken.status, 0, broken.stderr);
    assert.match(JSON.parse(broken.stdout).systemMessage, /could not be cloned/);
    assert.ok(!existsSync(env.HOOK_MARKER) && !existsSync(kit));
    for (const event of ['SessionStart', 'SubagentStart']) {
      rmSync(env.HOOK_MARKER, { force: true });
      const result = await run(handler(event));
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(kit, 'scripts/kit-hook.mjs')), 'the entry clones the missing shared kit');
      assert.equal(readFileSync(env.HOOK_MARKER, 'utf8'), `${event} --agent ${agent}`);
    }

    // Empty and relative project paths still resolve to this checkout when Git runs from its safe temp cwd.
    for (const projectPath of ['', '.']) {
      rmSync(env.HOOK_MARKER, { force: true });
      const result = await run(handler('SessionStart'), { CLAUDE_PROJECT_DIR: projectPath, WORKFLOW_KIT_DIR: undefined });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(env.HOOK_MARKER, 'utf8'), 'SessionStart --agent ' + agent);
    }

    // WORKFLOW_KIT_DIR names another place.
    const chosen = join(temp, 'chosen');
    await run(handler('UserPromptSubmit'), { WORKFLOW_KIT_DIR: chosen });
    assert.ok(!existsSync(chosen), 'only SessionStart and SubagentStart clone');
    await run(handler('SessionStart'), { WORKFLOW_KIT_DIR: chosen });
    assert.ok(existsSync(join(chosen, 'scripts/kit-hook.mjs')));
  });
}

// #1064: Claude starts bash hooks without the PATH of the user's shell, where fnm puts Node; the hook then did nothing (no kit link in a fresh worktree).
test('claude command: Node outside PATH comes from fnm (default alias, else the newest version by number), else the hint stays', { skip: !sh && 'sh unavailable' }, async t => {
  const temp = temporary(t, 'kit-node '), project = join(temp, 'project'), fnm = join(temp, 'fnm'), empty = mkdtempSync(join(temp, 'empty '));
  mkdirSync(join(project, '.agents'), { recursive: true });
  mkdirSync(fnm);
  writeFileSync(join(project, entryFile), '');
  const command = hookSettings('claude').hooks.SubagentStart[0].hooks[0].command;
  const run = async () => JSON.parse((await spawn(sh, ['-c', command], { cwd: project, env: { ...isolatedGit(temp), HOME: home(temp), FNM_DIR: fnm, PATH: [empty, dirname(sh)].join(delimiter), CLAUDE_PROJECT_DIR: project }, input: '{}' })).stdout).systemMessage;
  const fake = (installation, name) => {
    const bin = join(fnm, installation, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' '{"systemMessage":"${name}"}'\n`);
    chmodSync(join(bin, 'node'), 0o755);
  };
  assert.match(await run(), /Node is missing/);
  fake('node-versions/v9.11.2/installation', 'v9'); fake('node-versions/v24.10.0/installation', 'v24');
  assert.equal(await run(), 'v24');
  fake('aliases/default/installation', 'alias');
  assert.equal(await run(), 'alias');
});
});
