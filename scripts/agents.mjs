// The one list of agents the kit serves. A new agent is a new entry; setup, init and update scripts read only this table.
// skills: where the agent finds skills. agents: where it finds agent definitions; upstreamAgents: where Impeccable ships them.
// linksShared: the agent reads the shared skills through links (junction or symlink, never committed), not copies.
// detectEnv: an environment variable only this agent's session sets; defaultAgent is the one without.
// projectEnv: the variable that names the project folder for the agent's hooks (absent: the hook runs in the project folder, ".").
// label: the name messages use. sessionEnv: the variable that names the agent's session (claims, #789).
// sessionFromDirectory: a pattern on the working directory whose first group is the session, for an agent whose worktrees carry it (#810).
// worktrees: the folder (below the project) whose subfolders are the agent's worktrees; the merge deletes those (#859).
// detect: project paths that show a project uses this agent (kit setup writes hooks only for detected agents; none detected: for all).
// localSettings: the agent's personal settings file (kept out of Git). plugins: its plugin list under the home directory (#815).
// hooks: settings file, trust: the command a human uses to trust the hooks, PostToolUse matcher and handler shape (shell key for bash handlers, a PowerShell variant, file description; description: the settings file takes a description line, its text comes from the provider; fingerprint: where a session keeps the settings fingerprint, absent for an agent that reloads hooks itself); null for an agent without hooks (level 0 of AGENT_RULES: AGENTS.md, skills, board.mjs, kit check).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const defaultAgent = 'claude';
export const sharedSkills = '.agents/skills';

export const agents = {
  codex: {
    label: 'Codex',
    detectEnv: 'CODEX_THREAD_ID',
    projectEnv: 'CLAUDE_PROJECT_DIR',
    sessionEnv: 'CODEX_THREAD_ID',
    detect: ['.codex'],
    skills: sharedSkills,
    agents: '.codex/agents',
    upstreamAgents: '.agents/skills/impeccable/agents',
    hooks: { file: '.codex/hooks.json', matcher: 'Edit|Write|apply_patch', windows: true, trust: '/hooks' },
  },
  claude: {
    label: 'Claude Code',
    projectEnv: 'CLAUDE_PROJECT_DIR',
    sessionFromDirectory: /[\\/]agent-(\w+)(?:[\\/]|$)/,
    worktrees: '.claude/worktrees',
    sessionEnv: 'CLAUDE_CODE_SESSION_ID',
    detect: ['.claude'],
    skills: '.claude/skills',
    linksShared: true,
    agents: '.claude/agents',
    upstreamAgents: '.claude/agents',
    localSettings: '.claude/settings.local.json',
    plugins: '.claude/plugins/installed_plugins.json',
    hooks: {
      file: '.claude/settings.json', matcher: 'Edit|Write', shell: 'bash', trust: '/hooks',
      fingerprint: { configEnv: 'CLAUDE_CONFIG_DIR', configDir: '.claude' }, description: true,
    },
  },
};

/** Provider folders that hold skills (`.agents`, `.claude`). */
export const providers = Object.values(agents).map(agent => dirname(agent.skills));
/** Provider folders that hold real skill copies; the others link to them. */
export const sourceProviders = Object.values(agents).filter(agent => !agent.linksShared).map(agent => dirname(agent.skills));
/** The one way to list the agent names: read live from the table (a test may extend it). */
export const agentNames = () => Object.keys(agents);
/** "A", "A and B", "A, B and C": the labels of the given agents (default: all of the table) for a message. */
export function agentLabels(names = agentNames()) {
  const labels = names.map(name => agents[name].label ?? name);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels.join('');
}
/** The agents a project uses (one of their detect paths exists), optionally only those that pass the filter (hooks: agent => agent.hooks). none: nothing found, as in a new project; names is then all agents that pass. */
export function projectAgents(root, filter = () => true) {
  const candidates = agentNames().filter(name => filter(agents[name])), found = candidates.filter(name => agents[name].detect.some(path => existsSync(join(root, path))));
  return { names: found.length ? found : candidates, none: !found.length };
}
/** The project folder the environment names for the agent (without an agent: any agent's variable), else undefined. */
export const projectDirOf = (agent, env = process.env) => (agent ? [agent] : agentNames()).map(name => env[agents[name].projectEnv]).find(Boolean) || undefined;
/** The agent whose session this process runs in. */
export const detectAgent = (env = process.env) => Object.keys(agents).find(name => agents[name].detectEnv && env[agents[name].detectEnv]) ?? defaultAgent;
export const hookFiles = Object.values(agents).filter(agent => agent.hooks).map(agent => agent.hooks.file);

/** The project's copy of kit-entry.mjs (written by `kit setup`); hook-commands.json names the same path. */
export const entryFile = '.agents/workflow-kit-hook.mjs';
/** The id every kit hook handler carries; a settings file's other handlers are not the kit's. */
export const handlerId = 'workflow-kit';
