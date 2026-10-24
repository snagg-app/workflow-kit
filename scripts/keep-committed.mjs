// Zweck: `kit setup` ändert keine eingecheckte Skill-, Agenten- oder Hook-Quelldatei des Projekts; nur `--refresh` darf sie überschreiben (#877).
// Nutzen: Das Kit läuft als geteilter Checkout vor jedem Projektstand; ohne diese Regel schreibt jeder Agent-Start den neueren Kit-Stand über die eingecheckten Kopien.
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitIn } from './git-tool.mjs';

/** The generated outputs a project commits; settings and hook entries of the project are not among them. */
const outputs = ['.agents', '.claude/skills', '.claude/agents', '.codex/agents'];

/**
 * Runs `work`, then puts every Git-tracked output file back that `work` changed or removed (content and executable bit),
 * unless `refresh`. Files Git does not track (new skills, links) are left as `work` made them. Returns the restored paths.
 */
export async function keepCommitted(root, work, { refresh = false, log = console.log } = {}) {
  if (refresh) return work();
  const git = gitIn({}, root);
  let tracked;
  try { tracked = git(root, 'ls-files', '-z', '--', ...outputs).split('\0').filter(Boolean); } catch { return work(); } // not a Git checkout: nothing is committed
  const before = new Map(tracked.map(file => {
    const entry = lstatSync(join(root, file), { throwIfNoEntry: false });
    return [file, entry?.isFile() ? { data: readFileSync(join(root, file)), mode: entry.mode & 0o777 } : null];
  }));
  try {
    return await work();
  } finally { // also after a failed run: no half-written committed file
    const restored = [];
    for (const [file, old] of before) {
      if (!old) continue; // absent or a link before: nothing to preserve
      const path = join(root, file), entry = lstatSync(path, { throwIfNoEntry: false });
      if (entry?.isFile() && readFileSync(path).equals(old.data) && (process.platform === 'win32' || (entry.mode & 0o777) === old.mode)) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, old.data);
      if (process.platform !== 'win32') chmodSync(path, old.mode);
      restored.push(file);
    }
    if (restored.length) log(`Kept ${restored.length} committed kit file(s) as they are (e.g. ${restored[0]}). The kit is newer; refresh them on purpose with "setup --refresh" and commit the result.`);
  }
}
