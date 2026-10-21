// The one list of agents the kit serves. A new agent is a new entry; setup, init and update scripts read only this table.
// skills: where the agent finds skills. agents: where it finds agent definitions; upstreamAgents: where Impeccable ships them.
// hooks: settings file, PostToolUse matcher and handler shape (shell key for bash handlers, a PowerShell variant, file description).
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const agents = {
  codex: {
    skills: '.agents/skills',
    agents: '.codex/agents',
    upstreamAgents: '.agents/skills/impeccable/agents',
    hooks: { file: '.codex/hooks.json', matcher: 'Edit|Write|apply_patch', windows: true },
  },
  claude: {
    skills: '.claude/skills',
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
export const hookFiles = Object.values(agents).map(agent => agent.hooks.file);

// kind: `start` also checks for Node and clones a missing shared kit; `simple` only hands over.
const events = [
  { event: 'PostToolUse', kind: 'simple', timeout: 120, matcher: true, statusMessage: true },
  { event: 'Stop', kind: 'simple', timeout: 120, statusMessage: true },
  { event: 'SessionStart', kind: 'start', timeout: 120 },
  { event: 'SubagentStart', kind: 'start', timeout: 120 },
  { event: 'UserPromptSubmit', kind: 'simple', timeout: 5 },
];

/** The hook settings the kit contributes to one agent's settings file. */
export function hookSettings(name) {
  const commands = JSON.parse(readFileSync(new URL('./hook-commands.json', import.meta.url), 'utf8'));
  const { hooks: shape } = agents[name], fill = (text, event) => text.replaceAll('{event}', event).replaceAll('{agent}', name);
  const hooks = {};
  for (const { event, kind, timeout, matcher, statusMessage } of events) {
    const handler = { id: 'workflow-kit', type: 'command', command: fill(commands[kind], event) };
    if (shape.windows) handler.commandWindows = fill(commands[`${kind}Windows`], event);
    handler.timeout = timeout;
    if (shape.shell) handler.shell = shape.shell;
    if (statusMessage) handler.statusMessage = 'Impeccable UI check (verified user installation)';
    hooks[event] = [{ ...(matcher && { matcher: shape.matcher }), hooks: [handler] }];
  }
  return { ...(shape.description && { description: shape.description }), hooks };
}
