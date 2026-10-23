// Zweck: `kit setup` stellt den Sollzustand des Kits in einem Projekt her (neu, nach Update, halb kaputt) und nennt am Ende nur die Schritte für Menschen.
// Aufruf: node <kit>/scripts/kit.mjs [--cwd PROJEKT] setup; beliebig oft, ein zweiter Lauf ändert nichts. `check` meldet nur den Zustand (kit-check.mjs).
// Nutzen: Die Einzelskripte (init-project, setup-skills, provider install, install-git-hooks, setup-github) laufen als Funktionen; hier steht keine eigene Logik dafür.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentLabels, agents, hookAgents, projectAgents } from './agents.mjs';
import { setupBoard } from './github-board.mjs';
import { enterCwd, externalTool, projectRoot } from './checkout-root.mjs';
import { createGithub } from './github.mjs';
import { initProject } from './init-project.mjs';
import { installGitHooks } from './install-git-hooks.mjs';
import { kitCheck, modulesCheck } from './kit-check.mjs';
import { pluginSkills } from './plugin-skills.mjs';
import { activeSkills, projectFeatures, readProfile } from './project-profile.mjs';
import { featureProviders } from './provider-list.mjs';
import { context, install } from './provider.mjs';
import { setupSkills } from './setup-skills.mjs';
import { writeProjectFile } from './write-guard.mjs';

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
// A step is a function of `log`: it returns { state: 'ok' | 'open', note?, hint? } ("open": something is left to do, `hint` says what) or throws (the error message is the hint).
// What the scripts behind it say goes to `log`; `kit setup` shows it under the step's line.
const ok = note => ({ state: 'ok', note });
const open = hint => ({ state: 'open', hint });

const tasks = [];
const humans = [];
// Read before the steps: skills and hooks create agent folders, which would make every agent look used.
const trust = hookAgents(root).names.filter(name => agents[name].hooks.trust).map(name => `${agents[name].hooks.trust} in ${agents[name].label ?? name}`);

// Local steps decide the exit code; a step that needs the network or the user's home reports an open step instead.
const step = (title, required, work) => tasks.push({ title, required, work });

// A new project (no AGENTS.md yet) also gets the starter files; an existing one keeps everything of its own.
step('link, kit hooks, ignore files', true, log => { initProject({ root, existing: existsSync(join(root, 'AGENTS.md')), log }); return ok(); });
// The check the session start runs (without the pull): it reports what the other steps cannot repair.
step('kit check', false, () => {
  const hints = [...kitCheck(root, { kit: dirname(scripts) }), ...modulesCheck(root)];
  return hints.length ? open(hints.join(' ')) : ok();
});
step('profile .github/workflow-project.json', true, () => {
  if (!existsSync(profile)) writeProjectFile(root, '.github/workflow-project.json', '{\n  "language": "en"\n}\n');
  return ok();
});
step(`skills for ${agentLabels(projectAgents(root))}`, true, async log => { await setupSkills({ log }); return ok(); });
step('git hooks (.githooks)', true, log => { installGitHooks({ root, log }); return ok(); });
// A function the project does not use is not installed (no download); its hook entries are already gone from init-project.
for (const provider of featureProviders().filter(provider => provider.install))
  step(`${provider.label} hooks`, false, async log => {
    if (!projectFeatures(root)[provider.name]) return ok(`off for this project ("${provider.name}" in .github/workflow-project.json)`);
    await install(provider, context({ log }));
    return ok();
  });
step('GitHub board and labels', false, () => {
  const board = setupBoard({ root, github: createGithub({ tool: externalTool('gh', root), command: 'setup', projectDirectory: root, sleep() {} }) });
  return board.status === 0 ? ok(board.note) : open(board.stderr);
});

let failed = false;
for (const { title, required, work } of tasks) {
  let result;
  const notes = [];
  try { result = await work(line => notes.push(line)); } catch (error) { result = { state: required ? 'error' : 'open', hint: String(error.message ?? error).split('\n')[0] }; }
  const show = () => notes.forEach(line => console.log(`        ${line}`));
  if (result.state === 'ok') { console.log(`ok    ${title}${result.note ? ': ' + result.note : ''}`); show(); continue; }
  if (result.state === 'error') { console.log(`FAIL  ${title}: ${result.hint}`); show(); failed = true; break; }
  console.log(`open  ${title}: ${result.hint}`);
  show();
  humans.push(`Fix "${title}" (${result.hint}), then run kit setup again.`);
}
if (failed) process.exit(1);

// Hint only: skills the user also has as plugin load twice. The project copy goes by listing the wanted skills in "skills".
const installed = existsSync(join(root, '.agents/skills')) ? readdirSync(join(root, '.agents/skills')) : [];
const twice = [...pluginSkills()].filter(([name]) => installed.includes(name));
if (twice.length) {
  const wanted = (activeSkills(readProfile(root)) ?? installed).filter(name => !twice.some(([plugin]) => plugin === name));
  console.log(`\nAlso installed as your plugin: ${twice.map(([name, key]) => `${name} (${key})`).join(', ')}.`);
  console.log(`To leave the project copy out, set in .github/workflow-project.json: ${JSON.stringify({ skills: wanted })}`);
}
// An agent without hooks (hooks: null in agents.mjs) gets the check from AGENTS.md instead of an adapter (#690).
for (const [name, agent] of Object.entries(agents)) if (!agent.hooks)
  humans.push(`${name} has no hooks: add to the project's AGENTS.md "Start every session with: node .vendor/workflow-kit/scripts/kit.mjs check".`);
humans.push(`Review and trust the project hooks in your agent${trust.length ? ` (${trust.join(', ')})` : ''}, then start a new session.`);
humans.push('In GitHub: enable the chosen reviewers, set Project auto-add for the repository, require checks and approval for PRs.');
console.log(`\nOnly you can do:\n${humans.map((line, index) => `${index + 1}. ${line}`).join('\n')}`);
