// The one list of agents the kit serves. A new agent is a new entry; setup, init and update scripts read only this table.
// skills: where the agent finds skills. agents: where it finds agent definitions; upstreamAgents: where Impeccable ships them.
// linksShared: the agent reads the shared skills through links (junction or symlink, never committed), not copies.
// hooks: settings file, PostToolUse matcher and handler shape (shell key for bash handlers, a PowerShell variant, file description); null for an agent without hooks (level 0 of AGENT_RULES: AGENTS.md, skills, board.mjs, kit check).
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const sharedSkills = '.agents/skills';
/** Skills whose files differ per agent: every agent keeps its own copy. */
export const ownSkills = ['impeccable'];

export const agents = {
  codex: {
    skills: sharedSkills,
    agents: '.codex/agents',
    upstreamAgents: '.agents/skills/impeccable/agents',
    hooks: { file: '.codex/hooks.json', matcher: 'Edit|Write|apply_patch', windows: true },
  },
  claude: {
    skills: '.claude/skills',
    linksShared: true,
    agents: '.claude/agents',
    upstreamAgents: '.claude/agents',
    hooks: {
      file: '.claude/settings.json', matcher: 'Edit|Write', shell: 'bash',
      description: 'Impeccable design detector: immediate-tier checks after Edit/Write on UI files, full-rule deep pass on Stop.',
    },
  },
};

/** Provider folders that hold skills (`.agents`, `.claude`). */
export const providers = Object.values(agents).map(agent => dirname(agent.skills));
/** Provider folders that hold real skill copies; the others link to them. */
export const sourceProviders = Object.values(agents).filter(agent => !agent.linksShared).map(agent => dirname(agent.skills));
export const hookFiles = Object.values(agents).filter(agent => agent.hooks).map(agent => agent.hooks.file);

// kind: `start` also checks for Node and clones a missing shared kit; `simple` only hands over. feature: the event exists only for a project with that function.
const events = [
  { event: 'PostToolUse', kind: 'simple', timeout: 120, matcher: true, statusMessage: true, feature: 'impeccable' },
  { event: 'Stop', kind: 'simple', timeout: 120, statusMessage: true, feature: 'impeccable' },
  { event: 'SessionStart', kind: 'start', timeout: 120 },
  { event: 'SubagentStart', kind: 'start', timeout: 120 },
  { event: 'UserPromptSubmit', kind: 'simple', timeout: 5, feature: 'ponytail' },
];

/** The hook settings the kit contributes to one agent's settings file; `on` names the functions the project uses (projectFeatures). */
export function hookSettings(name, on = { impeccable: true, ponytail: true }) {
  const commands = JSON.parse(readFileSync(new URL('./hook-commands.json', import.meta.url), 'utf8'));
  const { hooks: shape } = agents[name], fill = (text, event) => text.replaceAll('{event}', event).replaceAll('{agent}', name);
  const hooks = {};
  for (const { event, kind, timeout, matcher, statusMessage, feature } of events) {
    if (feature && !on[feature]) continue;
    const handler = { id: 'workflow-kit', type: 'command', command: fill(commands[kind], event) };
    if (shape.windows) handler.commandWindows = fill(commands[`${kind}Windows`], event);
    handler.timeout = timeout;
    if (shape.shell) handler.shell = shape.shell;
    if (statusMessage) handler.statusMessage = 'Impeccable UI check (verified user installation)';
    hooks[event] = [{ ...(matcher && { matcher: shape.matcher }), hooks: [handler] }];
  }
  return { ...(shape.description && on.impeccable && { description: shape.description }), hooks };
}
