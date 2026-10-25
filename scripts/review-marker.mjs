// The review proof of `done` (#1036, #1042): the skill `code-review` runs `node scripts/review-marker.mjs` after its review and writes the reviewed head
// into the git dir (no GraphQL, no comment). `done` reads it when the PR changes a path the project lists in `reviewRequiredPaths`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitIn } from './git-tool.mjs';
import { isMain } from './is-main.mjs';

/** Without `reviewRequiredPaths` in the project profile: the database migrations of #1036. */
export const defaultReviewPaths = ['**/db/migration/**'];

const git = gitIn();
const markerFile = cwd => resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'board-code-review'));
const escape = text => text.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
// `**/` is any directories (none included), `**` anything, `*` a name part.
const glob = pattern => new RegExp('^' + pattern.split('**/').map(part => part.split('**').map(rest => rest.split('*').map(escape).join('[^/]*')).join('.*')).join('(.*/)?') + '$');

/**
 * Null when the review is not required or proven, else the message for `done`. Required: the diff against the base changes a file that matches one of `patterns`.
 * Proven: the marker names a commit that is an ancestor of HEAD and no such file differs between it and HEAD (a later fix elsewhere needs no second review).
 */
export function missingReview(cwd, base, patterns) {
  const matchers = patterns.map(pattern => glob(pattern.trim()));
  const paths = (...range) => git(cwd, 'diff', '--name-only', '-z', '--no-renames', ...range).split('\0').filter(path => matchers.some(matcher => matcher.test(path))); // -z: no quoted names
  const changed = paths(`${base}...HEAD`);
  if (!changed.length) return null;
  const file = markerFile(cwd);
  const reviewed = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  try {
    git(cwd, 'merge-base', '--is-ancestor', reviewed, 'HEAD');
    // Only files the PR itself changed count: a base merged in after the review may touch such paths without the PR doing so.
    if (!paths(reviewed, 'HEAD').some(path => changed.includes(path))) return null;
  } catch { /* no marker, or a commit this branch does not have */ }
  return `the PR changes a path that needs a review (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}; "reviewRequiredPaths" in .github/workflow-project.json) and no code-review covers this head: run the skill code-review against ${base} (Standards, Spec, Failure paths), fix or justify each finding, let it run \`node <kit>/scripts/review-marker.mjs\` for the head, then run done again`;
}

if (isMain(import.meta.url)) { // real paths: a start through the .vendor link must match too (#1049)
  const cwd = process.cwd();
  writeFileSync(markerFile(cwd), git(cwd, 'rev-parse', 'HEAD'));
  console.log(`code-review recorded for ${git(cwd, 'rev-parse', '--short', 'HEAD')}`);
}
