// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: `board.mjs help` lists the commands, `board.mjs help COMMAND` shows one (derived from the descriptions in board-commands.mjs).
// This file only passes the call on: the arguments, the environment and the console go to runBoard (board-run.mjs), which returns the exit code.
import { runBoard } from './board-run.mjs';
import { requireNode } from './versions.mjs';

requireNode();
process.exitCode = (await runBoard({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), io: console })).exitCode;
