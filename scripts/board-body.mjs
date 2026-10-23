// Issue bodies and links: `body`, `body-replace`, `link` and the backlinks.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';
import { shared } from './board-args.mjs';
import { result } from './board-result.mjs';

/** What `board.mjs help` and the parser know about the commands; `run` names the function this module returns. */
export const specs = [
  { name: 'body', run: 'body', writes: true, doc: 'docs/board/body.md', words: [{ name: 'ISSUE', kind: 'number' }, { name: 'FILE' }, { name: 'BASE_FILE' }],
    summary: 'Replaces the issue body with FILE. Only if the current body still equals BASE_FILE; read back after. A body that changed meanwhile is refused with a diff.' },
  { name: 'body-replace', run: 'bodyReplace', writes: true, doc: 'docs/board/body.md', words: [{ name: 'ISSUE', kind: 'number' }],
    summary: 'Replaces one occurrence of a text in the issue body. The text in --from becomes the text in --to; written and read back like `body`.',
    flags: { '--from': { value: 'FILE', required: true, help: 'File with the text to find (plain text, no regular expression).' }, '--to': { value: 'FILE', required: true, help: 'File with the new text.' } } },
  { name: 'link', run: 'link', hidden: true, writes: true, words: [{ name: 'ISSUE', kind: 'number' }, { name: 'PR', kind: 'digits' }], flags: { '--refs': shared.refs },
    summary: 'Connects the PR to the issue natively (and comments the PR URL). `done` runs it.' },
];

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createBody(env) {
  const { args, blockerRepository, github, graphql, isSpec, issueProject, lines, name, number, owner, project, readIssue, rest, restAll, sleep, specRefusal, state, validBlocker } = env;
  const { isPartialPr } = env.later;

  /** Every comment of an open issue, complete and unique, or an exception: a partial list must never read as "no backlink". */
  function issueComments(repository, issueNumber) {
    const issue = rest(`repos/${repository}/issues/${issueNumber}`);
    assert.ok(issue?.number === issueNumber && issue.state === 'open' && !issue.pull_request,
      `#${issueNumber} is not an open issue`);
    assert.ok(Number.isSafeInteger(issue.comments) && issue.comments >= 0, 'Issue comment count is unreadable');
    const comments = restAll(`repos/${repository}/issues/${issueNumber}/comments`, issue.comments);
    assert.equal(comments.length, issue.comments, `Not every comment on #${issueNumber} is readable; retry the read`);
    assert.ok(comments.every(comment => Number.isSafeInteger(comment?.id) && typeof comment.body === 'string'), 'Unreadable issue comment');
    assert.equal(new Set(comments.map(comment => comment.id)).size, comments.length, 'Duplicate comment page');
    return comments;
  }

  /** The comment that `status ... "Automated review"` accepts: it names the PR's full URL, whatever surrounds it. Shared by that guard and `link`. */
  const findBacklink = (comments, prUrl) => comments.find(comment => (comment.body.match(/https?:\/\/[^\s<>()[\]`"']+/g) ?? []).some(link => {
    try {
      const target = new URL(link.replace(/[.,;:!?]+$/, ''));
      return target.origin === prUrl.origin && target.pathname.replace(/\/$/, '') === prUrl.pathname;
    } catch { return false; } // An unrelated malformed URL is not a backlink.
  }));

  /** Explicit scope works with Refs on release branches; native closing links remain a separate proof. Returns the lines that report what it found or made. */
  function verifyBacklinks(issue) {
    const lines = [];
    const [prRef, ...extraIssues] = state.delivered ?? env.later.fieldWords().slice(2);
    assert.ok(prRef !== undefined, 'Automated review needs the PR number: field ISSUE Status "Automated review" PR [OTHER_ISSUE...]');
    const positive = ref =>/^\d+$/.test(ref ?? '') && Number.isSafeInteger(Number(ref)) && Number(ref) > 0;
    assert.ok(positive(prRef) && extraIssues.every(ref => validBlocker(ref) && positive(ref.slice(ref.lastIndexOf('#') + 1))),
      'Automated review requires PR [OTHER_ISSUE...]; post and read back every issue backlink first.');
    const prNumber = Number(prRef);
    const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){number url state isDraft body}}}`, { owner, name, number: prNumber }).repository;
    assert.ok(pr?.number === prNumber && pr.state === 'OPEN' && typeof pr.body === 'string', 'The declared PR is not open/readable');
    assert.ok(pr.isDraft === false, `PR #${prNumber} is still Draft (its CI skips checks); run board.mjs done ${number}`);
    const url = new URL(pr.url);
    assert.equal(url.pathname, `/${project.repository}/pull/${prNumber}`, 'PR belongs to another repository');
    const scope = new Set([`${issueProject.repository}#${number}`,...extraIssues.map(ref =>
      `${blockerRepository(ref)}#${Number(ref.slice(ref.lastIndexOf('#') + 1))}`)]);
    for (const issueRef of scope) {
      const repository = blockerRepository(issueRef), issueNumber = Number(issueRef.slice(issueRef.lastIndexOf('#') + 1));
      const qualifier = `(?:${RegExp.escape(repository)})${repository === project.repository ? '?' : ''}`;
      const reference = new RegExp(`(?<![\\w/])${qualifier}#${issueNumber}(?!\\w)`, 'i');
      assert.ok(reference.test(pr.body), `PR #${prNumber} does not reference ${issueRef}`);
      let backlink = findBacklink(issueComments(repository, issueNumber), url);
      // An issue of this repository gets what `link` does (native connection and comment, read back); only a failure refuses.
      // A partial PR of this issue gets the comment only: a native link would make it a second closing PR.
      if (!backlink && repository === issueProject.repository) {
        if (issueNumber === number && isPartialPr(issue, prNumber)) lines.push(postBacklink(issueNumber, pr.url));
        else lines.push(...linkIssue(issueNumber, prNumber));
        backlink = findBacklink(issueComments(repository, issueNumber), url);
      }
      assert.ok(backlink, `Missing backlink to ${pr.url} on #${issueNumber}; post the full URL as a comment and retry`);
      lines.push(`backlink ${issueRef}: ${backlink.html_url}`);
    }
    return lines;
  }

  /** Native PR connections, including manual links on a non-default base; refs and branches do not count. */
  function connectedIssues(pr, draftAllowed = false) {
    const ids = new Set();
    for (let after; ;) {
      // The PR read of the review (prQuery) carries the first page of the links; only a further page is a query of its own.
      const current = !after && pr.closingIssuesReferences ? pr : graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      pullRequest(number:$number){state isDraft headRefOid closingIssuesReferences(first:100,after:$after){totalCount
        pageInfo{hasNextPage endCursor} nodes{id}}}}}`, { owner, name, number: pr.number, ...(after && { after }) })
        .repository.pullRequest;
      assert.ok(current?.state === 'OPEN' && (draftAllowed || current.isDraft === false) && current.headRefOid === pr.headRefOid,
        'PR changed after the review check; read the current head again');
      const links = current.closingIssuesReferences;
      assert.ok(links?.nodes && links.pageInfo, 'Native issue links are unreadable');
      for (const issue of links.nodes) {
        assert.ok(issue?.id && !ids.has(issue.id), 'Native issue links are incomplete or repeated');
        ids.add(issue.id);
      }
      if (!links.pageInfo.hasNextPage) {
        assert.equal(ids.size, links.totalCount, 'Not every native issue link is readable');
        return ids;
      }
      assert.ok(links.pageInfo.endCursor && links.pageInfo.endCursor !== after, 'Issue-link pagination did not advance');
      after = links.pageInfo.endCursor;
    }
  }

  /** The changed region of two texts as `-`/`+` lines (common start and end cut off): enough to show a person what differs. */
  function diffText(before, after) {
    const [old, now] = [before, after].map(text => text.split('\n'));
    let start = 0;
    while (start < old.length && start < now.length && old[start] === now[start]) start++;
    let [endOld, endNow] = [old.length, now.length];
    while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) { endOld--; endNow--; }
    return [...old.slice(start, endOld).map(line => `- ${line}`), ...now.slice(start, endNow).map(line => `+ ${line}`)].join('\n');
  }

  /**
   * Replace an issue body only if it still is the one the change is based on, and prove the write afterwards.
   * GitHub has no conditional write for issue bodies: the window between the read and the write stays, which the
   * read-back closes for every overwrite that happens before it. Another session's change is reported, never lost silently.
   * `change(before, refuse)` turns the body just read into the new one; it returns undefined after calling `refuse`.
   */
  function writeBody(change) {
    const current = () => {
      const issue = rest(`repos/${issueProject.repository}/issues/${number}`);
      // The Issues API also serves pull requests under their number; a PR description is no issue body to replace.
      assert.ok(issue?.number === number && !issue.pull_request, `#${number} is not an issue of ${issueProject.repository}`);
      return String(issue.body ?? '').replaceAll('\r\n', '\n').trimEnd();
    };
    let refused;
    const refuse = (reason, diff) => {
      refused = result('failed', 'FAILED', { blockers: [reason], notes: diff.trimEnd() ? [diff.trimEnd()] : [] });
    };
    const before = current();
    const fresh = change(before, refuse);
    if (fresh === undefined) return refused;
    if (before === fresh) return result('ok', 'BODY', { headline: `BODY #${number} already has this text` });
    // The text already read and compared goes over stdin: gh would take a file named "-" for stdin and write an empty body.
    github.write('PATCH', `repos/${issueProject.repository}/issues/${number}`, { body: fresh });
    const after = current();
    if (after !== fresh) {
      refuse(`the body of #${number} is not what was written: another session overwrote it meanwhile (diff: what you wrote, then the current body); read it, merge, write again`, diffText(fresh, after));
      return refused;
    }
    return result('ok', 'BODY', { headline: `BODY #${number} written and read back` });
  }

  function body() {
    const [fresh, base] = args.words.slice(1).map(lines);
    return writeBody((before, refuse) => before === base ? fresh
      : refuse(`the body of #${number} changed since you read it (diff: your base, then the current body); read it again, merge, write again`, diffText(base, before)));
  }

  /** Replace exactly one occurrence of the --from text with the --to text; the body just read is the base. No regular expressions. */
  function bodyReplace() {
    const [from, to] = [args.value('--from'), args.value('--to')].map(lines);
    assert.ok(from !== '', 'The --from text is empty');
    return writeBody((before, refuse) => {
      // Every start position counts, so "aa" in "aaa" is two matches, not one.
      const starts = [];
      for (let at = before.indexOf(from); at !== -1; at = before.indexOf(from, at + 1)) starts.push(at);
      if (starts.length === 1) return before.slice(0, starts[0]) + to + before.slice(starts[0] + from.length);
      const lineOf = at => before.slice(0, at).split('\n').length;
      return refuse(starts.length === 0
        ? `the --from text is not in the body of #${number}; read the body again`
        : `the --from text occurs ${starts.length} times in the body of #${number} (from line ${starts.map(lineOf).join(', from line ')}); take more surrounding text so it matches once`, '');
    });
  }

  /** Connect the issue natively to the PR (what a closing keyword does only on the default branch), post the backlink comment `status` requires, and read both back. */
  const link = () => {
    const [headline, ...notes] = linkIssue(number, Number(state.value), args.flag('--refs'));
    return result('ok', 'LINKED', { headline, notes });
  };

  /** `refsOnly` (link --refs): the PR only names the issue, so no native link; the backlink comment alone (#510). */
  function linkIssue(issueNumber, prNumber, refsOnly, known) {
    const issue = known ?? readIssue(false, issueNumber);
    assert.ok(issue?.id, 'Issue identity is unreadable');
    // The backlink comment belongs on an open issue (the guard requires one); refuse before any write instead of half-way.
    assert.equal(issue.state, 'OPEN', `#${issueNumber} is not an open issue`);
    assert.ok(refsOnly || !isSpec(issue), specRefusal(issueNumber, `a PR must not close it, so it is not linked natively (use "Refs #${issueNumber}": link ${issueNumber} PR --refs)`));
    const pull = rest(`repos/${project.repository}/pulls/${prNumber}`);
    const pr = { id: pull.node_id, number: pull.number, state: pull.state === 'open' ? 'OPEN' : 'CLOSED', url: pull.html_url, headRefOid: pull.head.sha };
    assert.ok(pr.id && pr.number === prNumber && pr.state === 'OPEN', `#${prNumber} is not an open pull request of ${project.repository}`);
    // Already connected is a success without a write; a Draft PR can be connected too.
    if (!refsOnly && !connectedIssues(pr, true).has(issue.id)) {
      graphql('mutation($issue:ID!,$pr:ID!){addCloseIssueReferences(input:{issueId:$issue,pullRequestIds:[$pr]}){clientMutationId}}',
        { issue: issue.id, pr: pr.id });
      // GitHub shows the new connection with a delay (seen live: the first read-back right after the write was empty).
      // Read back a few times; the write is never repeated.
      for (let attempt = 1; !connectedIssues(pr, true).has(issue.id); attempt++) {
        assert.ok(attempt < 5, `Native link read-back differs: PR #${prNumber} does not close issue #${issueNumber}`);
        sleep(1);
      }
    }
    return [refsOnly ? `#${issueNumber} is named by PR #${prNumber} (Refs, no native link)` : `#${issueNumber} is natively linked to PR #${prNumber}`, postBacklink(issueNumber, pr.url)];
  }

  /** The backlink comment alone (a partial PR must not be linked natively). An existing comment is a success without a write. The text goes over stdin, like in `body`; the guard's reader proves it. */
  function postBacklink(issueNumber, url) {
    const prUrl = new URL(url);
    let backlink = findBacklink(issueComments(issueProject.repository, issueNumber), prUrl);
    if (!backlink) {
      github.write('POST', `repos/${issueProject.repository}/issues/${issueNumber}/comments`, { body: `PR: ${url}\n` });
      backlink = findBacklink(issueComments(issueProject.repository, issueNumber), prUrl);
      assert.ok(backlink, `Backlink read-back differs: the comment with ${url} is not readable on #${issueNumber}; read the comments before writing again`);
    }
    return `backlink #${issueNumber}: ${backlink.html_url}`;
  }

  /**
   * `done` says the issue is delivered, so every open task-list item of its body that names no issue counts as met; a part moved to a
   * follow-up stays open and carries its issue (`- [ ] … → #12`). Fenced code is left alone.
   * ponytail: works on the Markdown lines; a `#N` anywhere in the line or an issue URL counts as the follow-up reference.
   */
  function tickAcceptance(text) {
    let fence = false;
    return text.split('\n').map(line => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      return fence || /#\d|\/issues\/\d/.test(line) ? line : line.replace(/^(\s*(?:[-*]|\d+\.)\s+)\[ \]/, '$1[x]');
    }).join('\n');
  }

  return { verifyBacklinks, connectedIssues, writeBody, body, bodyReplace, link, linkIssue, postBacklink, tickAcceptance };
}
