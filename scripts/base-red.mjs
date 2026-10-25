// Tests that are red on the PR base too (#1052). A project test command that finds only such tests (test-vs-base) exits
// BASE_RED_EXIT and prints one `RED ON BASE: <test>` line each; affected-tests.mjs keeps them in its steps file, `done` reports them.
export const BASE_RED_EXIT = 3, BASE_RED_PREFIX = 'base-red: ';

/** The base-red test names a steps file (see affected-tests.mjs --resume) remembers. */
export const baseRedTests = steps => [...new Set(steps.split('\n').filter(line => line.startsWith(BASE_RED_PREFIX)).map(line => line.slice(BASE_RED_PREFIX.length)))];

/** `io.snagg.StashServiceTest.addsItem` -> `StashServiceTest`; a name without a dot is its own class. */
export const testClass = name => name.split('.').filter(Boolean).at(-2) ?? name;

const mentions = (issue, className) => new RegExp(`(^|\\W)${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(`${issue.title}\n${issue.body ?? ''}`);

/**
 * One line per test class: the open issue that names the class as a word, else the one `createIssue(className, tests)` returns.
 * A failed creation is a line, never an error: base-red tests must not block the handoff. `t` is the profile text set.
 */
export function baseRedLines(names, issues, createIssue, t) {
  return [...Map.groupBy(names, testClass)].map(([className, tests]) => {
    const known = issues.find(issue => mentions(issue, className));
    let reference;
    try { reference = known ? t.baseRedKnown(known.html_url) : t.baseRedNew(createIssue(className, tests)); } catch (error) { reference = t.baseRedFailed(String(error.message).split('\n')[0]); }
    return `- ${tests.map(name => `\`${name}\``).join(', ')}: ${reference}`;
  });
}

/** `text` (the handoff body) with the section placed before its `### Retro` list, which stays last. */
export function withBaseRed(text, section) {
  const at = text.indexOf('### Retro');
  return at < 0 ? `${text.trimEnd()}\n\n${section}` : `${text.slice(0, at).trimEnd()}\n\n${section}\n\n${text.slice(at)}`;
}

export const baseRedSection = (base, lines, t) => `### ${t.baseRedHeading}\n\n${t.baseRedIntro(base)}\n\n${lines.join('\n')}`;
