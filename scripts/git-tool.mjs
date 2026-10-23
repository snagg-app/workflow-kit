// Zweck: Die eine Stelle, die git für Kit-Skripte und Hooks startet (immer ein git außerhalb des Checkouts, #758).
// Aufruf: const git = gitIn({ timeout, env }, ...pfade); git(ordner, ...argumente) liefert die Ausgabe oder wirft.
// Nutzen: Ein Checkout kann kein eigenes git unterschieben; Hooks, Kit-Prüfung, Einrichtung und Board nutzen denselben Weg.
import { runProgram } from './board-process.mjs';
import { externalTool } from './checkout-root.mjs';

/**
 * A git runner `(dir, ...args) => stdout` (trimmed unless `-z`; throws like execFileSync). The program is looked up on first use per `dir`,
 * outside the checkouts of `paths`, the working directory and `dir`, so a command without git never needs one and a checkout cannot substitute it.
 * `options`: `timeout` and extra `env` for every call. The runner is passed around, never installed globally.
 */
export function gitIn({ timeout, env } = {}, ...paths) {
  const tools = new Map();
  return (dir, ...args) => {
    if (!tools.has(dir)) tools.set(dir, externalTool('git', process.cwd(), ...paths, dir));
    const tool = tools.get(dir);
    const output = runProgram(tool.file, ['-C', dir, ...args],
      { encoding: 'utf8', env: { ...tool.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, maxBuffer: 1 << 28 });
    return args.includes('-z') ? output : output.trim();
  };
}

/** For a check that may pull: never prompt, never wait long (the host kills a hook after 120 seconds). */
export const patient = { timeout: 40_000, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' } };

/** The same runner for callers that only ask: `{ ok, out }`, no throw (git missing, not a repository, failed command). */
export const asking = git => (dir, ...args) => {
  try { return { ok: true, out: git(dir, ...args) }; } catch { return { ok: false, out: '' }; }
};
