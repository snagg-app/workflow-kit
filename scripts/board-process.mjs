// Process-level helpers of the board: a blocking pause and the shell commands of the project file. Git lives in board-checkout.mjs.
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, resolve } from 'node:path';

let adapter; // (file, args, options) => stdout, like execFileSync; unset means the real process
/** A test sets the test variant (board-worker.mjs), like useGhAdapter: no test patches child_process. */
export const useProcessAdapter = fake => { adapter = fake; };

/** The one door for the board's own child processes (git, the targeted tests, the project file's shell); options as for execFileSync. */
export const runProgram = (file, args, options) => (adapter ?? execFileSync)(file, args, options);

export function createProcess() {
  const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

  /** One shell command of the project file in `cwd`, output passed through; throws on a non-zero exit. `execPath` is `git --exec-path`. */
  function runShell(execPath, cwd, command, env) {
    const bash = process.platform === 'win32' ? resolve(execPath, '..', '..', '..', 'bin', 'bash.exe') : '/bin/bash';
    // The setup installs dependencies (npm ci): it must use the Node of this process, which the agent's tests use too, not whichever Node the shell finds first.
    const merged = { ...process.env, ...env }, key = Object.keys(merged).find(name => name.toLowerCase() === 'path') ?? 'PATH';
    merged[key] = [dirname(process.execPath), merged[key]].filter(Boolean).join(delimiter);
    runProgram(bash, ['-c', command], { cwd, env: merged, stdio: 'inherit', windowsHide: true, timeout: 30 * 60_000 });
  }

  return { sleep, runShell };
}
