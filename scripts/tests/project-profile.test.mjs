// Zweck: Das Projekt-Profil wird an einer Stelle gelesen und geprüft (#756): gültige und ungültige Profile, eine kaputte Datei, der UI-Zwischenspeicher.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseProfile, projectFeatures, readProfile, readProfileAt, readProfileLenient, textsFor } from '../project-profile.mjs';

const valid = [
  ['an empty profile gets every default', {}, view => assert.deepEqual([view.language, view.staleHours, view.reviewerGraceMinutes, view.specLabel, view.doneBaseMerge, view.optionalReviewers, view.setup, view.impeccable],
    ['en', 6, 3, 'spec', 'always', [], '', 'auto'])],
  ['a renamed status keeps the others', { statuses: { humanReview: 'QA' } }, view => assert.deepEqual([view.statuses.humanReview, view.statuses.done], ['QA', 'Done'])],
  ['zero turns the grace off', { reviewerGraceMinutes: 0, staleHours: 0 }, view => assert.equal(view.reviewerGraceMinutes, 0)],
  ['lists and switches are kept', { optionalReviewers: ['coderabbitai'], push: ['npm run x'], ponytail: false, doneBaseMerge: 'overlap' }, view => assert.deepEqual([view.optionalReviewers, view.ponytail, view.doneBaseMerge], [['coderabbitai'], false, 'overlap'])],
];
for (const [name, profile, check] of valid) test(`profile: ${name}`, () => check(parseProfile(JSON.stringify(profile))));

const invalid = [
  ['not JSON', '{"language":', /not valid JSON/],
  ['not an object', '[]', /must be a JSON object/],
  ['null', 'null', /must be a JSON object/],
  ['two statuses with one name', '{"statuses":{"done":"Ready"}}', /statuses in/],
  ['an unknown language', '{"language":"fr"}', /language in/],
  ['labels without a color', '{"labels":[{"name":"x"}]}', /labels in/],
  ['skills of the wrong kind', '{"skills":5}', /skills in/],
  ['a board template without a number', '{"boardTemplate":{"owner":"o"}}', /boardTemplate in/],
  ['a negative grace', '{"reviewerGraceMinutes":-1}', /reviewerGraceMinutes in/],
  ['a text for the grace', '{"reviewerGraceMinutes":"0"}', /reviewerGraceMinutes in/],
  ['stale hours that are null', '{"staleHours":null}', /staleHours in/],
  ['a list with an empty entry', '{"optionalReviewers":["  "]}', /optionalReviewers in/],
  ['a list that is a text', '{"updateBranchChecks":"ci"}', /updateBranchChecks in/],
  ['an empty spec label', '{"specLabel":" "}', /specLabel in/],
  ['an unknown base merge policy', '{"doneBaseMerge":"never"}', /doneBaseMerge in/],
  ['a setup that is a list', '{"setup":["npm ci"]}', /setup in/],
  ['a switch that is a text', '{"ponytail":"auto"}', /ponytail in/],
];
for (const [name, text, message] of invalid) test(`profile: ${name} is refused with a message that names the field`, () => assert.throws(() => parseProfile(text), message));

test('profile: a misspelled key is named with the closest known one (#953)', () => {
  assert.throws(() => parseProfile('{"doneBaseMerges":"overlap"}'), /Unknown key "doneBaseMerges".*did you mean "doneBaseMerge"\?/);
  assert.throws(() => parseProfile('{"zzzzzzzzzzzzzzz":1}'), /Unknown key "zzzzzzzzzzzzzzz"/);
});

test('profile: the kit\'s own profile and a project profile with the project-owned keys read without an unknown key (#953)', () => {
  parseProfile(readFileSync(new URL('../../.github/workflow-project.json', import.meta.url), 'utf8'));
  parseProfile(JSON.stringify({ repository: 'o/r', owner: 'o', number: 1, id: 'P', url: 'u', start: 'ready', setup: 'npm ci', push: ['x'], baseBranch: { field: 'F' }, worktreeVolumePrefixes: ['v'], skills: ['core'] }));
});

test('profile: every language has the same texts, and a text follows the language', () => {
  const english = textsFor({}), german = textsFor({ language: 'de' });
  assert.deepEqual(Object.keys(german), Object.keys(english));
  assert.notEqual(german.modulesMissing(''), english.modulesMissing(''));
  assert.notEqual(german.closedByMerge(1, 'main'), english.closedByMerge(1, 'main'));
});

test('profile: the file as written stays reachable, without defaults', () => {
  assert.deepEqual(parseProfile('{"language":"de"}').raw, { language: 'de' });
});

test('profile: disk and Git ref give the same view and the same message for a broken file', t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(readProfile(root).language, 'en', 'no file: the defaults');
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/workflow-project.json'), '{"staleHours": "soon"');
  assert.throws(() => readProfile(root), /workflow-project\.json is not valid JSON/);
  assert.deepEqual(readProfileLenient(root), {}, 'the lenient reader falls back instead of throwing');
  const answer = text => path => path.startsWith('repos/o/r/contents/.github/workflow-project.json?ref=main') ? { encoding: 'base64', content: Buffer.from(text).toString('base64') } : assert.fail(path);
  assert.throws(() => readProfileAt(answer('{"staleHours": "soon"'), 'o/r', 'main'), /workflow-project\.json of o\/r on main is not valid JSON/);
  assert.throws(() => readProfileAt(answer('{"staleHours": "soon"}'), 'o/r', 'main'), /staleHours in/);
  assert.equal(readProfileAt(answer('{"language":"de"}'), 'o/r', 'main').language, 'de');
});

test('profile: first setup can use defaults only for a never-configured readable base (#1077)', () => {
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40), calls = [];
  const missing = Object.assign(new Error('not found'), { stderr: 'gh: Not Found (HTTP 404)' });
  const answer = path => {
    calls.push(path);
    if (path.includes('/contents/')) throw missing;
    if (path === 'repos/o/r/commits/main') return { sha, commit: { tree: { sha: tree } } };
    if (path === `repos/o/r/git/trees/${tree}?recursive=1`) return { sha: tree, truncated: false, tree: [{ path: '.github', type: 'tree' }] };
    if (path === `repos/o/r/commits?sha=${sha}&path=.github%2Fworkflow-project.json&per_page=1`) return [];
    assert.fail(path);
  };
  assert.throws(() => readProfileAt(answer, 'o/r', 'main'), error => error === missing, 'ordinary readers stay strict');
  calls.length = 0;
  const profile = readProfileAt(answer, 'o/r', 'main', { allowUnconfigured: true });
  assert.equal(profile.doneBaseMerge, 'always');
  assert.deepEqual([profile.ignoredChecks, profile.optionalReviewers], [[], []]);
  assert.equal(calls.length, 4, 'all absence evidence is read');
});

test('profile: first-setup defaults never hide errors, deletion or incomplete absence evidence (#1077)', () => {
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
  const missing = Object.assign(new Error('not found'), { stderr: 'gh: Not Found (HTTP 404)' });
  const commit = { sha, commit: { tree: { sha: tree } } };
  for (const [name, evidence] of [
    ['deleted profile', { history: [{ sha }] }],
    ['file appeared meanwhile', { tree: { truncated: false, tree: [{ path: '.github/workflow-project.json', type: 'blob' }] } }],
    ['symlinked parent', { tree: { truncated: false, tree: [{ path: '.github', type: 'blob' }] } }],
    ['truncated tree', { tree: { truncated: true, tree: [] } }],
    ['unreadable tree', { tree: { tree: [] } }],
    ['unreadable history', { history: {} }],
    ['unreadable commit', { commit: {} }],
    ['unknown repository or ref', { fail: '/commits/main' }],
    ['history read failed', { fail: '/commits?' }],
  ]) {
    const rest = path => {
      if (evidence.fail && path.includes(evidence.fail)) throw missing;
      if (path.includes('/contents/')) throw missing;
      if (path.endsWith('/commits/main')) return evidence.commit ?? commit;
      if (path.includes('/git/trees/')) return { sha: tree, ...(evidence.tree ?? { truncated: false, tree: [] }) };
      if (path.includes('/commits?')) return evidence.history ?? [];
      assert.fail(path);
    };
    assert.throws(() => readProfileAt(rest, 'o/r', 'main', { allowUnconfigured: true }), name);
  }
  for (const error of [new Error('timeout'), Object.assign(new Error('denied'), { stderr: 'gh: Forbidden (HTTP 403)' })]) {
    let calls = 0;
    assert.throws(() => readProfileAt(() => { calls++; throw error; }, 'o/r', 'main', { allowUnconfigured: true }), current => current === error);
    assert.equal(calls, 1, 'no fallback for other failures');
  }
  assert.throws(() => readProfileAt(() => ({ encoding: 'base64', content: Buffer.from('{').toString('base64') }), 'o/r', 'main', { allowUnconfigured: true }), /not valid JSON/);
});

test('the UI check of "auto" is kept per commit and does not scan again', t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' }).toString();
  git('init', '-q');
  writeFileSync(join(root, 'readme.md'), 'x');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  assert.equal(projectFeatures(root).impeccable, false);
  writeFileSync(join(root, 'App.tsx'), 'x');
  assert.equal(projectFeatures(root).impeccable, false, 'same commit: the kept answer');
  git('add', '.');
  git('commit', '-q', '-m', 'two');
  assert.equal(projectFeatures(root).impeccable, true, 'a new commit scans again');
  assert.match(readFileSync(join(root, '.git/kit-has-ui'), 'utf8'), /"ui":true/);
});
