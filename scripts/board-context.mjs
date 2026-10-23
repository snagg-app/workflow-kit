// What one board.mjs call knows at run time: the project, the GitHub access, the arguments and the tools that talk to git and the shell.
// Commands import these names (live bindings, set once by `setContext` before any command runs); a name that does not exist fails when the module loads.
// The helpers the commands share are not here: they are imported from the module that defines them.
// `memory` is what one call keeps for its later steps (field definitions, the default branch, the review settings, the stack it read); a new call starts empty, also in the tests that run many calls in one process.
export let env, project, owner, name, number, command, github, graphql, rest, restAll, projectDirectory, issueProject, issueOwner, issueName, statuses, texts, startedAt, state,
  git, gitAt, checkout, localHead, sleep, runShell, args, staleHours, numberOption, stallOption, stack, graceOption, sessionOption, blockerRepository, validBlocker,
  progress, step, specLabel, handoffHeading, memory;

/** Takes the values of the call (the names above, nothing else); `specLabel` and `handoffHeading` follow from the project file and its texts. */
export function setContext(values) {
  ({ env, project, owner, name, number, command, github, graphql, rest, restAll, projectDirectory, issueProject, issueOwner, issueName, statuses, texts, startedAt, state,
    git, gitAt, checkout, localHead, sleep, runShell, args, staleHours, numberOption, stallOption, stack, graceOption, sessionOption, blockerRepository, validBlocker,
    progress, step } = values);
  ({ specLabel } = project);
  memory = { stackState: { order: [], trunk: undefined, layers: new Map() } };
  handoffHeading = new RegExp(`^## ${RegExp.escape(texts.handoff)}\\s*$`, 'm');
}
