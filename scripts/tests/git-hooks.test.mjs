// Zweck: install-git-hooks an echten Git-Repos mit Worktree pruefen, ohne Netzwerk.
// Nutzen: Ein ausgecheckter Branch führt keinen eigenen Hook-Code aus (Kopie im Git-Verzeichnis); fremde Hooks gehen nie verloren.
// Jeder Fall hat sein eigenes temporaeres Repository und laeuft neben den anderen (siehe fixtures.mjs).
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rename } from '../provider-links.mjs';
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

/** A consumer with the kit as submodule: main pins kit commit one, `other` pins commit two; the kit's own main is a third, newer commit. The installer ran in it. */
async function kitFixture(t) {
  const base = temporary(t, 'kit post checkout ');
  const global = join(base, 'global.gitconfig');
  // The submodule is a local path; Git blocks that transport for submodules unless allowed.
  writeFileSync(global, '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@t\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  const sh = async (cwd, ...args) => {
    const result = await exec('git', args, { cwd, env });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const kit = join(base, 'kit'), repo = join(base, 'repo');
  for (const dir of [kit, repo]) { mkdirSync(dir); await sh(dir, 'init', '-q', '-b', 'main'); }
  const pin = async n => { writeFileSync(join(kit, 'AGENT_RULES.md'), `rules ${n}\n`); if (n === 2) writeFileSync(join(kit, 'new.txt'), 'tracked\n'); await sh(kit, 'add', '.'); await sh(kit, 'commit', '-q', '-am', `kit ${n}`); return (await sh(kit, 'rev-parse', 'HEAD')).stdout.trim(); };
  writeFileSync(join(kit, 'AGENT_RULES.md'), 'rules 0\n');
  await sh(kit, 'add', '.');
  const one = await pin(1), two = await pin(2);
  await pin(3);
  mkdirSync(join(repo, '.githooks'));
  writeFileSync(join(repo, '.githooks/pre-push'), '#!/bin/sh\n');
  const installed = await exec(process.execPath, [script], { cwd: repo, env });
  assert.equal(installed.status, 0, installed.stderr);
  await sh(repo, 'submodule', '-q', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
  await sh(repo, '-C', '.vendor/workflow-kit', 'checkout', '-q', one);
  await sh(repo, 'add', '.');
  await sh(repo, 'commit', '-q', '-m', 'pin one');
  await sh(repo, 'switch', '-q', '-c', 'other');
  await sh(repo, '-C', '.vendor/workflow-kit', 'checkout', '-q', two);
  await sh(repo, 'commit', '-q', '-am', 'pin two');
  await sh(repo, 'switch', '-q', 'main');
  await sh(repo, 'submodule', '-q', 'update', '--init');
  const rules = join(repo, '.vendor/workflow-kit/AGENT_RULES.md');
  return { repo, sh, rules, status: async () => (await sh(repo, 'status', '--porcelain')).stdout, switchTo: (branch, extra) => exec('git', ['switch', '-q', branch], { cwd: repo, env: { ...env, ...extra } }) };
}

test('switching branches with another kit gitlink leaves no modified submodule', async t => {
  const f = await kitFixture(t);
  assert.equal(await f.status(), '');
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 1\n');
  assert.equal((await f.switchTo('other')).status, 0);
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 2\n');
  assert.equal(await f.status(), '');
  assert.equal((await f.switchTo('main')).status, 0);
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 1\n');
  assert.equal(await f.status(), '');
  // A new worktree starts with an empty kit directory; the same hook fills it.
  const linked = join(f.repo, '../linked');
  await f.sh(f.repo, 'worktree', 'add', '-q', '--detach', linked, 'other');
  assert.equal(readFileSync(join(linked, '.vendor/workflow-kit/AGENT_RULES.md'), 'utf8'), 'rules 2\n');
});

test('a kit with local changes keeps them, prints a hint and does not fail the switch', async t => {
  const f = await kitFixture(t);
  writeFileSync(f.rules, 'my edit\n');
  const result = await f.switchTo('other');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr.trim(), '', 'a diagnostic is printed');
  assert.equal(readFileSync(f.rules, 'utf8'), 'my edit\n');
});

test('a failing kit update prints the command and does not fail the switch', async t => {
  const f = await kitFixture(t);
  // The kit is not cloned (empty directory) and its source is gone, so the update cannot succeed.
  rename(join(f.repo, '../kit'), join(f.repo, '../kit-gone'));
  rmSync(join(f.repo, '.vendor/workflow-kit'), { recursive: true, force: true });
  rmSync(join(f.repo, '.git/modules'), { recursive: true, force: true });
  mkdirSync(join(f.repo, '.vendor/workflow-kit'));
  const result = await f.switchTo('other');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr.trim(), '', 'a diagnostic is printed');
});

test('a .git file that points nowhere is cleared when it is the only thing in the kit folder, otherwise reported', async t => {
  const f = await kitFixture(t);
  const inner = join(f.repo, '.vendor/workflow-kit');
  rmSync(join(f.repo, '.git/modules'), { recursive: true });
  let result = await f.switchTo('other');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr.trim(), '', 'a dangling .git with other files is reported');
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 1\n');
  for (const name of readdirSync(inner)) if (name !== '.git') rmSync(join(inner, name), { recursive: true });
  mkdirSync(join(f.repo, '.git/modules'));
  result = await f.switchTo('main');
  assert.equal(result.status, 0, result.stderr);
  result = await f.switchTo('other');
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 2\n');
});

test('local commits and ignored files are kept; a clean published kit still follows', async t => {
  const kit = f => join(f.repo, '.vendor/workflow-kit');
  await Promise.all([
    async () => {
      // An unpublished commit would be left behind by the checkout.
      const a = await kitFixture(t);
      await a.sh(kit(a), 'commit', '-q', '--allow-empty', '-m', 'local');
      const local = (await a.sh(kit(a), 'rev-parse', 'HEAD')).stdout;
      const result = await a.switchTo('other');
      assert.equal(result.status, 0, result.stderr);
      assert.notEqual(result.stderr.trim(), '', 'a diagnostic is printed');
      assert.equal((await a.sh(kit(a), 'rev-parse', 'HEAD')).stdout, local);
    },
    async () => {
      // An ignored file that the target revision tracks would be overwritten without a word.
      const b = await kitFixture(t);
      writeFileSync(join(kit(b), 'new.txt'), 'mine\n');
      appendFileSync(resolve(kit(b), (await b.sh(kit(b), 'rev-parse', '--git-path', 'info/exclude')).stdout.trim()), 'new.txt\n');
      assert.equal(await b.status(), '');
      assert.equal((await b.switchTo('other')).status, 0);
      assert.equal(readFileSync(join(kit(b), 'new.txt'), 'utf8'), 'mine\n');
    },
    async () => {
      // A clean kit that is not the old pin but is published (stale) still follows the new gitlink.
      const c = await kitFixture(t);
      await c.sh(kit(c), 'checkout', '-q', 'origin/main');
      assert.equal((await c.switchTo('other')).status, 0);
      assert.equal(readFileSync(c.rules, 'utf8'), 'rules 2\n');
    },
  ].map(scenario => scenario()));
});

test('the kit update runs no hooks of the kit clone', async t => {
  const f = await kitFixture(t), kitDir = join(f.repo, '.vendor/workflow-kit');
  const hooks = resolve(kitDir, (await f.sh(kitDir, 'rev-parse', '--git-path', 'hooks')).stdout.trim()), marker = join(f.repo, '../hook-ran');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 });
  assert.equal((await f.switchTo('other')).status, 0);
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 2\n', 'the kit was updated');
  assert.equal(existsSync(marker), false);
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

test('a rerun replaces the hook copy; the project post-checkout wins over the kit one', async t => {
  const f = await fixture(t), copy = name => join(f.hooks, name);
  await f.run();
  assert.deepEqual(readdirSync(f.hooks).sort(), ['post-checkout', 'pre-push']);
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
