import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { commandSpecs } from '../board-commands.mjs';

// The commands are modules with plain exports: importing one reads no project, calls no GitHub and prints nothing, so tests and other tools can use them.
// A helper name that does not exist fails here, when the module links, not when the command that uses it runs.
test('every board command module can be imported without running anything, and every command has its function', async () => {
  const dir = new URL('../', import.meta.url), printed = [], log = console.log, error = console.error;
  console.log = console.error = (...parts) => printed.push(parts);
  const exported = new Set();
  try {
    const files = readdirSync(dir).filter(file => /^board-[a-z]+\.mjs$/.test(file) && file !== 'board-readme.mjs');
    assert.ok(files.length >= 16, 'the command modules are missing');
    for (const file of files) Object.keys(await import(new URL(file, dir))).forEach(name => exported.add(name));
  } finally {
    [console.log, console.error] = [log, error];
  }
  assert.deepEqual(printed, []);
  assert.deepEqual(commandSpecs.map(spec => spec.run).filter(run => !exported.has(run)), []);
});
