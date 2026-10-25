// #1055: a change across modules needs a review although none of its files is in `reviewRequiredPaths` (a shared contract plus its adapters).
import { gitIn } from './git-tool.mjs';

const git = gitIn();
export const reviewModuleLimit = 3;

/**
 * Path patterns for `missingReview`: the changed files inside modules when the diff against `base` touches at least `reviewModuleLimit` of them, else none.
 * A module is a direct subfolder of one of the `roots` (the profile's "reviewModuleRoots", for example "backend" or "backend/adapters").
 */
export function moduleReviewPaths(cwd, base, roots) {
  if (!roots.length) return [];
  const prefixes = roots.map(root => root.trim().replace(/^\.?\/+|\/+$/g, '') + '/');
  const inModules = git(cwd, 'diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`).split('\0').flatMap(path => {
    const prefix = prefixes.find(candidate => path.startsWith(candidate));
    const module = prefix && path.slice(prefix.length).split('/').length > 1 ? prefix + path.slice(prefix.length).split('/')[0] : null;
    return module ? [{ path, module }] : [];
  });
  return new Set(inModules.map(({ module }) => module)).size < reviewModuleLimit ? [] : inModules.map(({ path }) => path); // a path is its own pattern (missingReview escapes it)
}
