// The list of skill providers. A fourth provider is its own provider-<name>.mjs and one line here; every other script asks this list.
// A provider names: `skills` (names, or `root => names` for the skills the project has after setup), `perAgent: true` (every agent keeps its own copy),
// `feature` ({ default, auto?, hint? }: its switch in .github/workflow-project.json, named like the provider; absent: no switch).
// `hooks` ({ Event: { run(h), kind?, timeout?, matcher?, statusMessage? } }: the hook events it answers; with `kind` it owns the event's settings) and `hookDescription`: hooks.mjs and kit-hook.mjs read both from here.
import mattPocock from './provider-matt-pocock.mjs';
import ponytail from './provider-ponytail.mjs';
import impeccable from './provider-impeccable.mjs';

// Functions, not constants: the providers import modules that import this one. Order is the setup order (Matt's ownership manifests are checked first).
export const providerList = () => [mattPocock, ponytail, impeccable];
export const providerNamed = name => providerList().find(provider => provider.name === name);
/** The skills a provider has in the project at `root`. */
export const skillsOf = (provider, root) => typeof provider.skills === 'function' ? provider.skills(root) : provider.skills;
/** Skills whose files differ per agent: every agent keeps its own copy. */
export const ownSkills = () => providerList().filter(provider => provider.perAgent).flatMap(provider => provider.skills);
/** The providers with a profile switch. */
export const featureProviders = () => providerList().filter(provider => provider.feature);
