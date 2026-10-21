// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: board.mjs start | done | next | sweep | field | new | block | sub | wait | quota-wait | merge | stack-sync | body | body-replace (see usage in board-args.mjs).
// `--cwd PATH` as the first argument runs it for the project in PATH from any directory: without it the
// working directory decides the project, and a driver in another project would read and write the wrong board.
// This file only translates the call: it reads the project, checks the arguments and runs one command. Each command is a module
// `board-<name>.mjs` with a factory `createX(env)` that runs nothing when imported; the modules reach each other through `env.later`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { externalTool, projectRoot, takeCwd } from './checkout-root.mjs';
import { statusNames, textsFor } from './project-profile.mjs';
import { createGithub } from './github.mjs';
import { createArgs } from './board-args.mjs';
import { createProcess } from './board-process.mjs';
import { createCommon } from './board-common.mjs';
import { createClaims } from './board-claims.mjs';
import { createCheck } from './board-check.mjs';
import { createSweep } from './board-sweep.mjs';
import { createNext } from './board-next.mjs';
import { createStack } from './board-stack.mjs';
import { createFields } from './board-fields.mjs';
import { createNew } from './board-new.mjs';
import { createBody } from './board-body.mjs';
import { createHandoff } from './board-handoff.mjs';
import { createWait } from './board-wait.mjs';
import { createBlock } from './board-block.mjs';
import { createStart } from './board-start.mjs';
import { createDone } from './board-done.mjs';
import { createReviews } from './board-reviews.mjs';
import { createMerge } from './board-merge.mjs';

// Taken off here: the commands below read their arguments by position.
// A subfolder of the checkout (or of --cwd) works like its root: the project file is found there.
const startDirectory = takeCwd();
let projectDirectory;
try { projectDirectory = projectRoot(startDirectory); } catch (error) {
  // Only the two expected misses get a short line; any other failure (EACCES, ELOOP) keeps its own message.
  const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
  if (!missing && error.code !== 'ERR_ASSERTION') throw error;
  console.error(`${startDirectory}: ${missing ? 'is not a directory' : 'is not inside a Git checkout'}`);
  process.exit(2);
}
// `--issue-repo OWNER/NAME` (start, done), anywhere in the arguments: the issue lives in that repository and on its board (a kit issue fixed in
// the project); PR, branch and tests stay in the project's. Taken off here like --cwd, so the commands read their arguments by position.
const issueRepoAt = process.argv.indexOf('--issue-repo');
const issueRepoOption = issueRepoAt < 0 ? undefined : process.argv.splice(issueRepoAt, 2)[1];
const [command, ref, typed] = process.argv.slice(2);
const projectFile = join(projectDirectory, '.github/workflow-project.json');
if (!existsSync(projectFile)) {
  console.error(`${projectFile} is missing: run board.mjs inside the project, or name it with --cwd PROJECT_DIR`);
  process.exit(2);
}
const project = JSON.parse(readFileSync(projectFile, 'utf8'));
const [owner, name] = project.repository.split('/');
// The repository and board of the issue: the project's own unless --issue-repo names another one (read once by useIssueRepo, before start and done).
let issueProject = project, [issueOwner, issueName] = [owner, name];
// The status names of the issue's board and the texts written into issues and PRs (`statuses`, `language` in the project file).
let statuses = statusNames(project);
const texts = textsFor(project);
// `new` has no issue yet and assigns the number it creates.
const number = Number(String(ref).replace(/^#/, ''));
const gh = externalTool('gh', process.cwd(), projectDirectory);
const { git, localHead, sleep, runShell } = createProcess({ projectDirectory });

// The first argument after the PR; `ready PR --local` (the step `done` takes) reads the head from the checkout, so a shell never has to splice `$(git rev-parse HEAD)` into the call.
// The PR must still show exactly that head before it is marked ready, so a commit that was not pushed is refused like a mistyped id.
const value = command === 'ready' && typed === '--local' && Number.isSafeInteger(number) ? localHead() : typed;

const startedAt = Date.now();
const github = createGithub({ tool: gh, command, projectDirectory, sleep });
const { graphql, rest, restAll } = github;

const commandNames = ['start', 'done', 'next', 'sweep', 'check', 'block', 'sub', 'field', 'new', 'reviews', 'wait', 'quota-wait', 'handoff', 'merge', 'stack-sync', 'ready', 'link', 'body', 'body-replace'];
const { validate, options } = createArgs({ project, command, number, value, issueRepoAt, issueRepoOption, commandNames });
validate();

/** The issue lives in another repository when --issue-repo says so: its board and statuses replace the project's (read once, before the modules are made). */
function useIssueRepo() {
  if (issueRepoOption === undefined || issueRepoOption.toLowerCase() === project.repository.toLowerCase()) return;
  const file = rest(`repos/${issueRepoOption}/contents/.github/workflow-project.json`);
  assert.equal(file?.encoding, 'base64', `.github/workflow-project.json of ${issueRepoOption} is unreadable`);
  issueProject = { ...JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), repository: issueRepoOption };
  [issueOwner, issueName] = issueRepoOption.split('/');
  statuses = statusNames(issueProject);
}

// field and new report a failure as one "ERROR - reason" line: their output (verdicts, backlinks, confirmations)
// is held until the command succeeds, so no failed call shows a write or a check as confirmed. The other commands keep ERROR
// with "- reason" below it.
const oneLine = ['field', 'new'].includes(command), print = console.log, held = [];
if (oneLine) console.log = (...parts) => held.push(parts.join(' '));
let quotaLine = () => undefined;
try {
  if (['start', 'done'].includes(command)) useIssueRepo();
  // What commands hand to each other during one run: the PR `done` works on (`value`: the steps it calls read their PR where a called `handoff` reads its argument),
  // the base PR of the issue the last `check` judged STACKABLE (`stackedOn`: handoff compares it with the PR's base branch), a PR that only says "Refs #N"
  // (no native closer) which `start --takeover` finds (`adoptedPr`, #649), and the [PR, ...OTHER_ISSUE] `done` knows (`delivered`; else they follow "Automated review" on the command line).
  const state = { value, stackedOn: undefined, adoptedPr: undefined, delivered: undefined };
  // The commands call each other by name, when they run; every module adds its functions here.
  const registry = {};
  const later = new Proxy(registry, { get: (target, key) => (...parts) => target[key](...parts) });
  const shared = { project, owner, name, number, command, github, graphql, rest, restAll, gh, projectDirectory, issueProject, issueOwner, issueName, statuses, texts,
    startedAt, state, git, localHead, sleep, runShell, ...options, later };
  const common = createCommon(shared);
  const env = { ...shared, ...common };
  quotaLine = common.quotaLine;
  for (const create of [createClaims, createCheck, createSweep, createNext, createStack, createFields, createNew, createBody, createHandoff, createWait, createBlock, createStart, createDone]) {
    Object.assign(registry, create(env));
  }
  // The review gate and the merge live in their own modules.
  Object.assign(registry, createReviews({ project, owner, name, github, number, graceMinutes: options.graceOption, prQuery: common.prQuery, readStacks: later.readStacks,
    stackOrderText: common.stackOrderText, conflictLine: later.conflictLine }));
  Object.assign(registry, createMerge({ project, owner, name, github, projectDirectory, number, stack: options.stack, stackState: registry.stackState, numberOption: options.numberOption,
    sleep, readyQuery: common.readyQuery, dependentPrs: later.dependentPrs, runShell, mergeGate: later.mergeGate, stackReasons: later.stackReasons, reviewsForHead: later.reviewsForHead,
    poll: later.poll, readPr: later.readPr, baseMovement: later.baseMovement, filesText: later.filesText }));
  // check, reviews, handoff, ready and link are the steps `start` and `done` take; they stay callable for those two and for the tests, but nobody runs them by hand, so the usage leaves them out.
  const commands = { start: registry.start, done: registry.done, next: registry.next, sweep: registry.sweep, check: () => registry.check(common.readIssue(true), { session: options.sessionOption() }),
    block: registry.block, sub: registry.sub, field: registry.setField, new: registry.create, reviews: registry.reviewsOnce, wait: registry.wait, 'quota-wait': registry.quotaWait,
    handoff: registry.handoff, merge: registry.merge, 'stack-sync': registry.stackSync, ready: registry.ready, link: registry.link, body: registry.body, 'body-replace': registry.bodyReplace };
  await commands[command]();
  console.log = print;
  for (const line of held) print(line);
} catch (error) {
  console.log = print;
  // A failed read is never "no blockers" and never a finished review.
  if (!commandNames.filter(known => !['next', 'sweep', 'block', 'sub'].includes(known)).includes(command)) throw error;
  const message = String(error.stderr || error.message).trim();
  console.log(oneLine ? `ERROR - ${message.replace(/\s*\n\s*/g, ' ')}` : `${command === 'check' ? 'UNKNOWN' : 'ERROR'}\n- ${message}`);
  process.exitCode = 2;
} finally {
  // Waiting commands already print their quota with the verdict; all other commands need the same evidence, also on failure.
  const alreadyPrintedQuota = ['reviews', 'wait', 'quota-wait'].includes(command)
    || (process.exitCode === 4 && ['handoff', 'merge'].includes(command));
  if (github.quota && (process.exitCode === 2 || !alreadyPrintedQuota)) console.error(quotaLine());
}
