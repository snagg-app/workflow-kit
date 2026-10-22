// Print the test files that belong to the changed files; `--run` runs them with `node --test` instead.
// Without file arguments the changed files are everything that differs from the merge base with origin/main
// (commits, working tree, new files); with arguments those files are used instead.
// The mapping is the plain table below: explicit, no import analysis. CI keeps running the whole suite.
// A project adds its own map in .github/affected-tests.json (see README); its commands are printed after the kit's tests
// (`--base REF` replaces origin/main as the merge base, for projects that target release branches).
// `--resume FILE` (with `--run`) remembers the green steps per head in FILE and skips them on the next call; a red step names whether its test file is in the diff.
// `--run` stays quiet when green (test counts, `ok: <command>`) and shows the failing output otherwise; `--verbose` shows it all.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { enterCwd, projectRoot } from './checkout-root.mjs';

const kit = fileURLToPath(new URL('..', import.meta.url));
const tests = 'scripts/tests/';

const ALL = /\.test\.mjs$/;
const BOARD = /^board-.*\.test\.mjs$/;
const NOT_BOARD = /^(?!board-).*\.test\.mjs$/;

// Source path pattern -> test files (names inside scripts/tests, or a pattern over those names).
// A changed test file always runs itself; a file that matches no row is reported on stderr.
export const TABLE = [
  [/^scripts\/(board(-[a-z]+)?|quota|project-profile|github)\.mjs$|^scripts\/tests\/(board-(fixture|runner|worker)|fake-gh)\.mjs$/, [BOARD]],
  [/^scripts\/tests\/(gh-shapes\.mjs$|gh-shapes\/)/, [BOARD, 'gh-shapes.test.mjs']],
  [/^scripts\/record-gh-shapes\.mjs$/, ['gh-shapes.test.mjs']],
  [/^scripts\/quota-sample\.mjs$/, ['quota-sample.test.mjs']],
  [/^scripts\/affected-tests\.mjs$/, ['affected-tests.test.mjs']],
  [/^scripts\/worktree-gc\.mjs$/, ['worktree-gc.test.mjs']],
  [/^scripts\/checkout-root\.mjs$/, [ALL]],
  [/^scripts\/provider-links\.mjs$/, [NOT_BOARD]],
  [/^scripts\/tests\/fixtures\.mjs$/, ['git-hooks', 'kit-init-hook', 'kit-setup', 'ponytail-batch', 'ponytail-hooks', 'renovate-regenerate', 'setup'].map(n => `${n}.test.mjs`)],
  [/^scripts\/(install-git-hooks\.mjs|git-hooks\/)/, ['git-hooks.test.mjs', 'kit-init-hook.test.mjs']],
  [/^scripts\/(init-project|agents)\.mjs$|^scripts\/hook-commands\.json$|^templates\//, ['entrypoints.test.mjs', 'kit-init-hook.test.mjs', 'impeccable-update.test.mjs', 'matt-pocock.test.mjs']],
  [/^scripts\/provider\.mjs$/, ['provider.test.mjs', 'ponytail-batch.test.mjs', 'ponytail-hooks.test.mjs', 'matt-pocock.test.mjs', 'setup.test.mjs', 'impeccable-update.test.mjs']],
  [/^scripts\/provider-ponytail\.mjs$/, ['ponytail-batch.test.mjs', 'ponytail-hooks.test.mjs', 'setup.test.mjs']],
  [/^scripts\/(ponytail-patch\.mjs|ponytail\/)/, ['update-ponytail.test.mjs', 'ponytail-batch.test.mjs']],
  [/^scripts\/versions\.json$|^\.agents\/hooks\/|^\.github\/hooks\/ponytail\.json$/, ['ponytail-hooks.test.mjs', 'impeccable-hooks.test.mjs']],
  [/^scripts\/kit\.mjs$/, ['kit-setup.test.mjs']],
  [/^scripts\/kit-hook\.mjs$/,['kit-init-hook.test.mjs', 'ponytail-hooks.test.mjs', 'impeccable-hooks.test.mjs']],
  [/^scripts\/(impeccable-release\.mjs|impeccable\/)|^\.vendor\/impeccable$/, ['impeccable-update.test.mjs']],
  [/^scripts\/provider-impeccable\.mjs$/, ['provider.test.mjs', 'impeccable-update.test.mjs', 'impeccable-hooks.test.mjs', 'matt-pocock.test.mjs']],
  [/^scripts\/(provider-matt-pocock|setup-skills|code-review-failure-paths)\.mjs$/, ['matt-pocock.test.mjs', 'setup.test.mjs']],
  [/^\.github\/skills\/|^\.vendor\/matt-pocock-skills$/, ['matt-pocock.test.mjs']],
  [/^scripts\/check-submodule-sources\.mjs$|^\.gitmodules$/, ['check-submodule-sources.test.mjs']],
  [/^\.github\/workflows\/renovate-regenerate\.yml$|^renovate\.json$/, ['renovate-regenerate.test.mjs']],
];

// Static checks over sources and docs; fast, so every such change runs them (they do not count as coverage).
const STATIC = /^(scripts|docs)\/.*\.(mjs|js|md|json|ya?ml|patch)$|^[^/]+\.md$/;
// Changes here need no row; they stay silent.
const UNTESTED = /^(docs\/|[^/]+\.md$|scripts\/tests\/)/;

/** { tests, unmapped } for a list of changed files (paths relative to the kit root). */
export function affectedTests(files, directory = kit) {
  const available = readdirSync(resolve(directory, tests)).filter(name => ALL.test(name));
  const found = new Set(), unmapped = [];
  for (const file of files) {
    let hit = false;
    if (STATIC.test(file)) found.add('text-files.test.mjs');
    if (file.startsWith(tests) && ALL.test(file)) { found.add(basename(file)); hit = true; }
    for (const [pattern, targets] of TABLE) {
      if (!pattern.test(file)) continue;
      hit = true;
      for (const target of targets) for (const name of available.filter(a => (target instanceof RegExp ? target.test(a) : a === target))) found.add(name);
    }
    if (!hit && !UNTESTED.test(file) && /^(scripts|templates)\//.test(file)) unmapped.push(file);
  }
  return { tests: [...found].sort().filter(name => existsSync(resolve(directory, tests, name))).map(name => tests + name), unmapped };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Files that differ from the merge base with `base`, plus untracked ones, in the Git checkout `cwd`. */
export function changedFiles(base = 'origin/main', cwd = kit) {
  const [from] = git(cwd, 'merge-base', base, 'HEAD');
  return [...new Set([...git(cwd, 'diff', '--name-only', from), ...git(cwd, 'ls-files', '--others', '--exclude-standard')])];
}

export const PROJECT_FILE = '.github/affected-tests.json';

/** The project's map from path pattern (`*` within a folder, `**` across folders) to a command or a list of commands. */
export function readProjectMap(root) {
  const file = resolve(root, PROJECT_FILE);
  if (!existsSync(file)) return {};
  const map = JSON.parse(readFileSync(file, 'utf8'));
  for (const [pattern, value] of Object.entries(map))
    assert.ok([value].flat().every(command => typeof command === 'string' && command), `${PROJECT_FILE}: "${pattern}" needs a command or a list of commands`);
  return map;
}

const glob = pattern => new RegExp('^' + pattern.split('**').map(part => part.split('*').map(text => text.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*') + '$');

/** The project commands for a list of changed files (paths relative to the project root), each once, in table order. */
export function projectCommands(files, map) {
  return [...new Set(Object.entries(map).filter(([pattern]) => files.some(file => glob(pattern).test(file))).flatMap(([, value]) => [value].flat()))];
}

let lastOutput = '';

/** Says only whether the test files named in the red output are in the diff; the cause is for the reader to judge. */
function redHint(changed) {
  const named = [...new Set((lastOutput.match(/scripts[\\/]tests[\\/][\w.-]+\.test\.mjs/g) ?? []).map(file => file.replaceAll('\\', '/')))];
  if (!named.length) return 'the output names no test file; read it above';
  return named.map(file => `${file} ${changed.includes(file) ? 'is in your diff' : 'is not in your diff'}`).join('; ');
}

/**
 * Runs a command and returns its exit status. Unless `verbose`, its output stays hidden: a green run prints `ok` (or the
 * output lines matching `summary`), a red one prints everything except the lines matching `noise`. Either way a line names the
 * command (`label`) before it starts and the duration follows, so a long run shows what it waits for.
 */
export function quiet(verbose, command, args, options, { summary, noise, ok, label = command } = {}) {
  if (verbose) return spawnSync(command, args, { ...options, stdio: 'inherit' }).status ?? 1;
  console.log(`run: ${label}`);
  const start = Date.now(), result = spawnSync(command, args, { ...options, encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n');
  lastOutput = lines.join('\n');
  console.log(result.status === 0 ? ok ?? lines.filter(line => summary.test(line)).join('\n') : lines.filter(line => !noise?.test(line)).join('\n').trim());
  console.log(`took ${((Date.now() - start) / 1000).toFixed(1)} s`);
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  enterCwd(); // `--cwd PROJECT_DIR` as the first argument; file arguments are relative to it
  const { values, positionals: given } = parseArgs({ allowPositionals: true, options: { run: { type: 'boolean' }, verbose: { type: 'boolean' }, resume: { type: 'string' }, base: { type: 'string', default: 'origin/main' } } });
  // A project that uses the kit through .vendor/workflow-kit: kit tests follow the kit's own changes, the project map the project's.
  const root = projectRoot(), inKit = realpathSync.native(root) === realpathSync.native(kit);
  const kitFiles = given.length ? (inKit ? given : []) : changedFiles(inKit ? values.base : undefined, kit);
  const commands = projectCommands(inKit ? kitFiles : given.length ? given : changedFiles(values.base, root), readProjectMap(root));
  const { tests: selected, unmapped } = affectedTests(kitFiles);
  for (const file of unmapped) console.error(`no test mapped for ${file}; add a row to scripts/affected-tests.mjs or run the suite`);
  if (!values.run) { if (selected.length || commands.length) console.log([...selected, ...commands].join('\n')); }
  else if (!selected.length && !commands.length) console.log('no affected tests');
  else {
    // --resume FILE: the green steps of a head are kept in FILE (first line the head, then one step per line), so a call after a red step runs only what is still open.
    const head = values.resume ? git(root, 'rev-parse', 'HEAD')[0] : undefined;
    const [saved, ...green] = values.resume && existsSync(values.resume) ? readFileSync(values.resume, 'utf8').split('\n') : [];
    const done = new Set(saved === head ? green : []);
    const step = (label, command, args, options, texts) => {
      if (process.exitCode) return;
      const key = `${label} ${args.join(' ')}`; // the chosen files are part of the step: another selection of the same size is another step
      if (done.has(key)) return console.log(`skip (green for this head): ${label}`);
      const status = quiet(values.verbose, command, args, options, { ...texts, label });
      if (status === 0) { done.add(key); if (values.resume) writeFileSync(values.resume, [head, ...done].join('\n')); }
      else process.exitCode = status;
    };
    if (selected.length) step(`node --test (${selected.length} files)`, process.execPath, ['--test', ...selected], { cwd: kit }, { summary: /^ℹ (tests|pass|fail) /, noise: /^(start: |✔ )/ });
    for (const command of commands) step(command, command, [], { cwd: root, shell: true, env: { ...process.env, AFFECTED_BASE: values.base } }, { ok: `ok: ${command}` });
    if (process.exitCode) console.error(`red step; ${redHint(inKit ? kitFiles : given.length ? given : changedFiles(values.base, root))}`);
  }
}
