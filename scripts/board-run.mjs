// One board.mjs call as a function: `runBoard({ argv, env, cwd, io })` reads the project, checks the arguments, runs one command and returns
// { exitCode, stdout, stderr }. It touches neither process.exit, process.env nor the console unless the caller hands them in (`io`, default: nothing is printed),
// so the tests call it directly. board.mjs only passes the process's arguments, environment and console.
// `--cwd PATH` anywhere in the arguments runs it for the project in PATH from any directory: without it the
// working directory decides the project, and a driver in another project would read and write the wrong board.
// Each command is a module `board-<name>.mjs` with its description (`specs`) and its functions, which run nothing when imported. They take the run-time data of the call from board-context.mjs and each other's helpers by import.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cwdOf, externalToolIn, projectRoot } from './checkout-root.mjs';
import { readProfile, readProfileAt, textsFor } from './project-profile.mjs';
import { createGithub } from './github.mjs';
import { sleepers } from './quota.mjs';
import { createOptions, helpOf, listOf, parseArgs, usageOf } from './board-args.mjs';
import { commandSpecs } from './board-commands.mjs';
import { createProcess } from './board-process.mjs';
import { createCheckout } from './board-checkout.mjs';
import { createOutput, isResult, result } from './board-result.mjs';
import { setContext } from './board-context.mjs';
import { quotaLine as quotaLineOf } from './board-common.mjs';
import * as check from './board-check.mjs';
import * as claims from './board-claims.mjs';
import * as sweep from './board-sweep.mjs';
import * as next from './board-next.mjs';
import * as stack from './board-stack.mjs';
import * as fields from './board-fields.mjs';
import * as create from './board-new.mjs';
import * as body from './board-body.mjs';
import * as handoff from './board-handoff.mjs';
import * as wait from './board-wait.mjs';
import * as block from './board-block.mjs';
import * as start from './board-start.mjs';
import * as done from './board-done.mjs';
import * as merge from './board-merge.mjs';
import * as threads from './board-threads.mjs';

/**
 * `argv`: the arguments after the script name. `env`: the environment the call reads. `cwd`: the directory `--cwd` and the tool lookup start from.
 * `io`: `{ log(text), error(text) }`, called while the command runs (progress, verdict); the returned `stdout` and `stderr` hold the same lines.
 */
export async function runBoard({ argv, env = process.env, cwd = process.cwd(), io } = {}) {
  const [stdout, stderr] = [[], []];
  const lines = { log: text => { stdout.push(text); io?.log(text); }, error: text => { stderr.push(text); io?.error(text); } };
  const exitCode = await runCall({ argv: [...argv], env, cwd, io: lines });
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

async function runCall({ argv: call, env, cwd, io }) {
  // The only printer of this call (board-result.mjs); replaced once the arguments are known and --json / --verbose can apply.
  let output = createOutput({ io });
  // Taken off here, so the parser sees the command first.
  // A subfolder of the checkout (or of --cwd) works like its root: the project file is found there.
  const found = cwdOf(call);
  if (found.error) { output.diagnostic(found.error); return 2; }
  const startDirectory = resolve(cwd, found.directory);
  // `--issue-repo OWNER/NAME` may stand anywhere in the call (before the command too); the parser reads it after the command.
  const issueRepoAt = call.indexOf('--issue-repo');
  if (issueRepoAt >= 0) call.push(...call.splice(issueRepoAt, 2));
  // Help reads nothing: not the project, not GitHub. `help COMMAND` and `COMMAND --help` show that one command, everything else the list.
  if (call[0] === 'help' || call.includes('--help') || call.includes('-h')) {
    const target = commandSpecs.find(spec => spec.name === (call[0] === 'help' ? call[1] : call[0]));
    const unknown = call[0] === 'help' && call[1] !== undefined && !target;
    (unknown ? output.diagnostic : output.text)(unknown ? `unknown command "${call[1]}"\n${listOf(commandSpecs)}` : target ? helpOf(target) : listOf(commandSpecs));
    return unknown ? 2 : 0;
  }
  let projectDirectory;
  try { projectDirectory = projectRoot(startDirectory); } catch (error) {
    // Only the two expected misses get a short line; any other failure (EACCES, ELOOP) keeps its own message.
    const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
    if (!missing && error.code !== 'ERR_ASSERTION') throw error;
    output.diagnostic(`${startDirectory}: ${missing ? 'is not a directory' : 'is not inside a Git checkout'}`);
    return 2;
  }
  const command = call[0];
  const projectFile = join(projectDirectory, '.github/workflow-project.json');
  if (!existsSync(projectFile)) {
    output.diagnostic(`${projectFile} is missing: run board.mjs inside the project, or name it with --cwd PROJECT_DIR`);
    return 2;
  }
  let project;
  try { project = readProfile(projectDirectory); } catch (error) {
    output.diagnostic(error.message);
    return 2;
  }
  const [owner, name] = project.repository.split('/');
  // The repository and board of the issue: the project's own unless --issue-repo names another one (read once by useIssueRepo, before start and done).
  let issueProject = project, [issueOwner, issueName] = [owner, name];
  // The status names of the issue's board and the texts written into issues and PRs (`statuses`, `language` in the project file).
  let statuses = project.statuses;
  const texts = textsFor(project);
  const commandNames = commandSpecs.map(spec => spec.name);
  // A call the description does not allow ends here with the reason and the usage of that one command, before any read or write.
  const parsed = parseArgs(commandSpecs, call, project);
  if (!parsed.args) {
    output.diagnostic([parsed.error, parsed.spec ? usageOf(parsed.spec) : listOf(commandSpecs)].filter(Boolean).join('\n'));
    return 2;
  }
  const { spec, args } = parsed;
  // From here on the call is valid: the printer knows --json and --verbose (a refused call above prints plain text).
  output = createOutput({ json: args.flag('--json'), verbose: args.flag('--verbose'), io });
  const options = createOptions({ project, args, env, projectDirectory });
  // `--issue-repo OWNER/NAME` (start, done): the issue lives in that repository and on its board (a kit issue fixed in
  // the project); PR, branch and tests stay in the project's.
  const issueRepoOption = args.value('--issue-repo');
  // `new` has no issue yet and assigns the number it creates.
  const number = Number(String(args.words[0]).replace(/^#/, ''));
  const gh = externalToolIn(env, 'gh', cwd, projectDirectory);
  const { sleep, runShell } = createProcess({ env });
  const checkout = createCheckout({ projectDirectory, sleep, env });
  const { git, gitAt, localHead } = checkout;

  const startedAt = Date.now();
  const github = createGithub({ tool: gh, reserve: sleepers[command], pauses: command === 'wait', projectDirectory, sleep, env, say: output.diagnostic });
  const { graphql, rest, restAll } = github;

  /** The issue lives in another repository when --issue-repo says so: its board and statuses replace the project's (read once, before the modules are made). */
  function useIssueRepo() {
    if (issueRepoOption === undefined || issueRepoOption.toLowerCase() === project.repository.toLowerCase()) return;
    issueProject = { ...readProfileAt(rest, issueRepoOption), repository: issueRepoOption };
    [issueOwner, issueName] = issueRepoOption.split('/');
    statuses = issueProject.statuses;
  }

  // field and new report a failure as one "ERROR - reason" line, and they print only their result (no progress), so no failed call shows a write as confirmed.
  // The other commands keep ERROR with "- reason" below it.
  const oneLine = spec.oneLine;
  let quotaLine = () => undefined;
  let exitCode = 0;
  try {
    if (['start', 'done'].includes(command)) useIssueRepo();
    // What commands hand to each other during one run: the PR `done` works on (`value`: the steps it calls read their PR where a called `handoff` reads its argument),
    // the base PR of the issue the last `check` judged STACKABLE (`stackedOn`: handoff compares it with the PR's base branch), a PR that only says "Refs #N"
    // (no native closer) which `start --takeover` finds (`adoptedPr`, #649), and the [PR, ...OTHER_ISSUE] `done` knows (`delivered`; else they follow "Automated review" on the command line).
    // `value` is the first argument after the PR; `ready PR --local` (the step `done` takes) reads the head from the checkout, so a shell never has to splice `$(git rev-parse HEAD)` into the call.
    // The PR must still show exactly that head before it is marked ready, so a commit that was not pushed is refused like a mistyped id.
    const state = { value: command === 'ready' && args.flag('--local') ? localHead() : args.words[1], stackedOn: undefined, adoptedPr: undefined, delivered: undefined };
    setContext({ env, project, owner, name, number, command, github, graphql, rest, restAll, projectDirectory, issueProject, issueOwner, issueName, statuses, texts, startedAt, state,
      git, gitAt, checkout, localHead, sleep, runShell, args, ...options,
      // Lines that must show while the command runs; field and new have none (a failed call must not show a write as confirmed).
      progress: oneLine ? () => undefined : output.progress, step: oneLine ? () => undefined : output.step });
    quotaLine = quotaLineOf;
    const commands = { ...check, ...claims, ...sweep, ...next, ...stack, ...fields, ...create, ...body, ...handoff, ...wait, ...block, ...start, ...done, ...merge, ...threads };
    // check, reviews, handoff, ready and link are the steps `start` and `done` take (`hidden` in their description): callable for those two and for the tests, but not listed.
    const outcome = await commands[spec.run]();
    if (isResult(outcome)) {
      output.finish(outcome);
      exitCode = outcome.exitCode;
    }
  } catch (error) {
    // A failed read is never "no blockers" and never a finished review.
    if (!commandNames.filter(known => !['next', 'sweep', 'block', 'sub'].includes(known)).includes(command)) throw error;
    const message = String(error.stderr || error.message).trim();
    output.finish(oneLine ? result('error', 'ERROR', { headline: `ERROR - ${message.replace(/\s*\n\s*/g, ' ')}`, blockers: [message], inline: true })
      : result('error', command === 'check' ? 'UNKNOWN' : 'ERROR', { blockers: [message], bullet: '- ' }));
    exitCode = 2;
  } finally {
    // Waiting commands already print their quota with the verdict; all other commands need the same evidence, also on failure.
    const alreadyPrintedQuota = ['reviews', 'wait', 'quota-wait'].includes(command)
      || (exitCode === 4 && ['handoff', 'merge'].includes(command));
    if (github.quota && (exitCode === 2 || !alreadyPrintedQuota)) output.diagnostic(quotaLine());
  }
  return exitCode;
}
