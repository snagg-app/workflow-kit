import { realpathSync } from 'node:fs';
import { setupBoard, setupGithub } from './github-board.mjs';

const [repo, requestedNumber] = process.argv.slice(2);
// Only plain names and numbers reach gh: no argument can smuggle in options.
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || (requestedNumber !== undefined && !/^\d+$/.test(requestedNumber))) {
  console.error('Usage: node setup-github.mjs OWNER/REPO [PROJECT_NUMBER]');
  process.exit(2);
}
const root = realpathSync(process.cwd());
const github = setupGithub(root);
const result = setupBoard({ root, github, repo, number: requestedNumber });
if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
console.log(result.text);
