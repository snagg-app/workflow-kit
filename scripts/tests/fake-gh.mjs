import fs from 'node:fs';

// The fake `gh` of the board tests: what `gh api …` and `gh pr merge …` answer, read from files in the working directory
// (the checkout of the test). board-worker.mjs hands every gh call of board.mjs to fakeGh instead of starting a process.
// Each script is the former stand-alone script of the fixture: argv is what its process.argv was, exit() what process.exit() was.

class Exit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

/** gh api GRAPHQL_OR_REST_PATH … */
function api(argv, input, stdout, stderr, exit) {
  const path = argv[2] ?? '';
  if (!path.startsWith('graphql')) {
    if (fs.existsSync('fail') || (fs.existsSync('fail-rest') && !path.includes('/contents/'))) exit(1);
    // REST lists (comments, reviews, reactions) come in pages of 100, like GitHub.
    const parts = path.split('?')[0].split('/');
    const backlink = 'backlink-' + parts[4] + '.json';
    if (parts[3] === 'contents') {
      // The project settings on the PR base: base-project.json (a branch ahead of the checkout), else the checkout's own file; base-missing: not there.
      // Not hit by fail-rest, so the tests of the reads after the settings keep their verdict. The ref asked for is kept.
      fs.appendFileSync('contents-refs', new URLSearchParams(path.split('?')[1]).get('ref') + '\n');
      if (fs.existsSync('base-missing')) { stderr('gh: Not Found (HTTP 404)\n'); exit(1); }
      const settings = fs.readFileSync(fs.existsSync('base-project.json') ? 'base-project.json' : '.github/workflow-project.json');
      stdout(JSON.stringify({ encoding: 'base64', content: settings.toString('base64') }));
      exit(0);
    }
    // `start`: the assignee shows in the issue at once; a new Draft PR is number 7 (its request is kept in created-pr).
    if (parts[3] === 'issues' && parts[5] === 'assignees' && argv.includes('POST')) {
      const issue = JSON.parse(fs.readFileSync('issue.json'));
      fs.writeFileSync('issue.json', JSON.stringify({ ...issue, assignees: { nodes: [{ login: 'worker' }] } }));
      stdout('{}');
      exit(0);
    }
    if (parts[3] === 'pulls' && parts.length === 4 && argv.includes('POST')) {
      fs.writeFileSync('created-pr', argv.slice(3).join('\n') + '\n' + input);
      stdout('{"number":7}');
      exit(0);
    }
    if (parts[3] === 'issues' && parts.length === 4 && argv.includes('POST')) {
      // A new issue: the request is kept for the test (created.json the last one, creates.json all of them), the answer is prepared by it:
      // create-response.json for every call, or create-responses.json, one after the other.
      fs.writeFileSync('created.json', input);
      fs.appendFileSync('creates', input + '\n');
      if (fs.existsSync('create-responses.json')) {
        const answers = JSON.parse(fs.readFileSync('create-responses.json'));
        if (!answers.length) exit(1);
        fs.writeFileSync('create-responses.json', JSON.stringify(answers.slice(1)));
        stdout(JSON.stringify(answers[0]));
      } else stdout(fs.readFileSync('create-response.json'));
      exit(0);
    }
    if (parts[3] === 'issues' && parts[5] === 'events') {
      // The events of an issue (events-N.json, default none): the sweep looks for a reopen after the merge.
      const file = `events-${parts[4]}.json`;
      stdout(fs.existsSync(file) ? fs.readFileSync(file) : '[]');
      exit(0);
    }
    if (parts[3] === 'issues' && parts.length === 5 && argv.includes('PATCH')) {
      const issue = JSON.parse(fs.readFileSync(backlink));
      if (argv.includes('state=closed')) {
        // `merge --stack` closing an issue: the reason is kept, the call is listed.
        fs.appendFileSync('calls', `close ${parts[4]} ${argv.find(arg => arg.startsWith('state_reason='))}\n`);
        fs.writeFileSync(backlink, JSON.stringify({ ...issue, state: 'closed' }));
        stdout('{}');
        exit(0);
      }
      // A body write; body-overwritten is what another session writes right after it.
      // Like gh: body=@- is stdin, body=@<path> a file.
      const source = argv.find(arg => arg.startsWith('body=@')).slice(6);
      issue.body = (fs.existsSync('body-overwritten') ? fs.readFileSync('body-overwritten', 'utf8') : source === '-' ? input : fs.readFileSync(source, 'utf8'));
      fs.writeFileSync(backlink, JSON.stringify(issue));
      fs.appendFileSync('patches', 'x\n');
      stdout(JSON.stringify(issue));
      exit(0);
    }
    if (parts[3] === 'issues' && parts.length === 5) {
      stdout(JSON.stringify({ labels: [], ...JSON.parse(fs.readFileSync(backlink)) }));
      exit(0);
    }
    const comments = 'backlink-comments-' + parts[4] + '.json';
    if (parts[3] === 'issues' && parts[5] === 'comments' && argv.includes('POST')) {
      // A comment write; comment-noop is GitHub accepting it without showing it.
      fs.appendFileSync('comment-writes', 'x\n');
      // `done` posts the handoff comment: it shows in the PR's comments as the driver's.
      if (input.startsWith('## Übergabe')) {
        const posted = JSON.parse(fs.readFileSync('issues-comments.json'));
        const now = '2999-01-01T00:00:00Z';
        posted.push({ id: 901, user: { login: 'worker', type: 'User' }, body: input, html_url: 'h', created_at: now, updated_at: now });
        fs.writeFileSync('issues-comments.json', JSON.stringify(posted));
        stdout('{}');
        exit(0);
      }
      if (!fs.existsSync('comment-noop')) {
        const items = JSON.parse(fs.readFileSync(comments));
        items.push({ id: items.length + 1, user: { login: 'worker' }, created_at: '2026-10-07T00:00:00Z', body: input, html_url: 'https://github.com/test/example/issues/1#issuecomment-' + (items.length + 1) });
        fs.writeFileSync(comments, JSON.stringify(items));
        fs.writeFileSync(backlink, JSON.stringify({ ...JSON.parse(fs.readFileSync(backlink)), comments: items.length }));
      }
      stdout('{}');
      exit(0);
    }
    if (parts[3] === 'issues' && parts[5] === 'comments' && fs.existsSync(comments)) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
      const items = JSON.parse(fs.readFileSync(comments));
      stdout(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
      exit(0);
    }
    // What merge does to the repository, in order (calls): update-branch, merge, delete of the head branch.
    if (parts[3] === 'pulls' && parts[5] === 'update-branch' && argv.includes('PUT')) {
      // update-fails: GitHub refuses (conflict, or the head is not the expected one). Otherwise the base is part of the branch now;
      // the new head shows through pr-reads.json, which GitHub also shows late.
      fs.appendFileSync('calls', `update-branch ${argv.find(arg => arg.startsWith('expected_head_sha=')).slice(18)}\n`);
      // update-fails: GitHub refuses; "403" in the file: the refusal of a PR with stacked children, "no-code": the same text without the status.
      if (fs.existsSync('update-fails')) {
        const kind = fs.readFileSync('update-fails', 'utf8'), text = 'Updating a stacked PR\'s branch via this endpoint is not supported.';
        stderr(kind === '403' ? `gh: ${text} (HTTP 403)\n` : kind === 'no-code' ? `gh: ${text}\n` : 'gh: merge conflict (HTTP 422)\n');
        exit(1);
      }
      fs.rmSync('compare.json', { force: true });
      stdout('{"message":"Updating pull request branch."}');
      exit(0);
    }
    if (parts[3] === 'pulls' && parts[5] === 'merge-async' && argv.includes('PUT')) {
      // merge-async answers 202 and merges in the background: merge-async-late shows the merge from the second read on, merge-async-fails is GitHub refusing.
      fs.appendFileSync('calls', 'merge-async\n');
      // Like GitHub for a stacked PR (#492): no version header, no endpoint.
      if (!argv.includes('X-GitHub-Api-Version: 2026-03-10')) { stderr('gh: Not Found (HTTP 404)\n'); exit(1); }
      fs.appendFileSync('async-merges', argv.filter(arg => /^(merge_action|merge_method|sha)=/.test(arg)).join(' ') + '\n');
      if (fs.existsSync('merge-async-fails')) { stderr('gh: Forbidden (HTTP 403)\n'); exit(1); }
      const merged = { state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } };
      if (fs.existsSync('merge-async-late')) fs.writeFileSync('pr-reads.json', JSON.stringify([{}, merged]));
      else fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), ...merged }));
      // stack-prs.json: GitHub merges the layers below the merged top with it (`merge --stack`), unless stack-layers-stay is set.
      if (fs.existsSync('stack-prs.json') && !fs.existsSync('stack-layers-stay')) {
        const layers = JSON.parse(fs.readFileSync('stack-prs.json'));
        fs.writeFileSync('stack-prs.json', JSON.stringify(Object.fromEntries(Object.entries(layers).map(([key, layer]) => [key, { ...layer, ...merged }]))));
      }
      stdout('{"status":"pending"}');
      exit(0);
    }
    if (parts[3] === 'pulls' && parts.length === 4) {
      // The open PRs on a base branch (dependents.json: PRs with base.ref, the default is none).
      const base = new URLSearchParams(path.split('?')[1]).get('base');
      stdout(JSON.stringify((fs.existsSync('dependents.json') ? JSON.parse(fs.readFileSync('dependents.json')) : []).filter(pr => pr.base.ref === base)));
      exit(0);
    }
    if (parts[3] === 'git' && argv.includes('DELETE')) {
      // delete-fails: GitHub refuses; delete-gone: the branch was deleted already.
      fs.appendFileSync('calls', `delete ${decodeURIComponent(parts.slice(6).join('/'))}\n`);
      if (fs.existsSync('delete-gone')) { stderr('gh: Reference does not exist (HTTP 422)\n'); exit(1); }
      if (fs.existsSync('delete-fails')) { stderr('gh: Resource not accessible by integration (HTTP 403)\n'); exit(1); }
      exit(0);
    }
    if (parts.length === 3) {
      // auto-delete: the repository setting "Automatically delete head branches" is on.
      stdout(JSON.stringify({ default_branch: 'main', delete_branch_on_merge: fs.existsSync('auto-delete') }));
      exit(0);
    }
    if (parts[3] === 'stacks') {
      // The stack read-back: by default PR 5 and PR 7 are linked in one open stack.
      if (fs.existsSync('fail-stacks')) exit(1);
      // stacks-reads.json: a stack that changes between reads; each read takes the first entry, the last one stays.
      if (fs.existsSync('stacks-reads.json')) {
        const reads = JSON.parse(fs.readFileSync('stacks-reads.json'));
        stdout(JSON.stringify(reads.length > 1 ? reads.shift() : reads[0]));
        fs.writeFileSync('stacks-reads.json', JSON.stringify(reads));
        exit(0);
      }
      stdout(fs.existsSync('stacks.json') ? fs.readFileSync('stacks.json') : '[]');
      exit(0);
    }
    const branchHead = decodeURIComponent(parts.slice(4).join('/')).split('...')[1];
    if (parts[3] === 'compare' && fs.existsSync('branches.json') && JSON.parse(fs.readFileSync('branches.json')).includes(branchHead)) {
      // A branch of an issue against its base (#504). branch-work.json: { BRANCH: { ahead, hours } } = own commits and the age of the newest; by default one fresh commit.
      const { ahead = 1, hours = 0 } = fs.existsSync('branch-work.json') ? JSON.parse(fs.readFileSync('branch-work.json'))[branchHead] ?? {} : {};
      fs.appendFileSync('calls', `compare ${parts.slice(4).join('/')}\n`);
      if (fs.existsSync('compare-404')) { stderr('gh: Not Found (HTTP 404)\n'); exit(1); }
      stdout(JSON.stringify({ ahead_by: ahead, commits: Array.from({ length: ahead }, () => ({ commit: { committer: { date: new Date(Date.now() - hours * 3_600_000).toISOString() } } })) }));
      exit(0);
    }
    if (parts[3] === 'compare') {
      // compare.json: { behind: commits the base gained, own: files of the PR, base: files of the base }; by default the base has not moved.
      const moved = fs.existsSync('compare.json') ? JSON.parse(fs.readFileSync('compare.json')) : { behind: 0, own: [], base: [] };
      // gh cuts a request at an unencoded "#", so a ref that is not encoded never reaches GitHub whole.
      if (path.includes('#')) exit(1);
      // BASE...HEAD lists the PR's files, HEAD...BASE those of the base. GitHub lists up to 300 files, all on page 1.
      const base = decodeURIComponent(parts.slice(4).join('/')).split('...')[0];
      const forward = base === JSON.parse(fs.readFileSync('pr.json')).baseRefName;
      const files = (forward ? moved.own : moved.base).slice(0, 300).map(filename => ({ filename }));
      // stack-compare.json: the status of the upper head against the base PR's head (ahead unless the test says the base moved on).
      const status = fs.existsSync('stack-compare.json') ? JSON.parse(fs.readFileSync('stack-compare.json')).status : 'ahead';
      stdout(JSON.stringify({ status, behind_by: forward ? moved.behind : 0, files }));
      exit(0);
    }
    if (parts[3] === 'activity') {
      // The branch's push log; by default the head was set long ago.
      const head = JSON.parse(fs.readFileSync('pr.json')).headRefOid;
      stdout(fs.existsSync('activity.json') ? fs.readFileSync('activity.json') : JSON.stringify([{ after: head, timestamp: '2000-01-01T00:00:00Z' }]));
      exit(0);
    }
    if (parts[3] === 'actions') {
      // The workflow runs of the head branch (runs.json, by default none).
      stdout(JSON.stringify({ workflow_runs: fs.existsSync('runs.json') ? JSON.parse(fs.readFileSync('runs.json')) : [] }));
      exit(0);
    }
    if (parts[3] === 'pulls' && parts.length === 5 && argv.includes('PATCH')) {
      // A PR closed by `done` (no change) or a body written by `start` (a taken-over claim): both are kept in pr.json.
      fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), ...argv.includes('body=@-') ? { body: input } : { state: 'CLOSED' } }));
      stdout('{}');
      exit(0);
    }
    if (parts[3] === 'pulls' && parts.length === 5) {
      // The PR as REST shows it, derived from pr.json so GraphQL and REST agree. Each read takes the next overlay of pr-rest-reads.json
      // (the last one stays) and applies it to pr.json: a change that becomes visible between two rounds of `wait`. Reads are counted in rest-reads.
      fs.appendFileSync('rest-reads', 'x\n');
      if (fs.existsSync('pr-rest-reads.json')) {
        const reads = JSON.parse(fs.readFileSync('pr-rest-reads.json'));
        const overlay = reads.length > 1 ? reads.shift() : reads[0];
        fs.writeFileSync('pr-rest-reads.json', JSON.stringify(reads));
        fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), ...overlay }));
      }
      const pr = JSON.parse(fs.readFileSync('pr.json'));
      stdout(JSON.stringify({ number: pr.number, html_url: pr.url, state: pr.state === 'OPEN' ? 'open' : 'closed', merged: pr.state === 'MERGED', draft: pr.isDraft, changed_files: pr.changedFiles, body: pr.body, updated_at: pr.updatedAt ?? 'u',
        mergeable_state: String(pr.mergeStateStatus).toLowerCase(), head: { sha: pr.headRefOid, ref: pr.headRefName, repo: { full_name: pr.headRepository?.nameWithOwner } }, base: { ref: pr.baseRefName, sha: pr.baseRefOid } }));
      exit(0);
    }
    if (parts[3] === 'commits' && parts[5] === 'statuses') {
      // The commit statuses of the head, derived from pr.json.
      const { commit } = JSON.parse(fs.readFileSync('pr.json')).commits.nodes[0];
      stdout(JSON.stringify((commit.statusCheckRollup?.contexts.nodes ?? []).filter(node => node.__typename === 'StatusContext').map(({ context, state }) => ({ context, state }))));
      exit(0);
    }
    if (parts[3] === 'commits' && parts.length === 5) {
      // A merge commit: its first parent is the base before the merge.
      stdout(JSON.stringify({ parents: [{ sha: 'b'.repeat(40) }] }));
      exit(0);
    }
    if (parts[3] === 'commits' && ['check-runs', 'check-suites', 'status'].includes(parts[5])) {
      // The checks of the head, also derived from pr.json.
      const { commit } = JSON.parse(fs.readFileSync('pr.json')).commits.nodes[0];
      const contexts = commit.statusCheckRollup?.contexts.nodes ?? [];
      const pick = nodes => nodes.map((node, id) => ({ id, status: node.status?.toLowerCase(), conclusion: node.conclusion?.toLowerCase() }));
      stdout(JSON.stringify({
        'check-runs': { check_runs: pick(contexts.filter(node => node.__typename === 'CheckRun')) },
        'check-suites': { check_suites: pick(commit.checkSuites.nodes) },
        status: { statuses: contexts.filter(node => node.__typename === 'StatusContext').map(node => ({ context: node.context, state: node.state, description: node.description })) },
      }[parts[5]]));
      exit(0);
    }
    if (parts[3] === 'pulls' && parts[5] === 'reviews' && parts[7] === 'dismissals' && argv.includes('PUT')) {
      // Dismissing a review: the id and the message are kept in calls.
      fs.appendFileSync('calls', `dismiss ${parts[6]} ${argv.find(arg => arg.startsWith('message=')).slice(8)}\n`);
      stdout('{}');
      exit(0);
    }
    if (parts[3] === 'branches' && parts.length === 4) {
      // The branches of the repository (branches.json: names, the default is none), as `next` reads them.
      stdout(JSON.stringify((fs.existsSync('branches.json') ? JSON.parse(fs.readFileSync('branches.json')) : []).map(name => ({ name }))));
      exit(0);
    }
    const file = parts.at(-3) + '-' + parts.at(-1) + '.json';
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
    if (parts[5] === 'sub_issues' && page === 1 && fs.existsSync('sub-issues-reads.json')) {
      const reads = JSON.parse(fs.readFileSync('sub-issues-reads.json'));
      const next = reads.length > 1 ? reads.shift() : reads[0];
      fs.writeFileSync('sub-issues-reads.json', JSON.stringify(reads));
      stdout(JSON.stringify(next));
      exit(0);
    }
    const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    stdout(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
    exit(0);
  }
  const query = argv.find(arg => arg.startsWith('query=')).slice(6);
  if (fs.existsSync('fail') || (fs.existsSync('fail-viewer') && query.startsWith('query{viewer'))) exit(1);
  // `gh api -i` prints the status line and the headers before the body, on a failure too. The quota headers come with
  // quota-left (the points GitHub reports as left, to be spent until three seconds from now) and with limited (none left, reset within a second).
  const answer = (body, quota) => {
    const [remaining, reset] = quota ?? (fs.existsSync('quota-left') ? [Number(fs.readFileSync('quota-left', 'utf8')), Math.ceil((Date.now() + 3000) / 1000)] : []);
    const headers = ['HTTP/2.0 200 OK', 'Content-Type: application/json; charset=utf-8', ...remaining === undefined ? [] : [`X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Reset: ${reset}`]];
    stdout(argv.includes('-i') ? `${headers.join('\r\n')}\r\n\r\n${body}` : body);
  };
  if (query.startsWith('mutation') && query.includes('updateProjectV2ItemFieldValue') && fs.existsSync('status-quota-retry')) {
    fs.unlinkSync('status-quota-retry');
    fs.writeFileSync('issues-sub_issues.json', JSON.stringify([{ number: 3, state: 'open' }]));
    answer(JSON.stringify({ errors: [{ type: 'RATE_LIMIT', message: 'API rate limit already exceeded for user ID 1.' }] }), [4000, Math.ceil((Date.now() + 3000) / 1000)]);
    stderr('gh: API rate limit already exceeded for user ID 1.\n');
    exit(1);
  }
  // limited: GitHub refuses the next query, like its RATE_LIMIT error, and takes the file away: the quota is back after one wait.
  // "free" in the file: the refusal is stale, its own headers show 4000 points left and a reset three seconds away.
  if (fs.existsSync('limited') || fs.existsSync('limited-200')) {
    const limitedFile = fs.existsSync('limited') ? 'limited' : 'limited-200';
    const stale = fs.readFileSync(limitedFile, 'utf8') === 'free';
    fs.unlinkSync(limitedFile);
    answer(JSON.stringify({ errors: [{ type: 'RATE_LIMIT', code: 'graphql_rate_limit', message: 'API rate limit already exceeded for user ID 1.' }] }),
      stale ? [4000, Math.ceil((Date.now() + 3000) / 1000)] : [0, Math.floor(Date.now() / 1000) + 1]);
    if (!stale) fs.writeFileSync('quota-left', '4000'); // the retry after reset carries a fresh positive quota header
    if (limitedFile === 'limited-200') return;
    stderr('gh: API rate limit already exceeded for user ID 1.\n');
    exit(1);
  }
  // Every query that reached GitHub, one JSON string per line: what a test reads to count queries and see what they ask for.
  fs.appendFileSync('queries', JSON.stringify(query) + '\n');
  // resource-limit (a number): GitHub refuses a request that names more issues than that; resource-stuck (a node id): and every request that names this issue.
  if (fs.existsSync('resource-limit') || fs.existsSync('resource-stuck')) {
    const named = new Set([...query.matchAll(/(?:contentId|itemId|issueId):"(?:PI-)?([^"]*)"/g)].map(match => match[1]));
    for (const [, ids] of query.matchAll(/nodes\(ids:(\[[^\]]*\])/g)) JSON.parse(ids).forEach(id => named.add(id.replace(/^PI-/, '')));
    if ((fs.existsSync('resource-limit') && named.size > Number(fs.readFileSync('resource-limit', 'utf8'))) || named.has(fs.existsSync('resource-stuck') && fs.readFileSync('resource-stuck', 'utf8'))) {
      answer(JSON.stringify({ errors: [{ type: 'RESOURCE_LIMITS_EXCEEDED', message: 'Resource limits for this query exceeded' }] }));
      stderr('gh: Resource limits for this query exceeded\n');
      exit(1);
    }
  }
  let data;
  if (query.startsWith('mutation')) {
    // mutation-fails: GitHub refuses every write.
    if (fs.existsSync('mutation-fails')) exit(1);
    fs.appendFileSync('mutations', query + '\n');
    // The item or issue each mutation wrote to, one line per mutation.
    fs.appendFileSync('mutation-targets', argv.filter(arg => /^(item|issue)=/.test(arg)).join(' ') + '\n');
    if (/\bm\d+:\w+\(/.test(query)) {
      // Aliased mutations (m0:…, m1:…) with their values written into the query: items are PI-<issue id>, kept per item in
      // stored-items.json ({ item: { field: option } }); add-exists is GitHub refusing the add of every issue, but answering the rest.
      const items = fs.existsSync('stored-items.json') ? JSON.parse(fs.readFileSync('stored-items.json')) : {};
      const values = fs.existsSync('stored-values.json') ? JSON.parse(fs.readFileSync('stored-values.json')) : {};
      const result = {};
      let refused = false;
      for (const call of query.slice('mutation{'.length, -1).split(/ (?=m\d+:)/)) {
        const [, alias, name] = /^(m\d+):(\w+)/.exec(call);
        const argument = key => new RegExp(`${key}:"([^"]*)"`).exec(call)?.[1];
        if (name === 'addProjectV2ItemById') {
          refused ||= fs.existsSync('add-exists');
          result[alias] = refused ? null : { item: { id: `PI-${argument('contentId')}` } };
        } else {
          const target = argument('itemId') ?? argument('issueId');
          items[target] = { ...items[target], [argument('fieldId')]: argument('singleSelectOptionId') };
          values[argument('fieldId')] = argument('singleSelectOptionId');
          result[alias] = {};
        }
      }
      fs.writeFileSync('stored-items.json', JSON.stringify(items));
      fs.writeFileSync('stored-values.json', JSON.stringify(values));
      if (refused) {
        answer(JSON.stringify({ data: result, errors: [{ message: 'Content already exists in this project' }] }));
        stderr('gh: Content already exists in this project\n');
        exit(1);
      }
      return answer(JSON.stringify({ data: result }));
    }
    const option = argv.find(arg => arg.startsWith('option='));
    if (option) fs.writeFileSync('stored', option.slice(7));
    // Per field, so a call that sets several fields can be read back field by field.
    const fieldId = argv.find(arg => arg.startsWith('field='));
    if (option && fieldId) {
      const values = fs.existsSync('stored-values.json') ? JSON.parse(fs.readFileSync('stored-values.json')) : {};
      fs.writeFileSync('stored-values.json', JSON.stringify({ ...values, [fieldId.slice(6)]: option.slice(7) }));
    }
    if (query.includes('addCloseIssueReferences') && !fs.existsSync('link-noop')) {
      // link-delay: the connection shows only after that many reads, like GitHub's delayed consistency.
      const delay = fs.existsSync('link-delay') ? Number(fs.readFileSync('link-delay', 'utf8')) : 0;
      const before = JSON.parse(fs.readFileSync('pr.json'));
      fs.writeFileSync('pr.json', JSON.stringify(delay ? { ...before, linkPending: delay } : { ...before, linkPages: [['I1']] }));
    }
    // sub-noop: GitHub accepted the call but the link is not readable afterwards.
    if (query.includes('addSubIssue') && !fs.existsSync('sub-noop')) {
      fs.writeFileSync('child.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('child.json')), parent: { number: 1, repository: { nameWithOwner: 'Test/Example' } } }));
    }
    if (query.includes('markPullRequestReadyForReview') && !fs.existsSync('ready-noop')) {
      fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), isDraft: false }));
    }
    if (query.includes('addProjectV2ItemById')) {
      // add-exists: the Project's own automation was faster, so GitHub refuses like this and the item is readable now
      // (unless add-exists-unreadable); add-fails: any other refusal.
      if (fs.existsSync('add-exists')) {
        if (!fs.existsSync('add-exists-unreadable')) fs.copyFileSync('issue-with-item.json', 'issue.json');
        stderr('gh: Content already exists in this project\n');
        exit(1);
      }
      if (fs.existsSync('add-fails')) {
        stderr('gh: Resource not accessible by integration\n');
        exit(1);
      }
      data = { addProjectV2ItemById: { item: { id: 'PI1' } } };
    } else data = {};
  } else if (query.startsWith('query{viewer')) data = { viewer: { login: 'worker' } };
  else if (query.includes('items:nodes(ids:') || query.includes('issues:nodes(ids:')) {
    // The read-back of a batch: the values of the items (PI-<issue id>) and of the issues, as the mutations stored them.
    // lost: the API accepted the writes but every field reads back as this value.
    const names = { F1: 'Status', F2: 'Priority', F3: 'Size' };
    const stored = fs.existsSync('stored-items.json') ? JSON.parse(fs.readFileSync('stored-items.json')) : {};
    const lost = fs.existsSync('lost') && fs.readFileSync('lost', 'utf8');
    const read = key => {
      const ids = new RegExp(`${key}:nodes\\(ids:(\\[[^\\]]*\\])`).exec(query)?.[1];
      return ids && JSON.parse(ids).map(id => ({ fieldValues: { nodes: Object.entries(stored[id] ?? {}).map(([field, name]) => ({ name: lost || name, field: { name: names[field] } })) }, issueFieldValues: { nodes: [] } }));
    };
    data = { items: read('items'), issues: read('issues') };
  }
  else if (query.startsWith('query{nodes(ids:') && query.includes('projectItems(first:100){nodes{id project{id}}}')) {
    // The item of an issue the Project's own automation added first (add-exists-unreadable: it is not readable).
    const ids = JSON.parse(/nodes\(ids:(\[[^\]]*\])/.exec(query)[1]);
    data = { nodes: ids.map(id => ({ projectItems: { nodes: fs.existsSync('add-exists-unreadable') ? [] : [{ id: `PI-${id}`, project: { id: 'P1' } }] } })) };
  }
  else if (query.includes('nodes(ids:')) {
    // The PRs that close predecessors, read by id: deliveries.json maps an id to its closedByPullRequestsReferences; an id it lacks is unreadable.
    const deliveries = JSON.parse(fs.readFileSync('deliveries.json'));
    // assignees.json (optional) maps an id to the logins of its assignees.
    const assignees = fs.existsSync('assignees.json') ? JSON.parse(fs.readFileSync('assignees.json')) : {};
    data = { nodes: JSON.parse(/nodes\(ids:(\[[^\]]*\])/.exec(query)[1]).map(id => deliveries[id]
      ? { closedByPullRequestsReferences: deliveries[id], assignees: { nodes: (assignees[id] ?? []).map(login => ({ login })) } } : {}) };
  }
  else if (query.includes('fieldValues(first:100)')) {
    const names = { F1: 'Status', F2: 'Priority', F3: 'Size' };
    const values = JSON.parse(fs.readFileSync('stored-values.json'));
    // lost: the API accepted the writes but every field reads back as this value.
    const lost = fs.existsSync('lost') && fs.readFileSync('lost', 'utf8');
    data = { repository: { issue: { issueFieldValues: { nodes: [] },
      projectItems: { nodes: [{ project: { id: 'P1' }, fieldValues: { nodes: Object.entries(values).map(([id, name]) => ({ name: lost || name, field: { name: names[id] } })) } }] } } } };
  }
  else if (query.includes('reviewThreads(first:100')) {
    const stackPrs = fs.existsSync('stack-prs.json') ? JSON.parse(fs.readFileSync('stack-prs.json')) : {};
    let pr = stackPrs[Number(argv.find(arg => arg.startsWith('number='))?.slice(7))] ?? JSON.parse(fs.readFileSync('pr.json'));
    if (query.includes('readyEvents') && fs.existsSync('pr-reads.json')) {
      const reads = JSON.parse(fs.readFileSync('pr-reads.json'));
      const overlay = reads.length > 1 ? reads.shift() : reads[0];
      fs.writeFileSync('pr-reads.json', JSON.stringify(reads));
      pr = { ...pr, ...overlay };
      fs.writeFileSync('pr.json', JSON.stringify(pr));
    }
    const pages = pr.threadPages ?? [[]];
    const cursor = argv.find(arg => arg.startsWith('after='));
    const index = cursor ? Number(cursor.slice(6)) : 0;
    const reviewThreads = { pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
      nodes: pages[index].map(isResolved => ({ isResolved, comments: { nodes: [{ url: 'thread-' + index }] } })) };
    data = query.includes('readyEvents')
      ? { repository: { pullRequest: { ...pr, reviewThreads } } }
      : { repository: { pullRequest: { reviewThreads } } };
  }
  else if (query.includes('closingIssuesReferences')) {
    if (fs.existsSync('fail-links')) exit(1);
    const stackPrs = fs.existsSync('stack-prs.json') ? JSON.parse(fs.readFileSync('stack-prs.json')) : {};
    let pr = stackPrs[Number(argv.find(arg => arg.startsWith('number='))?.slice(7))] ?? JSON.parse(fs.readFileSync('pr.json'));
    if (pr.linkPending !== undefined) {
      pr = pr.linkPending > 0 ? { ...pr, linkPending: pr.linkPending - 1 } : { ...pr, linkPending: undefined, linkPages: [['I1']] };
      fs.writeFileSync('pr.json', JSON.stringify(pr));
    }
    const pages = pr.linkPages ?? [[]];
    const cursor = argv.find(arg => arg.startsWith('after='));
    const index = cursor ? Number(cursor.slice(6)) : 0;
    if (fs.existsSync('changed-issue.json')) fs.copyFileSync('changed-issue.json', 'issue.json');
    if (pr.prAfterLinks) fs.writeFileSync('pr.json', JSON.stringify(pr.prAfterLinks));
    data = { repository: { pullRequest: { state: pr.state, isDraft: pr.isDraft,
      headRefOid: pr.changedHead ?? pr.headRefOid,
      closingIssuesReferences: { totalCount: pr.linkTotal ?? pages.flat().length,
        pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
        nodes: pages[index].map(id => id === null ? null : { id, number: Number(String(id).replace(/\D/g, '')) }) } } } };
  }
  else if (query.includes('pullRequest(number')) {
    const number = Number(argv.find(arg => arg.startsWith('number='))?.slice(7));
    if (number === 7 && fs.existsSync('pr-reads.json')) {
      // Each read takes the next prepared overlay and the last one stays: metadata that catches up after a push.
      const reads = JSON.parse(fs.readFileSync('pr-reads.json'));
      const overlay = reads.length > 1 ? reads.shift() : reads[0];
      fs.writeFileSync('pr-reads.json', JSON.stringify(reads));
      fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), ...overlay }));
    }
    const stackPrs = fs.existsSync('stack-prs.json') ? JSON.parse(fs.readFileSync('stack-prs.json')) : {};
    data = { repository: { pullRequest: stackPrs[number] ?? JSON.parse(fs.readFileSync('pr.json')) } };
  }
  else if (query.includes('issue(number:$number){id parent{')) data = { repository: { issue: JSON.parse(fs.readFileSync('child.json')) } };
  else if (query.includes('fields(first:100)')) data = { node: { fields: { nodes: [{
    id: 'F1', name: 'Status', options: (fs.existsSync('status-options.json') ? JSON.parse(fs.readFileSync('status-options.json'))
      : ['Backlog', 'Ready', 'In progress', 'Automated review', 'Human review', 'Done']).map(name => ({ id: name, name }))
  }, { id: 'F2', name: 'Priority', options: ['High', 'Low'].map(name => ({ id: name, name })) },
  { id: 'F3', name: 'Size', options: ['XS', 'S'].map(name => ({ id: name, name })) }] } } };
  else if (query.includes('search(')) {
    // Like GitHub: is:blocked means an open native predecessor; 'truncate' simulates the 1,000-result cap.
    const blocked = / is:blocked$/.test(argv.find(arg => arg.startsWith('q=')));
    const nodes = (fs.existsSync('search.json') ? JSON.parse(fs.readFileSync('search.json')) : [])
      .filter(issue => issue.blockedBy.nodes.some(predecessor => predecessor?.state === 'OPEN') === blocked);
    data = { viewer: { login: 'worker' }, search: { issueCount: nodes.length + Number(fs.existsSync('truncate')), pageInfo: { hasNextPage: false }, nodes } };
  }
  else {
    const issue = JSON.parse(fs.readFileSync('issue.json'));
    if (fs.existsSync('handoff-fixture') && fs.existsSync('stored')) {
      issue.projectItems.nodes[0].status.name = fs.readFileSync(fs.existsSync('lost') ? 'lost' : 'stored', 'utf8');
    }
    // branches.json: the names the branch filter of the issue query finds.
    const refs = fs.existsSync('branches.json') ? { nodes: JSON.parse(fs.readFileSync('branches.json')).map(name => ({ name })) } : { nodes: [] };
    data = { repository: { issue, refs }, ...query.includes('{viewer{login}') && { viewer: { login: 'worker' } } };
    // issue-next.json: what the issue looks like from the next read on (someone changed it in between).
    if (fs.existsSync('issue-next.json')) fs.renameSync('issue-next.json', 'issue.json');
  }
  // A query reports its cost (one point), a mutation none.
  answer(JSON.stringify({ data: data && query.startsWith('query') ? { ...data, rateLimit: { cost: 1 } } : data }));
}

/** gh pr merge …: records the call; merge-fails is gh refusing, merge-noop a merge that never shows. */
function pr(argv, input, stdout, stderr, exit) {
  fs.appendFileSync('merges', argv.slice(2).join(' ') + '\n');
  fs.appendFileSync('calls', 'merge\n');
  if (fs.existsSync('merge-fails')) { stderr('gh: Head branch was modified\n'); exit(1); }
  // merge-403: the refusal of a PR with stacked children; the file holds gh's text, empty means the GraphQL text seen on GitHub (#321).
  if (fs.existsSync('merge-403')) {
    stderr((fs.readFileSync('merge-403', 'utf8') || 'GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API. For more information, see https://docs.github.com/rest/pulls/pulls#merge-a-pull-request-asynchronously (mergePullRequest)') + '\n');
    exit(1);
  }
  if (!fs.existsSync('merge-noop')) fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), state: 'MERGED', mergeCommit: { oid: fs.existsSync('merge-oid') ? fs.readFileSync('merge-oid', 'utf8') : 'f'.repeat(40) } }));
}

/** gh issue develop …: the branch exists afterwards (branches.json), the call is kept in develops. */
function issue(argv) {
  fs.appendFileSync('develops', argv.slice(2).join(' ') + '\n');
  const known = fs.existsSync('branches.json') ? JSON.parse(fs.readFileSync('branches.json')) : [];
  fs.writeFileSync('branches.json', JSON.stringify([...known, argv[argv.indexOf('--name') + 1]]));
}

/** Runs gh with ARGS (the arguments after "gh") and returns its stdout, or throws like execFileSync on a non-zero exit. */
export function fakeGh(args, input = '') {
  const script = { api, pr, issue }[args[0]];
  if (!script) throw new Error(`The fake gh knows no command "${args[0]}"`);
  const out = [], err = [];
  try {
    script(['node', args[0], ...args.slice(1)], String(input), chunk => out.push(String(chunk)), chunk => err.push(String(chunk)), code => { throw new Exit(code); });
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    if (error.code !== 0) throw Object.assign(new Error(`Command failed: gh ${args[0]}`), { status: error.code, stdout: out.join(''), stderr: err.join('') });
  }
  return out.join('');
}
