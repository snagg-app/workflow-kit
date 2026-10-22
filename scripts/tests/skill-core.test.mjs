import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pluginSkills } from '../plugin-skills.mjs';
import { coreSkills } from '../project-profile.mjs';

const skills = fileURLToPath(new URL('../../.agents/skills/', import.meta.url));
// Skills whose text the kit writes or changes itself; upstream texts (Matt, Vercel, Ponytail, Impeccable) are exempt.
const ownText = ['spec-review', 'retro', 'implement', 'implement-spec', 'chief-of-staff', 'code-review'];
const limit = 600;

function description(name) {
  const lines = readFileSync(join(skills, name, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex(line => line.startsWith('description:'));
  assert.notEqual(start, -1, `${name} has a description`);
  const rest = lines.slice(start + 1, lines.findIndex((line, index) => index > start && /^\S/.test(line)));
  return [lines[start].slice('description:'.length), ...rest].join(' ').replace(/^\s*[>|]?-?\s*/, '').trim();
}

test('kit-adapted skills keep their description short', () => {
  for (const name of ownText) assert.ok(description(name).length <= limit, `${name}: ${description(name).length} characters, limit ${limit}`);
});

test('the core skills exist in the kit', () => {
  const kitSkills = readdirSync(skills);
  assert.deepEqual(coreSkills.filter(name => !kitSkills.includes(name)), []);
});

test('plugin skills come from the installed plugins of Claude Code; a missing or foreign file means none', t => {
  const home = mkdtempSync(join(tmpdir(), 'plugin-skills-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(pluginSkills(home).size, 0);
  const install = join(home, 'cache/ponytail');
  mkdirSync(join(install, 'skills/ponytail'), { recursive: true });
  writeFileSync(join(install, 'skills/ponytail/SKILL.md'), 'x');
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'ponytail@ponytail': [{ installPath: install }] } }));
  assert.deepEqual([...pluginSkills(home)], [['ponytail', 'ponytail@ponytail']]);
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), '[1]');
  assert.equal(pluginSkills(home).size, 0);
});
