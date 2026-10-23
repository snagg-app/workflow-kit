// Skills the user has as Claude Code plugin: <home>/.claude/plugins/installed_plugins.json lists each plugin with its installPath, skills sit in <installPath>/skills/<name>/SKILL.md.
// shortcut: this is Claude Code's own file layout (version 2); anything unexpected counts as "no plugin skills", so kit setup only misses a hint.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agents } from './agents.mjs';

/** Map of skill name to the plugin key that ships it (for example "ponytail@ponytail"). */
export function pluginSkills(home = homedir()) {
  const found = new Map();
  for (const { plugins: list } of Object.values(agents)) {
    if (!list) continue;
    try {
      const { plugins } = JSON.parse(readFileSync(join(home, list), 'utf8'));
      for (const [key, installs] of Object.entries(plugins ?? {}))
        for (const { installPath } of installs) {
          const dir = join(installPath, 'skills');
          if (!existsSync(dir)) continue;
          for (const name of readdirSync(dir)) if (existsSync(join(dir, name, 'SKILL.md')) && !found.has(name)) found.set(name, key);
        }
    } catch { /* no plugins or an unknown layout */ }
  }
  return found;
}
