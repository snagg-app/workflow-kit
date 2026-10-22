// Process-level helpers of the board: a blocking pause and the shell commands of the project file. Git lives in board-checkout.mjs.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export function createProcess() {
  const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

  /** One shell command of the project file in `cwd`, output passed through; throws on a non-zero exit. `execPath` is `git --exec-path`. */
  function runShell(execPath, cwd, command, env) {
    const bash = process.platform === 'win32' ? resolve(execPath, '..', '..', '..', 'bin', 'bash.exe') : '/bin/bash';
    execFileSync(bash, ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true, timeout: 30 * 60_000 });
  }

  return { sleep, runShell };
}
