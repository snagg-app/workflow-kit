// `threads PR [--resolve NUMBER ... [--reply TEXT]]`: lists the open review threads of a PR and closes exactly the ones the caller names.
// Its functions run nothing when imported; run-time data comes from board-context.mjs.
import assert from 'node:assert/strict';
import { failed, result } from './board-result.mjs';
import { args, graphql, name, number, owner, progress } from './board-context.mjs';

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
  return result('ok', 'RESOLVED', { headline: `resolved threads: ${resolved.length}, open threads: ${left.length}`,
    notes: [...skipped.map(wanted => `thread ${wanted} was already resolved`), ...left.map(line)], data: { resolved, skipped, open: left.map(thread => thread.number) } });
}

export { threads };
