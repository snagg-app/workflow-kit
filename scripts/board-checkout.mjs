// The git rules of the board in one place (#686): where the checkout stands, which branch is the work's target and where a push may go.
// `start`, `done`, `stack-sync` and `merge` only run what these answer; every git call of the board goes through `git` / `gitAt` here.
import { runProgram } from './board-process.mjs';
import { externalTool } from './checkout-root.mjs';

/** #646: nothing the board pushes may reach these (private repos have no branch protection). */
const onBase = ref => ref === 'main' || ref.startsWith('release/');

/** `<agent>/<number>-<title>`: the title without accents, lower case, dashes, at most 40 characters. */
export function branchStem(agent, number, title) {
  return `${agent.toLowerCase()}/${number}-${title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')}`;
}

/**
 * The branch the work of an issue goes on. The checkout's own branch stays when it already has the shape `<agent>/<number>-…` and is no base (a resume);
 * otherwise the stem, with the session (and a counter) appended while `taken(name)` says the name exists (locally, on the remote or on the issue).
 * Pure: `create` says whether the caller must still make the branch.
 */
export function targetBranch({ number, title, agent, session, branch, taken }) {
  if (branch && !onBase(branch) && new RegExp(`^[\\w.-]+/${number}-`).test(branch)) return { branch, create: false };
  const stem = branchStem(agent, number, title);
  let name = stem;
  for (let suffix = 1; taken(name); suffix++) name = `${stem}-${session}${suffix === 1 ? '' : `-${suffix}`}`;
  return { branch: name, create: true };
}

/**
 * Where a push may go (#646, #651, #656, #659). `stand` is the checkout's state, `pr` the PR it feeds (`branch`, `head`, `number`, `repository`, `sameRepo`) when there is one, `mergeNeeded` a base merge
 * that was just made. The answer is a refusal with its reason, or `push` (false when the PR already shows this head) with the git arguments: always the own branch by name,
 * whatever the upstream is, so an upstream on the base (`git switch -c x origin/release/…`) is harmless. Pure.
 */
export function pushPlan({ stand, number, pr, mergeNeeded = false }) {
  const { branch, head } = stand;
  if (onBase(branch)) return { refuse: `the checkout is on ${branch}; nothing is pushed to main or release/**. Fix: git switch -c <agent>/${number}-<slug> --no-track (keeps your commits), then run done again` };
  const args = ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`];
  if (!pr) return { push: true, args };
  if (branch !== pr.branch || !pr.sameRepo) return { refuse: `the checkout is on ${branch || 'HEAD'}, not on the branch ${pr.branch} of ${pr.repository} that PR #${pr.number} shows: check it out first` };
  return { push: mergeNeeded || head !== pr.head, args };
}

/** env: { projectDirectory, sleep } */
export function createCheckout({ projectDirectory, sleep }) {
  /**
   * git in `cwd` (looked up on use, outside every checkout, so commands without git never need one).
   * Worktrees of one clone share their remote refs: a `fetch` that meets another's lock on a ref ("cannot lock ref", #566) is repeated
   * after a second, three tries in all; any other failure stays one at once. A failure carries `status` and `stderr` of git.
   */
  function gitAt(cwd, ...args) {
    const tool = externalTool('git', process.cwd(), cwd);
    for (let attempt = 1; ; attempt++) {
      try {
        const output = runProgram(tool.file, ['-C', cwd, ...args], { encoding: 'utf8', env: tool.env, stdio: ['ignore', 'pipe', 'pipe'] });
        return args.includes('-z') ? output : output.trim();
      } catch (error) {
        if (args[0] !== 'fetch' || attempt === 3 || !/cannot lock ref|unable to update local ref/.test(String(error.stderr || error.message))) throw error;
        sleep(1);
      }
    }
  }
  const git = (...args) => gitAt(projectDirectory, ...args);
  const quiet = (...args) => { try { return git(...args); } catch { return ''; } };

  /** The commit the project's checkout (--cwd, else the working directory) has checked out: what `done` expects the PR to show. */
  function localHead() {
    try {
      return git('rev-parse', 'HEAD');
    } catch (error) {
      throw new Error(`cannot read the head of ${projectDirectory}: ${String(error.stderr || error.message).trim()}`, { cause: error });
    }
  }

  /**
   * Where the checkout stands: branch ('' when detached), its upstream ('' when none), head, the commits it is ahead of and behind `origin/<base>` (as last fetched;
   * undefined without `base` or when that ref is unknown) and whether the tracked files are clean.
   */
  function stand(base) {
    // An unknown base ref throws: "ahead" must never read as 0 or undefined by accident.
    const counts = base ? git('rev-list', '--left-right', '--count', `origin/${base}...HEAD`).split(/\s+/).map(Number) : [];
    return {
      branch: git('branch', '--show-current'), upstream: quiet('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'), head: git('rev-parse', 'HEAD'),
      base, behind: counts[0], ahead: counts[1], clean: git('status', '--porcelain', '--untracked-files=no', '--ignore-submodules') === '',
    };
  }

  function hasLocalBranch(name) {
    try { git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`); return true; } catch { return false; }
  }

  /** Whether a branch of that name exists locally or on the remote. */
  const branchExists = name => hasLocalBranch(name) || Boolean(git('ls-remote', '--heads', 'origin', `refs/heads/${name}`));

  return { git, gitAt, localHead, stand, hasLocalBranch, branchExists };
}
