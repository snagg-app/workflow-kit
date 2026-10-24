// Zweck: Das Versions-Manifest (scripts/versions.json) wird nur hier gelesen und geschrieben.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = kit => join(kit, 'scripts/versions.json');

/** The pinned versions of the kit at `kit` (default: this kit). */
export const readVersions = (kit = here) => JSON.parse(readFileSync(file(kit), 'utf8').replaceAll('\r\n', '\n'));

/** The message for a too old Node, or '' when `found` is new enough. */
export function nodeTooOld(found = process.versions.node, needed = readVersions().node) {
  return Number(found.split('.')[0]) < needed ? `Node ${needed} oder neuer nötig, gefunden: ${found}` : '';
}

/** For board.mjs and kit.mjs: ends the process with a clear sentence instead of "RegExp.escape is not a function" later. */
export function requireNode() {
  const message = nodeTooOld();
  if (message) {
    console.error(message);
    process.exit(1);
  }
}

/** Sets one version and keeps the other entries. */
export function setVersion(name, version, kit = here) {
  writeFileSync(file(kit), JSON.stringify({ ...readVersions(kit), [name]: version }, null, 2) + '\n');
}
