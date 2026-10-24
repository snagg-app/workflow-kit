// Helpers for the slow, Git-heavy tests. Each test works in its own temporary directory, never in the
// checkout that runs the suite (its .git/modules), so concurrent runs and concurrent tests do not interfere (#207).
// Scenarios that do not share state run side by side (#239): child processes are the cost, not the code.
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Git for Windows stops at 260 characters; the long TEMP of an agent session pushes the clones of these fixtures
// past it (#370). Every Git child of the tests inherits the setting.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true' });
// Other Windows tools (cmd, PowerShell Add-Type, git's loose objects) stop there too, so the tests and their
// children also work in the short default temp directory instead of the agent session's long one (#373).
if (process.platform === 'win32' && process.env.LOCALAPPDATA) process.env.TEMP = process.env.TMP = join(process.env.LOCALAPPDATA, 'Temp');

/** spawnSync's result shape for an asynchronous child. stdin is closed at once, as spawnSync does without input. */
export const run = (file, args = [], { input, ...options } = {}) => new Promise(resolve => {
  const child = execFile(file, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...options }, (error, stdout, stderr) =>
    resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr, error }));
  child.stdin.on('error', () => {}); // a child that exits without reading its input is no error, as with spawnSync
  child.stdin.end(input);
});

/** Waits until the hook's background installer is over: `installed()` is true and neither function's lock shows on two looks 300 ms apart (they run one after the other). */
export async function installersDone(home, timeout, installed = () => true) {
  const busy = () => !installed() || ['.ponytail/workflow-kit/.ponytail.lock', '.impeccable/workflow-kit/.impeccable.lock'].some(lock => existsSync(join(home, lock)));
  for (let quiet = 0, waited = 0; quiet < 2; waited += 300) {
    if (waited >= timeout) throw new Error(`The hook installer was not done after ${timeout} ms`);
    await new Promise(resolve => setTimeout(resolve, 300));
    quiet = busy() ? 0 : quiet + 1;
  }
}

/** A temporary directory that is removed with the test. */
export function temporary(t, name) {
  const path = mkdtempSync(join(tmpdir(), name));
  // A detached hook installer may still have its working directory in here for a moment; Windows refuses to remove it until it ends.
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }));
  return path;
}

/** Environment for Git children that read neither the user's nor the system's configuration. */
export function isolatedGit(dir) {
  const global = join(dir, 'isolated.gitconfig');
  writeFileSync(global, '');
  return { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
}

const kit = fileURLToPath(new URL('../../', import.meta.url));

/** Tests that clone the pinned vendor sources call this first: a fresh clone has them empty, and Git would fail
 * deep inside a test with "does not appear to be a git repository" (#229). One line, no stack trace. */
const uninitialized = root => execFileSync('git', ['ls-files', '-s', '--', '.vendor'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean).map(line => line.split(/\s+/)[3]).find(path => !existsSync(join(root, path, '.git')));

/** The `skip` option for tests that need the pinned vendor sources: a named reason locally, never in CI (#416),
 * where a missing submodule must stay red. */
export const skipWithoutSubmodules = (root = kit) => {
  const path = !process.env.CI && uninitialized(root);
  return path ? `${path} nicht initialisiert (git submodule update --init --recursive)` : false;
};

export function requireSubmodules(root = kit) {
  if (!uninitialized(root)) return;
  writeSync(2, 'run: git submodule update --init --recursive\n');
  process.exit(1);
}

/** Copies this checkout's `scripts/` without `tests/` to `<kitDir>/scripts`: a new import between scripts needs no list (#888). */
export const copyKitScripts = kitDir => cpSync(join(kit, 'scripts'), join(kitDir, 'scripts'), { recursive: true, filter: source => basename(source) !== 'tests' });

/** A throwaway kit for scripts that write to the kit they live in (`git submodule update --init` registers
 * submodules in its .git): this checkout's scripts and data, its pinned vendor sources as shared clones,
 * and a Git repository of its own. The suite's own checkout and its .git/modules stay untouched. */
export function kitCheckout(t) {
  requireSubmodules();
  const root = temporary(t, 'kit checkout ');
  const env = isolatedGit(root);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(root, 'init', '-q');
  for (const path of ['.gitattributes', '.gitmodules', 'AGENT_RULES.md', '.agents/skills/find-skills', '.agents/skills/spec-review', 'templates'])
    cpSync(join(kit, path), join(root, path), { recursive: true });
  copyKitScripts(root);
  for (const line of git(kit, 'ls-files', '-s', '--', '.vendor').split('\n')) {
    const [mode, sha, , path] = line.split(/\s+/);
    git(root, '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--shared', join(kit, path), join(root, path));
    git(root, 'update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`);
  }
  return root;
}
