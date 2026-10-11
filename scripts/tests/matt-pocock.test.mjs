import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { skipWithoutSubmodules } from './fixtures.mjs';

const skip = skipWithoutSubmodules();
const kit = fileURLToPath(new URL('../../', import.meta.url));
const upstream = join(kit, '.vendor/matt-pocock-skills');
const providers = ['.agent', '.agents', '.claude', '.github', '.opencode', '.pi'];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const files = path => readdirSync(path, { recursive: true }).filter(file => lstatSync(join(path, file)).isFile())
  .map(file => file.split(sep).join('/')).sort();
const succeeds = result => assert.equal(result.status, 0, result.stderr);

test('all pinned Matt Pocock skills survive a fresh checkout, rerun and local source changes safely', { skip }, t => {
  const base = mkdtempSync(join(tmpdir(), 'matt pocock '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const consumer = join(base, 'consumer'), fixture = join(base, 'kit'), source = join(fixture, '.vendor/matt-pocock-skills');
  for (const path of [consumer, fixture]) { mkdirSync(path); git(path, 'init', '--quiet'); }
  copyFileSync(join(kit, '.gitattributes'), join(consumer, '.gitattributes'));
  const revision = git(kit, 'rev-parse', ':.vendor/matt-pocock-skills').trim();
  git(fixture, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', upstream, source);
  git(source, 'checkout', '--quiet', '--detach', revision);
  write(join(fixture, '.gitmodules'), '[submodule ".vendor/matt-pocock-skills"]\n'
    + '\tpath = .vendor/matt-pocock-skills\n\turl = https://github.com/mattpocock/skills.git\n');
  git(fixture, 'add', '.gitmodules');
  git(fixture, 'update-index', '--add', '--cacheinfo', `160000,${revision},.vendor/matt-pocock-skills`);
  mkdirSync(join(fixture, 'scripts'));
  for (const name of ['setup-skills.mjs', 'setup-matt-pocock.mjs', 'checkout-root.mjs', 'provider-links.mjs'])
    copyFileSync(join(kit, 'scripts', name), join(fixture, 'scripts', name));
  for (const name of ['setup-ponytail.mjs', 'setup-impeccable.mjs'])
    write(join(fixture, 'scripts', name), 'import {writeFileSync} from "node:fs"; writeFileSync("other-generator-ran", "");\n');
  const run = (script = 'setup-matt-pocock.mjs') => spawnSync(process.execPath, [join(fixture, 'scripts', script)], { cwd: consumer, encoding: 'utf8' });
  const tracked = git(source, 'ls-tree', '-r', '--name-only', revision, '--', 'skills').trim().split('\n');
  const skillTrees = tracked.filter(path => path.endsWith('/SKILL.md')).map(path => path.slice(0, -'/SKILL.md'.length));
  // A new upstream skill is distributed only after a human has read it; every other upstream change flows through.
  const reviewed = JSON.parse(readFileSync(join(kit, 'scripts/tests/matt-pocock-reviewed-skills.json'), 'utf8'));
  assert.deepEqual(skillTrees.filter(skill => !reviewed.includes(skill)), [],
    'New upstream skills: read them, then add their paths to scripts/tests/matt-pocock-reviewed-skills.json');
  const expected = new Map(tracked.filter(path => skillTrees.some(skill => path.startsWith(`${skill}/`)))
    .map(path => [path.split('/').slice(2).join('/'), readFileSync(join(source, path), 'utf8').replaceAll('\r\n', '\n')]));
  assert.ok(expected.size >= skillTrees.length, 'Every skill has its files in the package');
  // The deviations from upstream: agents may invoke retro; implement leaves the full suite to CI;
  // every other skill keeps its flags and text.
  const flag = /^disable-model-invocation: true\n/m;
  expected.set('retro/SKILL.md', expected.get('retro/SKILL.md').replace(flag, ''));
  expected.set('implement/SKILL.md', expected.get('implement/SKILL.md')
    .replace(', and the full test suite once at the end.', ', and leave the full test suite to CI (run it once at the end only if CI does not).'));
  // Only a human closes a spec (#508): implement-spec's PR closes the tickets only, chief-of-staff states the rule. The checks fail when upstream moves the sentence.
  expected.set('implement-spec/SKILL.md', expected.get('implement-spec/SKILL.md')
    .replace(' marked as closing the spec and tickets.', ' marked as closing the tickets, never the spec (only a human closes a spec: `AGENT_RULES.md`, Hard rules).'));
  expected.set('chief-of-staff/SKILL.md', expected.get('chief-of-staff/SKILL.md').replace('All work should be done in subagents. Protect your context window.\n',
    'All work should be done in subagents. Protect your context window.\n\nNo agent closes a spec or sets it to Done, a subagent and you included: only a human accepts a spec (`AGENT_RULES.md`, Hard rules).\n'));
  assert.match(expected.get('implement-spec/SKILL.md'), /closing the tickets, never the spec/, 'upstream still has the sentence implement-spec adapts');
  assert.match(expected.get('chief-of-staff/SKILL.md'), /No agent closes a spec/, 'upstream still has the paragraph chief-of-staff adapts');
  write(join(consumer, '.agents/skills/ask-matt/LOCAL.md'), 'Keep my local work\n');
  write(join(consumer, '.agents/skills/project-custom/SKILL.md'), 'Keep unrelated skill\n');
  write(join(consumer, '.agents/skills/retired-skill/SKILL.md'), 'Retired upstream skill\n');
  const previousManifest = {
    repository: 'https://github.com/mattpocock/skills', revision, license: 'MATT-POCOCK-LICENSE.md',
    skills: { 'retired-skill': 'skills/engineering/retired-skill' },
  };
  write(join(consumer, '.agents/skills/MATT-POCOCK-SOURCES.json'), JSON.stringify(previousManifest));
  // A malformed manifest in the last provider must prevent every earlier provider from changing.
  const invalid = join(consumer, '.pi/skills/MATT-POCOCK-SOURCES.json');
  write(invalid, JSON.stringify({ ...previousManifest, skills: { '../outside': 'skills/engineering/retired-skill' } }));
  const invalidRun = run('setup-skills.mjs');
  assert.notEqual(invalidRun.status, 0);
  assert.equal(existsSync(join(consumer, 'other-generator-ran')), false, 'Invalid Matt manifest stops the aggregate updater before other generators');
  assert.equal(readFileSync(join(consumer, '.agents/skills/ask-matt/LOCAL.md'), 'utf8'), 'Keep my local work\n');
  assert.equal(existsSync(join(consumer, '.agents/skills/retired-skill/SKILL.md')), true);
  rmSync(invalid);
  succeeds(run());

  const verify = root => {
    for (const provider of providers) {
      const destination = join(root, provider, 'skills');
      const manifest = JSON.parse(readFileSync(join(destination, 'MATT-POCOCK-SOURCES.json'), 'utf8'));
      assert.equal(manifest.revision, revision);
      assert.equal(manifest.repository, 'https://github.com/mattpocock/skills');
      assert.deepEqual(Object.values(manifest.skills), skillTrees);
      assert.equal(readFileSync(join(destination, manifest.license), 'utf8'), readFileSync(join(source, 'LICENSE'), 'utf8').replaceAll('\r\n', '\n'));
      for (const [path, content] of expected) {
        assert.ok(lstatSync(join(destination, path)).isFile(), `${provider}/${path} is a real file`);
        assert.equal(readFileSync(join(destination, path), 'utf8'), content, `${provider}/${path}`);
      }
      for (const skill of Object.keys(manifest.skills)) {
        assert.ok(lstatSync(join(destination, skill)).isDirectory(), `${provider}/${skill} is a real directory`);
        assert.deepEqual(files(join(destination, skill)), [...expected.keys()].filter(path => path.startsWith(`${skill}/`)).map(path => path.slice(skill.length + 1)).sort());
      }
    }
  };
  verify(consumer);
  for (const provider of providers) {
    assert.doesNotMatch(readFileSync(join(consumer, provider, 'skills/retro/SKILL.md'), 'utf8'), flag, `${provider} retro is invocable`);
    assert.match(readFileSync(join(consumer, provider, 'skills/ask-matt/SKILL.md'), 'utf8'), flag, `${provider} ask-matt stays user-only`);
  }
  const backups = join(consumer, '.workflow-kit/replaced');
  assert.equal(files(backups).filter(path => path.endsWith('/LOCAL.md')).length, 1);
  assert.equal(readFileSync(join(backups, files(backups).find(path => path.endsWith('/LOCAL.md'))), 'utf8'), 'Keep my local work\n');
  assert.equal(existsSync(join(consumer, '.agents/skills/retired-skill')), false, 'Retired managed skill is no longer discoverable');
  const retired = files(backups).filter(path => path.endsWith('/retired-skill/SKILL.md'));
  assert.equal(retired.length, 1);
  assert.equal(readFileSync(join(backups, retired[0]), 'utf8'), 'Retired upstream skill\n');
  assert.equal(readFileSync(join(consumer, '.agents/skills/project-custom/SKILL.md'), 'utf8'), 'Keep unrelated skill\n');
  const installed = join(consumer, '.agents/skills/ask-matt/SKILL.md');
  const modified = lstatSync(installed).mtimeMs;
  succeeds(run());
  verify(consumer);
  assert.equal(lstatSync(installed).mtimeMs, modified, 'Matching files are not rewritten');
  assert.equal(files(backups).filter(path => path.endsWith('/LOCAL.md')).length, 1, 'Rerun creates no new backup');

  // Ordinary tracked files remain available in a fresh checkout without generators or submodules.
  git(consumer, 'add', '--', '.gitattributes', ...providers);
  const fresh = join(base, 'fresh');
  mkdirSync(fresh);
  git(consumer, 'checkout-index', '--all', `--prefix=${fresh.replaceAll('\\', '/')}/`);
  verify(fresh);
  assert.equal(existsSync(join(fresh, '.workflow-kit')), false);

  write(join(source, 'skills/engineering/ask-matt/SKILL.md'), 'Uncommitted source change\n');
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.equal(lstatSync(installed).mtimeMs, modified, 'Dirty source refuses before changing installed files');
});
