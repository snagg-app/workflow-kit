// Process-level helpers of the board: a blocking pause and the shell commands of the project file. Git lives in board-checkout.mjs.
import { delimiter, dirname, resolve } from 'node:path';
import { runProgram } from './run-program.mjs';

export function createProcess({ env: base = process.env } = {}) {
  const clockSleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
  // BOARD_SLEEP_SCALE (a number, default 1) shortens the fixed pauses of retries and head polls; the board tests set 0 so they do not wait in real time (#1067).
  // A wait for a point in time (the quota reset) uses `clockSleep` and is never scaled: shortened, it would ask GitHub in a tight loop.
  const scale = /^\d+(\.\d+)?$/.test(base.BOARD_SLEEP_SCALE ?? '') ? Number(base.BOARD_SLEEP_SCALE) : 1;
  const sleep = seconds => clockSleep(seconds * scale);

  /** One shell command of the project file in `cwd`, output passed through; throws on a non-zero exit. `execPath` is `git --exec-path`. */
  function runShell(execPath, cwd, command, env) {
    const bash = process.platform === 'win32' ? resolve(execPath, '..', '..', '..', 'bin', 'bash.exe') : '/bin/bash';
    // The setup installs dependencies (npm ci): it must use the Node of this process, which the agent's tests use too, not whichever Node the shell finds first.
    const merged = { ...base, ...env }, key = Object.keys(merged).find(name => name.toLowerCase() === 'path') ?? 'PATH';
    merged[key] = [dirname(process.execPath), merged[key]].filter(Boolean).join(delimiter);
    runProgram(bash, ['-c', command], { cwd, env: merged, stdio: 'inherit', windowsHide: true, timeout: 30 * 60_000 });
  }

  return { sleep, clockSleep, runShell };
}
