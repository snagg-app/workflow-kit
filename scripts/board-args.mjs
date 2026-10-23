// The arguments of board.mjs, read from the command descriptions (`specs` of the board-<name>.mjs modules, collected in board-commands.mjs).
// One parser takes a call or refuses it with the reason and the usage of that one command; nothing here reads GitHub.
// A refused call ends with exit code 2; --help and `help` print the usage derived from the same description.

const kinds = {
  number: { what: 'an issue or PR number', ok: text => /^#?[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text.replace('#', ''))) },
  digits: { what: 'a number of 1 or more', ok: text => /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) },
  // OWNER/REPO#N names an issue in another repository; N or #N one in this project's repository.
  reference: { what: 'N, #N or OWNER/REPO#N', ok: (text, project) => /^\d+$/.test(text.slice(text.lastIndexOf('#') + 1)) && /^[\w.-]+\/[\w.-]+$/.test(blockerRepository(text, project)) },
  sha: { what: 'a commit id of 7 to 40 characters (git rev-parse HEAD)', ok: text => /^[0-9a-f]{7,40}$/i.test(text) },
  text: { what: 'a value', ok: text => text !== '' },
  // Field names and options travel as GraphQL variables, so any printable text works (Größe, Area/Team, P0: urgent).
  printable: { what: 'printable text that does not start with -', ok: text => /^[^\p{Cc}-][^\p{Cc}]*$/u.test(text) },
  id: { what: 'a name of letters, digits, dots and dashes', ok: text => /^\w[\w.-]*$/.test(text) },
  repo: { what: 'OWNER/NAME', ok: text => /^[\w.-]+\/[\w.-]+$/.test(text) },
  // 0 = no limit for --max-minutes; a missing or non-numeric value must not silently mean that.
  minutes: { what: 'a number of minutes, 0 or more', ok: text => text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 },
  positive: { what: 'a number above 0', ok: text => text !== '' && Number(text) > 0 && Number.isFinite(Number(text)) },
  // sleep(NaN) would wait forever.
  seconds: { what: 'a number of seconds, 0 or more', ok: text => text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 },
  seconds60: { what: 'a number of seconds from 0 to 60', ok: text => text !== '' && Number(text) >= 0 && Number(text) <= 60 },
  seconds300: { what: 'a number of seconds from 0 to 300', ok: text => text !== '' && Number(text) >= 0 && Number(text) <= 300 },
  attempts: { what: 'a whole number from 1 to 100', ok: text => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 100 },
};

/** Flags that several commands share, so that each is described once. */
export const shared = {
  session: { value: 'ID', kind: 'id', help: 'The own session. Default: the agent-<id> worktree, CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID.' },
  issueRepo: { value: 'OWNER/NAME', kind: 'repo', help: 'The issue lives in that repository and on its board; PR, branch and tests stay here.' },
  refs: { help: 'The PR only names the issue ("Refs #N"); the issue status stays.' },
  maxMinutes: { value: 'N', kind: 'minutes', help: 'Stop waiting after N minutes (default 9, 0 = no limit): exit 4, call again.' },
  stall: { value: 'MINUTES', kind: 'positive', help: 'A reviewer silent this long counts as stalled (default 20).' },
  grace: { value: 'MINUTES', kind: 'minutes', help: 'Wait this long for reviewers that start on Ready or a push (default 3, 0 = off).' },
};

/** Every command takes these two: they only change how the result prints (board-result.mjs). */
const outputFlags = { '--verbose': { help: 'Print the details too.' }, '--json': { help: 'Print the result as one JSON document.' } };

/** OWNER/REPO#N names a blocker in another repository; N or #N one in this project's repository. */
export const blockerRepository = (reference, project) => reference.includes('/') ? reference.slice(0, reference.lastIndexOf('#')) : project.repository;
export const validBlocker = (reference, project) => kinds.reference.ok(reference ?? '', project);

const wordText = word => word.optional ? `[${word.name}]` : word.name;
const flagText = (flag, def) => `${flag}${def.value ? ` ${def.value}` : ''}`;

/** `Usage: board.mjs sub PARENT CHILD`: the one line of a command, built from its description. */
export function usageOf(spec) {
  if (spec.usage) return `Usage: board.mjs ${spec.usage}`;
  const flags = Object.entries(spec.flags ?? {}).map(([flag, def]) => def.required ? flagText(flag, def) : `[${flagText(flag, def)}${def.many ? ' ...' : ''}]`);
  return ['Usage: board.mjs', spec.name, ...(spec.words ?? []).map(wordText), ...(spec.rest ? [spec.rest.usage] : []), ...flags].join(' ');
}

/** `board.mjs help COMMAND`: usage, what the command does, its flags and where the long text is (about 0.3 to 1 KB). */
export function helpOf(spec) {
  const flags = Object.entries({ ...spec.flags, ...outputFlags }).map(([flag, def]) => `  ${flagText(flag, def).padEnd(24)} ${def.help ?? ''}`.trimEnd());
  return [usageOf(spec), `${spec.writes ? 'Writes.' : 'Read-only.'} ${spec.summary}`, ...flags, ...(spec.doc ? [`Details: ${spec.doc}`] : [])].join('\n');
}

/** `board.mjs help`: every command in one line, the hidden steps of `start` and `done` left out. */
export function listOf(specs) {
  const shown = specs.filter(spec => !spec.hidden);
  return ['Usage: board.mjs [--cwd PROJECT_DIR] COMMAND [ARGUMENTS]   (board.mjs help COMMAND shows one command)',
    ...shown.map(spec => `  ${spec.name.padEnd(13)} ${spec.writes ? 'writes   ' : 'read-only'} ${spec.summary.split('. ')[0].replace(/\.$/, '')}`)].join('\n');
}

/**
 * Takes the arguments after the command or says why not: `{ spec, args }` or `{ spec, error }` (`spec` is missing for an unknown command).
 * A flag the command does not describe, a missing or malformed value, a word too many or too few: all refused here, before any read or write.
 * `args.words` are the named words, `args.rest` the free pairs of `field` and `new`.
 */
export function parseArgs(specs, argv, project) {
  const [command, ...given] = argv;
  const spec = specs.find(entry => entry.name === command);
  if (!spec) return { error: command === undefined ? undefined : `unknown command "${command}"` };
  const flags = new Map(), words = [];
  const fail = error => ({ spec, error });
  for (let index = 0; index < given.length; index++) {
    const text = given[index];
    if (!/^-./.test(text)) { words.push(text); continue; } // a lone "-" is a file name (`body ISSUE - BASE`), not a flag
    const def = outputFlags[text] ?? spec.flags?.[text];
    if (!def) return fail(`unknown option ${text}`);
    if (flags.has(text) && !def.many) return fail(`${text} may appear once`);
    if (!def.value) { flags.set(text, []); continue; }
    const value = given[++index];
    if (value === undefined || value.startsWith('--')) return fail(`${text} needs a value (${def.value})`);
    if (!kinds[def.kind ?? 'text'].ok(value, project)) return fail(`${text} needs ${kinds[def.kind ?? 'text'].what}, not "${value}"`);
    flags.set(text, [...flags.get(text) ?? [], value]);
  }
  const named = spec.words ?? [];
  const missing = named.find((word, index) => !word.optional && index >= words.length);
  if (missing) return fail(`${missing.name} is missing`);
  const rest = spec.rest ? words.splice(named.length) : [];
  if (words.length > named.length) return fail(`unexpected argument "${words[named.length]}"`);
  const bad = words.findIndex((text, index) => !kinds[named[index].kind ?? 'text'].ok(text, project));
  if (bad >= 0) return fail(`${named[bad].name} needs ${kinds[named[bad].kind ?? 'text'].what}, not "${words[bad]}"`);
  const badRest = rest.find(text => !kinds[spec.rest.kind ?? 'text'].ok(text, project));
  if (badRest !== undefined) return fail(`${spec.rest.usage} needs ${kinds[spec.rest.kind ?? 'text'].what}, not "${badRest}"`);
  const missingFlag = Object.entries(spec.flags ?? {}).find(([flag, def]) => def.required && !flags.has(flag));
  if (missingFlag) return fail(`${missingFlag[0]} is missing`);
  const args = { words, rest, flag: name => flags.has(name), names: () => [...flags.keys()], value: name => flags.get(name)?.[0], values: name => flags.get(name) ?? [],
    number: (name, fallback) => flags.has(name) ? Number(flags.get(name)[0]) : fallback };
  const error = spec.check?.(args, { project });
  return error ? fail(error) : { spec, args };
}

/** The options commands read by name, on top of the parsed arguments. */
export function createOptions({ project, args }) {
  // "staleHours" in the project file (default 6): after that long without activity the work counts as abandoned and a new session may take it over (#400).
  const { staleHours } = project;
  // "reviewerGraceMinutes" in the project file is the default of --grace; 0 turns the grace off.
  const projectGrace = project.reviewerGraceMinutes;
  const numberOption = args.number;
  // The own session for start, check and next alike: `--session`, else the `agent-<id>` of a Claude Code worktree, else CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID (the session itself, not a subagent).
  const sessionOption = () => args.value('--session')
    ?? (process.env.CODEX_THREAD_ID || /[\\/]agent-(\w+)(?:[\\/]|$)/.exec(process.cwd())?.[1] || process.env.CLAUDE_CODE_SESSION_ID);
  return { staleHours, numberOption, stallOption: () => numberOption('--stall', 20), stack: args.flag('--stack'), projectGrace, graceOption: () => numberOption('--grace', projectGrace),
    sessionOption, blockerRepository: reference => blockerRepository(reference, project), validBlocker: reference => validBlocker(reference, project) };
}
