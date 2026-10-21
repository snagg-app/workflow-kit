// The arguments of board.mjs: the options commands read by name, the usage text and the checks that refuse a call before any read or write.
// Nothing here reads GitHub; a refused call ends with the usage and exit code 2.

/** env: { project, command, number, value, issueRepoAt, issueRepoOption, commandNames } */
export function createArgs(env) {
  const { project, command, number, value, issueRepoAt, issueRepoOption, commandNames } = env;

  // "staleHours" in the project file (default 6): after that long without activity the work counts as abandoned and a new session may take it over (#400).
  const staleHours = project.staleHours === undefined ? 6 : project.staleHours;
  const numberOption = (flag, fallback) => process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) : fallback;
  const stallOption = () => numberOption('--stall', 20);
  const stack = process.argv.includes('--stack');
  // "reviewerGraceMinutes" in the project file is the default of --grace; 0 turns the grace off. Only a missing field is allowed.
  const projectGrace = project.reviewerGraceMinutes === undefined ? 3 : project.reviewerGraceMinutes;
  const graceOption = () => numberOption('--grace', projectGrace);
  const headOption = () => process.argv.includes('--head') ? process.argv[process.argv.indexOf('--head') + 1] ?? '' : undefined;
  // The own session for start, check and next alike: `--session`, else the `agent-<id>` of a Claude Code worktree, else CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID (the session itself, not a subagent).
  const sessionOption = () => (process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : undefined)
    ?? (process.env.CODEX_THREAD_ID || /[\\/]agent-(\w+)(?:[\\/]|$)/.exec(process.cwd())?.[1] || process.env.CLAUDE_CODE_SESSION_ID);
  // OWNER/REPO#N names a blocker in another repository; N or #N one in this project's repository.
  const blockerRepository = reference => reference.includes('/') ? reference.slice(0, reference.lastIndexOf('#')) : project.repository;
  const validBlocker = reference => /^\d+$/.test(reference.slice(reference.lastIndexOf('#') + 1))
    && /^[\w.-]+\/[\w.-]+$/.test(blockerRepository(reference));
  /**
   * Polling must end: a few reads, finite pauses, at most half an hour of waiting in total (also keeps seconds * 1000
   * finite). `ready` waits in two loops (stale head before the write, read-back after it), each sleeping up to
   * (attempts - 1) times, so both count.
   */
  function readyOptionsBounded() {
    const attempts = numberOption('--attempts', 6), interval = numberOption('--interval', 5);
    return Number.isInteger(attempts) && attempts >= 1 && attempts <= 100 && Number.isFinite(interval) && interval >= 0
      && 2 * attempts * interval <= 1800;
  }

  // check, reviews, handoff, ready and link are the steps `start` and `done` take; they stay callable for those two and for the tests, but nobody runs them by hand, so the usage leaves them out.
  const usage = 'Usage: board.mjs [--cwd PROJECT_DIR] start ISSUE [--session ID] [--takeover: take over a fresh PR of another session] [--issue-repo OWNER/NAME: the issue is in that repository, the PR here] | done ISSUE [PR] [HANDOFF_FILE] [--refs] [--no-pr: an exploration without a PR may reach Human review] [--issue-repo OWNER/NAME] [--max-minutes N] [--skip-local-tests REASON] (without HANDOFF_FILE: prepare only, stops after the automated review)'
    + ' | next [--session ID] | sweep | field ISSUE NAME VALUE [NAME VALUE ...] [--spec-review: only a human-invoked spec-review changes spec status]'
    + ' | new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--status S] [--field NAME=VALUE ...] | new --from FILE'
    + ' | block ISSUE BLOCKER | sub PARENT CHILD | wait PR [--stall MINUTES] [--grace MINUTES] [--head SHA] [--max-minutes N] [--interval SECONDS] | wait PR --merged [--max-minutes N]'
    + ' | quota-wait [--max-minutes N] | merge PR [--stack] [--stall MINUTES] [--grace MINUTES] [--interval SECONDS (0-60)] [--max-minutes N] | stack-sync TOP'
    + ' | body ISSUE FILE BASE_FILE | body-replace ISSUE --from FILE --to FILE';

  // A writing command takes only its own flags (value 1: followed by a value) and as many plain words as it names (the issue or PR
  // included); any other argument is a mistake that must not reach a write. `field` checks its own trailing words.
  const writeArgs = { start: { words: 1, flags: { '--session': 1, '--takeover': 0 } }, done: { words: 3, flags: { '--refs': 0, '--no-pr': 0, '--max-minutes': 1, '--skip-local-tests': 1 } },
    sweep: { words: 0 }, field: { words: Infinity, flags: { '--spec-review': 0 } }, block: { words: 2 }, sub: { words: 2 }, link: { words: 2, flags: { '--refs': 0 } },
    body: { words: 3 }, 'body-replace': { words: 1, flags: { '--from': 1, '--to': 1 } },
    new: { words: 0, flags: { '--title': 1, '--body-file': 1, '--milestone': 1, '--label': 1, '--priority': 1, '--field': 1, '--from': 1, '--status': 1 } },
    ready: { words: 2, flags: { '--local': 0, '--attempts': 1, '--interval': 1 } }, handoff: { words: 2, flags: { '--stall': 1, '--grace': 1, '--interval': 1, '--refs': 0 } },
    merge: { words: 1, flags: { '--stack': 0, '--stall': 1, '--grace': 1, '--interval': 1, '--max-minutes': 1 } }, 'stack-sync': { words: 1 } };
  function refusesArguments() {
    const { words, flags = {} } = writeArgs[command], args = process.argv.slice(3);
    let given = 0;
    for (let index = 0; index < args.length; index++) {
      if (Object.hasOwn(flags, args[index])) index += flags[args[index]];
      else if (/^-./.test(args[index])) return true; // a lone "-" is a file name (`body ISSUE - BASE`), not a flag
      else given++;
    }
    return given > words - (args.includes('--local') ? 1 : 0);
  }

  /** Ends the run with the usage (exit code 2) when the call is malformed; --help is the one flag that never writes: usage on stdout, success. */
  function validate() {
    if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
      console.log(usage);
      process.exit(0);
    }
    if (Object.hasOwn(writeArgs, command) && refusesArguments()) {
      console.error(usage);
      process.exit(2);
    }
    if (['reviews', 'wait', 'handoff', 'merge', 'done'].includes(command) && !(Number.isFinite(projectGrace) && projectGrace >= 0)) {
      console.error('reviewerGraceMinutes in .github/workflow-project.json must be a number of minutes, 0 or more (0 turns the grace off); omit the field for the default');
      process.exit(2);
    }
    if (['next', 'check', 'start'].includes(command) && !(Number.isFinite(staleHours) && staleHours >= 0)) {
      console.error('staleHours in .github/workflow-project.json must be a number of hours, 0 or more; omit the field for the default of 6');
      process.exit(2);
    }
    // Only numbers and plain names reach gh, so no argument can smuggle in options.
    if (command === 'ready' && Number.isSafeInteger(number) && !/^[0-9a-f]{7,40}$/i.test(value ?? '')) {
      console.error(`ready needs a commit id of 7 to 40 characters (git rev-parse HEAD) or --local, not ${value ? `"${value}"` : 'nothing'}`);
      process.exit(2);
    }
    if (command === 'wait' && Number.isSafeInteger(number) && value !== '--merged' && headOption() !== undefined && !/^[0-9a-f]{7,40}$/i.test(headOption())) {
      console.error(`wait --head needs a commit id of 7 to 40 characters (git rev-parse HEAD), not ${headOption() ? `"${headOption()}"` : 'nothing'}`);
      process.exit(2);
    }
    if (!commandNames.includes(command) || (!['next', 'sweep', 'new', 'quota-wait'].includes(command) && !Number.isSafeInteger(number))
      // --issue-repo needs a repository and belongs to start and done only: elsewhere it would silently read the project's issue.
      || (issueRepoAt >= 0 && (!['start', 'done'].includes(command) || !/^[\w.-]+\/[\w.-]+$/.test(issueRepoOption ?? '')))
      // Field names and options travel as GraphQL variables, so any printable text works (Größe, Area/Team, P0: urgent).
      || (command === 'field' && !(process.argv.length > 5 && process.argv.slice(4).filter(arg => arg !== '--spec-review').every(text => /^[^\p{Cc}-][^\p{Cc}]*$/u.test(text))))
      // A misspelled flag must not silently turn the session check off.
      || (command === 'next' && process.argv.length > 3 && !(process.argv.length === 5 && process.argv[3] === '--session' && /^\w[\w.-]*$/.test(process.argv[4])))
      || (command === 'check' && process.argv.length > 4 && !(process.argv.length === 6 && process.argv[4] === '--session' && /^\w[\w.-]*$/.test(process.argv[5])))
      || (command === 'start' && process.argv.includes('--session') && !/^\w[\w.-]*$/.test(sessionOption() ?? ''))
      || (['reviews', 'wait', 'handoff', 'merge'].includes(command) && !(stallOption() > 0 && graceOption() >= 0 && Number.isFinite(graceOption())))
      // sleep(NaN) would wait forever.
      || (['handoff', 'merge'].includes(command) && !(numberOption('--interval', 3) >= 0 && numberOption('--interval', 3) <= 60))
      // wait: a fixed pause between reads instead of the growing one (60 to 300 s).
      || (command === 'wait' && !(numberOption('--interval', 60) >= 0 && numberOption('--interval', 60) <= 300))
      // --head is the id of the pushed commit (git rev-parse HEAD, 7 to 40 characters), as for ready; a missing one would wait on a head that never matches.
      || (headOption() !== undefined && (command !== 'wait' || value === '--merged' || !/^[0-9a-f]{7,40}$/i.test(headOption())))
      // 0 = no limit; a missing or non-numeric value must not silently mean that.
      || (process.argv.includes('--max-minutes') && (!['wait', 'merge', 'quota-wait', 'done'].includes(command) || !(numberOption('--max-minutes', 9) >= 0 && Number.isFinite(numberOption('--max-minutes', 9)))))
      || (['handoff', 'link'].includes(command) && (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1))
      || (command === 'ready' && (!/^[0-9a-f]{7,40}$/i.test(value ?? '') || !readyOptionsBounded()))
      || (command === 'body' && !(value && process.argv[5]))
      || (command === 'body-replace' && !(process.argv.length === 8 && value === '--from' && process.argv[6] === '--to' && process.argv[5] && process.argv[7]))
      || (['block', 'sub'].includes(command) && !validBlocker(value ?? ''))) {
      console.error(usage);
      process.exit(2);
    }
  }

  return { validate, options: { staleHours, numberOption, stallOption, stack, projectGrace, graceOption, headOption, sessionOption, blockerRepository, validBlocker, readyOptionsBounded } };
}
