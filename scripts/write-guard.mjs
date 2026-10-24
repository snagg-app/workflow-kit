// The one guard for writing into a project: the path must lie below the checkout and no component on the way may be a link or a file.
// Every writer of `kit setup` (hook files, profile, board marker, skills, provider output) goes through this module.
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const present = path => lstatSync(path, { throwIfNoEntry: false });
const stamp = new Date().toISOString().replaceAll(':', '-');

let kept = [];

/** `keepCommitted` names the committed files (relative, with `/`) it restores for the length of one run; none outside a run. */
export const keepFiles = files => { kept = files; };

/** True while a run keeps `path` (a committed file or a folder holding one): the writers leave it alone, so no backup of a file that stays as committed (#881). */
export const isKept = (root, path) => {
  const rel = relative(root, path).split(sep).join('/');
  return kept.some(file => file === rel || file.startsWith(`${rel}/`));
};

/** Assert `path` lies below `root` and no existing component on the way is a link or a file (no redirected state). */
export function checkDirectory(root, path) {
  const inside = relative(root, path);
  assert.ok(!isAbsolute(inside) && inside.split(sep)[0] !== '..', `Directory leaves checkout: ${path}`);
  let current = root;
  for (const part of inside.split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = present(current);
    if (!entry) break;
    assert.ok(entry.isDirectory(), `Refusing linked or non-directory path: ${relative(root, current)}`);
  }
}

/** Create `path` as a directory below `root` after `checkDirectory`. */
export function localDirectory(root, path) {
  checkDirectory(root, path);
  mkdirSync(path, { recursive: true });
}

/** `file` below `root`, reached without links, that is a plain file if it exists. */
export function projectFile(root, file) {
  const target = join(root, file);
  checkDirectory(root, dirname(target));
  assert.ok(!present(target) || present(target).isFile(), `Refusing non-file target: ${file}`);
  return target;
}

/** Write `value` to `file` below `root` through the guard; an equal file (ignoring CRLF) stays untouched. */
export function writeProjectFile(root, file, value) {
  const target = projectFile(root, file);
  localDirectory(root, dirname(target));
  // Read once and treat a missing file as ENOENT: no separate existence check that could go stale before the read.
  let current;
  try { current = readFileSync(target, 'utf8').replaceAll('\r\n', '\n'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current === value) return;
  // Temp file plus rename: an abort never leaves a half-written (e.g. broken JSON) project file (#975).
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, value, { mode: present(target)?.mode });
    rename(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** renameSync that waits out the short locks Windows antivirus and indexers put on fresh files. */
export function rename(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (error) {
      if (attempt === 30 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** Move whatever is at `path` to .workflow-kit/replaced/<stamp>/, keeping it for the user. */
export function moveAside(root, path, log = console.log) {
  // Through a linked ancestor, `path` would name an entry somewhere else.
  checkDirectory(root, dirname(path));
  const entry = present(path);
  if (!entry) return;
  const destination = join(root, '.workflow-kit/replaced', stamp, relative(root, path));
  localDirectory(root, dirname(destination));
  const target = entry.isSymbolicLink() ? readlinkSync(path) : null;
  if (process.platform !== 'win32' && target && !isAbsolute(target)) {
    // Moving a relative link verbatim would break recovery. Keep its original target
    // without reading through it; remove the old link only after the backup exists.
    // Preserve `..` after symlink components rather than normalizing it lexically.
    symlinkSync(dirname(path) + sep + target, destination);
    unlinkSync(path);
  } else rename(path, destination);
  log(`Moved ${relative(root, path)} to ${relative(root, destination)}`);
}
