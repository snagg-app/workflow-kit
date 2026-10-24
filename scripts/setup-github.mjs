import { enterCwd, projectRoot } from './checkout-root.mjs';
import { setupBoard, setupGithub } from './github-board.mjs';
import { isMain } from './is-main.mjs';

const usage = 'Usage: node <kit>/scripts/setup-github.mjs [--cwd PROJECT_DIR] OWNER/REPO [PROJECT_NUMBER]';

if (isMain(import.meta.url)) {
  enterCwd();
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage); process.exit(0); }
  const [repo, requestedNumber] = args;
  // Only plain names and numbers reach gh: no argument can smuggle in options.
  if (args.length > 2 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || (requestedNumber !== undefined && !/^\d+$/.test(requestedNumber))) {
    console.error(usage);
    process.exit(2);
  }
  let root;
  try { root = projectRoot(); } catch (error) { console.error(error.message); process.exit(2); }
  const github = setupGithub(root);
  const result = setupBoard({ root, github, repo, number: requestedNumber });
  if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
  console.log(result.text);
}
