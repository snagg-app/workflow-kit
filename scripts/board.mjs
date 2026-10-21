// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: `board.mjs help` lists the commands, `board.mjs help COMMAND` shows one (derived from the descriptions in board-commands.mjs).
// `--cwd PATH` as the first argument runs it for the project in PATH from any directory: without it the
// working directory decides the project, and a driver in another project would read and write the wrong board.
// This file only translates the call: it reads the project, checks the arguments and runs one command. Each command is a module
// `board-<name>.mjs` with its description (`specs`) and a factory `createX(env)` that runs nothing when imported; the modules reach each other through `env.later`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { externalTool, projectRoot, takeCwd } from './checkout-root.mjs';
import { statusNames, textsFor } from './project-profile.mjs';
import { createGithub } from './github.mjs';
import { configError, createOptions, helpOf, listOf, parseArgs, usageOf } from './board-args.mjs';
import { commandSpecs } from './board-commands.mjs';
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

// Taken off here, so the parser sees the command first.
// A subfolder of the checkout (or of --cwd) works like its root: the project file is found there.
const startDirectory = takeCwd();
const call = process.argv.slice(2);
// `--issue-repo OWNER/NAME` may stand anywhere in the call (before the command too); the parser reads it after the command.
const issueRepoAt = call.indexOf('--issue-repo');
if (issueRepoAt >= 0) call.push(...call.splice(issueRepoAt, 2));
// Help reads nothing: not the project, not GitHub. `help COMMAND` and `COMMAND --help` show that one command, everything else the list.
if (call[0] === 'help' || call.includes('--help') || call.includes('-h')) {
  const target = commandSpecs.find(spec => spec.name === (call[0] === 'help' ? call[1] : call[0]));
  const unknown = call[0] === 'help' && call[1] !== undefined && !target;
  (unknown ? console.error : console.log)(unknown ? `unknown command "${call[1]}"\n${listOf(commandSpecs)}` : target ? helpOf(target) : listOf(commandSpecs));
  process.exit(unknown ? 2 : 0);
}
let projectDirectory;
try { projectDirectory = projectRoot(startDirectory); } catch (error) {
  // Only the two expected misses get a short line; any other failure (EACCES, ELOOP) keeps its own message.
  const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
  if (!missing && error.code !== 'ERR_ASSERTION') throw error;
  console.error(`${startDirectory}: ${missing ? 'is not a directory' : 'is not inside a Git checkout'}`);
  process.exit(2);
}
const command = call[0];
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
const commandNames = commandSpecs.map(spec => spec.name);
// A call the description does not allow ends here with the reason and the usage of that one command, before any read or write.
const parsed = parseArgs(commandSpecs, call, project);
const configProblem = parsed.args && configError(command, project);
if (configProblem) {
  console.error(configProblem);
  process.exit(2);
}
if (!parsed.args) {
  console.error([parsed.error, parsed.spec ? usageOf(parsed.spec) : listOf(commandSpecs)].filter(Boolean).join('\n'));
  process.exit(2);
}
const { spec, args } = parsed;
const options = createOptions({ project, args });
// `--issue-repo OWNER/NAME` (start, done): the issue lives in that repository and on its board (a kit issue fixed in
// the project); PR, branch and tests stay in the project's.
const issueRepoOption = args.value('--issue-repo');
// `new` has no issue yet and assigns the number it creates.
const number = Number(String(args.words[0]).replace(/^#/, ''));
const gh = externalTool('gh', process.cwd(), projectDirectory);
const { git, localHead, sleep, runShell } = createProcess({ projectDirectory });

// The first argument after the PR; `ready PR --local` (the step `done` takes) reads the head from the checkout, so a shell never has to splice `$(git rev-parse HEAD)` into the call.
// The PR must still show exactly that head before it is marked ready, so a commit that was not pushed is refused like a mistyped id.
const value = command === 'ready' && args.flag('--local') ? localHead() : args.words[1];

const startedAt = Date.now();
const github = createGithub({ tool: gh, command, projectDirectory, sleep });
const { graphql, rest, restAll } = github;

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
const oneLine = spec.oneLine, print = console.log, held = [];
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
    startedAt, state, git, localHead, sleep, runShell, args, ...options, later };
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
  // check, reviews, handoff, ready and link are the steps `start` and `done` take (`hidden` in their description): callable for those two and for the tests, but not listed.
  await registry[spec.run]();
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
