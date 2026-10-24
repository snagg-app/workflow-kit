// Zweck: `kit setup` ändert keine eingecheckte Skill-, Agenten- oder Hook-Quelldatei des Projekts; nur `--refresh` darf sie überschreiben (#877).
// Nutzen: Das Kit läuft als geteilter Checkout vor jedem Projektstand; ohne diese Regel schreibt jeder Agent-Start den neueren Kit-Stand über die eingecheckten Kopien.
import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agents, sourceProviders } from './agents.mjs';
import { gitIn } from './git-tool.mjs';
import { keepFiles } from './write-guard.mjs';

/** The generated outputs a project commits (skills and agent definitions of every agent, hook sources); the project's settings and hook entries are not among them. */
const outputs = () => [...new Set([...Object.values(agents).flatMap(agent => [agent.skills, agent.agents]), ...sourceProviders])];

/** Content and executable bits of a file, or null when it is absent. Works on one open file, so nothing can change between the check and the read. */
function snapshot(path) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try { return { data: readFileSync(fd), mode: fstatSync(fd).mode & 0o777 }; } finally { closeSync(fd); }
}

const isSame = (now, old) => now && now.data.equals(old.data) && (process.platform === 'win32' || now.mode === old.mode);

/** Writes `old` to `path` through one open file (content and mode). */
function put(path, old) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w', old.mode);
  try {
    writeSync(fd, old.data);
    if (process.platform !== 'win32') fchmodSync(fd, old.mode);
  } finally { closeSync(fd); }
}

/**
 * Runs `work`, then puts every Git-tracked output file back that `work` changed (content and executable bit),
 * unless `refresh`. Files Git does not track (new skills, links) are left as `work` made them.
 */
export async function keepCommitted(root, work, { refresh = false, log = console.log } = {}) {
  if (refresh) return work();
  let tracked;
  try { tracked = gitIn({ env: { LC_ALL: 'C', LANGUAGE: 'C' } }, root)(root, 'ls-files', '-z', '--', ...outputs()).split('\0').filter(Boolean); } catch (error) {
    // Only "not a Git checkout" means nothing is committed; any other Git failure (ownership, locked index, no git) must not switch the protection off.
    if (/not a git repository/i.test(String(error.stderr ?? error.message))) return work();
    throw new Error(`Cannot tell which kit files are committed (git ls-files failed): ${String(error.stderr || error.message).trim()}`);
  }
  const before = new Map(tracked.map(file => [file, snapshot(join(root, file))]));
  keepFiles(tracked);
  try {
    return await work();
  } finally { // also after a failed run: no half-written committed file
    keepFiles([]);
    const restored = [];
    for (const [file, old] of before) {
      if (!old || isSame(snapshot(join(root, file)), old)) continue; // absent before: nothing to preserve
      put(join(root, file), old);
      restored.push(file);
    }
    if (restored.length) log(`Kept ${restored.length} committed kit file(s) as they are (e.g. ${restored[0]}). The kit is newer; refresh them on purpose with "setup --refresh" and commit the result.`);
  }
}
