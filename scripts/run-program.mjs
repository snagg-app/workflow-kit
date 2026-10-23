// Zweck: Die eine Tür für Kindprozesse der Kit-Skripte (git, gezielte Tests, Shell der Projektdatei); ein Test setzt hier eine Ersatzfunktion.
// Aufruf: runProgram(datei, argumente, optionen) wie execFileSync; useProcessAdapter(ersatz) nur in Tests.
// Nutzen: git-tool.mjs und das Board teilen die Tür, ohne dass der sichere git-Weg vom Board-Werkzeug abhängt (#796).
import { execFileSync } from 'node:child_process';

let adapter; // (file, args, options) => stdout, like execFileSync; unset means the real process
/** A test sets the test variant (board-worker.mjs), like useGhAdapter: no test patches child_process. */
export const useProcessAdapter = fake => { adapter = fake; };

/** The one door for child processes of the kit scripts; options as for execFileSync. */
export const runProgram = (file, args, options) => (adapter ?? execFileSync)(file, args, options);
