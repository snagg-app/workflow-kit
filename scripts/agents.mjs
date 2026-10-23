// The one list of agents the kit serves. A new agent is a new entry; setup, init and update scripts read only this table.
// skills: where the agent finds skills. agents: where it finds agent definitions; upstreamAgents: where Impeccable ships them.
// linksShared: the agent reads the shared skills through links (junction or symlink, never committed), not copies.
// detectEnv: an environment variable only this agent's session sets; defaultAgent is the one without.
// detect: project paths that show a project uses this agent (kit setup writes hooks only for detected agents; none detected: for all).
// hooks: settings file, PostToolUse matcher and handler shape (shell key for bash handlers, a PowerShell variant, file description; fingerprint: where a session keeps the settings fingerprint, absent for an agent that reloads hooks itself); null for an agent without hooks (level 0 of AGENT_RULES: AGENTS.md, skills, board.mjs, kit check).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const defaultAgent = 'claude';
export const sharedSkills = '.agents/skills';

export const agents = {
  codex: {
    detectEnv: 'CODEX_THREAD_ID',
    detect: ['.codex'],
    skills: sharedSkills,
    agents: '.codex/agents',
    upstreamAgents: '.agents/skills/impeccable/agents',
    hooks: { file: '.codex/hooks.json', matcher: 'Edit|Write|apply_patch', windows: true },
  },
  claude: {
    detect: ['.claude'],
    skills: '.claude/skills',
    linksShared: true,
    agents: '.claude/agents',
    upstreamAgents: '.claude/agents',
    hooks: {
      file: '.claude/settings.json', matcher: 'Edit|Write', shell: 'bash',
      fingerprint: { configEnv: 'CLAUDE_CONFIG_DIR', configDir: '.claude' }, description: 'Impeccable design detector: immediate-tier checks after Edit/Write on UI files, full-rule deep pass on Stop.',
    },
  },
};

/** Provider folders that hold skills (`.agents`, `.claude`). */
export const providers = Object.values(agents).map(agent => dirname(agent.skills));
/** Provider folders that hold real skill copies; the others link to them. */
export const sourceProviders = Object.values(agents).filter(agent => !agent.linksShared).map(agent => dirname(agent.skills));
export const agentNames = Object.keys(agents);
/** The agent whose session this process runs in. */
export const detectAgent = (env = process.env) => agentNames.find(name => agents[name].detectEnv && env[agents[name].detectEnv]) ?? defaultAgent;
/** The agents with hooks that a project uses (one of their detect paths exists); none found, as in a new project: all of them. */
export function hookAgents(root) {
  const withHooks = agentNames.filter(name => agents[name].hooks), found = withHooks.filter(name => agents[name].detect.some(path => existsSync(join(root, path))));
  return { names: found.length ? found : withHooks, none: !found.length };
}
export const hookFiles = Object.values(agents).filter(agent => agent.hooks).map(agent => agent.hooks.file);

/** The project's copy of kit-entry.mjs (written by `kit setup`); hook-commands.json names the same path. */
export const entryFile = '.agents/workflow-kit-hook.mjs';

// kind: `start` also reports a missing Node (the entry clones a missing shared kit); `simple` only hands over. feature: the event exists only for a project with that function.
const events = [
  { event: 'PostToolUse', kind: 'simple', timeout: 120, matcher: true, statusMessage: true, feature: 'impeccable' },
  { event: 'Stop', kind: 'simple', timeout: 120, statusMessage: true, feature: 'impeccable' },
  { event: 'SessionStart', kind: 'start', timeout: 120 },
  { event: 'SubagentStart', kind: 'start', timeout: 120 },
  { event: 'UserPromptSubmit', kind: 'simple', timeout: 5, feature: 'ponytail' },
];

export const hookEvents = events.map(({ event }) => event);

/** The hook settings the kit contributes to one agent's settings file; `on` names the functions the project uses (projectFeatures), without it all of them. */
export function hookSettings(name, on) {
  const commands = JSON.parse(readFileSync(new URL('./hook-commands.json', import.meta.url), 'utf8'));
  const { hooks: shape } = agents[name], fill = (text, event) => text.replaceAll('{event}', event).replaceAll('{agent}', name).replaceAll('{entry}', entryFile);
  const hooks = {};
  for (const { event, kind, timeout, matcher, statusMessage, feature } of events) {
    if (feature && on && !on[feature]) continue;
    const handler = { id: 'workflow-kit', type: 'command', command: fill(commands[kind], event) };
    if (shape.windows) handler.commandWindows = fill(commands[`${kind}Windows`], event);
    handler.timeout = timeout;
    if (shape.shell) handler.shell = shape.shell;
    if (statusMessage) handler.statusMessage = 'Impeccable UI check (verified user installation)';
    hooks[event] = [{ ...(matcher && { matcher: shape.matcher }), hooks: [handler] }];
  }
  return { ...(shape.description && (!on || on.impeccable) && { description: shape.description }), hooks };
}
