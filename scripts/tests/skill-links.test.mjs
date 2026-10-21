import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { linkSkills } from '../provider-links.mjs';
import { temporary } from './fixtures.mjs';

const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

test('Claude Code reads shared skills through links: equal copies go, changed ones move aside, own skills stay', t => {
  const root = temporary(t, 'skill links ');
  for (const skill of ['same', 'changed', 'fresh', 'impeccable']) write(join(root, '.agents/skills', skill, 'SKILL.md'), `shared ${skill}\n`);
  write(join(root, '.agents/skills/NOTICE.md'), 'notice\n');
  write(join(root, '.claude/skills/same/SKILL.md'), 'shared same\n');
  write(join(root, '.claude/skills/changed/SKILL.md'), 'my edit\n');
  write(join(root, '.claude/skills/impeccable/SKILL.md'), 'claude variant\n');
  write(join(root, '.claude/skills/NOTICE.md'), 'notice\n');
  linkSkills(root);
  for (const skill of ['same', 'changed', 'fresh']) {
    assert.ok(lstatSync(join(root, '.claude/skills', skill)).isSymbolicLink(), skill);
    assert.equal(realpathSync(join(root, '.claude/skills', skill)), realpathSync(join(root, '.agents/skills', skill)));
  }
  assert.equal(readFileSync(join(root, '.claude/skills/impeccable/SKILL.md'), 'utf8'), 'claude variant\n');
  assert.equal(existsSync(join(root, '.claude/skills/NOTICE.md')), false, 'A duplicate shared file goes');
  const [stamp] = readdirSync(join(root, '.workflow-kit/replaced'));
  assert.equal(readFileSync(join(root, '.workflow-kit/replaced', stamp, '.claude/skills/changed/SKILL.md'), 'utf8'), 'my edit\n');
  assert.deepEqual(readdirSync(join(root, '.workflow-kit/replaced', stamp, '.claude/skills')), ['changed'], 'An equal copy needs no backup');
  linkSkills(root);
  assert.deepEqual(readdirSync(join(root, '.workflow-kit/replaced')), [stamp], 'A rerun changes nothing');
});
