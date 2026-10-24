#!/usr/bin/env node
// Cleans up finished Git worktrees and Docker volumes whose worktree is gone (#704).
//   node scripts/worktree-gc.mjs [--cwd PROJECT_DIR]                 dry run (default): only shows what it would do
//   node scripts/worktree-gc.mjs [--cwd PROJECT_DIR] --rm            deletes finished worktrees (parallel) and orphaned volumes
//   node scripts/worktree-gc.mjs [--cwd PROJECT_DIR] --rm --only DIR  one worktree, e.g. a driver's own after its PR is merged
// Options: --list (one line per worktree), --min-age MINUTES (default 120), --jobs N (default 8), --volume-prefix P (repeatable).
// Volumes: `worktreeVolumePrefixes` in .github/workflow-project.json lists the name prefixes; a volume is
// `<prefix><sha256(worktree root)[0:12]>[-suffix]`. Only those names are ever touched, and never a name containing
// one of `worktreeVolumeProtect` (the project's long-lived volumes; also --volume-protect, repeatable).
// A worktree is deleted only if ALL hold: no local changes, no commits missing on the remote (or in a merged PR),
// no running process, not locked by a living session, older than --min-age. Anything unclear is kept.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { enterCwd, externalTool, projectRoot } from './checkout-root.mjs';
import { gitAsyncIn } from './git-tool.mjs';
import { readProfile } from './project-profile.mjs';
import { isMain } from './is-main.mjs';

const norm = path => resolve(path).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

/** Does a running process (other than this script) have `path` in its command line? `listing` is {ok, out} of the process list.
 * An unreadable list (ok:false) counts as busy: we cannot prove the worktree is idle. */
export function busyFrom(listing, path) {
  if (!listing.ok) return true;
  const here = norm(path);
  return listing.out.split(/\r?\n/).filter(line => !line.startsWith(`${process.pid}\t`) && !line.trim().startsWith(`${process.pid} `))
    .some(line => line.replaceAll('\\', '/').toLowerCase().includes(here));
}

/** Number of commits not on any remote, from the rev-list result {ok, out}. A failed or unreadable count is null (unknown), never 0. */
export function unpushedCount(result) {
  if (!result.ok || !/^\d+$/.test(result.out.trim())) return null;
  return Number(result.out.trim());
}

/** Commits counted as unpushed for a worktree. An unknown count stays unknown (null) even when its HEAD is a closed PR's head. */
export function unpushedFor(count, headIsClosed) {
  if (count === null) return null;
  return headIsClosed ? 0 : count;
}

/** Head commits of merged PRs from `gh pr list --json headRefOid,mergedAt`. A PR closed without a merge saved nothing. Unreadable output gives an empty set. */
export function mergedHeads(json) {
  try { return new Set(JSON.parse(json).filter(pr => pr.mergedAt).map(pr => pr.headRefOid)); } catch { return new Set(); }
}

/** Why this worktree must stay, or null if it is finished. Pure: the facts are gathered elsewhere.
 * `explicit` (--only) skips the two guards meant for other sessions' trees (lock, age); the safety checks always apply. */
export function keepReason(w, { minAge = 120, explicit = false } = {}) {
  if (w.main) return 'main checkout';
  if (w.current) return 'this checkout';
  if (w.dirty !== false) return 'local changes';
  if (w.unpushed !== 0) return 'commits not on the remote';
  if (w.busy) return 'running process';
  if (explicit) return null;
  if (w.locked != null && w.lockAlive !== false) return 'locked by a living session';
  if (w.ageMinutes < minAge) return 'too young';
  return null;
}

/** Volumes of vanished roots: starts with a configured prefix, then 12 hex digits of a root hash nobody lives in. */
export function orphanVolumes(names, prefixes, liveHashes, protect = []) {
  return names.filter(name => !protect.some(word => name.toLowerCase().includes(word.toLowerCase())) && prefixes.some(prefix => {
    const id = name.startsWith(prefix) && name.slice(prefix.length).match(/^([0-9a-f]{12})(?![0-9a-f])/)?.[1];
    return id && !liveHashes.has(id);
  }));
}

/** All spellings of a root that a tool may have hashed (slashes, drive letter case). */
export function rootHashes(path) {
  const forms = new Set();
  for (const base of [path, resolve(path)]) {
    for (const slashes of [base.replaceAll('\\', '/'), base.replaceAll('/', '\\')]) {
      forms.add(slashes);
      forms.add(slashes.replace(/^./, c => c.toLowerCase()));
      forms.add(slashes.replace(/^./, c => c.toUpperCase()));
    }
  }
  return [...forms].map(form => createHash('sha256').update(form).digest('hex').slice(0, 12));
}

export function parseWorktrees(porcelain) {
  return porcelain.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const field = name => block.match(new RegExp(`^${name}(?: (.*))?$`, 'm'));
    const lock = field('locked');
    return {
      path: field('worktree')[1], head: field('HEAD')?.[1], branch: field('branch')?.[1]?.replace('refs/heads/', ''),
      locked: lock ? (lock[1] ?? '') : null, missing: !existsSync(field('worktree')[1]),
    };
  });
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

async function main() {
  enterCwd();
  const usage = `Usage: node scripts/worktree-gc.mjs [--cwd DIR] [--list] [--rm] [--only PATH] [--min-age MINUTES] [--jobs N] [--volume-prefix P] [--volume-protect V]
Lists the worktrees that can go; --rm removes them.`;
  let option;
  try { ({ values: option } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, rm: { type: 'boolean' }, list: { type: 'boolean' }, only: { type: 'string' }, 'min-age': { type: 'string', default: '120' },
    jobs: { type: 'string', default: '8' }, 'volume-prefix': { type: 'string', multiple: true }, 'volume-protect': { type: 'string', multiple: true },
  } })); } catch (error) {
    console.error(`${usage}
${error.message}`);
    process.exit(2);
  }
  if (option.help) { console.log(usage); return; }
  const refuse = message => { console.error(`${usage}\n${message}`); process.exit(2); };
  if (!/^\d+$/.test(option['min-age'])) refuse('--min-age needs a whole number of minutes (0 or more)');
  if (!/^[1-9]\d*$/.test(option.jobs)) refuse('--jobs needs a whole number of 1 or more');
  const root = projectRoot();
  const gitAsync = gitAsyncIn({}, root);
  const exec = (tool, args, cwd = root) => new Promise(done => execFile(tool.file, args, { cwd, env: tool.env, encoding: 'utf8', maxBuffer: 1 << 28 },
    (error, stdout) => done({ ok: !error, out: stdout ?? '' })));
  const gitIn = (args, cwd = root) => gitAsync(cwd, ...args);
  const jobs = Number(option.jobs);
  const pool = async (items, work) => {
    const queue = [...items];
    await Promise.all(Array.from({ length: jobs }, async () => { for (let item; (item = queue.shift());) await work(item); }));
  };

  const listed = parseWorktrees((await gitIn(['worktree', 'list', '--porcelain'])).out);
  const worktrees = listed.map((w, index) => ({ ...w, main: index === 0, current: norm(w.path) === norm(root) }));
  const only = option.only && norm(option.only);
  if (only && !worktrees.some(w => norm(w.path) === only)) refuse(`--only ${option.only} is no worktree of this project`);

  // Facts: commits of merged PRs count as saved (a squash merge leaves them on no remote branch).
  const gh = (() => { try { return externalTool('gh', root); } catch { return null; } })();
  const closedHeads = !gh ? new Set() : mergedHeads((await exec(gh, ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', 'headRefOid,mergedAt'])).out);
  const processes = process.platform === 'win32'
    ? (await exec({ file: 'powershell.exe', env: process.env }, ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }']))
    : (await exec({ file: 'ps', env: process.env }, ['-eo', 'pid,args']));

  await pool(worktrees.filter(w => !w.main && !w.current), async w => {
    const ref = w.branch ? `refs/heads/${w.branch}` : w.head;
    const unpushed = /^0+$/.test(w.head ?? '0') && !w.branch ? null : unpushedCount(await gitIn(['rev-list', '--count', ref, '--not', '--remotes']));
    w.unpushed = unpushedFor(unpushed, closedHeads.has(w.head));
    if (w.missing) w.dirty = false; // nothing on disk to lose
    else { const status = await gitIn(['--no-optional-locks', 'status', '--porcelain'], w.path); w.dirty = !status.ok || status.out.trim() !== ''; }
    w.busy = !w.missing && busyFrom(processes, w.path);
    const pid = w.locked?.match(/pid (\d+)/)?.[1];
    w.lockAlive = pid ? alive(Number(pid)) : undefined;
    try {
      const gitdir = readFileSync(join(w.path, '.git'), 'utf8').match(/^gitdir: (.+)$/m)[1].trim();
      w.ageMinutes = (Date.now() - Math.max(...['HEAD', 'index'].filter(f => existsSync(join(gitdir, f))).map(f => statSync(join(gitdir, f)).mtimeMs))) / 60000;
    } catch { w.ageMinutes = w.missing ? Infinity : 0; }
  });

  const candidates = worktrees.filter(w => !only || norm(w.path) === only);
  const reasons = new Map(worktrees.map(w => [w, only && norm(w.path) !== only ? 'not selected' : keepReason(w, { minAge: Number(option['min-age']), explicit: Boolean(only) })]));
  const finished = candidates.filter(w => reasons.get(w) === null);
  const kept = {};
  for (const w of candidates) if (reasons.get(w)) kept[reasons.get(w)] = (kept[reasons.get(w)] ?? 0) + 1;
  if (option.list) for (const w of candidates) console.log(`${reasons.get(w) ? 'keep  ' : 'REMOVE'} ${w.path} [${w.branch ?? 'detached'}] ${reasons.get(w) ?? ''}`);

  console.log(`Worktrees: ${worktrees.length} in total, ${finished.length} finished${option.rm ? ' (deleting)' : ' (dry run, nothing is deleted)'}, kept: ${JSON.stringify(kept)}`);
  console.log(`  of the finished: ${finished.filter(w => w.missing).length} already gone from disk (prune only), ${finished.filter(w => w.branch).length} with a local branch`);

  let removed = [];
  if (option.rm) {
    await pool(finished, async w => {
      if (w.locked != null) await gitIn(['worktree', 'unlock', w.path]);
      if (!w.missing) {
        if (process.platform === 'win32') await exec({ file: 'cmd.exe', env: process.env }, ['/c', 'rd', '/s', '/q', resolve(w.path)]);
        else rmSync(w.path, { recursive: true, force: true });
      }
      if (!existsSync(w.path)) removed.push(w);
      else console.log(`  kept (could not delete, in use?): ${w.path}`);
    });
    await gitIn(['worktree', 'prune']);
    for (const w of removed) if (w.branch && !/^(main|master|release\/)/.test(w.branch)) await gitIn(['branch', '-D', w.branch]);
    console.log(`  deleted ${removed.length} worktrees and ${removed.filter(w => w.branch).length} local branches`);
  }

  // Volumes
  let prefixes = option['volume-prefix'] ?? [], protect = option['volume-protect'] ?? [];
  const project = readProfile(root);
  prefixes = [...prefixes, ...project.worktreeVolumePrefixes];
  protect = [...protect, ...project.worktreeVolumeProtect];
  if (!prefixes.length || only) return;
  const docker = { file: 'docker', env: process.env };
  const names = await exec(docker, ['volume', 'ls', '-q']);
  if (!names.ok) return console.log('Volumes: Docker is not reachable, skipped');
  const all = names.out.split(/\s+/).filter(Boolean);
  const livePaths = existsSync(root) ? worktrees.filter(w => !w.missing && (!option.rm || !removed.includes(w))) : [];
  const hashesOf = list => new Set(list.flatMap(w => rootHashes(w.path)));
  const orphans = orphanVolumes(all, prefixes, hashesOf(livePaths), protect);
  const afterRm = orphanVolumes(all, prefixes, hashesOf(livePaths.filter(w => !finished.includes(w))), protect);
  console.log(`Volumes: ${all.length} in total, ${all.filter(n => protect.some(word => n.toLowerCase().includes(word.toLowerCase()))).length} protected (never touched), ${orphans.length} orphaned${option.rm ? '' : `, ${afterRm.length - orphans.length} more once the finished worktrees are gone`}`);
  if (option.rm) {
    let deleted = 0;
    await pool(orphans, async name => { if ((await exec(docker, ['volume', 'rm', name])).ok) deleted++; });
    console.log(`  deleted ${deleted} volumes (${orphans.length - deleted} in use, kept)`);
  }
}

if (isMain(import.meta.url)) await main();
