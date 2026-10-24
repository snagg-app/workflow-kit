// `threads PR [--resolve NUMBER ... [--reply TEXT]]`: lists the open review threads of a PR and closes exactly the ones the caller names.
// Its functions run nothing when imported; run-time data comes from board-context.mjs.
import assert from 'node:assert/strict';
import { failed, result } from './board-result.mjs';
import { args, github, graphql, name, number, owner, progress, rest, restAll } from './board-context.mjs';
import { login } from './review-verdict.mjs';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'threads', run: 'threads', writes: true, doc: 'docs/board/threads.md', words: [{ name: 'PR', kind: 'number' }],
    summary: 'Lists the open review threads of a PR (number, author, file and line, outdated or not, link). With --resolve it closes exactly the threads you name, nothing else.',
    flags: { '--resolve': { value: 'NUMBER', kind: 'digits', many: true, help: 'Close this thread (the number of its first comment, as listed); repeatable. Closes nothing unless named.' },
      '--reply': { value: 'TEXT', help: 'Answer in each named thread before closing it (only with --resolve).' } },
    check: parsed => parsed.flag('--reply') && !parsed.flag('--resolve') ? '--reply needs --resolve' : undefined },
];

/** Every review thread of the PR across all pages, resolved or not. The number is the id of the first comment (the digits after `#discussion_r` in its link). */
function readThreads(pr) {
  const threads = [];
  for (let after; ;) {
    const page = graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
      reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:1){nodes{databaseId url body author{login}}}}}}}}`,
    { owner, name, number: pr, ...(after && { after }) }).repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const comment = node.comments.nodes[0];
      threads.push({ id: node.id, number: comment?.databaseId, resolved: node.isResolved, outdated: node.isOutdated, path: node.path, line: node.line,
        author: comment?.author?.login ?? 'unknown', url: comment?.url ?? 'unreadable thread', first: (comment?.body ?? '').split('\n').find(line => line.trim())?.trim().slice(0, 100) ?? '' });
    }
    if (!page.pageInfo.hasNextPage) return threads;
    assert.ok(page.pageInfo.endCursor && page.pageInfo.endCursor !== after, 'Thread pagination did not advance');
    after = page.pageInfo.endCursor;
  }
}

const line = thread => `thread ${thread.number} @${thread.author} ${thread.path ?? 'no file'}${thread.line ? `:${thread.line}` : ''} outdated: ${thread.outdated ? 'yes' : 'no'} - ${thread.first} - ${thread.url}`;

function threads() {
  const all = readThreads(number), open = all.filter(thread => !thread.resolved);
  const named = [...new Set(args.values('--resolve').map(Number))];
  if (!named.length) {
    return result('ok', 'THREADS', { headline: `open threads: ${open.length}`, notes: open.map(line), data: { open: open.map(thread => thread.number) } });
  }
  // All numbers are checked before the first write: a number of another PR (or a typo) is not one of this PR's threads.
  const unknown = named.filter(wanted => !all.some(thread => thread.number === wanted));
  if (unknown.length) return failed(`no review thread ${unknown.join(', ')} on PR #${number}; nothing was changed (list them with: board.mjs threads ${number})`);
  const reply = args.value('--reply'), resolved = [], skipped = [];
  for (const wanted of named) {
    const thread = all.find(candidate => candidate.number === wanted);
    if (thread.resolved) { skipped.push(wanted); continue; }
    if (reply !== undefined) {
      graphql('mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}', { thread: thread.id, body: reply });
    }
    const written = graphql('mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}', { thread: thread.id });
    assert.ok(written.resolveReviewThread?.thread?.isResolved === true, `Thread ${wanted} is not resolved after the write`);
    resolved.push(wanted);
    progress(`thread ${wanted} resolved`);
  }
  const left = open.filter(thread => !resolved.includes(thread.number));
  const dismissed = resolved.length ? dismissStaleBotReviews(left) : [];
  return result('ok', 'RESOLVED', { headline: `resolved threads: ${resolved.length}, open threads: ${left.length}`,
    notes: [...skipped.map(wanted => `thread ${wanted} was already resolved`), ...dismissed.map(bot => `dismissed stale change request by ${bot}: all its threads are resolved`), ...left.map(line)],
    data: { resolved, skipped, open: left.map(thread => thread.number), dismissed } });
}

/**
 * #958: a bot (CodeRabbit …) often checks the fixed head with a plain comment, so its old change request stands and blocks the merge.
 * It is dismissed when none of the bot's threads is open and the bot has reviewed the current head after that request. A person's
 * review is never touched: only authors GitHub types as Bot qualify. Returns the bots whose request was dismissed.
 */
function dismissStaleBotReviews(left) {
  const repository = `repos/${owner}/${name}`, head = rest(`${repository}/pulls/${number}`).head.sha;
  const reviews = restAll(`${repository}/pulls/${number}/reviews`).filter(review => review.user?.type === 'Bot');
  const dismissed = [];
  for (const bot of new Set(reviews.map(review => login(review.user)))) {
    const own = reviews.filter(review => login(review.user) === bot);
    const standing = own.findLast(review => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state));
    if (standing?.state !== 'CHANGES_REQUESTED' || standing.commit_id === head || !own.some(review => review.commit_id === head)) continue;
    if (left.some(thread => thread.author === bot)) continue;
    github.write('PUT', `${repository}/pulls/${number}/reviews/${standing.id}/dismissals`,
      { fields: { message: `All review threads of ${bot} are resolved and it has reviewed head ${head.slice(0, 7)}; the change request is stale.` } });
    dismissed.push(bot);
  }
  return dismissed;
}

export { threads };
