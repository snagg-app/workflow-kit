import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { clearResolved, loadResolved, patchApplies, patchedFiles, refreshPatch, saveConflicts } from '../ponytail-patch.mjs';

const lines = (...overrides) => Array.from({ length: 12 }, (_, i) => overrides.find(([n]) => n === i + 1)?.[1] ?? `line ${i + 1}`).join('\n') + '\n';
const FILE = 'hooks/ponytail-example.js';

/** What `git diff` writes for one changed file, as the kit stores its adaptation patch. */
function diff(t, before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'ponytail refresh test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [side, text] of [['a', before], ['b', after]]) {
    mkdirSync(join(dir, side, dirname(FILE)), { recursive: true });
    writeFileSync(join(dir, side, FILE), text);
  }
  return spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-prefix', '--no-color', 'a', 'b'], { cwd: dir, encoding: 'utf8' }).stdout;
}

function apply(t, patch, text) {
  const dir = mkdtempSync(join(tmpdir(), 'ponytail apply test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, dirname(FILE)), { recursive: true });
  writeFileSync(join(dir, FILE), text);
  writeFileSync(join(dir, 'p.patch'), patch);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=error-all', 'p.patch'], { cwd: dir, stdio: 'pipe' });
  return readFileSync(join(dir, FILE), 'utf8');
}

test('an adaptation is ported onto changed upstream and the new patch applies to the new upstream', t => {
  const previous = lines();
  const patch = diff(t, previous, lines([3, 'adapted 3']));
  assert.deepEqual(patchedFiles(patch), [FILE]);
  // Upstream edits inside the patch's context (so the old patch no longer applies) and far from it.
  const next = lines([6, 'upstream 6'], [11, 'upstream 11']);
  const refreshed = refreshPatch({ patch, from: { [FILE]: previous }, to: { [FILE]: next }, files: [FILE] });
  assert.equal(apply(t, refreshed, next), lines([3, 'adapted 3'], [6, 'upstream 6'], [11, 'upstream 11']));
  assert.equal(patchApplies(patch, { [FILE]: next }), false);
  assert.equal(patchApplies(refreshed, { [FILE]: next }), true);
});

test('an adaptation that overlaps an upstream change stops with the file name', t => {
  const previous = lines();
  const patch = diff(t, previous, lines([3, 'adapted 3']));
  const next = lines([3, 'upstream 3']);
  const run = resolved => refreshPatch({ patch, from: { [FILE]: previous }, to: { [FILE]: next }, files: [FILE], resolved });
  assert.throws(() => run({}), error => error.message.includes(FILE) && error.conflicts[FILE].includes('<<<<<<< adapted'));
  // The hand-edited result of that conflict becomes the new patch; leftover markers are rejected.
  const merged = lines([3, 'adapted upstream 3']);
  assert.equal(apply(t, run({ [FILE]: merged }), next), merged);
  for (const leftover of ['<<<<<<< adapted\nx\n', 'x\n=======\ny\n', 'x\n>>>>>>> new upstream\n'])
    assert.throws(() => run({ [FILE]: leftover }), /still contains conflict markers/);
  // A bare ======= line is fine where the new upstream has it too (a Markdown heading underline).
  const underlined = lines([3, 'Heading\n=======']);
  const withUnderline = resolved => refreshPatch({ patch, from: { [FILE]: previous }, to: { [FILE]: underlined }, files: [FILE], resolved: { [FILE]: resolved } });
  assert.doesNotThrow(() => withUnderline(underlined));
  // ...but an extra separator elsewhere is a leftover, also when the legitimate one was deleted (same total count).
  for (const orphaned of [`${underlined}=======\n`, lines([3, 'Heading'], [7, '=======']), lines([7, '======='])])
    assert.throws(() => withUnderline(orphaned), /still contains conflict markers/);
});

test('conflict state is read, written and deleted only inside the checkout, never through a link', t => {
  const base = mkdtempSync(join(tmpdir(), 'ponytail state test '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'kit'), outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  // A junction works without privileges on Windows and is an ordinary symlink elsewhere.
  symlinkSync(outside, join(root, '.workflow-kit'), 'junction');
  for (const act of [() => loadResolved(root, [FILE], 'new'), () => saveConflicts(root, { [FILE]: 'x' }, 'new'), () => clearResolved(root)])
    assert.throws(act); // the wording is free; the filesystem checks below carry the behavior
  assert.deepEqual(readdirSync(outside), ['keep.txt'], 'Nothing outside the checkout is created, changed or deleted');
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
  rmSync(join(root, '.workflow-kit'));

  // The ordinary round trip: kept for the same target revision, discarded for another one.
  saveConflicts(root, { [FILE]: 'marked up' }, 'new');
  assert.deepEqual(loadResolved(root, [FILE], 'new'), { [FILE]: 'marked up' });
  assert.deepEqual(loadResolved(root, [FILE], 'other'), {});
  assert.equal(existsSync(join(root, '.workflow-kit/ponytail-resolve')), false);
});

test('conflict files are never written through a link in the state directory either', t => {
  const base = mkdtempSync(join(tmpdir(), 'ponytail leaf test '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'kit'), outside = join(base, 'outside');
  const state = join(root, '.workflow-kit/ponytail-resolve');
  mkdirSync(join(state, 'hooks'), { recursive: true });
  mkdirSync(outside);
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'keep');
  // File links need privileges on Windows (the CI runs them); a junction as the target needs none and is no regular file either.
  const link = (target, leaf, type) => {
    try { symlinkSync(target, leaf, type); return true; } catch (error) { if (error.code === 'EPERM') return false; throw error; }
  };
  let ran = 0;
  for (const [leaf, target, type] of [[join(state, FILE), victim, 'file'], [join(state, 'TARGET'), victim, 'file'],
    [join(state, FILE), join(outside, 'not-yet.txt'), 'file'], [join(state, 'TARGET'), outside, 'junction']]) {
    rmSync(leaf, { force: true, recursive: true });
    if (!link(target, leaf, type)) continue;
    ran++;
    assert.throws(() => saveConflicts(root, { [FILE]: 'marked up' }, 'new'));
    assert.deepEqual(readdirSync(outside).sort(), ['victim.txt'], 'No file is created outside the checkout');
    assert.equal(readFileSync(victim, 'utf8'), 'keep', 'The linked file keeps its content');
    rmSync(leaf, { recursive: true });
  }
  assert.ok(ran >= 1, 'At least the junction case ran');
});

test('a linked or dangling TARGET is refused before any hand-edited resolution is discarded', t => {
  const base = mkdtempSync(join(tmpdir(), 'ponytail target test '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'kit'), outside = join(base, 'outside');
  const state = join(root, '.workflow-kit/ponytail-resolve');
  mkdirSync(join(state, 'hooks'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  const resolution = join(state, FILE);
  writeFileSync(resolution, 'hand edited');
  const link = (target, leaf, type) => {
    try { symlinkSync(target, leaf, type); return true; } catch (error) { if (error.code === 'EPERM') return false; throw error; }
  };
  let ran = 0;
  for (const [target, type] of [[join(outside, 'gone.txt'), 'file'], [join(outside, 'secret.txt'), 'file'], [outside, 'junction']]) {
    const leaf = join(state, 'TARGET');
    rmSync(leaf, { force: true, recursive: true });
    if (!link(target, leaf, type)) continue;
    ran++;
    assert.throws(() => loadResolved(root, [FILE], 'new'));
    assert.equal(readFileSync(resolution, 'utf8'), 'hand edited', 'The resolution is not discarded by a refused TARGET');
    assert.deepEqual(readdirSync(outside).sort(), ['secret.txt'], 'Nothing outside the checkout is touched');
    rmSync(leaf, { recursive: true });
  }
  assert.ok(ran >= 1, 'At least the junction case ran');
  // Without any TARGET the directory still counts as stale and is discarded.
  assert.deepEqual(loadResolved(root, [FILE], 'new'), {});
  assert.equal(existsSync(state), false);
});
