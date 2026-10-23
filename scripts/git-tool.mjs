// Zweck: Die eine Stelle, die git für Kit-Skripte und Hooks startet (immer ein git außerhalb des Checkouts, #758, #796).
// Aufruf: const git = gitIn({ timeout, env }, ...pfade); git(ordner, ...argumente) liefert die Ausgabe oder wirft; gitResultIn liefert Status und Fehlerausgabe, gitAsyncIn läuft parallel.
// Nutzen: Ein Checkout kann kein eigenes git unterschieben; Hooks, Kit-Prüfung, Einrichtung, Board und Test-Auswahl nutzen denselben Weg.
import { execFile } from 'node:child_process';
import { externalToolIn } from './checkout-root.mjs';
import { runProgram } from './run-program.mjs';

/** Looks git up on first use per `dir`, outside the checkouts of `paths`, the working directory and `dir`: a command without git never needs one and a checkout cannot substitute it. */
function lookup(paths, from) {
  const tools = new Map();
  return dir => {
    if (!tools.has(dir)) tools.set(dir, externalToolIn(from, 'git', process.cwd(), ...paths, dir));
    return tools.get(dir);
  };
}

const spawnOptions = (tool, env, timeout) => ({ encoding: 'utf8', env: { ...tool.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, maxBuffer: 1 << 28 });

/**
 * A git runner `(dir, ...args) => stdout` (trimmed unless `-z`; throws like execFileSync).
 * `options`: `timeout` and extra `env` for every call (a value of `undefined` removes a variable); `from`: the environment that finds git (default: the process's). The runner is passed around, never installed globally.
 */
export function gitIn({ timeout, env, from = process.env } = {}, ...paths) {
  const tool = lookup(paths, from);
  return (dir, ...args) => {
    const output = runProgram(tool(dir).file, ['-C', dir, ...args], spawnOptions(tool(dir), env, timeout));
    return args.includes('-z') ? output : output.trim();
  };
}

/** For callers that need more than the output: `{ status, stdout, stderr }`, no throw on a non-zero exit (`status` null and `error` set when git did not run, e.g. a timeout). */
export function gitResultIn({ timeout, env, from = process.env } = {}, ...paths) {
  const tool = lookup(paths, from);
  return (dir, ...args) => {
    const found = tool(dir); // a missing git throws here, never as a result
    try {
      return { status: 0, stdout: runProgram(found.file, ['-C', dir, ...args], spawnOptions(found, env, timeout)), stderr: '' };
    } catch (error) {
      return { status: error.status ?? null, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), error: error.status == null ? error : undefined };
    }
  };
}

/** The same lookup for many calls at once: `(dir, ...args) => Promise<{ ok, out }>`, no throw. */
export function gitAsyncIn({ timeout, env, from = process.env } = {}, ...paths) {
  const tool = lookup(paths, from);
  return (dir, ...args) => new Promise(done => {
    const found = tool(dir);
    execFile(found.file, ['-C', dir, ...args], { ...spawnOptions(found, env, timeout), stdio: undefined },
      (error, stdout) => done({ ok: !error, out: stdout ?? '' }));
  });
}

/** For a check that may pull: never prompt, never wait long (the host kills a hook after 120 seconds). */
export const patient = { timeout: 40_000, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' } };

/** The same runner for callers that only ask: `{ ok, out }`, no throw (git missing, not a repository, failed command). */
export const asking = git => (dir, ...args) => {
  try { return { ok: true, out: git(dir, ...args) }; } catch { return { ok: false, out: '' }; }
};
