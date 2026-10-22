// `start ISSUE`: claim, branch and Draft PR.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shared } from './board-args.mjs';
import { pushPlan, targetBranch } from './board-checkout.mjs';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'start', run: 'start', writes: true, doc: 'docs/board/start.md', words: [{ name: 'ISSUE', kind: 'number' }],
    summary: 'Claims a Ready issue. Runs the execution check, then assignment, In progress and the claim comment, each write read back. A repeated call resumes.',
    flags: { '--session': shared.session, '--takeover': { help: 'Take over a fresh PR of another session.' }, '--issue-repo': shared.issueRepo } },
];

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createStart(env) {
  const { args, checkout, claimField, claimOf, commentClaims, defaultBranchName, git, github, isSpec, issueProject, number, project, projectDirectory, projectItem, readIssue, refOf, rest, restAll, restPost, runShell, sameLogin, sessionOption, specRefusal, state, statuses } = env;
  const { baseOf, branchWork, check, foreignAssignees, isOwn, linkIssue, mayStart, openPr, ownPr, refsPr, set, startReasons, workBranches } = env.later;

  /** A branch name is taken when the issue, this clone or the remote already has it. */
  const takenFor = issue => name => workBranches(issue).includes(name) || checkout.branchExists(name);

  /**
   * The first push (#643): the claim comment has no branch and no PR yet. Own commits on top of the claimed base get the branch `<agent>/<number>-<title>` (the checkout's own
   * branch when it already has that shape) and the Draft PR that closes the issue, with the claim line in its body. Returns the PR number, or undefined when there is nothing to open
   * (no claim, no commit of its own: a check task ends with FILE alone).
   */
  function openFirstPr(issue) {
    const claim = commentClaims(issue).at(-1);
    // A merged PR (squash: its commits are not in the base) means the work is delivered: the FILE-only path reports it.
    if (!claim || issue.closedByPullRequestsReferences?.nodes.some(pr => pr?.state === 'MERGED')) return;
    git('fetch', 'origin');
    const base = /^Basis:[ \t]*(\S+)[ \t]*$/m.exec(claim.input)?.[1] ?? (baseOf(issue).branch || defaultBranchName());
    const here = checkout.stand(base);
    if (here.ahead === 0) return;
    const { branch, create } = targetBranch({ number, title: issue.title, agent: claim[1], session: claim[2], branch: here.branch, taken: takenFor(issue) });
    if (create) git('switch', '-c', branch, '--no-track');
    const plan = pushPlan({ stand: { ...here, branch }, number });
    assert.ok(!plan.refuse, plan.refuse);
    git(...plan.args);
    const pr = JSON.parse(restPost(`repos/${project.repository}/pulls`, ['-f', `title=${issue.title}`, '-f', `head=${branch}`, '-f', `base=${base}`, '-F', 'draft=true', '-F', 'body=@-'], `Closes ${issueProject === project ? '' : issueProject.repository}#${number}\n${claim[0]}\n`)).number;
    linkIssue(number, pr, false, issue);
    console.log(`done: opened branch ${branch} and Draft PR #${pr} on ${base}`);
    return pr;
  }

  // A clone-local Git setting, read back: an override in another scope fails loudly instead of being ignored.
  function setCloneSetting(key, want) {
    const read = () => { try { return git('config', '--get', key); } catch { return ''; } };
    if (read() !== want) git('config', '--local', key, want);
    assert.equal(read(), want, `${key} must be ${want} but is overridden outside this clone's config; fix that override`);
  }

  /**
   * `start ISSUE`: the claim (#643). The check of the issue decides first (BLOCKED, UNKNOWN: nothing is written), then assignment, In progress and a claim comment
   * ("Agent: …, Session: …" and the base: the Project's base field, the base PR of a stack, else the default branch); every write is read back. No branch and no Draft PR yet:
   * `done` opens both with the first push (openFirstPr). Taking over an issue that already has a PR continues on that PR's branch and rewrites the claim line in its body.
   * A step that is already done is skipped, so a resume is the same call. The session is the one of `sessionOption`.
   */
  function start() {
    const agent = process.env.CODEX_THREAD_ID ? 'codex' : 'claude', modules = join(projectDirectory, '.gitmodules');
    const session = sessionOption();
    assert.match(session ?? '', /^\w[\w.-]*$/, 'start needs your session id: pass --session ID');
    // One checkout-wide setting each, so a kit commit never rides along with a project push and a branch switch follows the kit pin.
    if (existsSync(modules)) for (const [key, want] of [['submodule.recurse', 'true'], ['push.recurseSubmodules', 'no']]) setCloneSetting(key, want);
    const issue = readIssue();
    assert.ok(!isSpec(issue), specRefusal(number, 'start is refused; agents leave specs untouched'));
    // `upstream` would send a push to the base branch of a worktree made from origin/<base> (#3822); `simple` pushes to the branch's own name.
    setCloneSetting('push.default', 'simple');
    const takeover = args.flag('--takeover');
    if (takeover && !openPr(issue)) state.adoptedPr = refsPr();
    // --takeover without an open PR, a claim or a foreign assignee has nothing to take over (#564): refuse before anything is written.
    // A foreign assignee or claim without a PR yet is what --takeover takes over then (#572).
    if (takeover && !openPr(issue) && !commentClaims(issue).length && !foreignAssignees(issue).length) {
      const merged = issue.closedByPullRequestsReferences?.nodes.find(pr => pr?.state === 'MERGED');
      assert.fail(`--takeover: no open PR closes #${number}${merged ? ` (PR ${refOf(merged.repository, merged.number)} is already merged)` : ''}`);
    }
    if (!mayStart(check(issue, { session, takeover }))) return;
    const stacked = state.stackedOn, login = issue.viewer.login;
    // The check took seconds: whoever claimed the issue meanwhile wins, nothing is written yet (#572).
    const fresh = readIssue(), raced = startReasons(fresh, session, takeover).blocked;
    if (raced.length) assert.fail(`${raced.join('; ')}; changed while starting, nothing was written`);
    // #657: an empty base field must not fall back to the default branch silently (a tooling issue says `main` in the field).
    const unset = baseOf(issue);
    if (unset.setting && !unset.value && !stacked && !openPr(issue)) assert.fail(`the Project field ${unset.setting.field} of #${number} is empty; set it (main for tooling issues) and start again, nothing was written`);
    if (!fresh.assignees.nodes.some(user => sameLogin(user.login, login))) {
      restPost(`repos/${issueProject.repository}/issues/${number}/assignees`, ['-f', `assignees[]=${login}`]);
      fresh.assignees.nodes.push({ login });
    }
    // The read seconds ago is the one `set` would take now; the read-back at the end of start still reads the issue again.
    set('Status', statuses.inProgress, () => fresh);
    const base = stacked ? (stacked.state === 'MERGED' ? stacked.baseRefName : stacked.headRefName)
      : baseOf(issue).branch || defaultBranchName();
    const claimLine = `Agent: ${agent}, Session: ${session}`;
    const current = openPr(issue);
    let branch = git('branch', '--show-current'), handedBranch;
    const continueOn = name => {
      if (git('branch', '--show-current') === name) return;
      const local = checkout.hasLocalBranch(name);
      // --takeover (#550): the predecessor's worktree may still hold the branch; it belongs to nobody after the takeover.
      git('switch', ...takeover ? ['--ignore-other-worktrees'] : [], ...local ? [name] : ['--track', `origin/${name}`]);
      // The predecessor may have pushed from another clone: catch up when that is a fast-forward, else leave the branch as it is.
      if (takeover && local) try { git('merge', '--ff-only', `origin/${name}`); } catch { /* diverged: the driver decides */ }
    };
    if (current) {
      // An issue that already has a PR (a takeover, a resume) continues on its branch; a PR of another session gets this session's claim line.
      assert.ok(current.headRefName, 'The claimed PR branch is unreadable');
      git('fetch', 'origin');
      branch = current.headRefName;
      continueOn(branch);
      if (!ownPr(issue, session)) {
        const path = `repos/${project.repository}/pulls/${current.number}`, body = rest(path).body ?? '';
        github.run(['api', path, '-X', 'PATCH', '-F', 'body=@-'], { input: claimField.test(body) ? body.replace(claimField, claimLine) : `${body}\n${claimLine}\n` });
        assert.equal(claimOf(rest(path))?.[2], session, 'Claim in the PR body read-back differs');
      }
    } else {
      git('fetch', 'origin');
      // #655: --takeover continues on the pushed branch of the predecessor, which has no PR yet.
      handedBranch = takeover ? workBranches(fresh).find(name => branchWork(fresh, name).ahead) : undefined;
      if (handedBranch) continueOn(branch = handedBranch);
      // #657: the work branch starts on origin/<base> whatever the checkout stands on; an own branch of this issue (a resume) stays.
      else {
        const target = targetBranch({ number, title: fresh.title, agent, session, branch, taken: takenFor(fresh) });
        branch = target.branch;
        if (target.create) git('switch', '-c', branch, '--no-track', `origin/${base}`);
      }
      if (!isOwn(fresh, session)) {
        restPost(`repos/${issueProject.repository}/issues/${number}/comments`, ['-F', 'body=@-'], `Beansprucht.\n${claimLine}\nBasis: ${base}\n`);
        const posted = restAll(`repos/${issueProject.repository}/issues/${number}/comments`).findLast(comment => claimField.test(comment.body ?? ''));
        assert.equal(claimField.exec(posted?.body ?? '')?.[2], session, 'Claim comment read-back differs');
      }
    }
    if (existsSync(modules) && readFileSync(modules, 'utf8').includes('.vendor/workflow-kit')) git('submodule', 'update', '--init', '.vendor/workflow-kit');
    const final = readIssue();
    assert.equal(projectItem(final)?.status?.name, statuses.inProgress, `${statuses.inProgress} status read-back differs`);
    assert.ok(final.assignees.nodes.some(user => sameLogin(user.login, login)), 'Assignment read-back differs');
    // The project's setup (e.g. its dependencies) runs last, on the branch with the kit at its pin; a failure leaves claim, status and PR, so start again resumes.
    // #705: the setup can run for minutes; a start that is cut off or read in the background shows that the claim is complete.
    if (project.setup) {
      console.log(`CLAIMED #${number} session ${session} branch ${branch}; the project setup runs now (START follows when it is done)`);
      try { runShell(git('--exec-path'), projectDirectory, project.setup, { BRANCH: branch }); } catch (error) { assert.fail(`setup failed (${String(error.message).split('\n')[0]}); assignment, status and claim stay: fix it and run start again`); }
    }
    console.log(current ? `START #${number} session ${session} branch ${branch} base ${base} PR #${current.number}`
      : handedBranch ? `START #${number} session ${session} branch ${branch} base ${base} (took over the pushed branch of the predecessor; done opens the Draft PR)`
      : `START #${number} session ${session} branch ${branch} base ${base} (branch made from origin/${base}, never push to ${base}; done opens the Draft PR with the first push${stacked && stacked.state !== 'MERGED' ? `; stack: link that PR above PR #${stacked.number}, docs/CONTRIBUTING.md#stacked-pull-requests` : ''})`);
  }

  return { openFirstPr, start };
}
