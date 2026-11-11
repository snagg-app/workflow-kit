// Free disk space before a long run (#1091): a full disk made `done` fail deep inside Gradle/Docker.
import { statfsSync } from 'node:fs';

/** Refusal text when `dir`'s volume has less than `minGb` free; null when enough or when the space cannot be read (never blocks on unknown). */
export function lowDiskRefusal(dir, minGb = 5, statfs = statfsSync) {
  try {
    const { bavail, bsize } = statfs(dir);
    const freeGb = bavail * bsize / 2 ** 30;
    return freeGb < minGb ? `only ${freeGb.toFixed(1)} GB free on the disk of ${dir} (need ${minGb} GB): free space first (node scripts/worktree-gc.mjs --rm removes finished worktrees), then run done again` : null;
  } catch { return null; }
}
