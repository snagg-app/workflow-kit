import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitResultIn } from '../git-tool.mjs';
import { kitCheck } from '../kit-check.mjs';
import { useProcessAdapter } from '../run-program.mjs';
import { temporary } from './fixtures.mjs';

test('the kit check waits at most 40 seconds for each git call and never prompts (#782)', t => {
  const dir = temporary(t, 'git-tool ');
  mkdirSync(join(dir, '.git'));
  const seen = [];
  useProcessAdapter((_file, _args, options) => { seen.push(options); throw new Error('no git here'); });
  t.after(() => useProcessAdapter(undefined));
  kitCheck(dir);
  assert.ok(seen.length > 0);
  for (const options of seen) {
    assert.equal(options.timeout, 40_000);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  }
});

const scripts = new URL('../', import.meta.url);

test('no kit script starts git itself; only git-tool.mjs looks it up, and it does not depend on the board (#796)', () => {
  // kit-entry.mjs runs before the kit exists and cannot import anything; it is the one stated exception.
  const files = readdirSync(scripts, { recursive: true }).map(name => name.replaceAll('\\', '/'))
    .filter(name => name.endsWith('.mjs') && !name.startsWith('tests/') && !['git-tool.mjs', 'kit-entry.mjs'].includes(name));
  assert.ok(files.includes('provider.mjs'));
  for (const name of files) {
    const source = readFileSync(new URL(name, scripts), 'utf8');
    assert.doesNotMatch(source, /externalTool\(\s*['"`]git['"`]/, `${name} looks up git itself`);
    assert.doesNotMatch(source, /(execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*['"`]git['"`]/, `${name} starts git from the PATH`);
  }
  assert.doesNotMatch(readFileSync(new URL('git-tool.mjs', scripts), 'utf8'), /board-process/);
});

test('gitResultIn reports status and error output of a failed command instead of throwing (#796)', t => {
  const dir = temporary(t, 'git-result ');
  const result = gitResultIn()(dir, 'rev-parse', '--git-dir');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a git repository/i);
  assert.equal(gitResultIn()(dir, '--version').status, 0);
});

test('gitResultIn throws when git cannot be found instead of returning a result (#796)', t => {
  const dir = temporary(t, 'git-missing ');
  const path = process.env.PATH;
  process.env.PATH = '';
  t.after(() => { process.env.PATH = path; });
  assert.throws(() => gitResultIn()(dir, '--version'), /Install git/);
});
