// Zweck: Das Projekt-Profil wird an einer Stelle gelesen und geprüft (#756): gültige und ungültige Profile, eine kaputte Datei, der UI-Zwischenspeicher.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

for (const path of ['F:/Workspace/Vaultdex/workflow-kit/.github/workflow-project.json', 'F:/Workspace/Vaultdex/Vaultdex/.claude/worktrees/chief-of-staff-orchestrate-018748/.github/workflow-project.json'])
  test(`profile: the real profile ${path} reads without an unknown key (#953)`, { skip: !existsSync(path) }, () => parseProfile(readFileSync(path, 'utf8'), path));

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
