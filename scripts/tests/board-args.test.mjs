import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandSpecs } from '../board-commands.mjs';
import { helpOf, usageOf } from '../board-args.mjs';
import { fixture, issue, test } from './board-fixture.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The table runs over the descriptions, so a new command is covered the day it exists.
test('every command refuses an unknown flag before any GitHub call and shows only its own usage', t => {
  const { checkout, run } = fixture(t);
  for (const spec of commandSpecs) {
    for (const flag of ['--oops', '-x']) {
      const before = readdirSync(checkout).sort();
      const result = run(spec.name, flag);
      assert.equal(result.status, 2, `${spec.name} ${flag}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stderr.split('\n').filter(line => line.startsWith('Usage:')).join('\n'), usageOf(spec), `${spec.name} ${flag} shows the usage of ${spec.name} only`);
      assert.deepEqual(readdirSync(checkout).sort(), before, `${spec.name} ${flag} reached gh`);
    }
  }
});

test('help shows one command from its description, and the long text it points to exists', t => {
  const { run } = fixture(t);
  for (const spec of commandSpecs) {
    const help = run('help', spec.name);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.trimEnd(), helpOf(spec));
    assert.ok(help.stdout.length < 2048, `help ${spec.name} is a page, not a manual`);
    assert.ok(!spec.doc || existsSync(join(root, spec.doc)), `${spec.doc} is missing`);
  }
  assert.equal(run('help', 'nosuchcommand').status, 2);
});

test('field takes NAME VALUE and --field NAME=VALUE alike', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  for (const pair of [['Size', 'xs'], ['--field', 'Size=xs']]) {
    const result = run('field', '1', ...pair);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'XS');
  }
  assert.equal(run('field', '1', '--field', 'Size').status, 2, '--field needs NAME=VALUE');
});
