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

if (isMain(import.meta.url)) {
  const file = fileURLToPath(new URL('../README.md', import.meta.url)), readme = readFileSync(file, 'utf8');
  const from = readme.indexOf(start), to = readme.indexOf(end);
  if (from < 0 || to < from) throw new Error(`README.md lacks the markers ${start} and ${end}`);
  writeFileSync(file, `${readme.slice(0, from + start.length)}\n${commandTable()}\n${readme.slice(to)}`);
}
