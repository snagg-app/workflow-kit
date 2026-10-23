import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { materialize } from '../provider-links.mjs';
import { coreSkills } from '../project-profile.mjs';
import { kitCheckout, skipWithoutSubmodules } from './fixtures.mjs';

const kit = fileURLToPath(new URL('../../', import.meta.url));
const temporary = (t, name) => {
  const path = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

test('setup-skills --help and -h only print the usage and change no file', t => {
  const cwd = temporary(t, 'setup-skills-help-');
  for (const flag of ['--help', '-h']) {
    const result = spawnSync(process.execPath, [join(kit, 'scripts/setup-skills.mjs'), flag], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: /);
    assert.deepEqual(readdirSync(cwd), []);
  }
});

test('generated skills and hook sources survive a plain clone without setup', { skip: skipWithoutSubmodules() }, t => {
  const fixture = temporary(t, 'workflow-kit setup ');
  execFileSync('git', ['init', '--quiet', fixture]);
  execFileSync('git', ['-C', fixture, 'config', 'core.filemode', 'false']);
  copyFileSync(join(kit, '.gitattributes'), join(fixture, '.gitattributes'));
  // The generators register their submodules in the kit they live in: run them in a throwaway kit (#207).
  const scripts = join(kitCheckout(t), 'scripts');
  const setup = (name, cwd, ...args) => spawnSync(process.execPath, [join(scripts, name), ...args], { cwd, encoding: 'utf8' });
  // The first run names the fixture with --cwd from another checkout, which must stay untouched; the second runs in the fixture.
  const elsewhere = temporary(t, 'workflow-kit elsewhere ');
  execFileSync('git', ['init', '--quiet', elsewhere]);
  mkdirSync(join(fixture, '.github')); // the commit step below needs every kit skill, which only "all" keeps
  writeFileSync(join(fixture, '.github/workflow-project.json'), '{"skills": "all"}');
  for (const [cwd, args] of [[elsewhere, ['--cwd', fixture]], [fixture, []]]) {
    const result = setup('setup-skills.mjs', cwd, ...args);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(readdirSync(elsewhere), ['.git'], '--cwd acts on the named checkout, not the working directory');
  // Only discovery files enter the commit; no ignored staging bundles or upstream submodules.
  execFileSync('git', ['-C', fixture, 'add', '.gitattributes', '.agents', '.claude/skills/impeccable', '.claude/agents', '.codex']); // the other Claude skills are local links, not committed
  const executablePaths = ['**/skills/impeccable/scripts/impeccable', '**/skills/git-guardrails-claude-code/scripts/block-dangerous-git.sh']
    .map(path => `:(glob)${path}`);
  // The documented commit step preserves modes even on Windows/core.filemode=false.
  execFileSync('git', ['-C', fixture, 'add', '--chmod=+x', '--', ...executablePaths]);
  execFileSync('git', ['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Generated discovery']);
  const clone = temporary(t, 'workflow-kit clone ');
  execFileSync('git', ['clone', '--quiet', '--no-local', fixture, clone]);
  const executableEntries = execFileSync('git', ['-C', clone, 'ls-files', '--stage', '--', ...executablePaths], { encoding: 'utf8' }).trim().split('\n')
    .filter(entry => !/\t\.claude\/skills\/(?!impeccable)/.test(entry)); // Git for Windows follows the links; Linux does not
  assert.equal(executableEntries.length, 2); // Claude Code's copy of the launcher equals the shared one and is not committed (#761)
  const committed = execFileSync('git', ['-C', clone, 'ls-files', '--', '.claude/skills/impeccable', '.agents/skills/impeccable/agents', '.codex/agents'], { encoding: 'utf8' }).split('\n');
  assert.ok(committed.includes('.claude/skills/impeccable/SKILL.md') && committed.includes('.claude/skills/impeccable/.gitignore'));
  assert.ok(!committed.includes('.claude/skills/impeccable/scripts/VERSION'), 'a file equal to the shared one is not committed');
  assert.ok(lstatSync(join(fixture, '.claude/skills/impeccable/scripts/VERSION')).isFile(), 'setup copies the equal files locally, without link privileges');
  assert.ok(!committed.some(file => file.startsWith('.agents/skills/impeccable/agents/') && file.endsWith('.toml')), 'Codex definitions are committed once, in .codex/agents');
  assert.ok(executableEntries.every(entry => entry.startsWith('100755 ')), 'Git clone preserves every Unix executable mode even with core.filemode=false');
  const skills = readdirSync(join(fixture, '.agents/skills')).filter(name => lstatSync(join(fixture, '.agents/skills', name)).isDirectory());
  assert.ok(skills.includes('ponytail') && skills.includes('impeccable') && skills.includes('tdd') && skills.includes('find-skills'));
  for (const skill of skills.filter(name => name !== 'impeccable'))
    assert.equal(realpathSync(join(fixture, '.claude/skills', skill)), realpathSync(join(fixture, '.agents/skills', skill)), `${skill} is linked for Claude Code`);
  for (const provider of ['.agents', '.claude'])
    for (const skill of skills.filter(name => provider === '.agents' || name === 'impeccable')) {
      const path = join(provider, 'skills', skill);
      assert.ok(lstatSync(join(clone, path)).isDirectory(), path);
      assert.deepEqual(readFileSync(join(clone, path, 'SKILL.md')), readFileSync(join(fixture, path, 'SKILL.md')), path);
      if (skill === 'find-skills')
        for (const file of ['SKILL.md', 'LICENSE', 'NOTICE.md'])
          assert.deepEqual(readFileSync(join(clone, path, file)), readFileSync(join(kit, '.agents/skills/find-skills', file)));
    }
  for (const retired of ['.agent', '.cursor', '.opencode', '.pi'])
    assert.equal(existsSync(join(fixture, retired)), false, `No output for unsupported agents: ${retired}`);
  assert.ok(lstatSync(join(clone, '.agents/hooks/ponytail-activate.js')).isFile());
  assert.ok(lstatSync(join(clone, '.codex/agents/impeccable_finish_reviewer.toml')).isFile());
  assert.equal(existsSync(join(clone, '.workflow-kit')), false);
  assert.equal(existsSync(join(clone, '.impeccable/vendor')), false);
});

test('setup never runs a Git from the checkout or the working directory', t => {
  const root = temporary(t, 'workflow-kit git ');
  mkdirSync(join(root, '.git'));
  const tools = join(root, 'tools'), git = join(tools, process.platform === 'win32' ? 'git.exe' : 'git');
  mkdirSync(tools);
  copyFileSync(process.execPath, git);
  chmodSync(git, 0o755);
  const result = spawnSync(process.execPath, [join(kit, 'scripts/provider.mjs'), 'ponytail', 'setup'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: [tools, '.'].join(delimiter) } });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(root, '.workflow-kit')), false, 'Refused before any write');
});

test('materialization applies executable mode changes even when content matches', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t, 'workflow-kit mode '), source = join(root, 'source'), output = join(root, 'output');
  for (const file of [source, output]) writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  chmodSync(source, 0o755);
  materialize(root, output, source);
  assert.equal(lstatSync(output).mode & 0o777, 0o755);
});

test('the project file chooses the kit skills; the project\'s own skills stay', { skip: skipWithoutSubmodules() }, t => {
  const fixture = temporary(t, 'workflow-kit choice '), scripts = join(kitCheckout(t), 'scripts');
  execFileSync('git', ['init', '--quiet', fixture]);
  const setup = () => spawnSync(process.execPath, [join(scripts, 'setup-skills.mjs')], { cwd: fixture, encoding: 'utf8' });
  const has = (provider, name) => existsSync(join(fixture, provider, 'skills', name));
  const first = setup();
  assert.equal(first.status, 0, first.stderr);
  for (const provider of ['.agents', '.claude']) {
    assert.deepEqual(coreSkills.filter(name => !has(provider, name)), [], 'the core is active without a choice');
    assert.ok(!has(provider, 'tdd') && !has(provider, 'impeccable'), provider);
  }
  mkdirSync(join(fixture, '.claude/skills/mine'), { recursive: true });
  mkdirSync(join(fixture, '.github'));
  const profile = join(fixture, '.github/workflow-project.json');
  writeFileSync(profile, JSON.stringify({ skills: ['tdd', 'ponytail'] }));
  const result = setup();
  assert.equal(result.status, 0, result.stderr);
  for (const provider of ['.agents', '.claude']) {
    assert.ok(has(provider, 'tdd') && has(provider, 'ponytail'), provider);
    assert.ok(!has(provider, 'grilling') && !has(provider, 'find-skills') && !has(provider, 'impeccable'), provider);
  }
  assert.ok(has('.claude', 'mine'), 'a skill of the project is not touched');
  writeFileSync(profile, JSON.stringify({ skills: ['core', 'tdd'] }));
  assert.equal(setup().status, 0);
  assert.ok(has('.agents', 'tdd') && has('.agents', 'grilling') && !has('.agents', 'impeccable'));
  writeFileSync(profile, JSON.stringify({ skills: 'all' }));
  assert.equal(setup().status, 0);
  assert.ok(has('.agents', 'impeccable') && has('.claude', 'tdd'));
  writeFileSync(profile, JSON.stringify({ skills: ['tdd', 'typo'] }));
  assert.notEqual(setup().status, 0);
});
