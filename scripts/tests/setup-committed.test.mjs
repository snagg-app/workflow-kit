import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { kitCheckout, skipWithoutSubmodules, temporary } from './fixtures.mjs';

test('setup leaves committed kit files as committed; only --refresh rewrites them (#877)', { skip: skipWithoutSubmodules() }, t => {
  const fixture = temporary(t, 'workflow-kit committed '), scripts = join(kitCheckout(t), 'scripts');
  const git = (...args) => execFileSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  const setup = (...args) => spawnSync(process.execPath, [join(scripts, 'setup-skills.mjs'), ...args], { cwd: fixture, encoding: 'utf8' });
  assert.equal(setup().status, 0);
  git('add', '.agents');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Skills of an older kit');
  // The kit moved on: a committed kit text is older, and the profile now drops a committed skill.
  const older = join(fixture, '.agents/skills/find-skills/SKILL.md'), dropped = join(fixture, '.agents/skills/spec-review/SKILL.md');
  writeFileSync(older, 'older kit text\n');
  git('add', older);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Older text');
  mkdirSync(join(fixture, '.github'));
  writeFileSync(join(fixture, '.github/workflow-project.json'), '{"skills": ["find-skills"]}');
  const result = setup();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Kept \d+ committed kit file/);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'setup changed no committed file');
  assert.equal(readFileSync(older, 'utf8'), 'older kit text\n');
  assert.ok(existsSync(dropped), 'a committed skill the profile drops stays');
  // Committed copies are not moved aside first (#881): not by the first run, and not by two more, also with CRLF line ends.
  writeFileSync(older, 'older kit text\r\n');
  for (let run = 0; run < 2; run++) assert.equal(setup().status, 0);
  assert.equal(existsSync(join(fixture, '.workflow-kit/replaced')), false, 'no backup of a file that stays as committed');
  assert.equal(setup('--refresh').status, 0);
  assert.notEqual(readFileSync(older, 'utf8'), 'older kit text\n', '--refresh writes the kit state over the committed copy');
  assert.ok(!existsSync(dropped), '--refresh applies the profile');
});
