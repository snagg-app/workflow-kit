// Renovate regenerate holds contents: write and actions: write. These tests pin who defines the workflow, who
// sees the token, and that the held CI run of the pushed commit gets approved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run as exec } from './fixtures.mjs';

const read = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const yaml = read('renovate-regenerate');
const steps = yaml.split(/^      - (?=name:|uses:)/m).slice(1);
const name = step => step.match(/name: (.+)/)?.[1];

test('the write-capable definition comes from main, not from the branch, and only the last two steps see the token', () => {
  // pull_request would load this file from the PR's merge commit, so a branch could add its own steps to it.
  assert.match(yaml, /^  pull_request_target:$/m);
  assert.doesNotMatch(yaml, /^  pull_request:/m);
  assert.match(yaml, /^permissions: \{\}$/m);
  assert.match(yaml, /sender\.login == 'renovate\[bot\]'/);
  assert.match(yaml, /^          persist-credentials: false$/m);
  // The job runs the scripts of main (copied over the branch's), never a script of the checked-out branch.
  for (const [, script] of yaml.matchAll(/\bnode (\S+\.mjs)/g)) assert.match(script, /^scripts\//);
  assert.ok(yaml.includes("':(exclude).github/workflows'"), 'a generated or changed workflow is never staged');
  const withToken = steps.filter(step => step.includes('github.token')).map(name);
  assert.deepEqual(withToken, ['Commit and push', 'Approve the repository CI']);
  assert.deepEqual(steps.slice(-2).map(name), withToken);
});

const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const head = 'a'.repeat(40);
const block = steps.find(step => name(step) === 'Approve the repository CI').split('        run: |\n')[1].replace(/^          /gm, '');

/** Runs the step with gh, git and sleep replaced; gh answers the run list as after its jq filter, one "id conclusion" per run. */
function approve({ runs = [], codeqlRuns = runs, approveFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'renovate regenerate '));
  const log = join(dir, 'gh.log').replaceAll('\\', '/');
  const result = spawnSync(bash, ['-c', `
    git() { echo ${head}; }
    sleep() { :; }
    gh() {
      echo "$*" >> "${log}"
      case "$*" in
        *"--workflow codeql.yml "*) printf '%s' "$CODEQL_RUNS" ;;
        "run list"*) printf '%s' "$RUNS" ;;
        "api "*) return ${approveFails ? 1 : 0} ;;
      esac
    }
    ${block}
  `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, RUNS: runs.join('\n'), CODEQL_RUNS: codeqlRuns.join('\n'), GITHUB_REPOSITORY: 'o/r' } });
  let ghCalls = '';
  try { ghCalls = readFileSync(log, 'utf8'); } catch { /* gh was never called */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, ghCalls };
}

test('a CI run held for approval on the pushed commit is approved; a running or finished one is left alone', () => {
  const approvals = result => result.ghCalls.split('\n').filter(call => call.startsWith('api -X POST')).length;
  const held = approve({ runs: ['7 action_required'], codeqlRuns: ['9 action_required'] });
  assert.equal(held.status, 0, held.stderr);
  assert.equal(approvals(held), 2);
  assert.match(held.ghCalls, /actions\/runs\/7\/approve/);
  assert.match(held.ghCalls, /actions\/runs\/9\/approve/);
  // The list is asked for the pushed commit and the pull_request event only.
  assert.match(held.ghCalls, new RegExp(`--event pull_request --commit ${head}`));
  for (const workflow of ['repository.yml', 'codeql.yml'])
    assert.ok(held.ghCalls.includes(`--workflow ${workflow} --event pull_request --commit ${head}`));
  for (const conclusion of ['', 'success', 'failure']) {
    const other = approve({ runs: [`8 ${conclusion}`] });
    assert.equal(other.status, 0, other.stderr);
    assert.equal(approvals(other), 0);
  }
  // No run ever appears, or the approval is refused: the job fails instead of reporting a CI that never runs.
  const none = approve();
  assert.notEqual(none.status, 0);
  assert.match(none.stdout, /No pull_request run/);
  assert.notEqual(approve({ runs: ['7 action_required'], approveFails: true }).status, 0);
  const missingCodeql = approve({ runs: ['7 success'], codeqlRuns: [] });
  assert.notEqual(missingCodeql.status, 0);
  assert.match(missingCodeql.stdout, /codeql\.yml/);
  assert.notEqual(approve({ runs: ['7 success'], codeqlRuns: ['9 action_required'], approveFails: true }).status, 0);
});

const check = steps.find(step => name(step) === 'Check who changed the branch').split('        run: |\n')[1].replace(/^          /gm, '');

/** The guard step in a real repository: main with some files, then one branch commit by `author`. */
async function guard(change, author = 'renovate[bot]') {
  const dir = mkdtempSync(join(tmpdir(), 'renovate guard '));
  const git = (...args) => exec('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  const put = (path, text = 'x\n') => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  await git('init', '-q', '-b', 'main');
  for (const path of ['.github/workflows/repository.yml', 'scripts/a.mjs', 'scripts/ponytail/adaptations.patch', 'renovate.json', '.vendor/pin']) put(path);
  await git('add', '.');
  await git('commit', '-q', '-m', 'main');
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  change({ put, git, rename: (from, to) => { mkdirSync(join(dir, to, '..'), { recursive: true }); renameSync(join(dir, from), join(dir, to)); } });
  await git('add', '-A');
  await git('commit', '-q', '--author', `${author} <a@a>`, '-m', 'branch');
  const env = join(dir, 'env');
  writeFileSync(env, '');
  const result = await exec(bash, ['-c', check], { cwd: dir, env: { ...process.env, GITHUB_ENV: env.replaceAll('\\', '/') } });
  const skipped = readFileSync(env, 'utf8').includes('SKIP=true');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, skipped };
}

test('a branch may change the pin and the generated data, nothing that decides what runs with which rights', async () => {
  // Every case has its own repository, so they run side by side.
  const paths = ['.github/workflows/repository.yml', '.github/workflows/codeql.yml', 'scripts/a.mjs', 'renovate.json'];
  const [ok, renamed, foreign, ...changes] = await Promise.all([
    guard(({ put }) => { put('.vendor/pin', 'new\n'); put('scripts/ponytail/adaptations.patch', 'new\n'); }),
    // A rename lists only its new path unless renames are switched off: the moved-away workflow must still count.
    guard(({ rename }) => rename('.github/workflows/repository.yml', 'docs/repository.yml')),
    // Commits by someone else: the branch is theirs, the job skips instead of running.
    guard(({ put }) => put('scripts/a.mjs', 'changed\n'), 'Mallory'),
    ...paths.map(path => guard(({ put }) => put(path, 'changed\n'))),
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.skipped, false);
  changes.forEach((changed, i) => {
    assert.notEqual(changed.status, 0, paths[i]);
    assert.match(changed.stdout, /not running with write access/);
  });
  assert.notEqual(renamed.status, 0);
  assert.match(renamed.stdout, /\.github\/workflows\/repository\.yml/);
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(foreign.skipped, true);
});

// The job holds contents: write, so upstream code must not move with a tag.
const unpinnedUses = text => [...text.matchAll(/^\s*(?:-[ \t]+)?uses:[ \t]+(\S+)(.*)$/gm)]
  .filter(([, ref, rest]) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref) || !/^[ \t]+# v\d\S*\s*$/.test(rest))
  .map(([, ref]) => ref);

test('the write-capable workflow runs only commit-pinned actions, and Renovate keeps the pins', () => {
  assert.match(yaml, /uses: actions\/checkout@[0-9a-f]{40}/, 'pinned uses expected');
  assert.deepEqual(unpinnedUses(yaml), []);
  assert.deepEqual(unpinnedUses('      - uses: actions/checkout@v7.0.1\n'), ['actions/checkout@v7.0.1']);
  assert.deepEqual(unpinnedUses(`      - uses: actions/checkout@${'a'.repeat(40)}\n`), ['actions/checkout@' + 'a'.repeat(40)]);
  const rules = JSON.parse(readFileSync(new URL('../../renovate.json', import.meta.url), 'utf8')).packageRules;
  const index = rules.findIndex(rule => rule.pinDigests);
  assert.deepEqual(rules[index]?.matchFileNames, ['.github/workflows/renovate-regenerate.yml']);
});
