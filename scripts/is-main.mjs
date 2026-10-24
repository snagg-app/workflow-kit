import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when `moduleUrl` (pass `import.meta.url`) is the script node was started with: the one check for "run directly".
 * Compares real paths, so a link (junction, symlink such as `.vendor/workflow-kit`) and Windows casing or backslashes still match. */
export function isMain(moduleUrl, started = process.argv[1]) {
  if (!started) return false;
  try {
    const real = file => { const path = realpathSync.native(file); return process.platform === 'win32' ? path.toLowerCase() : path; };
    return real(started) === real(fileURLToPath(moduleUrl));
  } catch { return false; }
}
