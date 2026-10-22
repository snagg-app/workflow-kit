// Zweck: `kit setup` stellt den Sollzustand des Kits in einem Projekt her (neu, nach Update, halb kaputt) und nennt am Ende nur die Schritte für Menschen.
// Aufruf: node <kit>/scripts/kit.mjs [--cwd PROJEKT] setup; beliebig oft, ein zweiter Lauf ändert nichts. `check` meldet nur den Zustand (kit-check.mjs).
// Nutzen: Die Einzelskripte (init-project, setup-skills, provider install, install-git-hooks, setup-github) laufen als interne Schritte; hier steht keine eigene Logik dafür.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agents } from './agents.mjs';
import { enterCwd, externalTool, projectRoot } from './checkout-root.mjs';
import { kitCheck, modulesCheck } from './kit-check.mjs';
import { pluginSkills } from './plugin-skills.mjs';
import { activeSkills, projectFeatures } from './project-profile.mjs';

enterCwd();
if (!['setup', 'check'].includes(process.argv[2]) || process.argv.length > 3) {
  console.error('Usage: node <kit>/scripts/kit.mjs [--cwd PROJECT_DIR] setup|check');
  process.exit(2);
}
const scripts = dirname(fileURLToPath(import.meta.url));
const root = projectRoot();
// `check`: the one check behind the hooks and board.mjs, for an agent without hooks. Hints out, exit 1 when there are any.
if (process.argv[2] === 'check') {
  const hints = [...kitCheck(root), ...modulesCheck(root)];
  console.log(hints.length ? hints.join('\n') : 'ok    kit is in order');
  process.exit(hints.length ? 1 : 0);
}
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
// A function the project does not use is not installed (no download); its hook entries are already gone from init-project.
for (const [name, title] of [['ponytail', 'Ponytail hooks'], ['impeccable', 'Impeccable hooks']])
  step(title, false, () => projectFeatures(root)[name] ? run('provider.mjs', name, 'install') : { status: 0, note: 'off for this project ("' + name + '" in .github/workflow-project.json)' });
step('GitHub board and labels', false, () => {
  const git = externalTool('git', root), gh = externalTool('gh', root);
  const remote = spawnSync(git.file, ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', env: git.env }).stdout.trim();
  const repo = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
  if (!repo) return { status: 1, stderr: 'no GitHub remote "origin"' };
  // A project already bound to its board stays as it is: no network, no GraphQL quota (#730). A new or changed binding runs setup-github.mjs by hand.
  const bound = JSON.parse(readFileSync(profile, 'utf8'));
  if (bound.repository?.toLowerCase() === repo.toLowerCase() && bound.number && bound.id) return { status: 0, note: `already bound to project #${bound.number}; run setup-github.mjs ${repo} to redo it` };
  if (spawnSync(gh.file, ['auth', 'status'], { env: gh.env }).status !== 0) return { status: 1, stderr: 'gh is not signed in' };
  return run('setup-github.mjs', repo);
});

let failed = false;
for (const { title, required, work } of tasks) {
  let result;
  try { result = work(); } catch (error) { result = { status: 1, stderr: error.message }; }
  if (result.status === 0) { console.log(`ok    ${title}${result.note ? ': ' + result.note : ''}`); continue; }
  const reason = lastLine(output(result));
  if (required) { console.log(`FAIL  ${title}: ${reason}`); failed = true; break; }
  console.log(`open  ${title}: ${reason}`);
  humans.push(`Fix "${title}" (${reason}), then run kit setup again.`);
}
if (failed) process.exit(1);

// Hint only: skills the user also has as plugin load twice. The project copy goes by listing the wanted skills in "skills".
const installed = existsSync(join(root, '.agents/skills')) ? readdirSync(join(root, '.agents/skills')) : [];
const twice = [...pluginSkills()].filter(([name]) => installed.includes(name));
if (twice.length) {
  const wanted = (activeSkills(JSON.parse(readFileSync(profile, 'utf8'))) ?? installed).filter(name => !twice.some(([plugin]) => plugin === name));
  console.log(`\nAlso installed as your plugin: ${twice.map(([name, key]) => `${name} (${key})`).join(', ')}.`);
  console.log(`To leave the project copy out, set in .github/workflow-project.json: ${JSON.stringify({ skills: wanted })}`);
}
// An agent without hooks (hooks: null in agents.mjs) gets the check from AGENTS.md instead of an adapter (#690).
for (const [name, agent] of Object.entries(agents)) if (!agent.hooks)
  humans.push(`${name} has no hooks: add to the project's AGENTS.md "Start every session with: node .vendor/workflow-kit/scripts/kit.mjs check".`);
humans.push('Review and trust the project hooks in your agent (/hooks in Claude Code or Codex), then start a new session.');
humans.push('In GitHub: enable the chosen reviewers, set Project auto-add for the repository, require checks and approval for PRs.');
console.log(`\nOnly you can do:\n${humans.map((line, index) => `${index + 1}. ${line}`).join('\n')}`);
