// Zweck: `kit setup` stellt den Sollzustand des Kits in einem Projekt her (neu, nach Update, halb kaputt) und nennt am Ende nur die Schritte für Menschen.
// Aufruf: node <kit>/scripts/kit.mjs [--cwd PROJEKT] setup; beliebig oft, ein zweiter Lauf ändert nichts.
// Nutzen: Die Einzelskripte (init-project, setup-skills, install-*-hooks, install-git-hooks, setup-github) laufen als interne Schritte; hier steht keine eigene Logik dafür.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, externalTool, projectRoot } from './checkout-root.mjs';

enterCwd();
if (process.argv[2] !== 'setup' || process.argv.length > 3) {
  console.error('Usage: node <kit>/scripts/kit.mjs [--cwd PROJECT_DIR] setup');
  process.exit(2);
}
const scripts = dirname(fileURLToPath(import.meta.url));
const root = projectRoot();
const profile = join(root, '.github/workflow-project.json');
const output = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
const run = (name, ...args) => spawnSync(process.execPath, [join(scripts, name), ...args], { cwd: root, encoding: 'utf8' });
// A crashed script ends its output with the Node version; the line that names the error is the useful one.
const lastLine = (text) => (text.split('\n').find(line => /Error/.test(line) && !/^\s+at /.test(line)) ?? text.split('\n').filter(Boolean).at(-1) ?? 'no output').replace(/^[\s[]+|[\s\]{]+$/g, '');

const tasks = [];
const humans = [];

// Local steps decide the exit code; a step that needs the network or the user's home reports an open step instead.
const step = (title, required, work) => tasks.push({ title, required, work });

// A new project (no AGENTS.md yet) also gets the starter files; an existing one keeps everything of its own.
step('link, kit hooks, ignore files', true, () => run('init-project.mjs', ...(existsSync(join(root, 'AGENTS.md')) ? ['--existing'] : [])));
step('profile .github/workflow-project.json', true, () => {
  if (!existsSync(profile)) { mkdirSync(dirname(profile), { recursive: true }); writeFileSync(profile, '{\n  "language": "en"\n}\n'); }
  return { status: 0 };
});
step('skills for Codex and Claude Code', true, () => run('setup-skills.mjs'));
step('git hooks (.githooks)', true, () => run('install-git-hooks.mjs'));
step('Ponytail hooks', false, () => run('install-ponytail-hooks.mjs'));
step('Impeccable hooks', false, () => run('install-impeccable-hooks.mjs'));
step('GitHub board and labels', false, () => {
  const git = externalTool('git', root), gh = externalTool('gh', root);
  const remote = spawnSync(git.file, ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', env: git.env }).stdout.trim();
  const repo = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
  if (!repo) return { status: 1, stderr: 'no GitHub remote "origin"' };
  if (spawnSync(gh.file, ['auth', 'status'], { env: gh.env }).status !== 0) return { status: 1, stderr: 'gh is not signed in' };
  return run('setup-github.mjs', repo);
});

let failed = false;
for (const { title, required, work } of tasks) {
  let result;
  try { result = work(); } catch (error) { result = { status: 1, stderr: error.message }; }
  if (result.status === 0) { console.log(`ok    ${title}`); continue; }
  const reason = lastLine(output(result));
  if (required) { console.log(`FAIL  ${title}: ${reason}`); failed = true; break; }
  console.log(`open  ${title}: ${reason}`);
  humans.push(`Fix "${title}" (${reason}), then run kit setup again.`);
}
if (failed) process.exit(1);

humans.push('Review and trust the project hooks in your agent (/hooks in Claude Code or Codex), then start a new session.');
humans.push('In GitHub: enable the chosen reviewers, set Project auto-add for the repository, require checks and approval for PRs.');
console.log(`\nOnly you can do:\n${humans.map((line, index) => `${index + 1}. ${line}`).join('\n')}`);
