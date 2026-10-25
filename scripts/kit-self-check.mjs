// The two quick checks of `done` for the kit repository itself (#1046): a stale README command table and a new script without a row in affected-tests.mjs
// were found only by the kit CI. Projects that use the kit have neither file, so for them the checks do nothing. No tests run, no network.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { affectedTests } from './affected-tests.mjs';
import { renderReadme } from './board-readme.mjs';
import { gitIn } from './git-tool.mjs';

const git = gitIn();

/** True when `cwd` is the kit repository (it has the generator of its own README). */
const isKit = cwd => existsSync(resolve(cwd, 'scripts/board-readme.mjs'));

/** Null when all is well or `cwd` is no kit, else the message for `done`. `base` is the ref the PR is compared with. */
export function kitSelfCheck(cwd, base) {
  if (!isKit(cwd)) return null;
  const readme = git(cwd, 'show', 'HEAD:README.md').replaceAll('\r\n', '\n'); // the committed text (what the CI sees), line endings aside
  if (renderReadme(readme).trim() !== readme) return 'README.md does not match the board command descriptions: run `node scripts/board-readme.mjs`, commit the result, then run done again';
  const added = git(cwd, 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', `${base}...HEAD`).split('\0').filter(Boolean);
  const { unmapped } = affectedTests(added);
  if (unmapped.length) return `new ${unmapped.length === 1 ? 'script has' : 'scripts have'} no row in scripts/affected-tests.mjs (${unmapped.join(', ')}), so no test would be chosen for ${unmapped.length === 1 ? 'it' : 'them'}: add a row to TABLE there, commit, then run done again`;
  return null;
}
