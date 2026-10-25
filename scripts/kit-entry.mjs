// Zweck: Die eine Stelle, die das gemeinsame Kit findet und notfalls klont; zugleich der kleine Einstieg der Hook-Einträge im Projekt.
// Aufruf: `kit setup` kopiert diese Datei nach .agents/workflow-kit-hook.mjs; die Hook-Einträge rufen `node <Datei> <Event> --agent <Agent>`.
//         Der erste Befehl im frischen Worktree (auch ohne Hooks): `node .agents/workflow-kit-hook.mjs link` verknüpft `.vendor/workflow-kit` (#896).
// Nutzen: Fehlt das Kit, fehlt auch kit-hook.mjs; dieser Einstieg braucht nur Node und klont dann selbst, statt dass drei Shells es nachbauen.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kitUrl = 'https://github.com/snagg-app/workflow-kit.git';

/** The shared kit checkout: WORKFLOW_KIT_DIR, else `workflow-kit` next to the main checkout of the project (also from a worktree). `commonDir`: the project's git common dir. */
export function sharedKit(commonDir) {
  if (process.env.WORKFLOW_KIT_DIR) return path.resolve(process.env.WORKFLOW_KIT_DIR);
  return commonDir ? path.join(path.dirname(path.dirname(commonDir)), 'workflow-kit') : '';
}

// Git runs from the temp folder, so a checkout cannot put its own program in the way; it never prompts.
const git = (...args) => spawnSync('git', ['-c', 'credential.interactive=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd: tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 90_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' } });

/** Clones next to the target and renames at the end, so an aborted clone never leaves a folder that blocks the next start (#974). Returns '' or git's real error. */
export function cloneKit(kit, url = kitUrl) {
  const temp = `${kit}.clone-${process.pid}`;
  rmSync(temp, { recursive: true, force: true });
  const run = git('clone', '--quiet', url, temp);
  if (run.status !== 0) {
    rmSync(temp, { recursive: true, force: true });
    return (run.stderr || run.error?.message || 'git clone failed').trim();
  }
  try {
    if (existsSync(path.join(kit, 'scripts/kit-hook.mjs'))) throw new Error('kit already present');
    if (existsSync(kit)) {
      // Replace only what is recognizably an aborted clone: empty, or just a `.git` without a commit. Anything else may be someone's work.
      const names = readdirSync(kit);
      const aborted = names.every(name => name === '.git') && (!names.length || git('-C', kit, 'rev-parse', '--verify', 'HEAD').status !== 0);
      if (!aborted) {
        rmSync(temp, { recursive: true, force: true });
        return `${kit} exists but is not a kit checkout and does not look like an aborted clone; check it by hand and remove it if it is not needed.`;
      }
      rmSync(kit, { recursive: true, force: true });
    }
    renameSync(temp, kit);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    // A parallel start may have finished first; then the kit is there and fine.
    if (!existsSync(path.join(kit, 'scripts/kit-hook.mjs'))) return error.message;
  }
  return '';
}

/** `link`: the one first command of a fresh worktree; reports what is in order or what needs a human. */
async function linkNow(project, kit) {
  const root = git('-C', project, 'rev-parse', '--show-toplevel').stdout?.trim() || project;
  const { linkKit } = await import(pathToFileURL(path.join(kit, 'scripts/kit-check.mjs')).href);
  const problem = linkKit(root, kit);
  console.log(problem || `.vendor/workflow-kit links to ${kit}`);
  if (problem) process.exitCode = 1;
}

function main() {
  const [event] = process.argv.slice(2);
  const link = event === 'link';
  const start = link || event === 'SessionStart' || event === 'SubagentStart';
  const project = path.resolve(process.cwd(), process.env.CLAUDE_PROJECT_DIR || '.');
  const own = ['.vendor/workflow-kit/scripts/kit-hook.mjs', 'scripts/kit-hook.mjs'].map(file => path.join(project, file)).find(existsSync);
  let file = link ? '' : own;
  if (!file) {
    const common = git('-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout?.trim();
    const kit = sharedKit(common);
    file = kit && path.join(kit, 'scripts/kit-hook.mjs');
    // Only the events that may speak clone; the others stay silent without a kit.
    const cloneError = file && !existsSync(file) && start ? cloneKit(kit) : '';
    if (!file || !existsSync(file)) {
      if (start) console.log(JSON.stringify({ systemMessage: `The shared Workflow Kit checkout is missing and could not be cloned${cloneError ? `: ${cloneError}` : ' (offline?)'}. Clone https://github.com/snagg-app/workflow-kit.git to a folder named workflow-kit next to the project, or set WORKFLOW_KIT_DIR.` }));
      if (link) process.exitCode = 1;
      return;
    }
    if (link) return linkNow(project, kit);
  }
  // #1022: a kit being updated by another session can be half old, half new; say so instead of ending without a word.
  return import(pathToFileURL(file).href).catch(error => {
    if (start) console.log(JSON.stringify({ systemMessage: `The Workflow Kit hook could not be loaded (${error.message.split('\n')[0]}). The kit may be updating in another session; start the session again.` }));
    else throw error;
  });
}

// Run only as the entry (the copy in the project), not when kit-check imports sharedKit.
const entry = process.argv[1] && (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
