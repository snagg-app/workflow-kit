// Zweck: Die eine Stelle, die das gemeinsame Kit findet und notfalls klont; zugleich der kleine Einstieg der Hook-Einträge im Projekt.
// Aufruf: `kit setup` kopiert diese Datei nach .agents/workflow-kit-hook.mjs; die Hook-Einträge rufen `node <Datei> <Event> --agent <Agent>`.
//         Der erste Befehl im frischen Worktree (auch ohne Hooks): `node .agents/workflow-kit-hook.mjs link` verknüpft `.vendor/workflow-kit` (#896).
// Nutzen: Fehlt das Kit, fehlt auch kit-hook.mjs; dieser Einstieg braucht nur Node und klont dann selbst, statt dass drei Shells es nachbauen.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
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
  { cwd: tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 90_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' } });

/** `link`: the one first command of a fresh worktree; reports what is in order or what needs a human. */
async function linkNow(project, kit) {
  const root = git('-C', project, 'rev-parse', '--show-toplevel').stdout.trim() || project;
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
    const common = git('-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim();
    const kit = sharedKit(common);
    file = kit && path.join(kit, 'scripts/kit-hook.mjs');
    // Only the events that may speak clone; the others stay silent without a kit.
    if (file && !existsSync(file) && start) git('clone', '--quiet', kitUrl, kit);
    if (!file || !existsSync(file)) {
      if (start) console.log(JSON.stringify({ systemMessage: 'The shared Workflow Kit checkout is missing and could not be cloned (offline?). Clone https://github.com/snagg-app/workflow-kit.git to a folder named workflow-kit next to the project, or set WORKFLOW_KIT_DIR.' }));
      if (link) process.exitCode = 1;
      return;
    }
    if (link) return linkNow(project, kit);
  }
  return import(pathToFileURL(file).href);
}

// Run only as the entry (the copy in the project), not when kit-check imports sharedKit.
const entry = process.argv[1] && (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
