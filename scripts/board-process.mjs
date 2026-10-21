// Process-level helpers of the board: git in the project's checkout, a blocking pause and the shell commands of the project file.
// Every git call of a command goes through `git` here, so the git rules of `start` and `done` can move into one module (#686).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { externalTool } from './checkout-root.mjs';

/** env: { projectDirectory } */
export function createProcess({ projectDirectory }) {
  const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

  /**
   * git in the project's checkout (--cwd, else the working directory); looked up on use, so commands without git never need one.
   * Worktrees of one clone share their remote refs: a `fetch` that meets another's lock on a ref ("cannot lock ref", #566) is repeated
   * after a second, three tries in all; any other failure stays one at once.
   */
  function git(...args) {
    const tool = externalTool('git', process.cwd(), projectDirectory);
    for (let attempt = 1; ; attempt++) {
      try {
        const output = execFileSync(tool.file, ['-C', projectDirectory, ...args], { encoding: 'utf8', env: tool.env, stdio: ['ignore', 'pipe', 'pipe'] });
        return args.includes('-z') ? output : output.trim();
      } catch (error) {
        if (args[0] !== 'fetch' || attempt === 3 || !/cannot lock ref|unable to update local ref/.test(String(error.stderr || error.message))) throw error;
        sleep(1);
      }
    }
  }

  /** The commit the project's checkout (--cwd, else the working directory) has checked out: what `done` expects the PR to show. */
  function localHead() {
    try {
      return git('rev-parse', 'HEAD');
    } catch (error) {
      console.error(`ready --local cannot read the head of ${projectDirectory}: ${String(error.stderr || error.message).trim()}`);
      process.exit(2);
    }
  }

  /** One shell command of the project file in `cwd`, output passed through; throws on a non-zero exit. `execPath` is `git --exec-path`. */
  function runShell(execPath, cwd, command, env) {
    const bash = process.platform === 'win32' ? resolve(execPath, '..', '..', '..', 'bin', 'bash.exe') : '/bin/bash';
    execFileSync(bash, ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true, timeout: 30 * 60_000 });
  }

  return { git, localHead, sleep, runShell };
}
