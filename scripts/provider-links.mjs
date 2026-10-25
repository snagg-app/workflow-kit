// Provider discovery files are ordinary, committable files. Replaced local content stays recoverable.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { agents, sharedSkills } from './agents.mjs';
import { gitResultIn } from './git-tool.mjs';
import { ownSkills } from './provider-list.mjs';
import { checkDirectory, isKept, localDirectory, moveAside } from './write-guard.mjs';

const present = path => lstatSync(path, { throwIfNoEntry: false });

/** Compare ordinary files/directories without following a previous provider link. */
function same(path, source) {
  const current = present(path), expected = lstatSync(source);
  if (!current || current.isSymbolicLink()) return false;
  if (expected.isFile()) return current.isFile()
    && (process.platform === 'win32' || (current.mode & 0o111) === (expected.mode & 0o111))
    && readFileSync(path).equals(readFileSync(source));
  assert.ok(expected.isDirectory(), `Unexpected generated link or special file: ${source}`);
  if (!current.isDirectory()) return false;
  const names = readdirSync(source).sort();
  return JSON.stringify(readdirSync(path).sort()) === JSON.stringify(names)
    && names.every(name => same(join(path, name), join(source, name)));
}

/** Publish generated files; keep equal output and preserve changed files or old junctions aside. */
export function materialize(root, path, source, log) {
  localDirectory(root, dirname(path));
  if (same(path, source) || isKept(root, path)) return;
  moveAside(root, path, log);
  cpSync(source, path, { recursive: true });
}

const realpath = path => { try { return realpathSync.native(path); } catch { return ''; } };

const git = gitResultIn();

/** Keep the links out of `git status`: one line each in the checkout's `info/exclude` (worktree-safe, never committed). No Git checkout: nothing to do. */
function excludeLinks(root, paths) {
  const found = git(root, 'rev-parse', '--git-path', 'info/exclude');
  if (found.status !== 0 || !paths.length) return;
  const file = resolve(root, found.stdout.trim());
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* no exclude file yet */ }
  const lines = paths.map(path => `/${relative(root, path).split(sep).join('/')}`).filter(line => !text.split(/\r?\n/).includes(line));
  if (!lines.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
}

/**
 * Link every shared skill into the folders of the agents that read it through links (not committed: a junction on Windows,
 * which needs no privilege, else a symlink). Own skills stay real copies. A copy equal to the shared one goes; a changed one is moved aside.
 */
export function linkSkills(root, log) {
  const shared = join(root, sharedSkills), linked = [];
  checkDirectory(root, shared);
  for (const { skills } of Object.values(agents).filter(agent => agent.linksShared)) {
    localDirectory(root, join(root, skills));
    for (const name of readdirSync(shared).filter(name => !ownSkills().includes(name))) {
      const source = join(shared, name), path = join(root, skills, name);
      if (lstatSync(source).isFile()) {
        if (same(path, source)) rmSync(path);
      } else if (realpath(path) !== realpath(source) && !isKept(root, path)) {
        if (same(path, source)) rmSync(path, { recursive: true });
        else moveAside(root, path, log);
        symlinkSync(source, path, 'junction');
      }
      if (!lstatSync(source).isFile() && present(path)?.isSymbolicLink()) linked.push(path);
    }
  }
  excludeLinks(root, linked);
}
