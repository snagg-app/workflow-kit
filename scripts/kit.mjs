// Zweck: `kit setup` stellt den Sollzustand des Kits in einem Projekt her (neu, nach Update, halb kaputt) und nennt am Ende nur die Schritte für Menschen.
// Aufruf: node <kit>/scripts/kit.mjs [--cwd PROJEKT] setup; beliebig oft, ein zweiter Lauf ändert nichts. `check` meldet nur den Zustand (kit-check.mjs). Oder `import { kitSetup }`: eine Funktion mit Ergebnis, der Import führt nichts aus.
// Nutzen: Die Einzelskripte (init-project, setup-skills, provider install, install-git-hooks, setup-github) laufen als Funktionen; hier steht keine eigene Logik dafür.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentLabels, agents, projectAgents } from './agents.mjs';
import { setupBoard, setupGithub } from './github-board.mjs';
import { enterCwd, projectRoot } from './checkout-root.mjs';
import { initProject } from './init-project.mjs';
import { keepCommitted } from './keep-committed.mjs';
import { installGitHooks } from './install-git-hooks.mjs';
import { kitCheck, kitEnvironment, modulesCheck } from './kit-check.mjs';
import { ensureNode, realSystem } from './node-path.mjs';
import { pluginSkills } from './plugin-skills.mjs';
import { activeSkills, projectFeatures, readProfile } from './project-profile.mjs';
import { featureProviders } from './provider-list.mjs';
import { context, install } from './provider.mjs';
import { setupSkills } from './setup-skills.mjs';
import { writeProjectFile } from './write-guard.mjs';
import { isMain } from './is-main.mjs';
import { requireNode } from './versions.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));

/** `kit check`: the one check behind the hooks and board.mjs, for an agent without hooks. { hints, exitCode }: exit 1 when there are any. */
export function checkKit(root) {
  const hints = [...kitCheck(root, kitEnvironment()).messages, ...modulesCheck(root)];
  return { hints, exitCode: hints.length ? 1 : 0 };
}

/**
 * `kit setup` for the project at `root`. Returns { steps, plugin, humans, exitCode }:
 * - steps: [{ title, state: 'ok' | 'open' | 'error', note?, hint?, lines }] (`lines`: what the scripts behind the step said);
 * - plugin: { installed, wanted } when skills the user also has as plugin load twice (hint only), else undefined;
 * - humans: what only a person can do; empty after an error;
 * - exitCode: 1 after an error (the first failing local step ends the run), else 0.
 * `onStep` gets each step as soon as it is done, so a caller can show progress during long steps.
 */
export async function kitSetup(root, { onStep = () => {}, refresh = false, nodeSystem = realSystem } = {}) {
  const profile = join(root, '.github/workflow-project.json');
  // `kit setup` reads the profile once and hands it to the steps; a broken one fails the first step that needs it, as before.
  let read;
  const current = () => read ??= readProfile(root);
  // A step is a function of `log`: it returns { state: 'ok' | 'open', note?, hint? } ("open": something is left to do, `hint` says what) or throws (the error message is the hint).
  const ok = note => ({ state: 'ok', note });
  const open = hint => ({ state: 'open', hint });

  const tasks = [];
  const humans = [];
  // Read before the steps: skills and hooks create agent folders, which would make every agent look used.
  // No agent found: hooks go to all, but no agent is named.
  const used = projectAgents(root, agent => agent.hooks);
  const trust = (used.none ? [] : used.names).filter(name => agents[name].hooks.trust).map(name => `${agents[name].hooks.trust} in ${agents[name].label ?? name}`);

  // Local steps decide the exit code; a step that needs the network or the user's home reports an open step instead.
  const step = (title, required, work) => tasks.push({ title, required, work });

  // A new project (no AGENTS.md yet) also gets the starter files; an existing one keeps everything of its own.
  // A committed hook entry file stays as committed (reported once) until `setup --refresh` (#985).
  step('link, kit hooks, ignore files', true, async log => { await keepCommitted(root, () => initProject({ root, existing: existsSync(join(root, 'AGENTS.md')), log, profile: current() }), { refresh, log }); return ok(); });
  // The check the session start runs (without the pull): it reports what the other steps cannot repair.
  step('kit check', false, () => {
    const hints = [...kitCheck(root, { ...kitEnvironment(), kit: dirname(scripts) }).messages, ...modulesCheck(root)];
    return hints.length ? open(hints.join(' ')) : ok();
  });
  step('profile .github/workflow-project.json', true, () => {
    if (!existsSync(profile)) writeProjectFile(root, '.github/workflow-project.json', '{\n  "language": "en"\n}\n');
    return ok();
  });
  step(`skills for ${agentLabels()}`, true, async log => { await setupSkills({ log, profile: current(), refresh }); return ok(); });
  step('git hooks (.githooks)', true, log => { const { ready, reason } = installGitHooks({ root, log }); return ready ? ok() : open(reason); });
  // Hooks run in a non-interactive shell: node must be found there (#1068). KIT_NODE_SETUP=skip is for tests and CI.
  step('node in a non-interactive shell', true, () => {
    if (process.env.KIT_NODE_SETUP === 'skip') return ok('skipped (KIT_NODE_SETUP=skip)');
    const result = ensureNode(nodeSystem());
    if (result.state === 'error') throw new Error(result.hint);
    return ok(result.note);
  });
  // A function the project does not use is not installed (no download); its hook entries are already gone from init-project.
  for (const provider of featureProviders().filter(provider => provider.install))
    step(`${provider.label} hooks`, false, async log => {
      if (!projectFeatures(root, undefined, current())[provider.name]) return ok(`off for this project ("${provider.name}" in .github/workflow-project.json)`);
      await install(provider, context({ log }));
      return ok();
    });
  step('GitHub board and labels', false, () => {
    const board = setupBoard({ root, github: setupGithub(root) });
    return board.status === 0 ? ok(board.note) : open(board.stderr);
  });

  const steps = [];
  for (const { title, required, work } of tasks) {
    const lines = [];
    let result;
    try { result = await work(line => lines.push(line)); } catch (error) { result = { state: required ? 'error' : 'open', hint: String(error.message ?? error).split('\n')[0] }; }
    const done = { title, ...result, lines };
    steps.push(done);
    onStep(done);
    if (result.state === 'error') return { steps, plugin: undefined, humans, exitCode: 1 };
    if (result.state === 'open') humans.push(`Fix "${title}" (${result.hint}), then run kit setup again.`);
  }

  // Hint only: skills the user also has as plugin load twice. The project copy goes by listing the wanted skills in "skills".
  const installed = existsSync(join(root, '.agents/skills')) ? readdirSync(join(root, '.agents/skills')) : [];
  const twice = [...pluginSkills()].filter(([name]) => installed.includes(name));
  const plugin = twice.length ? { twice, wanted: (activeSkills(current()) ?? installed).filter(name => !twice.some(([other]) => other === name)) } : undefined;
  // An agent without hooks (hooks: null in agents.mjs) gets the check from AGENTS.md instead of an adapter (#690).
  for (const [name, agent] of Object.entries(agents)) if (!agent.hooks)
    humans.push(`${name} has no hooks: add to the project's AGENTS.md "Start every session with: node .vendor/workflow-kit/scripts/kit.mjs check".`);
  humans.push(`Review and trust the project hooks in your agent${trust.length ? ` (${trust.join(', ')})` : ''}, then start a new session.`);
  humans.push('In GitHub: enable the chosen reviewers, set Project auto-add for the repository, require checks and approval for PRs.');
  return { steps, plugin, humans, exitCode: 0 };
}

if (isMain(import.meta.url)) {
  requireNode();
  enterCwd();
  const refresh = process.argv[2] === 'setup' && process.argv[3] === '--refresh';
  if (!['setup', 'check'].includes(process.argv[2]) || process.argv.length > (refresh ? 4 : 3)) {
    console.error('Usage: node <kit>/scripts/kit.mjs [--cwd PROJECT_DIR] setup [--refresh] | check');
    process.exit(2);
  }
  const root = projectRoot();
  if (process.argv[2] === 'check') {
    const { hints, exitCode } = checkKit(root);
    console.log(hints.length ? hints.join('\n') : 'ok    kit is in order');
    process.exit(exitCode);
  }
  const { plugin, humans, exitCode } = await kitSetup(root, {
    refresh,
    onStep({ title, state, note, hint, lines }) {
      const line = state === 'ok' ? `ok    ${title}${note ? ': ' + note : ''}` : `${state === 'error' ? 'FAIL' : 'open'}  ${title}: ${hint}`;
      console.log(line);
      lines.forEach(text => console.log(`        ${text}`));
    },
  });
  if (exitCode) process.exit(exitCode);
  if (plugin) {
    console.log(`\nAlso installed as your plugin: ${plugin.twice.map(([name, key]) => `${name} (${key})`).join(', ')}.`);
    console.log(`To leave the project copy out, set in .github/workflow-project.json: ${JSON.stringify({ skills: plugin.wanted })}`);
  }
  console.log(`\nOnly you can do:\n${humans.map((line, index) => `${index + 1}. ${line}`).join('\n')}`);
}
