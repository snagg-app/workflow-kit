import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';

// Reuse the installer's ancestor check without executing an untrusted Git first.
// An enclosing checkout also owns sibling tools outside a nested submodule.
export function checkoutRoot(path) {
  let checkout = realpathSync.native(path);
  for (let ancestor = dirname(checkout);; ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, '.git'))) checkout = ancestor;
    if (dirname(ancestor) === ancestor) return checkout;
  }
}

/** Takes `--cwd PROJECT_DIR`, at any position, off `argv` and returns the directory ('.' without the option),
 * so a driver can run a kit command for another clone without `cd`. The one path a command takes from its arguments. */
export function takeCwd(argv = process.argv) {
  const at = argv.indexOf('--cwd', 2);
  if (at < 0) return '.';
  if (argv.indexOf('--cwd', at + 1) >= 0) {
    console.error('--cwd given twice');
    process.exit(2);
  }
  const directory = argv.splice(at, 2)[1];
  if (!directory || directory.startsWith('--')) {
    console.error('--cwd needs the directory of the project');
    process.exit(2);
  }
  return directory;
}

/** Makes the `--cwd` directory (if given) the working directory, which every command below treats as its project. */
export function enterCwd() {
  const directory = takeCwd();
  try { process.chdir(directory); } catch {
    console.error(`--cwd ${directory} is not a directory`);
    process.exit(2);
  }
}

/** The Git checkout containing `start` (default: the working directory, which `--cwd` sets): kit commands act on the project
 * they run in, never on any other path taken from their arguments. A submodule's `.git` file ends the search there. */
export function projectRoot(start = process.cwd()) {
  for (let directory = realpathSync.native(start);; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return directory;
    assert.notEqual(dirname(directory), directory, 'Run this command inside a Git checkout');
  }
}

/** Resolve an installed CLI (git, gh) outside every checkout containing `paths`, so a checkout
 * cannot substitute it. The returned environment keeps only such PATH entries and stops Windows
 * from searching the working directory first. */
export function externalTool(name, ...paths) {
  // Windows paths compare case-insensitively; don't rely on realpath returning one casing.
  const fold = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const checkouts = paths.map(path => fold(checkoutRoot(path)));
  const outside = path => checkouts.every(base => fold(path) !== base && !fold(path).startsWith(base + sep));
  const directories = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
    .filter(path => existsSync(path) && outside(realpathSync.native(path)));
  const file = directories.map(path => join(path, process.platform === 'win32' ? `${name}.exe` : name))
    .filter(existsSync).map(path => realpathSync.native(path)).find(outside);
  assert.ok(file, `Install ${name} outside the checkout on an absolute PATH`);
  return { file, env: { ...process.env, PATH: directories.join(delimiter), NoDefaultCurrentDirectoryInExePath: '1' } };
}
