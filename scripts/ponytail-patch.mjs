// Port scripts/ponytail/adaptations.patch to the Ponytail revision the submodule now points at (the update of provider-ponytail.mjs).
// The old patch is replayed onto the previous upstream files and 3-way merged with the new upstream files,
// like `quilt refresh`; a real conflict stops with the file name instead of guessing.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { checkDirectory } from './write-guard.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lf = text => text.replaceAll('\r\n', '\n');

/** Files and contents of the patched upstream paths at one revision; a CI checkout may only hold the new pin. */
const upstream = (source, revision, files) => {
  try { git(source, 'cat-file', '-e', `${revision}^{commit}`); }
  catch { git(source, 'fetch', '--no-tags', 'origin', revision); }
  return Object.fromEntries(files.map(file => {
    try { return [file, lf(git(source, 'show', `${revision}:${file}`))]; }
    catch { throw new Error(`${file} does not exist in Ponytail ${revision.slice(0, 7)}; adapt scripts/ponytail/adaptations.patch by hand.`); }
  }));
};

/** Whether `patch` applies cleanly to the upstream files in `contents`. */
export function patchApplies(patch, contents) {
  const stage = mkdtempSync(join(tmpdir(), 'ponytail-check-'));
  try {
    for (const [file, text] of Object.entries(contents)) {
      mkdirSync(dirname(join(stage, file)), { recursive: true });
      writeFileSync(join(stage, file), text);
    }
    writeFileSync(join(stage, '.check.patch'), patch);
    return spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--check', '--whitespace=error-all', '.check.patch'], { cwd: stage }).status === 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** `resolved` holds hand-edited results for files that conflicted in an earlier run. */
export function refreshPatch({ patch, from, to, files, resolved = {} }) {
  const stage = mkdtempSync(join(tmpdir(), 'ponytail-refresh-'));
  try {
    const dirs = Object.fromEntries(['old', 'ours', 'a', 'b'].map(name => [name, join(stage, name)]));
    const put = (dir, contents) => Object.entries(contents).forEach(([file, text]) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    });
    put(dirs.old, from);
    put(dirs.ours, from);
    put(dirs.a, to);
    const patchFile = join(stage, 'old.patch');
    writeFileSync(patchFile, patch);
    git(dirs.ours, 'apply', '--whitespace=error-all', patchFile);
    const conflicts = {};
    for (const file of files) {
      if (file in resolved) {
        // Any marker form counts. A bare "=======" is legitimate only where the new upstream has it too (a Markdown
        // heading underline), judged by the line above it; any other one is an orphaned conflict separator.
        const lines = resolved[file].split('\n');
        const orphan = lines.some((line, i) => line === '=======' && !(i > 0 && to[file].includes(`${lines[i - 1]}\n=======`)));
        const leftover = /^(?:<{7} adapted|>{7} new upstream)$/m.test(resolved[file]) || orphan;
        assert.ok(!leftover, `${file} still contains conflict markers`);
        put(dirs.b, { [file]: resolved[file] });
        continue;
      }
      const result = spawnSync('git', ['merge-file', '-p', '-L', 'adapted', '-L', 'previous upstream', '-L', 'new upstream',
        join(dirs.ours, file), join(dirs.old, file), join(dirs.a, file)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      assert.ok(result.status !== null && result.status < 128, `git merge-file failed for ${file}: ${result.stderr}`);
      if (result.status > 0) conflicts[file] = result.stdout;
      put(dirs.b, { [file]: result.stdout });
    }
    if (Object.keys(conflicts).length)
      throw Object.assign(new Error(`Adaptation conflicts with the new upstream in: ${Object.keys(conflicts).join(', ')}`), { conflicts });
    // Exit status 1 only means "differences found".
    const diff = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-prefix', '--no-color', 'a', 'b'], { cwd: stage, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(diff.status === 0 || diff.status === 1, `git diff failed: ${diff.stderr}`);
    return diff.stdout;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Conflicting files are written to this directory (ignored by Git) with markers; edit them and run the command again.
// Every access first checks the whole path chain inside the checkout, so a link (symlink or junction) in the ignored
// state directory can neither redirect a recursive delete nor an overwrite to somewhere else.
const stateDirectory = root => join(root, '.workflow-kit/ponytail-resolve');
/**
 * Contents of a regular file inside the checkout, or undefined when it is absent. A link (also a dangling one) or a
 * non-file is refused. The file is opened without following links and its type is checked on the opened descriptor,
 * so a swap for a link between the check and the read cannot redirect the read.
 */
const readRegular = (root, path) => {
  checkDirectory(root, dirname(path));
  let entry;
  try { entry = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  assert.ok(entry.isFile(), `Refusing linked or non-file path: ${relative(root, path)}`);
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    assert.ok(fstatSync(fd).isFile(), `Refusing linked or non-file path: ${relative(root, path)}`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
};

/** Hand-resolved files of an earlier conflict. Files that do not carry this target revision are discarded. */
export function loadResolved(root, files, to) {
  const dir = stateDirectory(root);
  checkDirectory(root, dir);
  if (!existsSync(dir)) return {};
  // A link as TARGET is refused before anything is deleted; only a missing or foreign TARGET discards the directory.
  if (readRegular(root, join(dir, 'TARGET'))?.trim() !== to) {
    rmSync(dir, { recursive: true, force: true });
    return {};
  }
  const resolved = {};
  for (const file of files) {
    const text = readRegular(root, join(dir, file));
    if (text !== undefined) resolved[file] = lf(text);
  }
  return resolved;
}

/** A write target must be a new path or a regular file: writing through a link (also a dangling one) would leave the checkout. */
const writableFile = (root, path) => {
  checkDirectory(root, dirname(path));
  let entry;
  try { entry = lstatSync(path); } catch { /* new path */ }
  assert.ok(!entry || entry.isFile(), `Refusing linked or non-file path: ${relative(root, path)}`);
  return path;
};

export function saveConflicts(root, conflicts, to) {
  const dir = stateDirectory(root);
  for (const [file, text] of Object.entries(conflicts)) {
    checkDirectory(root, dirname(join(dir, file)));
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(writableFile(root, join(dir, file)), text);
  }
  writeFileSync(writableFile(root, join(dir, 'TARGET')), `${to}\n`);
  return dir;
}

export function clearResolved(root) {
  const dir = stateDirectory(root);
  checkDirectory(root, dir);
  rmSync(dir, { recursive: true, force: true });
}

export function patchedFiles(patch) {
  return [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
}

/** `from`: the upstream revision the patch targets now; by default the pin of the last commit that changed the patch. */
export async function updatePatch(kit, submodule, patchFile, from) {
  const source = join(kit, submodule), patchPath = join(kit, patchFile);
  const to = git(source, 'rev-parse', 'HEAD').trim();
  // The generators read the index pin and reset the submodule to it, so stage a bump that is only checked out.
  if (git(kit, 'rev-parse', `:${submodule}`).trim() !== to) git(kit, 'add', '--', submodule);
  const patch = lf(readFileSync(patchPath, 'utf8'));
  const files = patchedFiles(patch);
  const target = upstream(source, to, files);
  // A patch that already fits the new upstream (earlier run, or unrelated pin bump) needs no port.
  if (patchApplies(patch, target)) {
    console.log(`Ponytail adaptations already fit ${to.slice(0, 7)}.`);
  } else {
    // The patch targets the pin recorded in the last commit that changed it; pass a revision when the history is shallow.
    const lastPatchCommit = git(kit, 'log', '-1', '--format=%H', '--', patchFile).trim();
    from ??= lastPatchCommit && git(kit, 'ls-tree', lastPatchCommit, submodule).split(/\s+/)[2];
    assert.ok(from, 'No previous upstream revision: pass it as the argument after update');
    const resolved = loadResolved(kit, files, to);
    try {
      writeFileSync(patchPath, refreshPatch({ patch, from: upstream(source, from, files), to: target, files, resolved }));
    } catch (error) {
      if (!error.conflicts) throw error;
      const dir = saveConflicts(kit, error.conflicts, to);
      throw new Error(`${error.message}. Resolve the conflict markers in ${dir}, then run node scripts/provider.mjs ponytail update again.`);
    }
    clearResolved(kit);
    console.log(`Ponytail adaptations ported from ${from.slice(0, 7)} to ${to.slice(0, 7)}.`);
  }
}
