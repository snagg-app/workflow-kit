// Zweck: Bricht board.mjs und kit.mjs beim Start mit einem klaren Satz ab, wenn Node älter ist als das Versions-Manifest verlangt.
// Aufruf: als erster Import (`import './node-guard.mjs'`); Module laufen in Importreihenfolge, die Prüfung kommt also vor den übrigen Skripten.
import { readVersions } from './versions.mjs';

/** The message for a too old Node, or '' when `found` is new enough. */
export function nodeTooOld(found = process.versions.node, needed = readVersions().node) {
  return Number(found.split('.')[0]) < needed ? `Node ${needed} oder neuer nötig, gefunden: ${found}` : '';
}

const message = nodeTooOld();
if (message) {
  console.error(message);
  process.exit(1);
}
