// Zweck: install-git-hooks an echten Git-Repos mit Worktree pruefen, ohne Netzwerk.
// Nutzen: Ein ausgecheckter Branch führt keinen eigenen Hook-Code aus (Kopie im Git-Verzeichnis); fremde Hooks gehen nie verloren.
// Jeder Fall hat sein eigenes temporaeres Repository und laeuft neben den anderen (siehe fixtures.mjs).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run as exec, temporary } from './fixtures.mjs';

const script = fileURLToPath(new URL('../install-git-hooks.mjs', import.meta.url));

/** A repository with .githooks and one linked worktree; global and system config are isolated. */
async function fixture(t, { hooks = true, extraEnv = {} } = {}) {
  const base = temporary(t, 'kit git hooks ');
  const repo = join(base, 'repo'), linked = join(base, 'linked'), global = join(base, 'global.gitconfig');
  writeFileSync(global, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  const git = async (...args) => {
    const result = await exec('git', args, { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  await git('init', '-q');
  if (hooks) {
    mkdirSync(join(repo, '.githooks'));
    writeFileSync(join(repo, '.githooks/pre-push'), '#!/bin/sh\n');
  }
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await git('config', 'extensions.worktreeConfig', 'true');
  await git('worktree', 'add', '-q', '--detach', linked);
  const linkedConfig = join(repo, '.git/worktrees/linked/config.worktree');
  const run = async (...args) => {
    const result = await exec(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extraEnv } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const value = async (...source) => (await exec('git', ['config', ...source, '--get', 'core.hooksPath'], { cwd: repo, env })).stdout.trim();
  const effective = async cwd => (await exec('git', ['config', '--get', 'core.hooksPath'], { cwd, env })).stdout.trim();
  const hooksDir = join(realpathSync.native(repo), '.git', 'workflow-kit-hooks').replaceAll('\\', '/');
  return { repo, linked, global, linkedConfig, hooks: hooksDir, git, run, value, effective };
}

describe('install-git-hooks', { concurrency: true }, () => {
test('--check reports a copy only when the installed hooks differ from .githooks (#730)', async t => {
  const f = await fixture(t);
  assert.match(await f.run('--check'), /would copy/, 'nothing installed yet');
  await f.run();
  assert.doesNotMatch(await f.run('--check'), /would copy/, 'a current copy has nothing open');
  if (process.platform !== 'win32') {
    chmodSync(join(f.hooks, 'pre-push'), 0o644);
    assert.match(await f.run('--check'), /would copy/, 'a hook without the execute bit is open');
    chmodSync(join(f.hooks, 'pre-push'), 0o755);
  }
  writeFileSync(join(f.repo, '.githooks/pre-push'), '#!/bin/sh\necho changed\n');
  assert.match(await f.run('--check'), /would copy/, 'a changed hook is open again');
});

test('unset or own absolute paths become the hook copy in the Git directory; --check and reruns change nothing', async t => {
  const f = await fixture(t);
  await f.run('--check');
  assert.equal(await f.value('--local'), '');
  await f.run();
  assert.equal(await f.value('--local'), f.hooks);
  await f.run();
  assert.equal(await f.value('--local'), f.hooks);

  // Absolute paths into this repo's worktrees, as earlier manual setups wrote them.
  await f.git('config', '--local', 'core.hooksPath', join(f.linked, '.githooks'));
  writeFileSync(f.linkedConfig, `[core]\n\thooksPath = ${join(f.repo, '.githooks').replaceAll('\\', '/')}\n`);
  await f.run('--check');
  assert.equal(await f.value('--local'), join(f.linked, '.githooks'));
  assert.notEqual(await f.value('--file', f.linkedConfig), '');
  await f.run();
  assert.equal(await f.value('--local'), f.hooks);
  assert.equal(await f.value('--file', f.linkedConfig), '');
  assert.equal(await f.effective(f.linked), f.hooks);
});

test('foreign hook paths stay, local or global; without .githooks nothing changes', async t => {
  // Every case has its own repository, so they run side by side.
  await Promise.all([
    async () => {
      const f = await fixture(t);
      await f.git('config', '--local', 'core.hooksPath', '.husky');
      writeFileSync(f.linkedConfig, `[core]\n\thooksPath = ${join(f.repo, '.githooks').replaceAll('\\', '/')}\n`);
      await f.run();
      assert.equal(await f.value('--local'), '.husky');
      assert.notEqual(await f.value('--file', f.linkedConfig), '');
    },
    async () => {
      // Global hooks, here only reachable through an include, are not shadowed by a local entry.
      const g = await fixture(t), included = join(g.global, '../included.gitconfig');
      writeFileSync(included, '[core]\n\thooksPath = /shared/hooks\n');
      writeFileSync(g.global, `[include]\n\tpath = ${included.replaceAll('\\', '/')}\n`);
      await g.run();
      assert.equal(await g.value('--local'), '');
    },
    async () => {
      // An own path that a worktree only includes stays in the included file; the run still completes.
      const i = await fixture(t), own = join(i.global, '../own.gitconfig');
      writeFileSync(own, `[core]\n\thooksPath = ${join(i.repo, '.githooks').replaceAll('\\', '/')}\n`);
      writeFileSync(i.linkedConfig, `[include]\n\tpath = ${own.replaceAll('\\', '/')}\n`);
      await i.run();
      assert.equal(await i.value('--local'), i.hooks);
      assert.equal(await i.value('--includes', '--file', i.linkedConfig), join(i.repo, '.githooks').replaceAll('\\', '/'));
    },
    async () => {
      // A foreign entry repeated before an own one in the same file is not lost.
      const m = await fixture(t), mixed = `[core]\n\thooksPath = .husky\n\thooksPath = ${join(m.repo, '.githooks').replaceAll('\\', '/')}\n`;
      writeFileSync(m.linkedConfig, mixed);
      await m.run();
      assert.equal(readFileSync(m.linkedConfig, 'utf8'), mixed);
    },
    async () => {
      // includeIf applies only on another branch: invisible from here, still kept.
      const c = await fixture(t), branch = join(c.global, '../release.gitconfig');
      writeFileSync(branch, '[core]\n\thooksPath = /release/hooks\n');
      writeFileSync(c.global, `[includeIf "onbranch:release"]\n\tpath = ${branch.replaceAll('\\', '/')}\n`);
      await c.run();
      assert.equal(await c.value('--local'), '');
    },
    async () => {
      // The same file reached first by a worktree's plain include still counts behind the includeIf.
      const d = await fixture(t), shared = join(d.global, '../shared.gitconfig').replaceAll('\\', '/');
      writeFileSync(shared, '[core]\n\thooksPath = /release/hooks\n');
      writeFileSync(d.linkedConfig, `[include]\n\tpath = ${shared}\n`);
      writeFileSync(d.global, `[includeIf "onbranch:release"]\n\tpath = ${shared}\n`);
      await d.run();
      assert.equal(await d.value('--local'), '');
    },
    async () => {
      // An include target this script cannot resolve like Git (~user/) blocks changes.
      const u = await fixture(t);
      writeFileSync(u.global, '[includeIf "onbranch:release"]\n\tpath = ~someone/hooks.gitconfig\n');
      await u.run();
      assert.equal(await u.value('--local'), '');
    },
    async () => {
      // A relative path other than .githooks resolves per worktree and may point elsewhere: kept.
      const r = await fixture(t);
      writeFileSync(r.linkedConfig, '[core]\n\thooksPath = ../repo/.githooks\n');
      await r.run();
      assert.equal(await r.value('--file', r.linkedConfig), '../repo/.githooks');
    },
    async () => {
      // An inherited GIT_DIR of another repository neither redirects the write nor touches that repository.
      const other = await fixture(t), e = await fixture(t, { extraEnv: { GIT_DIR: join(other.repo, '.git') } });
      await e.run();
      assert.equal(await e.value('--local'), e.hooks);
      assert.equal(await other.value('--local'), '');
    },
    async () => {
      const none = await fixture(t, { hooks: false });
      await none.run();
      assert.equal(await none.value('--local'), '');
      writeFileSync(join(none.repo, '.githooks'), '');
      await none.run();
      assert.equal(await none.value('--local'), '');
    },
  ].map(scenario => scenario()));
});

test('an own worktree path with a newline is still migrated', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), odd = join(f.linked, '../line\nbreak');
  await f.git('worktree', 'add', '-q', '--detach', odd);
  await f.git('config', '--local', 'core.hooksPath', join(odd, '.githooks'));
  await f.run();
  assert.equal(await f.value('--local'), f.hooks);
});

test('a branch that changes the tracked hooks does not run them on checkout or push', async t => {
  const f = await fixture(t), tracked = join(f.repo, '.githooks'), commit = message => f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', message);
  const markers = { checkout: join(f.repo, '../ran-checkout'), push: join(f.repo, '../ran-push') };
  const touch = name => `#!/bin/sh\ntouch "${markers[name].replaceAll('\\', '/')}"\n`;
  await f.git('add', '.githooks');
  await commit('hooks');
  const base = await f.git('rev-parse', 'HEAD');
  await f.git('init', '-q', '--bare', '../remote.git');
  await f.git('remote', 'add', 'origin', '../remote.git');
  await f.git('switch', '-q', '-c', 'evil');
  writeFileSync(join(tracked, 'post-checkout'), touch('checkout'), { mode: 0o755 });
  writeFileSync(join(tracked, 'pre-push'), touch('push'));
  chmodSync(join(tracked, 'pre-push'), 0o755); // the mode of an existing file stays
  await f.git('add', '--chmod=+x', '.githooks');
  await commit('evil hooks');
  const visit = async () => {
    for (const marker of Object.values(markers)) rmSync(marker, { force: true });
    await f.git('switch', '-q', '--detach', base);
    await f.git('switch', '-q', 'evil');
    await f.git('push', '-q', 'origin', 'evil', '--force');
  };
  // Precondition: with a relative setting the branch's own hooks run.
  await f.git('config', '--local', 'core.hooksPath', '.githooks');
  await visit();
  assert.deepEqual(Object.values(markers).map(existsSync), [true, true]);

  await f.git('switch', '-q', '--detach', base);
  await f.git('config', '--local', '--unset', 'core.hooksPath');
  await f.run();
  await visit();
  assert.deepEqual(Object.values(markers).map(existsSync), [false, false]);
  assert.equal(await f.value('--local'), f.hooks);
});

test('a rerun replaces the hook copy, including a post-checkout of the project', async t => {
  const f = await fixture(t), copy = name => join(f.hooks, name);
  await f.run();
  assert.deepEqual(readdirSync(f.hooks), ['pre-push']);
  writeFileSync(join(f.repo, '.githooks/pre-push'), '#!/bin/sh\necho changed\n');
  assert.equal(readFileSync(copy('pre-push'), 'utf8'), '#!/bin/sh\n');
  await f.run();
  assert.equal(readFileSync(copy('pre-push'), 'utf8'), '#!/bin/sh\necho changed\n');
  rmSync(join(f.repo, '.githooks/pre-push'));
  writeFileSync(join(f.repo, '.githooks/post-checkout'), '#!/bin/sh\necho mine\n');
  await f.run();
  assert.deepEqual(readdirSync(f.hooks), ['post-checkout']);
  assert.equal(readFileSync(copy('post-checkout'), 'utf8'), '#!/bin/sh\necho mine\n');
});
});
