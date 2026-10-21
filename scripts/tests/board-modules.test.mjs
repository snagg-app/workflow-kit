import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

// The commands are modules with a factory: importing one reads no project, calls no GitHub and prints nothing, so tests and other tools can use them.
test('every board command module can be imported without running anything', async () => {
  const dir = new URL('../', import.meta.url), printed = [], log = console.log, error = console.error;
  console.log = console.error = (...parts) => printed.push(parts);
  try {
    const files = readdirSync(dir).filter(file => /^board-[a-z]+\.mjs$/.test(file));
    assert.ok(files.length >= 16, 'the command modules are missing');
    for (const file of files) {
      const exported = Object.keys(await import(new URL(file, dir)));
      assert.ok(exported.some(name => /^create[A-Z]/.test(name)), `${file} exports no createX factory`);
    }
  } finally {
    [console.log, console.error] = [log, error];
  }
  assert.deepEqual(printed, []);
});
