// Zweck: writeProjectFile ersetzt eine Datei ueber Temp-Datei und Umbenennen (#975).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeProjectFile } from '../write-guard.mjs';
import { temporary } from './fixtures.mjs';

test('a changed project file is replaced as a whole file and no temp file stays', t => {
  const root = temporary(t, 'kit write guard ');
  mkdirSync(join(root, '.claude'));
  const file = join(root, '.claude/settings.json');
  writeFileSync(file, '{"a":1}\n');
  const before = statSync(file, { bigint: true }).ino;
  writeProjectFile(root, '.claude/settings.json', '{"a":2}\n');
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}\n');
  assert.notEqual(statSync(file, { bigint: true }).ino, before);
  assert.deepEqual(readdirSync(join(root, '.claude')), ['settings.json']);
  const same = statSync(file, { bigint: true }).ino;
  writeProjectFile(root, '.claude/settings.json', '{"a":2}\n');
  assert.equal(statSync(file, { bigint: true }).ino, same);
});
