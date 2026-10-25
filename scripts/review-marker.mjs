// The review proof of `done` (#1036): the skill `code-review` runs `node scripts/review-marker.mjs` after its review and writes the reviewed head
// into the git dir (no GraphQL, no comment). `done` reads it when the PR changes a database migration.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIn } from './git-tool.mjs';

const MIGRATION = /(^|\/)db\/migration\//;
const git = gitIn();
const markerFile = cwd => resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'board-code-review'));

/**
 * Null when the review is not required or proven, else the message for `done`. Required: the diff against the base changes a file under db/migration.
 * Proven: the marker names a commit that is an ancestor of HEAD and no migration file differs between it and HEAD (a later fix elsewhere needs no second review).
 */
export function missingMigrationReview(cwd, base) {
  const paths = (...range) => git(cwd, 'diff', '--name-only', '-z', '--no-renames', ...range).split('\0').filter(path => MIGRATION.test(path)); // -z: no quoted names
  const changed = paths(`${base}...HEAD`);
  if (!changed.length) return null;
  const file = markerFile(cwd);
  const reviewed = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  try {
    git(cwd, 'merge-base', '--is-ancestor', reviewed, 'HEAD');
    if (!paths(reviewed, 'HEAD').length) return null;
  } catch { /* no marker, or a commit this branch does not have */ }
  return `the PR changes a database migration (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}) and no code-review covers this head: run the skill code-review against ${base} (Standards, Spec, Failure paths), fix or justify each finding, let it run \`node <kit>/scripts/review-marker.mjs\` for the head, then run done again`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd();
  writeFileSync(markerFile(cwd), git(cwd, 'rev-parse', 'HEAD'));
  console.log(`code-review recorded for ${git(cwd, 'rev-parse', '--short', 'HEAD')}`);
}
