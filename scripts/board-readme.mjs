// Writes the table of board commands into the README from the descriptions of the commands (scripts/board-<name>.mjs).
// The kit CI runs it and then proves with Git that the committed README was current.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { usageOf } from './board-args.mjs';
import { commandSpecs } from './board-commands.mjs';
import { isMain } from './is-main.mjs';

const start = '<!-- board-commands:start -->', end = '<!-- board-commands:end -->';
const cell = text => text.replaceAll('|', '\\|');

export function commandTable() {
  const rows = commandSpecs.filter(spec => !spec.hidden).map(spec => {
    const doc = spec.doc ? ` [Details](${spec.doc})` : '';
    return `| \`${cell(usageOf(spec).replace('Usage: board.mjs ', ''))}\` | ${spec.writes ? 'writes' : 'reads'} | ${cell(spec.summary)}${doc} |`;
  });
  return ['| Command | Access | What it does |', '| --- | --- | --- |', ...rows].join('\n');
}

/** The README text with the command table written from the command descriptions; `done` in the kit compares it with the committed text (#1046). */
export function renderReadme(readme) {
  const from = readme.indexOf(start), to = readme.indexOf(end);
  if (from < 0 || to < from) throw new Error(`README.md lacks the markers ${start} and ${end}`);
  return `${readme.slice(0, from + start.length)}\n${commandTable()}\n${readme.slice(to)}`;
}

const usage = `Usage: node scripts/board-readme.mjs
Rewrites the board command table in README.md from the command descriptions.`;

if (isMain(import.meta.url)) {
  const [option] = process.argv.slice(2);
  if (option === '--help' || option === '-h') { console.log(usage); process.exit(0); }
  if (option) { console.error(`${usage}
Unknown argument; README.md was not changed.`); process.exit(2); }
  const file = fileURLToPath(new URL('../README.md', import.meta.url));
  writeFileSync(file, renderReadme(readFileSync(file, 'utf8')));
}
