// The one door from board.mjs to SonarCloud: open issues of a pull request analysis.
// Two variants, like github.mjs: the real request, and a test variant a test sets with useSonarAdapter (board-worker.mjs hands in fake-sonar.mjs),
// so no test patches fetch or starts a child process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

/** The SonarCloud check links the analysis of another PR (sync PRs with one head, #640). */
export class SonarOtherPr extends Error {}

let adapter; // (href, token) => { ok, status, text } like a fetch answer, read synchronously; unset means the real request
export const useSonarAdapter = fake => { adapter = fake; };

// The token goes only to these hosts, whatever URL a check run names.
const sonarHosts = ['https://sonarcloud.io', 'https://sonarqube.us'];
const sonarListed = 10; // findings printed per analysis; the count says how many more
const requestSeconds = 60;

// The review gate reads synchronously, so the request runs in a worker thread and this thread waits for its answer.
const requestScript = `const { workerData: { href, token, port, flag } } = require('node:worker_threads');
(async () => {
  try {
    const answer = await fetch(href, { headers: { Authorization: 'Bearer ' + token } });
    port.postMessage({ ok: answer.ok, status: answer.status, text: await answer.text() });
  } catch (error) { port.postMessage({ failure: String(error.message) }); }
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
})();`;

function requestInWorker(href, token) {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(requestScript, { eval: true, workerData: { href, token, port: port2, flag }, transferList: [port2] });
  try {
    assert.notEqual(Atomics.wait(flag, 0, 0, requestSeconds * 1000), 'timed-out', `Sonar API did not answer within ${requestSeconds} s`);
    const answer = receiveMessageOnPort(port1)?.message;
    assert.ok(answer && !answer.failure, `Sonar API is unreachable${answer?.failure ? `: ${answer.failure}` : ''}`);
    return answer;
  } finally {
    worker.terminate();
    port1.close();
  }
}

/** The answer of `sonar list issues` in the shape of the API answer; a missing CLI or a missing login throws in one line. */
function requestWithCli(key, prNumber) {
  const run = spawnSync('sonar', ['list', 'issues', '-p', key, '--pull-request', String(prNumber), '--format', 'json', '--page-size', String(sonarListed)], { encoding: 'utf8', timeout: requestSeconds * 1000 });
  const text = run.stdout?.slice(run.stdout.indexOf('{')) ?? '';
  const reason = run.error?.message ?? String(run.stderr || run.stdout || `exit ${run.status}`).trim().split('\n')[0];
  assert.ok(run.status === 0 && text.startsWith('{'), `Sonar is unreachable: SONAR_TOKEN is not set and \`sonar list issues\` failed (${reason}); set SONAR_TOKEN (docs/board/wait.md) or run \`sonar auth login\``);
  return { ok: true, text };
}

/**
 * OPEN and CONFIRMED issues of the pull request analysis a SonarCloud check run points at. The anonymous API reports 0
 * for private projects, so a failed read throws (never "clean"). Without a token the `sonar` CLI reads them.
 */
export function sonarIssues(detailsUrl, prNumber, token) {
  const target = new URL(detailsUrl ?? 'invalid:');
  const key = target.searchParams.get('id');
  const unlinked = `The SonarCloud check does not link PR #${prNumber}'s analysis (${detailsUrl}); open issues are unreadable`;
  assert.ok(sonarHosts.includes(target.origin) && key && target.searchParams.get('pullRequest'), unlinked);
  // Sync PRs with the same head share one analysis, and it links one of them (#640): `merge` answers with a branch update.
  if (target.searchParams.get('pullRequest') !== String(prNumber)) throw new SonarOtherPr(unlinked);
  const api = new URL('/api/issues/search', target.origin);
  api.search = new URLSearchParams({ componentKeys: key, pullRequest: String(prNumber), issueStatuses: 'OPEN,CONFIRMED', ps: String(sonarListed) });
  // #1055: the check summary counts new-code issues only ("0 New issues" behind 5 open ones), so without a token the logged-in `sonar` CLI lists them.
  const answer = adapter ? adapter(api.href, token) : token ? requestInWorker(api.href, token) : requestWithCli(key, prNumber);
  if (!answer.ok) throw new Error(`Sonar API answered ${answer.status}`);
  const { total, issues } = JSON.parse(answer.text);
  assert.ok(Number.isSafeInteger(total) && total >= 0 && Array.isArray(issues), 'Sonar issue count is unreadable');
  // One line each, so a finding is fixable without a script of its own. The message quotes code of the PR: no control characters.
  const lines = issues.slice(0, sonarListed).map(({ rule, component, line, message }) => {
    const file = String(component ?? '').replace(`${key}:`, '');
    return `sonar: ${rule} ${file}${line ? `:${line}` : ''} ${String(message ?? '').replace(/\p{Cc}+/gu, ' ')}`;
  });
  if (total > lines.length) lines.push(`sonar: … ${total - lines.length} more`);
  return { total, lines };
}
