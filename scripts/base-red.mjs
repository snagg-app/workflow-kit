// Tests that are red on the PR base too (#1052). A project test command that finds only such tests (test-vs-base) exits
// BASE_RED_EXIT and prints one `RED ON BASE: <test>` line each; affected-tests.mjs keeps them in its steps file, `done` reports them.
export const BASE_RED_EXIT = 3, BASE_RED_PREFIX = 'base-red: ';

/** The base-red test names a steps file (see affected-tests.mjs --resume) remembers. */
export const baseRedTests = steps => [...new Set(steps.split('\n').filter(line => line.startsWith(BASE_RED_PREFIX)).map(line => line.slice(BASE_RED_PREFIX.length)))];

/** `io.snagg.StashServiceTest.addsItem` -> `StashServiceTest`; a name without a dot is its own class. */
export const testClass = name => name.split('.').filter(Boolean).at(-2) ?? name;

/**
 * One line per test class: the open issue that already names the class, else the one `createIssue(className, tests)` returns.
 * `issues` are open issues (title, body, html_url); the first match wins.
 */
export function baseRedLines(names, issues, createIssue) {
  const classes = Map.groupBy(names, testClass);
  return [...classes].map(([className, tests]) => {
    const known = issues.find(issue => `${issue.title}\n${issue.body ?? ''}`.includes(className));
    return `- ${tests.map(name => `\`${name}\``).join(', ')}: ${known ? `Issue ${known.html_url}` : `neues Issue ${createIssue(className, tests)}`}`;
  });
}

export const baseRedSection = (base, lines) => `### Schon auf der Basis rot\n\nDiese Tests scheitern auch auf \`${base}\`, nicht wegen dieses PR; sie haben die Übergabe nicht blockiert.\n\n${lines.join('\n')}`;
