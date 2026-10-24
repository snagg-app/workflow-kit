// Fail when a branch's .gitmodules names other submodule sources than main's. The Renovate regenerate workflow runs this
// before fetching any submodule: a branch that points a submodule at another repository would otherwise get that
// repository's files turned into generated hooks.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { gitResultIn } from './git-tool.mjs';
import { isMain } from './is-main.mjs';

/** The `submodule.<name>.url <url>` lines of a .gitmodules file, sorted; no submodule at all is an empty list. */
export function submoduleSources(file) {
  const result = gitResultIn()(dirname(resolve(file)), 'config', '--file', resolve(file), '--get-regexp', '^submodule\\..*\\.url$');
  if (result.status === 1) return []; // git config: no match
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).sort();
}

/** Same submodules with the same URLs; other settings (branch, path of a tag) may differ, Renovate moves them. */
export function checkSubmoduleSources(branchFile, mainFile) {
  assert.deepEqual(submoduleSources(branchFile), submoduleSources(mainFile), '.gitmodules names other submodule sources than main; not fetching them.');
}

if (isMain(import.meta.url)) {
  try { checkSubmoduleSources('.gitmodules', process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
