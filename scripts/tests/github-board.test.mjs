import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setupBoard } from '../github-board.mjs';
import { createGithub, useGhAdapter } from '../github.mjs';
import { fakeGh } from './fake-gh.mjs';
import { temporary } from './fixtures.mjs';

// The fake gh reads and writes its files in the working directory: each case runs in a folder of its own.
function bind(t, profile, kitProject = { owner: 'kitorg', number: 5 }) {
  const home = process.cwd();
  t.after(() => process.chdir(home)); // before the folder is removed
  const root = temporary(t, 'board setup ');
  process.chdir(root);
  mkdirSync(join(root, '.github'));
  if (profile) writeFileSync(join(root, '.github/workflow-project.json'), JSON.stringify(profile));
  useGhAdapter(fakeGh);
  t.after(() => useGhAdapter(undefined));
  const github = createGithub({ tool: {}, projectDirectory: root, sleep() {} });
  const result = setupBoard({ root, github, repo: 'acme/app', kitProject });
  const calls = readFileSync(join(root, 'setup-calls'), 'utf8').split('\n');
  return { result, calls, saved: JSON.parse(readFileSync(join(root, '.github/workflow-project.json'), 'utf8')) };
}

test('a new project copies the board named in its profile and creates its labels', t => {
  const { result, calls, saved } = bind(t, { boardTemplate: { owner: 'acme', number: 3 }, labels: [{ name: 'ci', color: '1d76db' }, { name: 'ops', color: 'ffffff' }], language: 'de' });
  assert.equal(result.status, 0);
  assert.ok(calls.includes('project copy 3 --source-owner acme --target-owner acme --title app --format json'), calls.join('\n'));
  assert.deepEqual(calls.filter(call => call.startsWith('label create')), ['label create ci --repo acme/app --color 1d76db', 'label create ops --repo acme/app --color ffffff']);
  assert.deepEqual([saved.number, saved.id, saved.language], [9, 'PVT_new', 'de']);
});

test('without a template in the profile the board of the kit repository is copied, with the seven default labels', t => {
  const { calls } = bind(t, undefined);
  assert.ok(calls.includes('project copy 5 --source-owner kitorg --target-owner acme --title app --format json'), calls.join('\n'));
  assert.equal(calls.filter(call => call.startsWith('label create')).length, 7);
});

test('a malformed template is refused before anything is copied', t => {
  assert.throws(() => bind(t, { boardTemplate: { owner: 'acme' } }), /boardTemplate in /);
});

test('a malformed label list is refused before any label is created', t => {
  assert.throws(() => bind(t, { number: 4, labels: [{ name: 'ci' }] }), /labels in /);
});
