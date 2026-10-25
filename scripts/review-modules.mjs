// #1055: a change across modules needs a review although none of its files is in `reviewRequiredPaths` (a shared contract plus its adapters).
import { gitIn } from './git-tool.mjs';

const git = gitIn();
const reviewModuleLimit = 3;

/**
 * Path patterns for `missingReview`: the changed files inside modules when the diff against `base` touches at least `reviewModuleLimit` of them, else none.
 * A module is a direct subfolder of one of the `roots` (the profile's "reviewModuleRoots", for example "backend" or "backend/adapters").
 */
export function moduleReviewPaths(cwd, base, roots) {
  if (!roots.length) return [];
  // Longest root first: with "backend" and "backend/adapters", a file in an adapter belongs to that adapter, not to the module "backend/adapters".
  const prefixes = roots.map(root => root.trim().replace(/^\.?\/+|\/+$/g, '') + '/').sort((a, b) => b.length - a.length);
  const inModules = git(cwd, 'diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`).split('\0').flatMap(path => {
    const prefix = prefixes.find(candidate => path.startsWith(candidate));
    const [folder, ...rest] = prefix ? path.slice(prefix.length).split('/') : [];
    return rest.length ? [{ path, folder: prefix + folder }] : []; // a file directly in a root is no module
  });
  return new Set(inModules.map(({ folder }) => folder)).size < reviewModuleLimit ? [] : inModules.map(({ path }) => path); // a path is its own pattern (missingReview escapes it)
}
