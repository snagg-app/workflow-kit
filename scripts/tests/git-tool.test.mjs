import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useProcessAdapter } from '../board-process.mjs';
import { kitCheck } from '../kit-check.mjs';
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
