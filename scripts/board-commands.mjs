// Every board command, described by the module that runs it (`specs` of board-<name>.mjs). The parser, `board.mjs help` and the table
// in the README (scripts/board-readme.mjs) all read this list, so a command is described once.
import { specs as block } from './board-block.mjs';
import { specs as body } from './board-body.mjs';
import { specs as check } from './board-check.mjs';
import { specs as done } from './board-done.mjs';
import { specs as fields } from './board-fields.mjs';
import { specs as handoff } from './board-handoff.mjs';
import { specs as merge } from './board-merge.mjs';
import { specs as next } from './board-next.mjs';
import { specs as create } from './board-new.mjs';
import { specs as stack } from './board-stack.mjs';
import { specs as start } from './board-start.mjs';
import { specs as sweep } from './board-sweep.mjs';
import { specs as wait } from './board-wait.mjs';

// Listed in the order of the work: the visible commands first, then the steps `start` and `done` take (hidden from the list).
export const commandSpecs = [start, done, next, sweep, fields, create, block, wait, merge, stack, body, check, handoff].flat()
  .sort((a, b) => Boolean(a.hidden) - Boolean(b.hidden));
