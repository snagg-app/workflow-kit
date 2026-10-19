import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, projectRoot } from './checkout-root.mjs';
import { checkDirectory, materialize } from './provider-links.mjs';

// Check Matt's ownership manifests before another generator changes discovery files.
// All setups act on the checkout they run in (see projectRoot in checkout-root.mjs); `--cwd PROJECT_DIR` as the
// first argument picks it, and the setups started below inherit that working directory.
enterCwd();
const scripts = dirname(fileURLToPath(import.meta.url));
for (const name of ['setup-matt-pocock.mjs', 'setup-ponytail.mjs', 'setup-impeccable.mjs'])
  execFileSync(process.execPath, [join(scripts, name)], { stdio: 'inherit' });
const kit = dirname(scripts), root = projectRoot();
// Kit-owned skills: the canonical copy lives in the kit's .agents/skills.
for (const skill of ['find-skills', 'spec-review']) {
  const source = join(kit, '.agents/skills', skill);
  checkDirectory(kit, source);
  for (const provider of ['.agents', '.claude'])
    materialize(root, join(root, provider, 'skills', skill), source);
}
console.log('Skills generated for commit. Hook installation and personal trust are separate explicit steps.');
