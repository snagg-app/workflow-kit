import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agents } from '../agents.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Spec #669: an agent is one entry in scripts/agents.mjs. A script that spells out an agent folder bypasses the table (#859).
// The folders come from the table: the first path segment of every string and nested string in an entry.
const strings = value => (typeof value === 'string' ? [value] : value && typeof value === 'object' && !(value instanceof RegExp) ? Object.values(value).flatMap(strings) : []);
const folders = [...new Set(Object.values(agents).flatMap(strings).map(path => path.split('/')[0]).filter(name => name.startsWith('.')))];

// Scripts that may name a folder, with the reason. Everything else goes through the table.
const exempt = {
  'scripts/affected-tests.mjs': 'maps changed kit paths to tests; these are the kit repository\'s own files',
  'scripts/impeccable-release.mjs': 'reads a path inside the Impeccable submodule',
  'scripts/kit-entry.mjs': 'comment naming the hook file; the path is agents.mjs entryFile',
  'scripts/kit.mjs': 'reads the kit\'s own shared skills (.agents/skills is sharedSkills)',
  'scripts/measure-base-load.mjs': 'measures the shared skills and hooks of the project it runs in',
  'scripts/provider-impeccable.mjs': 'comment on the Codex definitions, the code reads agents.mjs',
  'scripts/provider-ponytail.mjs': 'builds the shared .agents skills and hooks, which are not one agent\'s folder',
  'scripts/setup-skills.mjs': 'copies the kit\'s own canonical .agents/skills',
};

test('no script names an agent folder as fixed text outside the agent table', () => {
  assert.ok(folders.includes('.claude') && folders.includes('.codex'), `folders read from the table: ${folders}`);
  const files = execFileSync('git', ['ls-files', '--', ':(glob)scripts/**/*.mjs'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter(file => file && file !== 'scripts/agents.mjs' && !file.startsWith('scripts/tests/'));
  const pattern = new RegExp(`(?:^|[^\\w.])(?:${folders.map(folder => folder.replaceAll('.', '\\.')).join('|')})/`);
  const hits = files.filter(file => pattern.test(readFileSync(`${root}/${file}`, 'utf8')) && !(file in exempt));
  assert.deepEqual(hits, [], 'resolve through scripts/agents.mjs or add the file to `exempt` with a reason');
  for (const file of Object.keys(exempt)) assert.ok(files.includes(file), `${file} is exempt but not a script any more`);
});
