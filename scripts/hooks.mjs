// The hook events and the settings the kit writes for them. The providers name their own handlers (`hooks` in provider-<name>.mjs); this file only collects them.
// A provider's hook entry with `kind` owns the event's settings (kind: `simple` only hands over; timeout, matcher, statusMessage); one without joins the kit's own start events.
import { readFileSync } from 'node:fs';
import { agents, entryFile } from './agents.mjs';
import { providerList } from './provider-list.mjs';
import { readVersions } from './versions.mjs';

// kind: `start` also reports a missing Node (the entry clones a missing shared kit).
const startEvents = [
  { event: 'SessionStart', kind: 'start', timeout: 120 },
  { event: 'SubagentStart', kind: 'start', timeout: 120 },
];
/** feature: the event exists only for a project with that function (the provider's name). */
const events = () => [
  ...providerList().flatMap(provider => Object.entries(provider.hooks ?? {}).filter(([, hook]) => hook.kind).map(([event, hook]) => ({ event, feature: provider.name, ...hook }))),
  ...startEvents,
];

export const hookEvents = events().map(({ event }) => event);

/** The hook settings the kit contributes to one agent's settings file; `on` names the functions the project uses (projectFeatures), without it all of them. */
export function hookSettings(name, on) {
  const commands = JSON.parse(readFileSync(new URL('./hook-commands.json', import.meta.url), 'utf8'));
  const { node } = readVersions();
  const { hooks: shape } = agents[name], fill = (text, event) => text.replaceAll('{event}', event).replaceAll('{agent}', name).replaceAll('{entry}', entryFile).replaceAll('{node}', node);
  const hooks = {};
  for (const { event, kind, timeout, matcher, statusMessage, feature } of events()) {
    if (feature && on && !on[feature]) continue;
    const handler = { id: 'workflow-kit', type: 'command', command: fill(commands[kind], event) };
    if (shape.windows) handler.commandWindows = fill(commands[`${kind}Windows`], event);
    handler.timeout = timeout;
    if (shape.shell) handler.shell = shape.shell;
    if (statusMessage) handler.statusMessage = statusMessage;
    hooks[event] = [{ ...(matcher && { matcher: shape.matcher }), hooks: [handler] }];
  }
  const description = shape.description && providerList().find(provider => provider.hookDescription && (!on || on[provider.name]))?.hookDescription;
  return { ...(description && { description }), hooks };
}
